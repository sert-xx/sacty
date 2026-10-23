import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLive, LIVE_INTERVAL_MS, LIVE_VERSION_HEADER, pollWhileVisible } from "./live";
import { liveResponse, liveVersion } from "./live-server";

/** visibilityState を変えて visibilitychange を送れる document。 */
function fakeDocument(state: DocumentVisibilityState = "visible") {
  const target = new EventTarget();
  const doc = {
    visibilityState: state,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    set(next: DocumentVisibilityState) {
      doc.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return doc;
}

describe("データだけを取り直す間隔（pollWhileVisible。PBI-108）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("間隔は 3 秒で、見えている間は間隔ごとに取り直す（描いた直後は取り直さない）", async () => {
    expect(LIVE_INTERVAL_MS).toBe(3_000);
    const load = vi.fn(async () => {});
    const stop = pollWhileVisible({ doc: fakeDocument(), intervalMs: LIVE_INTERVAL_MS, load });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("前の取り直しが終わるまで、次を始めない（問い合わせを重ねない）", async () => {
    let finish: () => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = pollWhileVisible({ doc: fakeDocument(), intervalMs: 3_000, load });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(1);
    // 応答が遅くても、重ねて問い合わせない
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    // 終わってから間隔を数え直す
    await vi.advanceTimersByTimeAsync(2_999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it("隠れている間は問い合わせず、見えたらすぐに一度取り直す", async () => {
    const doc = fakeDocument();
    const load = vi.fn(async () => {});
    const stop = pollWhileVisible({ doc, intervalMs: 3_000, load });
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).not.toHaveBeenCalled();
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    // その後は、また間隔ごと
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it("隠れた状態で描いた画面も、見えたらすぐに取り直す", async () => {
    const doc = fakeDocument("hidden");
    const load = vi.fn(async () => {});
    const stop = pollWhileVisible({ doc, intervalMs: 3_000, load });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).not.toHaveBeenCalled();
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("取り直しに失敗しても止まらず、次の間隔でまた取り直す（届くようになったら、また更新する）", async () => {
    const load = vi.fn(async () => {
      throw new Error("unreachable");
    });
    const stop = pollWhileVisible({ doc: fakeDocument(), intervalMs: 3_000, load });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
  });
});

describe("取り直しの返事（fetchLive・liveResponse。PBI-108）", () => {
  const reply = (body: unknown, ok = true) =>
    vi.fn(async () => ({ ok, json: async () => body }) as Response);

  it("データがあれば返し、前の版をヘッダーで送る", async () => {
    const fetcher = reply({ data: { n: 1 }, version: "v2" });
    expect(await fetchLive("/live/x", "v1", fetcher as unknown as typeof fetch)).toEqual({
      data: { n: 1 },
      version: "v2",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/live/x",
      expect.objectContaining({ cache: "no-store", headers: { [LIVE_VERSION_HEADER]: "v1" } }),
    );
  });

  it("変わっていないときは今のまま（current）、対象が無いときは missing。届かない・失敗の応答・通信の失敗は failed（更新が止まっていると出す）", async () => {
    expect(await fetchLive("/x", "v", reply({ unchanged: true }) as unknown as typeof fetch)).toBe(
      "current",
    );
    expect(await fetchLive("/x", "v", reply({ missing: true }) as unknown as typeof fetch)).toBe(
      "missing",
    );
    expect(
      await fetchLive("/x", "v", reply({ unavailable: true }) as unknown as typeof fetch),
    ).toBe("failed");
    expect(await fetchLive("/x", "v", reply({}, false) as unknown as typeof fetch)).toBe("failed");
    const broken = vi.fn(async () => {
      throw new TypeError("network");
    });
    expect(await fetchLive("/x", "v", broken as unknown as typeof fetch)).toBe("failed");
  });

  it("401（画面の認証が無い）は、届かないのと分けて signedOut にする（PR #141 レビュー提案）", async () => {
    const fetcher = vi.fn(async () => new Response("<!doctype html>", { status: 401 }));
    expect(await fetchLive("/x", "v", fetcher as unknown as typeof fetch)).toBe("signedOut");
    // ほかの失敗の状態は、これまでどおり failed
    for (const status of [403, 500, 502]) {
      const other = vi.fn(async () => new Response("x", { status }));
      expect(await fetchLive("/x", "v", other as unknown as typeof fetch)).toBe("failed");
    }
  });

  it("応答が無くても期限で打ち切り（中断する）、次の取り直しを続ける（PR #119 レビュー指摘）", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      // 応答しない（中断されるまで終わらない）
      const hanging = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            const signal = init?.signal as AbortSignal;
            signals.push(signal);
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const results: unknown[] = [];
      const stop = pollWhileVisible({
        doc: fakeDocument(),
        intervalMs: 3_000,
        load: async () => {
          results.push(
            await fetchLive("/x", undefined, hanging as unknown as typeof fetch, 10_000),
          );
        },
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(hanging).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signals[0]?.aborted).toBe(true);
      expect(results).toEqual(["failed"]);
      // 期限の後に、次の取り直しを予約している
      await vi.advanceTimersByTimeAsync(3_000);
      expect(hanging).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("本文を読む間に止まっても、期限で打ち切る", async () => {
    vi.useFakeTimers();
    try {
      const stuck = vi.fn(
        async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response,
      );
      const result = fetchLive("/x", undefined, stuck as unknown as typeof fetch, 10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("版が同じなら中身を送らない。デーモンに届かなくても 200 で unavailable を返す（コンソールにエラーを出し続けない）", async () => {
    const data = { tasks: [1, 2] };
    const version = liveVersion(data);
    const same = await liveResponse(
      new Request("http://web/live", { headers: { [LIVE_VERSION_HEADER]: version } }),
      async () => data,
    );
    expect(await same.json()).toEqual({ unchanged: true });
    const changed = await liveResponse(new Request("http://web/live"), async () => data);
    expect(await changed.json()).toEqual({ data, version });
    const down = await liveResponse(new Request("http://web/live"), async () => {
      throw new Error("unreachable");
    });
    expect(down.status).toBe(200);
    expect(await down.json()).toEqual({ unavailable: true });
    const missing = await liveResponse(new Request("http://web/live"), async () => null);
    expect(await missing.json()).toEqual({ missing: true });
  });
});
