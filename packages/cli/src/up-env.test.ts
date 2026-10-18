import { describe, expect, it } from "vitest";
import { daemonEnv, signInUrl, startMessage, webAuthEnabled, webEnv } from "./up-env.js";

describe("sacty up が子プロセスに渡す環境変数（PBI-129）", () => {
  it("画面の秘密は、デーモンに渡さない（シェルに同じ名前の変数があっても取り除く）", () => {
    const env = daemonEnv(
      { PATH: "/bin", SACTY_WEB_TOKEN: "from-shell" },
      { daemonPort: 4710, daemonToken: "d", webPort: 4700 },
    );
    expect(env).not.toHaveProperty("SACTY_WEB_TOKEN");
    expect(env).toMatchObject({
      PATH: "/bin",
      SACTY_DAEMON_PORT: "4710",
      SACTY_DAEMON_TOKEN: "d",
      SACTY_WEB_URL: "http://127.0.0.1:4700",
    });
  });

  it("画面には、デーモンの接続先と、画面の秘密とポートを渡す", () => {
    const env = webEnv(
      { PATH: "/bin", SACTY_WEB_TOKEN: "from-shell" },
      { daemonUrl: "http://127.0.0.1:4710", daemonToken: "d", webPort: 4700, webToken: "w" },
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      SACTY_DAEMON_URL: "http://127.0.0.1:4710",
      SACTY_DAEMON_TOKEN: "d",
      SACTY_WEB_TOKEN: "w",
      SACTY_WEB_PORT: "4700",
    });
  });

  it("画面の認証を OFF にする指定は、設定ファイル（web.auth: false）からだけ決める（PBI-133）", () => {
    const config = (webAuth: boolean) => ({ ok: true as const, config: { webAuth } as never });
    expect(webAuthEnabled(config(true))).toBe(true);
    expect(webAuthEnabled(config(false))).toBe(false);
    // 設定ファイルが無い・読めないときは ON（安全側）
    expect(webAuthEnabled({ ok: false, problem: { code: "config.missing" } as never })).toBe(true);
    // OFF なら秘密を渡さず、OFF を伝える
    const off = webEnv(
      { PATH: "/bin" },
      { daemonUrl: "http://127.0.0.1:4710", daemonToken: "d", webPort: 4700 },
    );
    expect(off).not.toHaveProperty("SACTY_WEB_TOKEN");
    expect(off.SACTY_WEB_AUTH).toBe("off");
    // ON なら、シェルに OFF の指定があっても取り除く。デーモンにも渡さない
    const on = webEnv(
      { PATH: "/bin", SACTY_WEB_AUTH: "off" },
      { daemonUrl: "http://127.0.0.1:4710", daemonToken: "d", webPort: 4700, webToken: "w" },
    );
    expect(on).not.toHaveProperty("SACTY_WEB_AUTH");
    expect(on.SACTY_WEB_TOKEN).toBe("w");
    expect(
      daemonEnv({ SACTY_WEB_AUTH: "off" }, { daemonPort: 4710, daemonToken: "d", webPort: 4700 }),
    ).not.toHaveProperty("SACTY_WEB_AUTH");
  });

  it("起動したときの表示：ON なら入り口の URL、OFF なら画面の URL と危険の警告（PBI-133）", () => {
    expect(startMessage(4700, "w")).toContain("http://127.0.0.1:4700/auth?token=w");
    expect(startMessage(4700, "w")).not.toContain("警告");
    const off = startMessage(4700, undefined);
    expect(off).toContain("Open http://127.0.0.1:4700 in your browser.");
    expect(off).not.toContain("/auth");
    expect(off).toContain("警告：画面の認証を OFF にしています（config.yaml の web.auth: false）");
  });

  it("入り口の URL に、画面の秘密を入れる", () => {
    expect(signInUrl(4700, "a+b/c")).toBe("http://127.0.0.1:4700/auth?token=a%2Bb%2Fc");
  });
});
