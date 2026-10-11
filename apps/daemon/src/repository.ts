import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { message } from "@sacty/core";
import { MessageError } from "./errors.js";

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
    /** HTTPS の GitHub に認証する環境変数（gh のトークン。PBI-13）。無ければホストの認証を使う。 */
    authEnv?: Record<string, string>,
    /**
     * 作業領域を用意し直すときの、記録済みの起点のコミット。ブランチの最新ではなく、このコミットで
     * 用意する（タスクの起点を最後まで変えないため。PBI-15）。取得できなければエラーにする。
     */
    baseCommit?: string,
  ): Promise<{ baseCommit: string }>;
  /** 起点からの差分（新しく作ったファイルを含む）。 */
  diff(dir: string, gitDir: string, baseCommit: string): Promise<string>;
  /**
   * 起点のコミットのファイルを、退避したメタデータから outDir に書き出す（.git は含めない）。
   * 要求要件・設計の工程で、実装の作業領域とは別に、起点のコードを読ませるため（PBI-15）。
   */
  snapshot(gitDir: string, baseCommit: string, outDir: string): Promise<void>;
  /**
   * 実装の作業領域の内容（.git を除く）を outDir に写す。ゴールガーディアンに、実装後のコードを読み取り専用で
   * 読ませるため（PBI-16）。シンボリックリンクはたどらず、そのまま写す。
   */
  copyWorkingTree(dir: string, outDir: string): Promise<void>;
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
    /** HTTPS の GitHub に認証する環境変数（gh のトークン。PBI-13）。 */
    authEnv?: Record<string, string>;
  }): Promise<{ commit: string }>;
  /**
   * コミットを、リモートから退避したメタデータに取得する（レビューの対象の PR のコミット。PBI-19）。
   * すでにあれば取得しない。
   */
  fetchCommits(gitDir: string, commits: string[], authEnv?: Record<string, string>): Promise<void>;
  /** base と head の分岐点から head までの差分（PR の差分。PBI-19）。 */
  diffCommits(gitDir: string, baseCommit: string, headCommit: string): Promise<string>;
  /** sacty のブランチを、リモートから消す（中止したとき）。 */
  deleteBranch(gitDir: string, branch: string, authEnv?: Record<string, string>): Promise<void>;
}

/** 起点から変更が無く、コミットするものが無い。 */
export class NothingToCommitError extends MessageError {}

const BASE_ENV_KEYS = ["PATH", "TMPDIR", "LANG"];

function pick(keys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * clone・プッシュの環境。エージェントが触る前のメタデータを使うので信頼できる。HTTPS の GitHub は
 * gh のトークン（authEnv）で、それ以外（SSH・ローカルのパス）はホストの認証（ssh-agent など）で認証する。
 */
function cloneEnv(authEnv: Record<string, string> = {}): Record<string, string> {
  return {
    ...pick([...BASE_ENV_KEYS, "HOME", "SSH_AUTH_SOCK"]),
    GIT_TERMINAL_PROMPT: "0",
    // HTTPS の GitHub は、gh のトークンで認証する（環境変数で渡し、コマンドラインには出さない）
    ...authEnv,
  };
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
    child.on("error", (error) =>
      reject(new MessageError(message("git.unavailable", { detail: error.message }))),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else if (err.trim()) {
        reject(new MessageError(message("git.failed", { command: label, detail: err.trim() })));
      } else reject(new MessageError(message("git.exitCode", { command: label, code })));
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
    if (!COMMIT_RE.test(baseCommit)) throw new MessageError(message("git.invalidBaseCommit"));
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

  async prepare(
    dir: string,
    gitDir: string,
    url: string,
    baseBranch: string,
    authEnv?: Record<string, string>,
    recorded?: string,
  ) {
    if (recorded !== undefined && !COMMIT_RE.test(recorded)) {
      throw new MessageError(message("git.invalidBaseCommit"));
    }
    // 前回の clone が途中で止まっていれば、作り直す
    for (const path of [dir, gitDir]) {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    const env = cloneEnv(authEnv);
    await git("clone", ["clone", "--branch", baseBranch, "--", url, dir], env);
    if (recorded) {
      // 用意し直すときは、記録済みの起点のコミットにする（ブランチが進んでいても変えない）。
      // ブランチの履歴に無ければ（強制プッシュなど）、コミットを直接取得してみる
      const checkout = () =>
        git("checkout", ["checkout", "--quiet", "--detach", recorded], env, dir);
      try {
        await checkout();
      } catch {
        try {
          await git("fetch", ["fetch", "--quiet", "origin", recorded], env, dir);
          await checkout();
        } catch {
          throw new MessageError(message("git.baseCommitMissing", { commit: recorded }));
        }
      }
    }
    const baseCommit = (await git("rev-parse", ["rev-parse", "HEAD"], env, dir)).trim();
    // エージェントが触る前のメタデータを、どのコンテナにもマウントしない場所に退避する
    mkdirSync(dirname(gitDir), { recursive: true });
    cpSync(join(dir, ".git"), gitDir, { recursive: true });
    return { baseCommit };
  }

  async copyWorkingTree(dir: string, outDir: string) {
    if (!existsSync(dir)) throw new MessageError(message("verify.workspaceMissing"));
    mkdirSync(dirname(outDir), { recursive: true });
    cpSync(dir, outDir, {
      recursive: true,
      // リンクの先は写さない（ホストのファイルを取り込まない）。.git は渡さない
      verbatimSymlinks: true,
      filter: (src) => relative(dir, src).split(sep)[0] !== ".git",
    });
  }

  async snapshot(gitDir: string, baseCommit: string, outDir: string) {
    if (!COMMIT_RE.test(baseCommit)) throw new MessageError(message("git.invalidBaseCommit"));
    mkdirSync(outDir, { recursive: true });
    // 差分と同じく、利用者やシステムの git の設定を読まない環境で、一時インデックスから書き出す
    const temp = mkdtempSync(join(tmpdir(), "sacty-git-"));
    try {
      const env = isolatedEnv(join(temp, "index"));
      const base = ["--git-dir", gitDir, "--work-tree", outDir, ...SAFE_CONFIG];
      await git("read-tree", [...base, "read-tree", baseCommit], env);
      await git("checkout-index", [...base, "checkout-index", "--all", "--force"], env);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
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
    authEnv?: Record<string, string>;
  }) {
    if (!COMMIT_RE.test(input.parent)) throw new MessageError(message("git.invalidParentCommit"));
    if (!/^[\w./-]+$/.test(input.branch) || input.branch.startsWith("-")) {
      throw new MessageError(message("git.invalidBranch"));
    }
    const author = await this.author();
    const commit = await this.stage(input.dir, input.gitDir, input.baseCommit, async (run) => {
      const tree = (await run("write-tree", ["write-tree"])).trim();
      const baseTree = (await run("rev-parse", ["rev-parse", `${input.baseCommit}^{tree}`])).trim();
      if (tree === baseTree) throw new NothingToCommitError(message("git.nothingToCommit"));
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
    // プッシュは、HTTPS の GitHub なら gh のトークン、それ以外はホストの認証（ssh-agent など）を使う。
    // 作業領域は読まない
    await git(
      "push",
      ["--git-dir", input.gitDir, "push", "--", "origin", `${commit}:refs/heads/${input.branch}`],
      cloneEnv(input.authEnv),
    );
    return { commit };
  }

  async fetchCommits(gitDir: string, commits: string[], authEnv?: Record<string, string>) {
    if (!commits.every((c) => COMMIT_RE.test(c))) {
      throw new MessageError(message("git.invalidBaseCommit"));
    }
    const env = cloneEnv(authEnv);
    const has = async (commit: string) => {
      try {
        await git(
          "cat-file",
          ["--git-dir", gitDir, ...SAFE_CONFIG, "cat-file", "-e", `${commit}^{commit}`],
          env,
        );
        return true;
      } catch {
        return false;
      }
    };
    const missing: string[] = [];
    for (const commit of commits) if (!(await has(commit))) missing.push(commit);
    if (missing.length === 0) return;
    await git(
      "fetch",
      ["--git-dir", gitDir, ...SAFE_CONFIG, "fetch", "--quiet", "--", "origin", ...missing],
      env,
    );
  }

  async diffCommits(gitDir: string, baseCommit: string, headCommit: string) {
    if (!COMMIT_RE.test(baseCommit) || !COMMIT_RE.test(headCommit)) {
      throw new MessageError(message("git.invalidBaseCommit"));
    }
    // 作業領域は使わず、退避したメタデータだけで差分を出す（外部の差分・変換は使わない）
    const diff = await git(
      "diff",
      [
        "--git-dir",
        gitDir,
        ...SAFE_CONFIG,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        `${baseCommit}...${headCommit}`,
      ],
      isolatedEnv("/dev/null"),
    );
    return diff.length > DIFF_LIMIT
      ? `${diff.slice(0, DIFF_LIMIT)}\n[sacty] 差分が大きいため、先頭の ${DIFF_LIMIT} バイトだけを渡しています。`
      : diff;
  }

  async deleteBranch(gitDir: string, branch: string, authEnv?: Record<string, string>) {
    // 人間のブランチを消さないよう、sacty のブランチだけを受け付ける
    if (!/^sacty\/[\w./-]+$/.test(branch)) throw new MessageError(message("git.notSactyBranch"));
    // プッシュと同じく、退避したメタデータと、gh のトークンかホストの認証を使う。作業領域は読まない
    await git(
      "push",
      ["--git-dir", gitDir, "push", "--", "origin", `:refs/heads/${branch}`],
      cloneEnv(authEnv),
    );
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
