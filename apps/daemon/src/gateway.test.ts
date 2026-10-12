import { afterEach, describe, expect, it } from "vitest";
import { AiGateway, type GatewayDeps, type RetryPolicy, retryAfterMs } from "./gateway.js";

/** 上流の偽物。呼ばれるたびに、決めた順に応答を返す（Error なら接続の失敗）。 */
function upstream(responses: (Response | Error | (() => Response))[]) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: new Headers(init.headers),
      body: init.body ? Buffer.from(init.body as Uint8Array).toString() : "",
    });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

let gateway: AiGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function start(
  responses: Parameters<typeof upstream>[0],
  policy: RetryPolicy = { maxAttempts: 8, maxWaitMs: 600_000 },
  extra: GatewayDeps = {},
) {
  const up = upstream(responses);
  const waits: number[] = [];
  gateway = new AiGateway({
    policy: () => policy,
    fetchImpl: up.fetchImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 1,
    ...extra,
  });
  const port = await gateway.listen();
  const run = gateway.register({
    origin: "https://bedrock-runtime.us-east-2.amazonaws.com",
    apiKey: "ABSK-real-key",
  });
  const call = (token = run.token, path = "/openai/v1/responses", init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "global.openai.gpt-6-sol" }),
      ...init,
    });
  return { ...up, waits, run, call, port };
}

describe("ホストのゲートウェイ（PBI-37）", () => {
  it("実行ごとのトークンを、本物の API キーに差し替えて上流に転送する（コンテナには API キーを渡さない）", async () => {
    const g = await start([json(200, { output: "ok" })]);
    const res = await g.call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ output: "ok" });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]?.url).toBe(
      "https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1/responses",
    );
    expect(g.calls[0]?.headers.get("authorization")).toBe("Bearer ABSK-real-key");
    expect(g.calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(g.calls[0]?.body).toBe('{"model":"global.openai.gpt-6-sol"}');
    expect(gateway?.containerOrigin()).toBe(`http://host.docker.internal:${g.port}`);
    expect(g.run.stats()).toEqual({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false });
  });

  it("知らないトークン・終わった実行・OpenAI 互換の API 以外のパスは受け付けない", async () => {
    const g = await start([]);
    expect((await g.call("sacty-gw-unknown")).status).toBe(401);
    expect((await g.call(g.run.token, "/admin")).status).toBe(404);
    g.run.close();
    const closed = await g.call();
    expect(closed.status).toBe(401);
    expect(await closed.text()).toContain("unknown or expired run token");
    expect(g.calls).toHaveLength(0);
  });

  it("429 は Retry-After に従って待ってリトライし、無ければ1秒から倍にして待つ。5xx・接続の失敗もリトライする", async () => {
    const g = await start([
      json(429, { message: "Too many requests" }, { "retry-after": "7" }),
      json(429, { message: "Too many requests" }),
      json(503, { message: "unavailable" }),
      new Error("ECONNRESET"),
      json(200, { output: "ok" }),
    ]);
    const res = await g.call();
    expect(res.status).toBe(200);
    expect(g.calls).toHaveLength(5);
    expect(g.waits).toEqual([7_000, 2_000, 4_000, 8_000]);
    expect(g.run.stats()).toEqual({
      retries: 4,
      waitedMs: 21_000,
      statuses: [429, 503, 0],
      gaveUp: false,
    });
  });

  it("リトライしない失敗（400 など）は、そのまま返す", async () => {
    const g = await start([json(400, { message: "bad request" })]);
    const res = await g.call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "bad request" });
    expect(g.calls).toHaveLength(1);
  });

  it("回数の上限に達したら、レート制限であきらめたことが分かる文で返す", async () => {
    const g = await start(
      [
        json(429, { message: "ThrottlingException" }),
        json(429, { message: "ThrottlingException" }),
      ],
      { maxAttempts: 2, maxWaitMs: 600_000 },
    );
    const res = await g.call();
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).toContain("gave up after 2 attempt(s)");
    expect(text).toContain("429 (rate limited)");
    expect(text).toContain("ThrottlingException");
    expect(g.run.stats()).toMatchObject({ retries: 1, gaveUp: true });
  });

  it("待ち時間の上限は一続きの失敗で数え、上限の後のやり直しは待たずに1回だけ転送する。成功すると数え直す", async () => {
    const g = await start(
      [
        json(429, {}, { "retry-after": "30" }),
        json(429, {}, { "retry-after": "30" }),
        json(429, {}, { "retry-after": "30" }),
        // エージェント自身のやり直し：待たずに1回だけ
        json(429, {}, { "retry-after": "30" }),
        // 上流が戻った
        json(200, { output: "ok" }),
        // 成功の後は、また待ってリトライする
        json(429, {}, { "retry-after": "30" }),
        json(200, { output: "ok" }),
      ],
      { maxAttempts: 10, maxWaitMs: 60_000 },
    );
    expect((await g.call()).status).toBe(429);
    expect(g.waits).toEqual([30_000, 30_000]);
    expect(g.calls).toHaveLength(3);
    expect((await g.call()).status).toBe(429);
    expect(g.calls).toHaveLength(4);
    expect(g.waits).toHaveLength(2);
    expect((await g.call()).status).toBe(200);
    expect((await g.call()).status).toBe(200);
    expect(g.waits).toEqual([30_000, 30_000, 30_000]);
  });

  it("回数の上限であきらめた後も、成功するまでのやり直しは待たずに1回だけ転送する", async () => {
    const g = await start(
      [
        json(429, {}, { "retry-after": "30" }),
        json(429, {}, { "retry-after": "30" }),
        // エージェント自身のやり直し（待ち時間はまだ上限の手前でも、もう待たない）
        json(429, {}, { "retry-after": "30" }),
      ],
      { maxAttempts: 2, maxWaitMs: 600_000 },
    );
    expect((await g.call()).status).toBe(429);
    expect(g.waits).toEqual([30_000]);
    expect((await g.call()).status).toBe(429);
    expect(g.waits).toEqual([30_000]);
    expect(g.calls).toHaveLength(3);
  });

  it("応答はストリーミングのまま返し、返し始めた後はリトライしない", async () => {
    const encoder = new TextEncoder();
    let pull: (() => void) | undefined;
    const g = await start([
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: one\n\n"));
              pull = () => {
                controller.enqueue(encoder.encode("data: two\n\n"));
                controller.close();
              };
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ]);
    const res = await g.call();
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    const first = await reader?.read();
    // 上流がまだ続きを送っていなくても、届いた分はすぐ返す
    expect(new TextDecoder().decode(first?.value)).toBe("data: one\n\n");
    pull?.();
    let rest = "";
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toBe("data: two\n\n");
    expect(g.calls).toHaveLength(1);
  });

  it("待っている間にコンテナとの接続が切れたら（一時停止・中止）、待つのもリトライもやめる", async () => {
    let waiting: (() => void) | undefined;
    const started = Promise.withResolvers<void>();
    const g = await start([json(429, {}, { "retry-after": "600" })], undefined, {
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          waiting = resolve;
          started.resolve();
          signal.addEventListener("abort", () => resolve());
        }),
    });
    const aborter = new AbortController();
    const pending = g.call(g.run.token, "/openai/v1/responses", { signal: aborter.signal });
    await started.promise;
    aborter.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    // 接続が切れた後に、上流へ送り直していない
    expect(g.calls).toHaveLength(1);
    waiting?.();
  });

  it("Retry-After は秒と HTTP の日時を読む", () => {
    expect(retryAfterMs("12", 0)).toBe(12_000);
    expect(retryAfterMs(new Date(5_000).toUTCString(), 1_000)).toBe(4_000);
    expect(retryAfterMs("soon", 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });
});
