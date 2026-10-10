import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 差分は、先頭のこのバイト数だけゴールガーディアンに渡す。 */
export const DIFF_LIMIT = 200_000;

/** 実装の対象リポジトリを扱う口。テストでは偽物に差し替える。 */
export interface RepositoryWorkspace {
  /**
   * 作業領域（dir）にリポジトリを clone し、起点のコミットを返す。
   * あわせて、clone した直後の git のメタデータを gitDir に退避する（差分を作るときの信頼できる元）。
   */
  prepare(
    dir: string,
    gitDir: string,
    url: string,
    baseBranch: string,
  ): Promise<{ baseCommit: string }>;
  /** 起点からの差分（新しく作ったファイルを含む）。 */
  diff(dir: string, gitDir: string, baseCommit: string): Promise<string>;
  /**
   * 作業領域の内容をコミットし、ブランチにプッシュする。コミットは parent に積む
   * （前回プッシュしたコミットに積むので、強制プッシュはしない）。
   */
  publish(input: {
    dir: string;
    gitDir: string;
    baseCommit: string;
    parent: string;
    branch: string;
    message: string;
    /**
     * コミットの日時（ISO 8601）。同じ提出では同じ値を渡す。プッシュの後、台帳に記録する前に
     * 失敗して再開しても、同じコミットを作り直せる（前回プッシュしたものと枝分かれしない）ように。
     */
    date: string;
  }): Promise<{ commit: string }>;
}

/** 起点から変更が無く、コミットするものが無い。 */
export class NothingToCommitError extends Error {}

const BASE_ENV_KEYS = ["PATH", "TMPDIR", "LANG"];

function pick(keys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** clone はホストの認証（credential helper や ssh-agent）を使う。エージェントが触る前なので信頼できる。 */
function cloneEnv(): Record<string, string> {
  return { ...pick([...BASE_ENV_KEYS, "HOME", "SSH_AUTH_SOCK"]), GIT_TERMINAL_PROMPT: "0" };
}

/**
 * 差分を作るときの環境。作業領域はエージェントとテストのコンテナが書き換えられるので、
 * そこにある git の設定は読まない（--git-dir で退避したメタデータを使う）。
 * 利用者やシステムの git の設定も読まない（フィルターなどの外部コマンドを、ホストで実行させないため）。
 */
function isolatedEnv(indexFile: string): Record<string, string> {
  return {
    ...pick(BASE_ENV_KEYS),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: indexFile,
  };
}

/** 外部コマンドを呼び出しうる設定を、コマンドラインで打ち消す。 */
const SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.external=",
];

function git(
  label: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => reject(new Error(`gitを実行できません（${error.message}）。`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${label} に失敗しました：${err.trim() || `終了コード ${code}`}`));
    });
  });
}

const COMMIT_RE = /^[0-9a-f]{40,64}$/;

export class GitRepositoryWorkspace implements RepositoryWorkspace {
  /**
   * 作業領域のファイルを、退避したメタデータの一時インデックスに載せる。
   * 作業領域・利用者・システムの git の設定は読まない（外部コマンドを実行させない）。
   */
  private async stage<T>(
    dir: string,
    gitDir: string,
    baseCommit: string,
    then: (git: (label: string, args: string[]) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    if (!COMMIT_RE.test(baseCommit)) throw new Error("起点のコミットが不正です。");
    // インデックスは一時ファイルにする
    const temp = mkdtempSync(join(tmpdir(), "sacty-git-"));
    try {
      const env = isolatedEnv(join(temp, "index"));
      const base = ["--git-dir", gitDir, "--work-tree", dir, ...SAFE_CONFIG];
      const run = (label: string, args: string[]) => git(label, [...base, ...args], env);
      await run("read-tree", ["read-tree", baseCommit]);
      // 新しく作ったファイルも含めるため、すべてインデックスに載せる
      await run("add", ["add", "--all"]);
      return await then(run);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  async prepare(dir: string, gitDir: string, url: string, baseBranch: string) {
    // 前回の clone が途中で止まっていれば、作り直す
    for (const path of [dir, gitDir]) {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    const env = cloneEnv();
    await git("clone", ["clone", "--branch", baseBranch, "--", url, dir], env);
    const baseCommit = (await git("rev-parse", ["rev-parse", "HEAD"], env, dir)).trim();
    // エージェントが触る前のメタデータを、どのコンテナにもマウントしない場所に退避する
    mkdirSync(dirname(gitDir), { recursive: true });
    cpSync(join(dir, ".git"), gitDir, { recursive: true });
    return { baseCommit };
  }

  async diff(dir: string, gitDir: string, baseCommit: string) {
    return this.stage(dir, gitDir, baseCommit, async (run) => {
      // 属性で差分を隠されないよう、外部の差分・変換を使わず、すべてテキストとして出す
      const diff = await run("diff", [
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        baseCommit,
      ]);
      return diff.length > DIFF_LIMIT
        ? `${diff.slice(0, DIFF_LIMIT)}\n[sacty] 差分が大きいため、先頭の ${DIFF_LIMIT} バイトだけを渡しています。`
        : diff;
    });
  }

  async publish(input: {
    dir: string;
    gitDir: string;
    baseCommit: string;
    parent: string;
    branch: string;
    message: string;
    date: string;
  }) {
    if (!COMMIT_RE.test(input.parent)) throw new Error("積む先のコミットが不正です。");
    if (!/^[\w./-]+$/.test(input.branch) || input.branch.startsWith("-")) {
      throw new Error("ブランチ名が不正です。");
    }
    const author = await this.author();
    const commit = await this.stage(input.dir, input.gitDir, input.baseCommit, async (run) => {
      const tree = (await run("write-tree", ["write-tree"])).trim();
      const baseTree = (await run("rev-parse", ["rev-parse", `${input.baseCommit}^{tree}`])).trim();
      if (tree === baseTree)
        throw new NothingToCommitError("起点から変更がないため、コミットできません。");
      const parentTree = (await run("rev-parse", ["rev-parse", `${input.parent}^{tree}`])).trim();
      // 前回プッシュした内容から変わっていなければ、同じコミットをそのまま使う
      if (tree === parentTree && input.parent !== input.baseCommit) return input.parent;
      return (
        await git(
          "commit-tree",
          [
            "--git-dir",
            input.gitDir,
            ...SAFE_CONFIG,
            "commit-tree",
            tree,
            "-p",
            input.parent,
            "-m",
            input.message,
          ],
          {
            ...isolatedEnv("/dev/null"),
            ...author,
            GIT_AUTHOR_DATE: input.date,
            GIT_COMMITTER_DATE: input.date,
          },
        )
      ).trim();
    });
    // プッシュはホストの認証（credential helper や ssh-agent）を使う。作業領域は読まない
    await git(
      "push",
      ["--git-dir", input.gitDir, "push", "--", "origin", `${commit}:refs/heads/${input.branch}`],
      cloneEnv(),
    );
    return { commit };
  }

  /** コミットの作者。ホストの git の利用者の設定を使い、無ければ sacty にする。 */
  private async author(): Promise<Record<string, string>> {
    const get = async (key: string) => {
      try {
        return (await git("config", ["config", "--global", "--get", key], cloneEnv())).trim();
      } catch {
        return "";
      }
    };
    const name = (await get("user.name")) || "sacty";
    const email = (await get("user.email")) || "sacty@localhost";
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
  }
}
