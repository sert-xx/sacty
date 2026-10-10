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
}

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

export class GitRepositoryWorkspace implements RepositoryWorkspace {
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
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("起点のコミットが不正です。");
    // インデックスは一時ファイルにし、退避したメタデータは書き換えない
    const temp = mkdtempSync(join(tmpdir(), "sacty-diff-"));
    try {
      const env = isolatedEnv(join(temp, "index"));
      const base = ["--git-dir", gitDir, "--work-tree", dir, ...SAFE_CONFIG];
      await git("read-tree", [...base, "read-tree", baseCommit], env);
      // 新しく作ったファイルも差分に含めるため、インデックスに載せてから比べる（コミットはしない）
      await git("add", [...base, "add", "--all"], env);
      // 属性で差分を隠されないよう、外部の差分・変換を使わず、すべてテキストとして出す
      const diff = await git(
        "diff",
        [
          ...base,
          "diff",
          "--cached",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--text",
          baseCommit,
        ],
        env,
      );
      return diff.length > DIFF_LIMIT
        ? `${diff.slice(0, DIFF_LIMIT)}\n[sacty] 差分が大きいため、先頭の ${DIFF_LIMIT} バイトだけを渡しています。`
        : diff;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}
