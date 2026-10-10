import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { errorText } from "./errors.js";
import { GhCliAuth, gitAuthEnv, gitAuthSecrets, isGitHubHttps } from "./gh.js";

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
  it("ログイン済みのアカウントを読む（トークンは求めない）", async () => {
    const gh = fakeGh({
      stdout: JSON.stringify({
        hosts: {
          "github.com": [
            { state: "success", active: true, login: "personal" },
            { state: "success", active: false, login: "side-job" },
            { state: "error", active: false, login: "expired" },
          ],
        },
      }),
    });
    expect(await new GhCliAuth(gh.spawnImpl).accounts()).toEqual([
      { login: "personal", active: true },
      { login: "side-job", active: false },
    ]);
    expect(gh.calls[0]?.args).toEqual([
      "auth",
      "status",
      "--json",
      "hosts",
      "--hostname",
      "github.com",
    ]);
    expect(gh.calls[0]?.args).not.toContain("--show-token");
  });

  it("選んだアカウントのトークンを取り出す。環境の GH_TOKEN は渡さない（選んだアカウントを使うため）", async () => {
    process.env.GH_TOKEN = "env-token";
    process.env.GITHUB_TOKEN = "env-token-2";
    const gh = fakeGh({ stdout: "ghp_side\n" });
    expect(await new GhCliAuth(gh.spawnImpl).token("side-job")).toBe("ghp_side");
    expect(gh.calls[0]?.args).toEqual([
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      "side-job",
    ]);
    expect(gh.calls[0]?.env.GH_TOKEN).toBeUndefined();
    expect(gh.calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("gh が無い・ログインしていなければ、理由を示す", async () => {
    const missing = fakeGh({ error: "ENOENT" });
    expect(
      errorText(await new GhCliAuth(missing.spawnImpl).token("me").catch((e: unknown) => e)),
    ).toEqual({ code: "github.ghMissing" });
    const notLoggedIn = fakeGh({ code: 1, stderr: "no oauth token found for github.com" });
    expect(
      errorText(
        await new GhCliAuth(notLoggedIn.spawnImpl).token("side-job").catch((e: unknown) => e),
      ),
    ).toEqual({ code: "github.accountUnavailable", params: { account: "side-job" } });
    // ログインしているアカウントが無ければ、空の一覧
    const none = fakeGh({ code: 1, stderr: "You are not logged into any GitHub hosts." });
    expect(await new GhCliAuth(none.spawnImpl).accounts()).toEqual([]);
  });

  it("HTTPS の GitHub だけを、トークンで git を認証する対象にする", () => {
    expect(isGitHubHttps("https://github.com/acme/app.git")).toBe(true);
    expect(isGitHubHttps("git@github.com:acme/app.git")).toBe(false);
    expect(isGitHubHttps("https://example.com/acme/app.git")).toBe(false);
    expect(isGitHubHttps("/local/path")).toBe(false);
    const env = gitAuthEnv("ghp_x");
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:ghp_x").toString("base64")}`,
    });
    // 取り除く対象は、トークンと認証の値だけ（"1" などは含めない）
    expect(gitAuthSecrets("ghp_x")).toEqual([
      "ghp_x",
      Buffer.from("x-access-token:ghp_x").toString("base64"),
    ]);
  });
});
