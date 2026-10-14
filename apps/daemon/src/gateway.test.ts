import { request } from "node:http";
import { connect } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import {
  AiGateway,
  contextMcpDispatcher,
  FETCH_DEFAULT_TIMEOUT_MS,
  type GatewayDeps,
  type RetryPolicy,
  retryAfterMs,
  sentUrl,
} from "./gateway.js";
import { PlatformCredentials, PlatformFile, toPlatform } from "./platforms.js";
import { MemorySecretStore } from "./secrets.js";

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
    base: "https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1",
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

  it("転送先の起点の下に送り、API キーが無い接続先には認証を付けない（組織の AI gateway。PBI-40）", async () => {
    const up = upstream([json(200, { output: "ok" })]);
    gateway = new AiGateway({ fetchImpl: up.fetchImpl });
    const port = await gateway.listen();
    const run = gateway.register({ base: "https://ai-gw.example.com/llm/v1" });
    const res = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${run.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(up.calls[0]?.url).toBe("https://ai-gw.example.com/llm/v1/responses");
    // エージェントが付けた（実行のトークンの）認証は、上流に送らない
    expect(up.calls[0]?.headers.get("authorization")).toBeNull();
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

  it("本文を受け取り終える前に接続が切れても、デーモンは終わらず、次のリクエストを受け付ける（レビュー指摘）", async () => {
    const g = await start([json(200, { output: "ok" })]);
    const socket = connect(g.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      [
        "POST /openai/v1/responses HTTP/1.1",
        "Host: 127.0.0.1",
        `Authorization: Bearer ${g.run.token}`,
        "Content-Type: application/json",
        "Content-Length: 10000",
        "",
        "{",
      ].join("\r\n"),
    );
    await new Promise((r) => setTimeout(r, 50));
    socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    // 途中で切れたリクエストは、上流に送っていない
    expect(g.calls).toHaveLength(0);
    const res = await g.call();
    expect(res.status).toBe(200);
    expect(g.calls).toHaveLength(1);
  });

  it("Retry-After は秒と HTTP の日時を読む", () => {
    expect(retryAfterMs("12", 0)).toBe(12_000);
    expect(retryAfterMs(new Date(5_000).toUTCString(), 1_000)).toBe(4_000);
    expect(retryAfterMs("soon", 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });
});

describe("組織内 PF の API の中継（PBI-35）", () => {
  const ticket = toPlatform(
    "ticket",
    PlatformFile.parse({
      upstream: "https://ticket.internal.example.com",
      auth: { header: "X-Internal-Token", secret: "ticket-token" },
      allow: ["GET /api/v1/tickets/**", "POST /api/v1/tickets/*/comments"],
    }),
  );
  const deploy = toPlatform(
    "deploy",
    PlatformFile.parse({
      upstream: "https://deploy.internal.example.com",
      auth: {
        prefix: "Bearer ",
        token: {
          url: "https://auth.internal.example.com/token",
          json: { apiKey: "{{secret}}" },
          secret: "deploy-key",
          token_path: "token",
        },
      },
      allow: ["GET /api/**"],
    }),
  );

  async function startPf(responses: Parameters<typeof upstream>[0]) {
    const up = upstream(responses);
    const credentials = new PlatformCredentials({
      secrets: new MemorySecretStore({ "ticket-token": "tkt-secret", "deploy-key": "dk" }),
      fetchImpl: up.fetchImpl,
    });
    gateway = new AiGateway({
      fetchImpl: up.fetchImpl,
      platforms: () => [ticket, deploy],
      credentials,
    });
    const port = await gateway.listen();
    const run = gateway.register();
    const base = `http://127.0.0.1:${port}/r/${run.token}/pf`;
    return { ...up, run, base, port };
  }

  it("ホワイトリストに合うリクエストだけを、PF の認証を付けて転送する（エージェントが付けた認証・クッキーは捨てる）", async () => {
    const g = await startPf([json(200, { id: 42 }), json(201, { ok: true })]);
    expect(gateway?.platformsUrl(g.run.token)).toBe(
      `http://host.docker.internal:${g.port}/r/${g.run.token}/pf`,
    );
    const got = await fetch(`${g.base}/ticket/api/v1/tickets/42?expand=1`, {
      headers: { "x-internal-token": "agent-made-up", cookie: "a=b", accept: "application/json" },
    });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ id: 42 });
    expect(g.calls[0]?.url).toBe("https://ticket.internal.example.com/api/v1/tickets/42?expand=1");
    expect(g.calls[0]?.headers.get("x-internal-token")).toBe("tkt-secret");
    expect(g.calls[0]?.headers.get("cookie")).toBeNull();
    expect(g.calls[0]?.headers.get("accept")).toBe("application/json");
    const posted = await fetch(`${g.base}/ticket/api/v1/tickets/42/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "調べました" }),
    });
    expect(posted.status).toBe(201);
    expect(g.calls[1]?.body).toBe('{"text":"調べました"}');
  });

  it("ホワイトリストに無い・知らない PF・知らないトークンは、上流に送らずに拒否する", async () => {
    const g = await startPf([]);
    const denied = await fetch(`${g.base}/ticket/api/v1/users`);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain(
      'GET /api/v1/users is not allowed for \\"ticket\\". Allowed: GET /api/v1/tickets/**, POST /api/v1/tickets/*/comments',
    );
    expect((await fetch(`${g.base}/ticket/api/v1/tickets/42`, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await fetch(`${g.base}/unknown/api`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${g.port}/r/sacty-gw-unknown/pf/ticket/api/v1/tickets/1`))
        .status,
    ).toBe(401);
    g.run.close();
    expect((await fetch(`${g.base}/ticket/api/v1/tickets/1`)).status).toBe(401);
    expect(g.calls).toHaveLength(0);
  });

  it("# など URL として解釈すると変わるパスは、許可の判定をすり抜けられず、上流に一切送らない（レビュー指摘）", async () => {
    const g = await startPf([json(200, {})]);
    // fetch は # を落とすので、node:http で生のパスを送る
    const raw = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: g.port, method: "POST", path }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end("{}");
      });
    const base = `/r/${g.run.token}/pf/ticket`;
    const fragment = await raw(`${base}/api/v1/tickets/123#x/comments`);
    expect(fragment.status).toBe(400);
    expect(fragment.body).toContain("changes when sent as a URL");
    expect((await raw(`${base}/api/v1/tickets/123/./comments`)).status).not.toBe(200);
    expect((await raw(`${base}/api/v1/tickets/123/comments?a=1#frag`)).status).toBe(400);
    expect(g.calls).toHaveLength(0);
  });

  it("送る URL は、パス・クエリが URL として変わらないときだけ作る", () => {
    const up = "https://ticket.example.com";
    expect(sentUrl(up, "/api/v1/tickets/1", "?a=1")).toBe(
      "https://ticket.example.com/api/v1/tickets/1?a=1",
    );
    expect(sentUrl("https://ex.com/base", "/api/x", "")).toBe("https://ex.com/base/api/x");
    expect(sentUrl(up, "/api/1#x/comments", "")).toBeUndefined();
    expect(sentUrl(up, "/api/./x", "")).toBeUndefined();
    expect(sentUrl(up, "/api/../x", "")).toBeUndefined();
    expect(sentUrl(up, "/api/x", "?a=1#f")).toBeUndefined();
    expect(sentUrl(up, "/api/x y", "")).toBeUndefined();
  });

  it("トークンを取得する PF は、拒否（401）されたらトークンを取り直して1回だけ送り直す", async () => {
    const g = await startPf([
      json(200, { token: "jwt-old" }),
      json(401, { message: "expired" }),
      json(200, { token: "jwt-new" }),
      json(200, { deployments: [] }),
    ]);
    const res = await fetch(`${g.base}/deploy/api/v1/deployments`);
    expect(res.status).toBe(200);
    expect(g.calls.map((c) => c.url)).toEqual([
      "https://auth.internal.example.com/token",
      "https://deploy.internal.example.com/api/v1/deployments",
      "https://auth.internal.example.com/token",
      "https://deploy.internal.example.com/api/v1/deployments",
    ]);
    expect(g.calls[1]?.headers.get("authorization")).toBe("Bearer jwt-old");
    expect(g.calls[3]?.headers.get("authorization")).toBe("Bearer jwt-new");
  });

  it("トークンの取得に失敗しても、ゲートウェイの応答に秘密情報を出さない（レビュー指摘）", async () => {
    const up = upstream([]);
    const bad = toPlatform(
      "bad",
      PlatformFile.parse({
        upstream: "https://bad.example.com",
        auth: {
          token: {
            url: "https://auth.example.com/token",
            headers: { "X-Key": "{{secret}}" },
            secret: "bad-key",
            token_path: "token",
          },
        },
        allow: ["GET /**"],
      }),
    );
    gateway = new AiGateway({
      fetchImpl: up.fetchImpl,
      platforms: () => [bad],
      credentials: new PlatformCredentials({
        secrets: new MemorySecretStore({ "bad-key": "FAKE-SECRET\nBAD" }),
        fetchImpl: up.fetchImpl,
      }),
    });
    const port = await gateway.listen();
    const run = gateway.register();
    const res = await fetch(`http://127.0.0.1:${port}/r/${run.token}/pf/bad/x`);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("[secret]");
    expect(text).not.toContain("FAKE-SECRET");
    expect(up.calls).toHaveLength(0);
  });

  it("認証情報を用意できなければ、理由を返して上流に送らない", async () => {
    const g = await startPf([json(500, { message: "auth down" })]);
    const res = await fetch(`${g.base}/deploy/api/v1/deployments`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('cannot prepare the credentials for \\"deploy\\"');
    expect(g.calls.map((c) => c.url)).toEqual(["https://auth.internal.example.com/token"]);
  });
});

describe("プロジェクトのコンテキストの外部 PF の中継（PBI-74）", () => {
  const pf = (name: string, upstream: string, secret: string, from?: string) => ({
    ...toPlatform(
      name,
      PlatformFile.parse({
        upstream,
        auth: { prefix: "Bearer ", secret },
        allow: ["GET /api/**"],
      }),
    ),
    ...(from ? { from } : {}),
  });
  const host = pf("shared", "https://host.example.com", "host-token");

  async function startCtx(responses: Parameters<typeof upstream>[0], secrets = {}) {
    const up = upstream(responses);
    const credentials = new PlatformCredentials({
      secrets: new MemorySecretStore({
        "host-token": "host-secret-value",
        "a-token": "a-secret-value",
        "b-token": "b-secret-value",
        ...secrets,
      }),
      fetchImpl: up.fetchImpl,
    });
    gateway = new AiGateway({ fetchImpl: up.fetchImpl, platforms: () => [host], credentials });
    const port = await gateway.listen();
    const url = (token: string, path: string) => `http://127.0.0.1:${port}/r/${token}/pf${path}`;
    return { ...up, port, url, credentials };
  }

  it("実行に登録したコンテキストの PF だけを、その実行のトークンで使える（ほかのプロジェクトの実行のトークンでは使えない）", async () => {
    const g = await startCtx([json(200, { from: "a" }), json(200, { from: "host" })]);
    const a = gateway?.register(undefined, undefined, [
      pf("a-pf", "https://a.example.com", "a-token", "acme/a-ctx@c0ffee0"),
    ]);
    const b = gateway?.register(undefined, undefined, [
      pf("b-pf", "https://b.example.com", "b-token", "acme/b-ctx@c0ffee0"),
    ]);
    const none = gateway?.register();
    if (!a || !b || !none) throw new Error("not registered");
    // 自分のプロジェクトの PF は、秘密情報の名前をホストで値にして付ける
    const ok = await fetch(g.url(a.token, "/a-pf/api/items"));
    expect(ok.status).toBe(200);
    expect(g.calls[0]?.url).toBe("https://a.example.com/api/items");
    expect(g.calls[0]?.headers.get("authorization")).toBe("Bearer a-secret-value");
    // ほかのプロジェクトの PF は、名前を知っていても使えない（上流に送らない）
    const other = await fetch(g.url(b.token, "/a-pf/api/items"));
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain("a.example.com");
    expect((await fetch(g.url(none.token, "/a-pf/api/items"))).status).toBe(404);
    expect((await fetch(g.url(a.token, "/b-pf/api/items"))).status).toBe(404);
    // ホストの PF は、どの実行でも使える
    expect((await fetch(g.url(none.token, "/shared/api/x"))).status).toBe(200);
    expect(g.calls.map((c) => c.url)).toEqual([
      "https://a.example.com/api/items",
      "https://host.example.com/api/x",
    ]);
    // 実行が終われば、そのトークンでは使えない
    a.close();
    expect((await fetch(g.url(a.token, "/a-pf/api/items"))).status).toBe(401);
    expect(g.calls).toHaveLength(2);
  });

  it("ホストの PF と同じ名前なら、実行に登録したものよりホストのものを使う", async () => {
    const g = await startCtx([json(200, {})]);
    const run = gateway?.register(undefined, undefined, [
      pf("shared", "https://evil.example.com", "a-token", "acme/a-ctx@c0ffee0"),
    ]);
    if (!run) throw new Error("not registered");
    expect((await fetch(g.url(run.token, "/shared/api/x"))).status).toBe(200);
    expect(g.calls[0]?.url).toBe("https://host.example.com/api/x");
    expect(g.calls[0]?.headers.get("authorization")).toBe("Bearer host-secret-value");
  });

  it("秘密情報が見つからなければ、どの層のどの PF かを添えて理由を返し、上流に送らない（画面の状態には出さない）", async () => {
    const g = await startCtx([]);
    const run = gateway?.register(undefined, undefined, [
      pf("a-pf", "https://a.example.com", "missing-token", "acme/a-ctx@c0ffee0"),
    ]);
    if (!run) throw new Error("not registered");
    const res = await fetch(g.url(run.token, "/a-pf/api/items"));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain(
      'cannot prepare the credentials for \\"a-pf\\" (platforms.yaml of acme/a-ctx@c0ffee0)',
    );
    expect(text).toContain("missing-token");
    expect(g.calls).toHaveLength(0);
    // プロジェクトごとに同じ名前がありうるので、ホストの PF の状態（画面）には出さない
    expect(g.credentials.unavailable(["a-pf"])).toEqual([]);
  });
});

describe("コンテキストの HTTP の MCP サーバーの中継（PBI-49）", () => {
  /** MCP サーバーの偽物（本物の HTTP）。受けたリクエストを記録し、POST は SSE、GET は SSE、DELETE は 204 を返す。 */
  async function mcpServer() {
    const { createServer } = await import("node:http");
    const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] =
      [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        if (req.url?.startsWith("/redirect")) {
          res.writeHead(302, { location: "https://elsewhere.example.com/steal" });
          return res.end();
        }
        if (req.method === "DELETE") {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n`);
        setTimeout(() => {
          res.write(`event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":2}}\n\n`);
          res.end();
        }, 30);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { url: `http://127.0.0.1:${port}/mcp`, seen, close: () => server.close() };
  }

  async function send(
    port: number,
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method ?? "POST",
      headers: options.headers ?? {},
      ...(options.body ? { body: options.body } : {}),
      redirect: "manual",
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  }

  it("実行のトークンを確かめ、ホストに持った認証を付けて中継する（エージェントの認証・ほかのヘッダーは送らない）", async () => {
    const upstreamMcp = await mcpServer();
    gateway = new AiGateway();
    const port = await gateway.listen();
    const run = gateway.register(undefined, {
      docs: { url: upstreamMcp.url, headers: { Authorization: "Bearer docs-secret" } },
    });
    const res = await send(port, "/ctx-mcp/docs", {
      headers: {
        authorization: `Bearer ${run.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "sess-1",
        "mcp-protocol-version": "2025-06-18",
        cookie: "x=1",
        "x-other": "y",
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(200);
    // SSE の応答とセッションのヘッダーをそのまま返す
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("mcp-session-id")).toBe("sess-1");
    expect(res.body).toContain('"result":{"ok":1}');
    expect(res.body).toContain('"result":{"ok":2}');
    const seen = upstreamMcp.seen[0];
    expect(seen?.url).toBe("/mcp");
    expect(seen?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(seen?.headers.authorization).toBe("Bearer docs-secret");
    expect(seen?.headers["mcp-session-id"]).toBe("sess-1");
    expect(seen?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(seen?.headers.accept).toBe("application/json, text/event-stream");
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers["x-other"]).toBeUndefined();
    expect(JSON.stringify(seen?.headers)).not.toContain(run.token);

    // GET（SSE）・DELETE（セッションの終わり）も中継する。クエリは付け替える
    expect(
      (
        await send(port, "/ctx-mcp/docs?a=1", {
          method: "GET",
          headers: { authorization: `Bearer ${run.token}` },
        })
      ).status,
    ).toBe(200);
    expect(upstreamMcp.seen[1]).toMatchObject({ method: "GET", url: "/mcp?a=1" });
    expect(
      (
        await send(port, "/ctx-mcp/docs", {
          method: "DELETE",
          headers: { authorization: `Bearer ${run.token}` },
        })
      ).status,
    ).toBe(204);
    upstreamMcp.close();
  });

  it("知らないトークン・終わった実行・登録していないサーバーは中継しない。リダイレクトはたどらない", async () => {
    const upstreamMcp = await mcpServer();
    gateway = new AiGateway();
    const port = await gateway.listen();
    const run = gateway.register(undefined, {
      docs: { url: upstreamMcp.url, headers: { Authorization: "Bearer docs-secret" } },
      moved: { url: upstreamMcp.url.replace("/mcp", "/redirect"), headers: { "X-Api-Key": "k" } },
    });
    expect((await send(port, "/ctx-mcp/docs")).status).toBe(401);
    expect(
      (await send(port, "/ctx-mcp/docs", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (await send(port, "/ctx-mcp/other", { headers: { authorization: `Bearer ${run.token}` } }))
        .status,
    ).toBe(404);
    // ほかの実行（MCP を登録していない）のトークンでは使えない
    const other = gateway.register();
    expect(
      (await send(port, "/ctx-mcp/docs", { headers: { authorization: `Bearer ${other.token}` } }))
        .status,
    ).toBe(404);
    const moved = await send(port, "/ctx-mcp/moved", {
      headers: { authorization: `Bearer ${run.token}` },
    });
    expect(moved.status).toBe(302);
    run.close();
    expect(
      (await send(port, "/ctx-mcp/docs", { headers: { authorization: `Bearer ${run.token}` } }))
        .status,
    ).toBe(401);
    // 上流に届いたのは、リダイレクトを返したものだけ
    expect(upstreamMcp.seen.map((s) => s.url)).toEqual(["/redirect"]);
    upstreamMcp.close();
  });

  describe("時間切れ（PBI-75）", () => {
    const headers = (token: string) => ({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });

    it("mcp.yaml の時間切れが fetch の既定（5分）より長ければ、待つ上限を延ばした接続で中継する。短い・無ければこれまでどおり", async () => {
      const long: { url: string; dispatcher: unknown }[] = [];
      const plain: string[] = [];
      gateway = new AiGateway({
        fetchImpl: (async (url: URL) => {
          plain.push(String(url));
          return json(200, { ok: "plain" });
        }) as unknown as typeof fetch,
        longFetchImpl: async (url, init) => {
          long.push({ url: String(url), dispatcher: init.dispatcher });
          return json(200, { ok: "long" });
        },
      });
      const port = await gateway.listen();
      const run = gateway.register(undefined, {
        slow: { url: "https://slow.example.com/mcp", headers: {}, timeoutMs: 1_800_000 },
        edge: { url: "https://edge.example.com/mcp", headers: {}, timeoutMs: 300_000 },
        quick: { url: "https://quick.example.com/mcp", headers: {}, timeoutMs: 60_000 },
        bare: { url: "https://bare.example.com/mcp", headers: {} },
      });
      for (const name of ["slow", "edge", "quick", "bare", "slow"]) {
        const res = await send(port, `/ctx-mcp/${name}`, {
          headers: headers(run.token),
          body: "{}",
        });
        expect(res.status).toBe(200);
      }
      expect(long.map((l) => l.url)).toEqual([
        "https://slow.example.com/mcp",
        "https://slow.example.com/mcp",
      ]);
      // 待つ上限ごとの接続を使い回す
      expect(long[0]?.dispatcher).toBeInstanceOf(Agent);
      expect(long[1]?.dispatcher).toBe(long[0]?.dispatcher);
      expect(plain).toEqual([
        "https://edge.example.com/mcp",
        "https://quick.example.com/mcp",
        "https://bare.example.com/mcp",
      ]);
    });

    it("延ばした接続でも、本物の上流の SSE をそのまま中継する", async () => {
      const upstreamMcp = await mcpServer();
      gateway = new AiGateway();
      const port = await gateway.listen();
      const run = gateway.register(undefined, {
        docs: {
          url: upstreamMcp.url,
          headers: { Authorization: "Bearer s" },
          timeoutMs: 3_600_000,
        },
      });
      const res = await send(port, "/ctx-mcp/docs", {
        headers: headers(run.token),
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.body).toContain('"result":{"ok":2}');
      expect(upstreamMcp.seen[0]?.headers.authorization).toBe("Bearer s");
      // リダイレクトは、延ばした接続でもたどらない（認証のヘッダーをほかの宛先に送らない）
      const moved = gateway.register(undefined, {
        moved: {
          url: upstreamMcp.url.replace("/mcp", "/redirect"),
          headers: { "X-Api-Key": "k" },
          timeoutMs: 3_600_000,
        },
      });
      const redirected = await send(port, "/ctx-mcp/moved", { headers: headers(moved.token) });
      expect(redirected.status).toBe(302);
      expect(upstreamMcp.seen.map((s) => s.url)).toEqual(["/mcp", "/redirect"]);
      upstreamMcp.close();
    });

    it("延ばした接続は、決めた上限まで応答を待ち、それを過ぎたら切る", {
      timeout: 10_000,
    }, async () => {
      const { createServer } = await import("node:http");
      const server = createServer((_req, res) => {
        // undici の待つ上限は、おおよそ1秒の刻みで効く
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }, 1_500);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
      const short = contextMcpDispatcher(50);
      const enough = contextMcpDispatcher(5_000);
      await expect(undiciFetch(url, { dispatcher: short })).rejects.toMatchObject({
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      });
      expect((await undiciFetch(url, { dispatcher: enough })).status).toBe(200);
      await short.close();
      await enough.close();
      server.close();
      expect(FETCH_DEFAULT_TIMEOUT_MS).toBe(300_000);
    });
  });
});
