import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/i18n/server", async () => {
  const { messagesFor } = await import("@/i18n");
  return { getMessages: async () => messagesFor("ja") };
});

const { listTasks } = await import("./daemon");
const { liveResponse } = await import("./live-server");
const { LIVE_SERVER_TIMEOUT_MS } = await import("./daemon-signal");

// デーモンが応答しない（中断されるまで終わらない）
const signals: AbortSignal[] = [];
function hangingDaemon() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (!signal) return; // 中断が渡らなければ、いつまでも終わらない
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ),
  );
}

describe("画面の取り直しから、デーモンへの問い合わせに中断と期限を渡す（PR #119 再レビュー指摘）", () => {
  beforeEach(() => {
    signals.length = 0;
    vi.stubEnv("SACTY_DAEMON_URL", "http://127.0.0.1:1");
    vi.stubEnv("SACTY_DAEMON_TOKEN", "test-token");
    hangingDaemon();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("ブラウザが打ち切ったら、デーモンへの問い合わせも止め、unavailable を返す", async () => {
    const controller = new AbortController();
    const reply = liveResponse(
      new Request("http://web/live/tasks", { signal: controller.signal }),
      () => listTasks(),
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();
    expect(await (await reply).json()).toEqual({ unavailable: true });
    expect(signals[0]?.aborted).toBe(true);
  });

  it("ブラウザが打ち切らなくても、画面のサーバーの期限で止める", async () => {
    vi.useFakeTimers();
    const reply = liveResponse(new Request("http://web/live/tasks"), () => listTasks());
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_SERVER_TIMEOUT_MS - 1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await reply).json()).toEqual({ unavailable: true });
    expect(signals[0]?.aborted).toBe(true);
  });
});
