import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { errorText } from "./errors.js";
import { GhCliAuth, gitAuthEnv, gitAuthSecrets, httpsHost } from "./gh.js";

/** gh コマンドの偽物。引数と環境変数を記録し、決めた出力と終了コードを返す。 */
function fakeGh(result: { stdout?: string; stderr?: string; code?: number; error?: string }) {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const spawnImpl = ((_cmd: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push({ args, env: options.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    setTimeout(() => {
      if (result.error) {
        child.emit("error", Object.assign(new Error(result.error), { code: result.error }));
        return;
      }
      if (result.stdout) child.stdout.emit("data", result.stdout);
      if (result.stderr) child.stderr.emit("data", result.stderr);
      child.emit("close", result.code ?? 0);
    }, 0);
    return child;
  }) as never;
  return { spawnImpl, calls };
}

const original = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("gh コマンドでの GitHub の認証（PBI-13）", () => {
  it("すべてのホスト（github.com・GitHub Enterprise Server）のログイン済みのアカウントを読む（トークンは求めない。PBI-40）", async () => {
    const gh = fakeGh({
      stdout: JSON.stringify({
        hosts: {
          "github.com": [
            { state: "success", active: true, login: "personal" },
            { state: "success", active: false, login: "side-job" },
            { state: "error", active: false, login: "expired" },
          ],
          "ghe.example.co.jp": [{ state: "success", active: true, login: "corp" }],
          "ghe2.example.co.jp": [{ state: "success", active: false, login: "corp2" }],
        },
      }),
    });
    expect(await new GhCliAuth(gh.spawnImpl).accounts()).toEqual([
      { host: "github.com", login: "personal", active: true },
      { host: "github.com", login: "side-job", active: false },
      { host: "ghe.example.co.jp", login: "corp", active: true },
      { host: "ghe2.example.co.jp", login: "corp2", active: false },
    ]);
    // ホストで絞らない
    expect(gh.calls[0]?.args).toEqual(["auth", "status", "--json", "hosts"]);
    expect(gh.calls[0]?.args).not.toContain("--show-token");
  });

  it("選んだホストのアカウントのトークンを取り出す。環境の GH_TOKEN は渡さない（選んだアカウントを使うため）", async () => {
    process.env.GH_TOKEN = "env-token";
    process.env.GITHUB_TOKEN = "env-token-2";
    const gh = fakeGh({ stdout: "ghp_side\n" });
    expect(await new GhCliAuth(gh.spawnImpl).token("ghe.example.co.jp", "side-job")).toBe(
      "ghp_side",
    );
    expect(gh.calls[0]?.args).toEqual([
      "auth",
      "token",
      "--hostname",
      "ghe.example.co.jp",
      "--user",
      "side-job",
    ]);
    expect(gh.calls[0]?.env.GH_TOKEN).toBeUndefined();
    expect(gh.calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("gh が無い・ログインしていなければ、理由を示す", async () => {
    const missing = fakeGh({ error: "ENOENT" });
    expect(
      errorText(
        await new GhCliAuth(missing.spawnImpl).token("github.com", "me").catch((e: unknown) => e),
      ),
    ).toEqual({ code: "github.ghMissing" });
    const notLoggedIn = fakeGh({ code: 1, stderr: "no oauth token found for github.com" });
    expect(
      errorText(
        await new GhCliAuth(notLoggedIn.spawnImpl)
          .token("github.com", "side-job")
          .catch((e: unknown) => e),
      ),
    ).toEqual({
      code: "github.accountUnavailable",
      params: { account: "side-job", host: "github.com" },
    });
    // ログインしているアカウントが無ければ、空の一覧
    const none = fakeGh({ code: 1, stderr: "You are not logged into any GitHub hosts." });
    expect(await new GhCliAuth(none.spawnImpl).accounts()).toEqual([]);
  });

  it("HTTPS の URL のホストを読み、そのホストにだけトークンで git を認証する", () => {
    expect(httpsHost("https://github.com/acme/app.git")).toBe("github.com");
    expect(httpsHost("https://GHE.example.co.jp/acme/app.git")).toBe("ghe.example.co.jp");
    expect(httpsHost("git@github.com:acme/app.git")).toBeUndefined();
    expect(httpsHost("/local/path")).toBeUndefined();
    const env = gitAuthEnv("ghe.example.co.jp", "ghp_x");
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://ghe.example.co.jp/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:ghp_x").toString("base64")}`,
    });
    // 取り除く対象は、トークンと認証の値だけ（"1" などは含めない）
    expect(gitAuthSecrets("ghp_x")).toEqual([
      "ghp_x",
      Buffer.from("x-access-token:ghp_x").toString("base64"),
    ]);
  });
});
