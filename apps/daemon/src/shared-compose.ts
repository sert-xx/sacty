import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { message } from "@sacty/core";
import { MessageError } from "./errors.js";

/**
 * 共用の docker compose のリポジトリの取得（PBI-70）。リポジトリごとに sacty のキャッシュ（bare リポジトリ）を持ち、
 * 実行ごとに ref の最新を取ってきて（キャッシュの更新）、そのコミットの中身を実行ごとのディレクトリに書き出す。
 * 実行ごとに別のディレクトリにするので、並行するタスクが同じ共用の compose を使っても、マウントするファイル
 * （初期化スクリプト・設定ファイル）が途中で書き換わらない。
 */
export interface SharedComposeFetcher {
  /**
   * repo の ref（無ければ既定のブランチ）を取得し、そのコミットの中身を dest に置く。authEnv は HTTPS の GitHub に
   * 認証する環境変数（プロジェクトの gh のアカウントのトークン。コンテキストリポジトリと同じ）。無ければホストの認証。
   */
  checkout(input: {
    repo: string;
    ref?: string;
    dest: string;
    authEnv?: Record<string, string>;
  }): Promise<{ commit: string }>;
}

/** 実行ごとに共用の compose を書き出すディレクトリ（作業領域の根の下。sacty が管理する）。 */
export function sharedComposeRunDir(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, "_shared-compose", runId);
}

/** 前回、片付ける前にデーモンが終わって残った、実行ごとの共用の compose を消す（デーモンの起動時）。 */
export function cleanupSharedComposeRuns(workspaceRoot: string): void {
  rmSync(join(workspaceRoot, "_shared-compose"), { recursive: true, force: true });
}

/** git の環境（コンテキストリポジトリの取得と同じ。認証は環境変数でだけ渡す）。 */
function gitEnv(authEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...authEnv };
}

export class GitSharedComposeFetcher implements SharedComposeFetcher {
  /** キャッシュごとの処理の順番（同じキャッシュの取得・書き出しを、並行させない）。 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cacheDir: string,
    private readonly spawnImpl: typeof spawn = spawn,
  ) {}

  private git(
    args: string[],
    authEnv?: Record<string, string>,
    cwd?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((done) => {
      const child = this.spawnImpl("git", args, {
        env: gitEnv(authEnv),
        ...(cwd ? { cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => done({ code: 127, stdout, stderr: error.message }));
      child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    });
  }

  /** git を実行し、失敗したら git のエラー文（外から来た文）で投げる。 */
  private async mustGit(args: string[], authEnv?: Record<string, string>): Promise<string> {
    const result = await this.git(args, authEnv);
    if (result.code === 0) return result.stdout;
    if (result.code === 127) {
      throw new MessageError(message("git.unavailable", { detail: result.stderr }));
    }
    if (result.stderr.trim()) throw new Error(result.stderr.trim());
    throw new MessageError(
      message("git.exitCode", {
        command: args.find((a) => !a.startsWith("-")) ?? "",
        code: result.code,
      }),
    );
  }

  /** そのキャッシュの処理を、前の処理が終わってから行う。 */
  private serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  checkout({ repo, ref, dest, authEnv }: Parameters<SharedComposeFetcher["checkout"]>[0]) {
    const key = createHash("sha256").update(repo).digest("hex").slice(0, 24);
    const cache = join(this.cacheDir, `${key}.git`);
    return this.serialized(key, async () => {
      if (!existsSync(join(cache, "HEAD"))) {
        await rm(cache, { recursive: true, force: true });
        mkdirSync(cache, { recursive: true });
        await this.mustGit(["init", "--bare", "--quiet", cache]);
      }
      // ref の最新を取る（キャッシュの更新）。ref が無ければ既定のブランチ（リモートの HEAD）。浅く取る
      await this.mustGit(
        [
          "--git-dir",
          cache,
          "fetch",
          "--quiet",
          "--no-tags",
          "--force",
          "--depth",
          "1",
          "--",
          repo,
          ref || "HEAD",
        ],
        authEnv,
      );
      const commit = (
        await this.mustGit(["--git-dir", cache, "rev-parse", "--verify", "FETCH_HEAD^{commit}"])
      ).trim();
      // そのコミットの中身を、実行ごとのディレクトリに書き出す（.git は含めない）。消す間もデーモンが応答し続けるよう、
      // 非同期で消す（PBI-156）
      await rm(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      await this.extract(cache, commit, dest);
      return { commit };
    });
  }

  /** git archive の中身を、tar で dest に展開する。 */
  private async extract(cache: string, commit: string, dest: string): Promise<void> {
    const archive = this.spawnImpl("git", ["--git-dir", cache, "archive", "--format=tar", commit], {
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tar = this.spawnImpl("tar", ["-x", "-f", "-", "-C", dest], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let errors = "";
    archive.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    tar.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    // tar が先に終わって読まなくなっても、書き込みのエラーで落ちないように
    tar.stdin?.on("error", () => undefined);
    if (archive.stdout && tar.stdin) archive.stdout.pipe(tar.stdin);
    const exited = (child: ReturnType<typeof spawn>) =>
      new Promise<number>((resolve) => {
        child.on("error", (error) => {
          errors += error.message;
          resolve(127);
        });
        child.on("close", (code) => resolve(code ?? 1));
      });
    const [archiveCode, tarCode] = await Promise.all([exited(archive), exited(tar)]);
    if (archiveCode !== 0 || tarCode !== 0) {
      throw new Error(errors.trim() || `git archive (${archiveCode}) | tar (${tarCode})`);
    }
  }
}
