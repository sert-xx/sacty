import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionValue } from "./web-auth";

let cookieValue: string | undefined;
let cookieName = "";
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      cookieName = name;
      return cookieValue === undefined ? undefined : { name, value: cookieValue };
    },
  }),
}));
vi.mock("@/i18n/server", async () => {
  const { messagesFor } = await import("@/i18n");
  return { getMessages: async () => messagesFor("ja") };
});

const { DaemonUnavailableError, listTasks } = await import("./daemon");
const { liveResponse } = await import("./live-server");

const fetchMock = vi.fn(async () => Response.json({ tasks: [] }));

describe("デーモンへ中継する前に、起動した本人のブラウザかを確かめ直す（PBI-129）", () => {
  beforeEach(() => {
    cookieValue = undefined;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SACTY_DAEMON_URL", "http://127.0.0.1:1");
    vi.stubEnv("SACTY_DAEMON_TOKEN", "daemon-token");
    vi.stubEnv("SACTY_WEB_TOKEN", "web-secret");
    vi.stubEnv("SACTY_WEB_PORT", "4700");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("cookie が無い・誤り・前の起動のものなら、デーモンのトークンを使わずに断る", async () => {
    for (const value of [undefined, "wrong", sessionValue("before")]) {
      cookieValue = value;
      await expect(listTasks()).rejects.toBeInstanceOf(DaemonUnavailableError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("取り直し（live）も中身を返さない", async () => {
    const res = await liveResponse(new Request("http://127.0.0.1:4700/live/tasks"), () =>
      listTasks(),
    );
    expect(await res.json()).toEqual({ unavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("画面の秘密が無ければ（sacty up で起動していない）、cookie があっても断る", async () => {
    vi.stubEnv("SACTY_WEB_TOKEN", "");
    cookieValue = sessionValue("");
    await expect(listTasks()).rejects.toThrow("画面の認証が設定されていません");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("認証を OFF にした（SACTY_WEB_AUTH=off）なら、cookie が無くても問い合わせる。off 以外の値では OFF にしない（PBI-133）", async () => {
    vi.stubEnv("SACTY_WEB_TOKEN", "");
    for (const value of ["false", "OFF", "0", ""]) {
      vi.stubEnv("SACTY_WEB_AUTH", value);
      await expect(listTasks()).rejects.toBeInstanceOf(DaemonUnavailableError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("SACTY_WEB_AUTH", "off");
    await expect(listTasks()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("今の起動の cookie なら、今までどおりデーモンに問い合わせる（ポートを入れた名前の cookie を読む）", async () => {
    cookieValue = sessionValue("web-secret");
    await expect(listTasks()).resolves.toEqual([]);
    expect(cookieName).toBe("sacty-session-4700");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
