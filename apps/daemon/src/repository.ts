import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

/** 差分は、先頭のこのバイト数だけゴールガーディアンに渡す。 */
export const DIFF_LIMIT = 200_000;

/** 実装の対象リポジトリを扱う口。テストでは偽物に差し替える。 */
export interface RepositoryWorkspace {
  /** 作業領域にリポジトリを clone し、起点のコミットを返す。 */
  prepare(dir: string, url: string, baseBranch: string): Promise<{ baseCommit: string }>;
  /** 起点からの差分（新しく作ったファイルを含む）。 */
  diff(dir: string, baseCommit: string): Promise<string>;
}

/** git にはホストの認証（credential helper や ssh-agent）を使わせる。 */
function gitEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR", "LANG"];
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of keep) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
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
      else
        reject(new Error(`git ${args[0]} に失敗しました：${err.trim() || `終了コード ${code}`}`));
    });
  });
}

export class GitRepositoryWorkspace implements RepositoryWorkspace {
  async prepare(dir: string, url: string, baseBranch: string) {
    // 前回の clone が途中で止まっていれば、作り直す
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    await git(["clone", "--branch", baseBranch, "--", url, dir]);
    const baseCommit = (await git(["rev-parse", "HEAD"], dir)).trim();
    return { baseCommit };
  }

  async diff(dir: string, baseCommit: string) {
    // 新しく作ったファイルも差分に含めるため、インデックスに載せてから比べる（コミットはしない）
    await git(["add", "--all"], dir);
    const diff = await git(
      ["-c", "core.quotepath=false", "diff", "--cached", "--no-color", baseCommit],
      dir,
    );
    return diff.length > DIFF_LIMIT
      ? `${diff.slice(0, DIFF_LIMIT)}\n[sacty] 差分が大きいため、先頭の ${DIFF_LIMIT} バイトだけを渡しています。`
      : diff;
  }
}
