import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/i18n/server", async () => {
  const { messagesFor } = await import("@/i18n");
  return { getMessages: async () => messagesFor("ja") };
});

const { saveProject } = await import("./daemon");

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SACTY_DAEMON_URL", "http://127.0.0.1:1");
  vi.stubEnv("SACTY_DAEMON_TOKEN", "daemon-token");
  vi.stubEnv("SACTY_WEB_AUTH", "off");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("プロジェクトの保存に、読み込んだ版を添える（PBI-274）", () => {
  it("変えるときは If-Match に版を送り、作成では送らない", async () => {
    fetchMock.mockImplementation(async () => Response.json({ project: { id: "p" } }));
    await saveProject("p", { name: "A" }, "2026-10-30T00:00:00.000Z");
    expect(fetchMock.mock.calls[0]?.[1].method).toBe("PUT");
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
      "if-match": "2026-10-30T00:00:00.000Z",
    });
    await saveProject(undefined, { name: "A" });
    expect(fetchMock.mock.calls[1]?.[1].method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1].headers).not.toHaveProperty("if-match");
  });

  it("ほかの保存で変わっていた（409）なら、衝突として理由を返す。ほかの 409 は衝突にしない", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        { error: "invalid_operation", messages: [{ code: "project.changedElsewhere" }] },
        { status: 409 },
      ),
    );
    const conflict = await saveProject("p", { name: "A" }, "old");
    expect(conflict).toMatchObject({ ok: false, conflict: true });
    expect(conflict.ok === false && conflict.message).toContain("ほかの保存で変わりました");
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          error: "invalid_operation",
          messages: [{ code: "project.targetDuplicated", params: { scope: "repo", target: "x" } }],
        },
        { status: 409 },
      ),
    );
    const duplicated = await saveProject("p", { name: "A" }, "old");
    expect(duplicated).toMatchObject({ ok: false });
    expect(duplicated).not.toHaveProperty("conflict");
  });
});
