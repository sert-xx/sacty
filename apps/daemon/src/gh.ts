import { spawn } from "node:child_process";
import { message } from "@sacty/core";
import { MessageError } from "./errors.js";

/**
 * gh にログイン済みの GitHub のアカウント。host は github.com や GitHub Enterprise Server のホスト（PBI-40）。
 * state は、gh auth status がトークンを確かめた結果（success・error・timeout）。確かめられなくても（プロキシ越しの
 * GitHub Enterprise Server に届かないなど）トークンは取り出せるので、一覧からは外さず、error に理由を載せる。
 */
export type GitHubAccount = {
  host: string;
  login: string;
  active: boolean;
  state: string;
  error?: string;
};

/**
 * GitHub への認証を、ホストの gh コマンドから得る口（PBI-13）。テストでは偽物に差し替える。
 * トークンは使う都度に取り出し、保存しない。
 */
export interface GitHubAuth {
  /** gh にログイン済みのアカウント（すべてのホスト）。 */
  accounts(): Promise<GitHubAccount[]>;
  /** そのホストのアカウントのトークン（アクティブなアカウントは切り替わるので、必ずアカウントを指定する）。 */
  token(host: string, account: string): Promise<string>;
}

/**
 * gh に渡す環境変数。gh の設定とキーチェーンを読むのと、GitHub に届くのに要るもの（プロキシ・社内の CA）だけを渡す。
 * プロキシなどを渡さないと、gh auth status がオンプレの GitHub Enterprise Server に届かず、アカウントが error になる。
 * GH_TOKEN・GITHUB_TOKEN・GH_ENTERPRISE_TOKEN は渡さない（渡すと、選んだアカウントではなく、そのトークンが使われるため）。
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
    // Linux のキーリング（Secret Service）
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    // プロキシと CA（gh は Go なので、大文字・小文字の両方を読む）
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
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
    const { code, stdout, stderr } = await this.run(["auth", "status", "--json", "hosts"]);
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
    const hosts = (parsed as { hosts?: Record<string, unknown> })?.hosts ?? {};
    return Object.entries(hosts).flatMap(([host, list]) =>
      Array.isArray(list)
        ? list
            .map(
              (item) =>
                item as { login?: unknown; active?: unknown; state?: unknown; error?: unknown },
            )
            .filter((item) => typeof item.login === "string" && item.login !== "")
            .map((item) => ({
              host,
              login: String(item.login),
              active: item.active === true,
              state: typeof item.state === "string" ? item.state : "unknown",
              ...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
            }))
        : [],
    );
  }

  async token(host: string, account: string): Promise<string> {
    const args = ["auth", "token", "--hostname", host, "--user", account];
    const { code, stdout } = await this.run(args);
    const token = stdout.trim();
    // エラー文にはトークンは含まれないが、念のため出さない
    if (code !== 0 || !token) {
      throw new MessageError(message("github.accountUnavailable", { account, host }));
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
export function gitAuthEnv(host: string, token: string): Record<string, string> {
  const basic = basicAuth(token);
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
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

/** git の HTTPS の URL のホスト（トークンで認証する対象を選ぶ）。SSH やローカルのパスは undefined（ホストの認証を使う）。 */
export function httpsHost(url: string): string | undefined {
  return url.match(/^https:\/\/([^/@]+)\//i)?.[1]?.toLowerCase();
}
