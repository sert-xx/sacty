import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const { DaemonUnavailableError, getStatus } = vi.hoisted(() => ({
  DaemonUnavailableError: class extends Error {},
  getStatus: vi.fn(),
}));
vi.mock("@/lib/daemon", () => ({ DaemonUnavailableError, getStatus }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));

const { GET } = await import("./route");
const m = messagesFor("ja");

beforeEach(() => {
  getStatus.mockReset();
});

describe("タスクの作成で、工程ごとに選べるイメージ・エージェントを返す", () => {
  it("既定のイメージと images、agents（秘密・接続先なし）と config.yaml で決まる工程ごとの名前を返す", async () => {
    getStatus.mockResolvedValue({
      agent: { id: "claude", runtime: "claude-code", authMode: "subscription" },
      problems: [],
      images: [{ name: "java", description: "Java 17" }],
      agents: [
        { id: "claude", runtime: "claude-code", model: "claude-sonnet-5-5" },
        { id: "stub", runtime: "stub" },
      ],
      stepAgents: { implement: "claude" },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      images: [
        { name: "default", description: m.task.images.defaultDescription },
        { name: "java", description: "Java 17" },
      ],
      // stub は、既定のエージェントが stub のときだけ
      agents: [{ id: "claude", model: "claude-sonnet-5-5" }],
      stepAgents: { implement: "claude" },
    });
  });

  it("設定を読めない・デーモンにつながらない・失敗したときは、理由を返す", async () => {
    getStatus.mockResolvedValue({ agent: null, problems: [{ code: "config.missing" }] });
    const unreadable = await GET();
    expect(unreadable.status).toBe(503);
    expect(await unreadable.json()).toEqual({ message: m.forms.task.stepOptionsUnavailable });
    getStatus.mockRejectedValue(new DaemonUnavailableError("つながりません"));
    const down = await GET();
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ message: "つながりません" });
    getStatus.mockRejectedValue(new Error("x"));
    expect((await GET()).status).toBe(502);
  });
});
