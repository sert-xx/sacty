import { describe, expect, it } from "vitest";
import { daemonEnv, signInUrl, webEnv } from "./up-env.js";

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

  it("入り口の URL に、画面の秘密を入れる", () => {
    expect(signInUrl(4700, "a+b/c")).toBe("http://127.0.0.1:4700/auth?token=a%2Bb%2Fc");
  });
});
