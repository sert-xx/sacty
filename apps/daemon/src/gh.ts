import { spawn } from "node:child_process";
import { message } from "@sacty/core";
import { MessageError } from "./errors.js";

/** gh にログイン済みの GitHub のアカウント。 */
export type GitHubAccount = { login: string; active: boolean };

/**
 * GitHub への認証を、ホストの gh コマンドから得る口（PBI-13）。テストでは偽物に差し替える。
 * トークンは使う都度に取り出し、保存しない。
 */
export interface GitHubAuth {
  /** gh にログイン済みのアカウント。 */
  accounts(): Promise<GitHubAccount[]>;
  /** そのアカウント（省略するとアクティブなアカウント）のトークン。 */
  token(account?: string): Promise<string>;
}

const HOST = "github.com";

/**
 * gh に渡す環境変数。gh の設定とキーチェーンを読むのに要るものだけを渡す。
 * GH_TOKEN・GITHUB_TOKEN は渡さない（渡すと、選んだアカウントではなく、そのトークンが使われるため）。
 */
function ghEnv(): Record<string, string> {
  const env: Record<string, string> = { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export class GhCliAuth implements GitHubAuth {
  constructor(private readonly spawnImpl: typeof spawn = spawn) {}

  async accounts(): Promise<GitHubAccount[]> {
    // トークンは出さない（--show-token は付けない）
    const { code, stdout, stderr } = await this.run([
      "auth",
      "status",
      "--json",
      "hosts",
      "--hostname",
      HOST,
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // ログインしていなければ、JSON を出さずに失敗する
      if (code !== 0) return [];
      throw new MessageError(
        message("github.ghFailed", { detail: stderr.trim() || stdout.trim() }),
      );
    }
    const list = (parsed as { hosts?: Record<string, unknown> })?.hosts?.[HOST];
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => item as { login?: unknown; active?: unknown; state?: unknown })
      .filter((item) => typeof item.login === "string" && item.state === "success")
      .map((item) => ({ login: String(item.login), active: item.active === true }));
  }

  async token(account?: string): Promise<string> {
    const args = ["auth", "token", "--hostname", HOST, ...(account ? ["--user", account] : [])];
    const { code, stdout } = await this.run(args);
    const token = stdout.trim();
    // エラー文にはトークンは含まれないが、念のため出さない
    if (code !== 0 || !token) {
      throw new MessageError(message("github.accountUnavailable", { account: account ?? "" }));
    }
    return token;
  }

  private run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl("gh", args, {
        env: ghEnv(),
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
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new MessageError(message("github.ghMissing"))
            : new MessageError(message("github.ghFailed", { detail: error.message })),
        );
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}

/**
 * HTTPS の GitHub に git で認証するための環境変数（トークンはコマンドラインに出さない）。
 * ホストの git の認証の設定（credential helper など）に頼らずに、clone・プッシュできるようにする。
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = basicAuth(token);
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${HOST}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString("base64");
}

/** 出力やエラー文から取り除く値（トークンと、git に渡す認証の値）。 */
export function gitAuthSecrets(token: string): string[] {
  return [token, basicAuth(token)];
}

/** HTTPS の GitHub の URL か（トークンで認証する対象）。SSH やローカルのパスは、ホストの認証を使う。 */
export function isGitHubHttps(url: string): boolean {
  return /^https:\/\/github\.com\//i.test(url);
}
