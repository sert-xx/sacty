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

  it("キーをクエリで送る窓口（GET）のトークンを付けて転送し、401 で取り直す。失敗の応答にキーの入った URL を出さない（PBI-93）", async () => {
    const key = "FAKE-QKEY+/=&'é";
    const encoded = "FAKE-QKEY%2B%2F%3D%26%27%C3%A9";
    const up = upstream([
      json(200, { token: "ey-old" }),
      json(401, { message: "expired" }),
      json(200, { token: "ey-new" }),
      json(200, { items: [] }),
      new TypeError(`fetch failed: https://auth.example.com/auth/token?v=1&api_token=${encoded}`),
    ]);
    const q = toPlatform(
      "q",
      PlatformFile.parse({
        upstream: "https://q.example.com",
        auth: {
          prefix: "Bearer ",
          token: {
            url: "https://auth.example.com/auth/token?v=1",
            method: "GET",
            query: { api_token: "{{secret}}" },
            secret: "q-key",
            token_path: "token",
          },
        },
        allow: ["GET /api/**"],
      }),
    );
    const credentials = new PlatformCredentials({
      secrets: new MemorySecretStore({ "q-key": key }),
      fetchImpl: up.fetchImpl,
    });
    gateway = new AiGateway({ fetchImpl: up.fetchImpl, platforms: () => [q], credentials });
    const port = await gateway.listen();
    const run = gateway.register();
    const res = await fetch(`http://127.0.0.1:${port}/r/${run.token}/pf/q/api/items`);
    expect(res.status).toBe(200);
    const tokenUrl = `https://auth.example.com/auth/token?v=1&api_token=${encoded}`;
    expect(up.calls.map((c) => c.url)).toEqual([
      tokenUrl,
      "https://q.example.com/api/items",
      tokenUrl,
      "https://q.example.com/api/items",
    ]);
    expect(up.calls[0]?.body).toBe("");
    expect(up.calls[3]?.headers.get("authorization")).toBe("Bearer ey-new");
    // 上流のキーやトークンの窓口の URL は、PF への転送に付けない
    expect(up.calls[3]?.url).not.toContain("api_token");
    // 取り直しの送信が失敗し、その文にキーの入った URL が入っても、エージェントへの応答には出さない
    credentials.invalidate(q);
    const failed = await fetch(`http://127.0.0.1:${port}/r/${run.token}/pf/q/api/items`);
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(text).toContain("api_token=[secret]");
    expect(text).not.toContain("FAKE-QKEY");
    expect(text).not.toContain(encoded);
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

  it("つなげなければ、どの MCP サーバー（mcp.yaml の名前）かを添えて 502 を返す（認証のヘッダーは出さない。PBI-92）", async () => {
    gateway = new AiGateway();
    const port = await gateway.listen();
    const run = gateway.register(undefined, {
      // 閉じたポート（つながらない）
      wiki: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer wiki-secret-92" } },
    });
    const res = await send(port, "/ctx-mcp/wiki", {
      headers: { authorization: `Bearer ${run.token}`, "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(502);
    expect(res.body).toContain('the MCP server \\"wiki\\" could not be reached');
    expect(res.body).not.toContain("wiki-secret-92");
    run.close();
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

describe("単発作業の接続先制限", () => {
  it("選択されたPFだけを通し、原稿作成のトークンと別PF/MCPへのアクセスは拒否する", async () => {
    const up = upstream([json(200, { ok: true })]);
    const platform = (name: string) =>
      toPlatform(
        name,
        PlatformFile.parse({
          upstream: `https://${name}.example.com`,
          auth: { secret: "key" },
          allow: ["GET /**"],
        }),
      );
    gateway = new AiGateway({
      fetchImpl: up.fetchImpl,
      platforms: () => [platform("calendar"), platform("other")],
      credentials: new PlatformCredentials({
        secrets: new MemorySecretStore({ key: "test-value" }),
      }),
    });
    const port = await gateway.listen();
    const execute = gateway.register(undefined, undefined, undefined, {
      platforms: ["calendar"],
      hostMcp: [],
    });
    const draft = gateway.register(undefined, undefined, undefined, {
      platforms: [],
      hostMcp: [],
    });
    const allowed = await fetch(`http://127.0.0.1:${port}/r/${execute.token}/pf/calendar/events`);
    expect(allowed.status).toBe(200);
    for (const [token, name] of [
      [execute.token, "other"],
      [draft.token, "calendar"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/r/${token}/pf/${name}/events`);
      expect(response.status).toBe(403);
    }
    const mcp = await fetch(`http://127.0.0.1:${port}/mcp/other`, {
      headers: { authorization: `Bearer ${execute.token}` },
    });
    expect(mcp.status).toBe(403);
    expect(up.calls).toHaveLength(1);
  });
});

describe("受け取る本文の上限（PBI-132）", () => {
  // ブロックを 1 バイトにして、合計に数える量を受け取った量と同じにする（ブロックの数え方は、別のテストで確かめる）
  const LIMITS = { perRequest: 100, total: 250, block: 1 };

  /** 本文を送る（chunked か Content-Length か、決めた量を決めた回数に分けて）。応答の状態と本文を返す。 */
  function post(
    port: number,
    path: string,
    token: string,
    options: { chunks: number[]; contentLength?: number; keepOpen?: boolean },
  ) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(options.contentLength !== undefined
              ? { "content-length": String(options.contentLength) }
              : {}),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      // 断られて接続を切られても、送る側のエラーにしない（応答を読む）
      req.on("error", (error) => {
        if (!req.writableEnded) reject(error);
      });
      // 本文を書く前でもヘッダーを送る（本文を送らないまま待つ要求のため）
      req.flushHeaders();
      for (const size of options.chunks) req.write("x".repeat(size));
      if (!options.keepOpen) req.end();
    });
  }

  /** 1 つめの上流の呼び出しを、release を呼ぶまで返さない上流。 */
  function heldUpstream() {
    const bodies: number[] = [];
    let release = () => {};
    let first = true;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(Buffer.from(init.body as Uint8Array).length);
      if (first) {
        first = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return json(200, { ok: true });
    }) as typeof fetch;
    return { fetchImpl, bodies, release: () => release() };
  }

  async function startAi(fetchImpl: typeof fetch) {
    gateway = new AiGateway({ fetchImpl, bodyLimits: LIMITS, sleep: async () => {} });
    const port = await gateway.listen();
    const run = gateway.register({ base: "https://ai.example.com/v1", apiKey: "k" });
    return { port, run, path: "/openai/v1/responses" };
  }

  it("Content-Length が上限を超えていれば、本文を読む前に 413 で断り、上流に送らない", async () => {
    const up = upstream([]);
    const g = await startAi(up.fetchImpl);
    // 宣言だけ大きく、本文は送らないまま待つ（読む前に断るので、本文の終わりを待たない）
    const res = await post(g.port, g.path, g.run.token, {
      chunks: [],
      contentLength: 1_000_000,
      keepOpen: true,
    });
    expect(res.status).toBe(413);
    expect(res.body).toContain("larger than the limit (100 bytes)");
    expect(up.calls).toHaveLength(0);
  });

  it("Content-Length が無い（chunked）ときも、受け取った量が上限を超えたら 413 で断る", async () => {
    const up = upstream([]);
    const g = await startAi(up.fetchImpl);
    const res = await post(g.port, g.path, g.run.token, { chunks: [60, 60] });
    expect(res.status).toBe(413);
    expect(up.calls).toHaveLength(0);
  });

  it("ちょうど上限は中継し、1 バイト多ければ断る（Content-Length あり・なしとも）", async () => {
    const up = upstream([json(200, { ok: 1 }), json(200, { ok: 2 })]);
    const g = await startAi(up.fetchImpl);
    const send = (chunks: number[], contentLength?: number) =>
      post(g.port, g.path, g.run.token, {
        chunks,
        ...(contentLength !== undefined ? { contentLength } : {}),
      });
    expect((await send([100], 100)).status).toBe(200);
    expect((await send([50, 50])).status).toBe(200);
    expect(up.calls.map((c) => c.body.length)).toEqual([100, 100]);
    expect((await send([101], 101)).status).toBe(413);
    expect((await send([50, 51])).status).toBe(413);
    expect(up.calls).toHaveLength(2);
  });

  it("同時に受け取っている合計が上限を超えたら 503 で断り、応答を返し終えたら、その分を空ける", async () => {
    const up = heldUpstream();
    const g = await startAi(up.fetchImpl);
    // 1 つめ（100）は、上流で止まっている間も数える
    const first = post(g.port, g.path, g.run.token, { chunks: [100] });
    await expect.poll(() => up.bodies.length).toBe(1);
    expect(gateway?.bodiesInUse()).toBe(100);
    // 2 つめ（100）は、本文の途中で止めておく（受け取って数えたことを確かめてから、次を送る。PR #144 レビュー提案）
    post(g.port, g.path, g.run.token, { chunks: [100], keepOpen: true }).catch(() => {});
    await expect.poll(() => gateway?.bodiesInUse()).toBe(200);
    // 合計の上限 250 を超える（100 + 100 + 60）
    const third = await post(g.port, g.path, g.run.token, { chunks: [60] });
    expect(third.status).toBe(503);
    expect(third.body).toContain("Retry later");
    up.release();
    expect((await first).status).toBe(200);
    // 1 つめを返し終えたので、その分が空く（100 + 100 で受け取れる）
    expect((await post(g.port, g.path, g.run.token, { chunks: [100] })).status).toBe(200);
  });

  it("断った本文・途中で切れた本文の分は、合計に残さない", async () => {
    const up = upstream(Array.from({ length: 3 }, () => json(200, { ok: true })));
    const g = await startAi(up.fetchImpl);
    for (let i = 0; i < 5; i++) {
      expect((await post(g.port, g.path, g.run.token, { chunks: [90, 90] })).status).toBe(413);
    }
    // 本文の途中で接続を切る
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const req = request({
          host: "127.0.0.1",
          port: g.port,
          path: g.path,
          method: "POST",
          headers: { authorization: `Bearer ${g.run.token}`, "content-length": "100" },
        });
        req.on("error", () => {});
        req.write("x".repeat(80));
        // ゲートウェイが受け取って数えたことを確かめてから切る（PR #144 レビュー提案）
        expect
          .poll(() => gateway?.bodiesInUse())
          .toBe(80)
          .then(() => {
            req.destroy();
            resolve();
          });
      });
      // 切った分を空ける
      await expect.poll(() => gateway?.bodiesInUse()).toBe(0);
    }
    // 合計の上限（250）に近い量を、同時に受け取れる
    const a = post(g.port, g.path, g.run.token, { chunks: [100] });
    const b = post(g.port, g.path, g.run.token, { chunks: [100] });
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });

  it("細かい chunk を大量に送られても、確保したブロックの大きさで数え、持つメモリーを抑える（PR #144 レビュー指摘）", async () => {
    const up = upstream([json(200, { ok: true })]);
    // ブロックは 16 バイト、合計は 40 バイト（ブロック 2 つと半分）
    gateway = new AiGateway({
      fetchImpl: up.fetchImpl,
      bodyLimits: { perRequest: 1000, total: 40, block: 16 },
      sleep: async () => {},
    });
    const port = await gateway.listen();
    const run = gateway.register({ base: "https://ai.example.com/v1", apiKey: "k" });
    const path = "/openai/v1/responses";
    // 1 バイトずつ 20 回：受け取ったのは 20 バイトでも、ブロック 2 つ（32）を数える
    const open = request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { authorization: `Bearer ${run.token}` },
    });
    open.on("error", () => {});
    for (let i = 0; i < 20; i++) open.write("x");
    await expect.poll(() => gateway?.bodiesInUse()).toBe(32);
    // 1 バイトの要求でも、新しいブロック（16）が合計（40）に収まらないので断る
    expect((await post(port, path, run.token, { chunks: [1] })).status).toBe(503);
    expect(gateway.bodiesInUse()).toBe(32);
    // 細かく届いた本文も、欠けずにつながって上流に届く（ブロックの残りは付けない）
    open.end("z");
    await expect.poll(() => up.calls.length).toBe(1);
    expect(up.calls[0]?.body).toBe(`${"x".repeat(20)}z`);
    await expect.poll(() => gateway?.bodiesInUse()).toBe(0);
  });

  it("組織内 PF・コンテキストの MCP・ホストの MCP の中継でも、上限を超えたら 413 で断る", async () => {
    const up = upstream([]);
    const ticket = toPlatform(
      "ticket",
      PlatformFile.parse({
        upstream: "https://ticket.example.com",
        auth: { header: "X-Token", secret: "t" },
        allow: ["POST /api/**"],
      }),
    );
    const handled: string[] = [];
    gateway = new AiGateway({
      fetchImpl: up.fetchImpl,
      bodyLimits: LIMITS,
      platforms: () => [ticket],
      credentials: new PlatformCredentials({
        secrets: new MemorySecretStore({ t: "secret" }),
        fetchImpl: up.fetchImpl,
      }),
      hostMcp: {
        handle: async (name: string) => {
          handled.push(name);
          return { status: 200, body: {} };
        },
      } as never,
    });
    const port = await gateway.listen();
    const run = gateway.register(undefined, {
      docs: { url: "https://mcp.example.com/mcp", headers: {} },
    });
    for (const path of [`/r/${run.token}/pf/ticket/api/x`, "/ctx-mcp/docs", "/mcp/notes"]) {
      expect((await post(port, path, run.token, { chunks: [101] })).status).toBe(413);
    }
    expect(up.calls).toHaveLength(0);
    expect(handled).toEqual([]);
  });

  it("Expect: 100-continue を付けた要求（curl の大きな本文）も中継し、上流には expect を送らない", async () => {
    const up = upstream([json(200, { ok: true })]);
    const g = await startAi(up.fetchImpl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: g.port,
          path: g.path,
          method: "POST",
          headers: {
            authorization: `Bearer ${g.run.token}`,
            "content-length": "50",
            expect: "100-continue",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.on("continue", () => req.end("x".repeat(50)));
    });
    expect(status).toBe(200);
    expect(up.calls[0]?.headers.get("expect")).toBeNull();
    expect(up.calls[0]?.body).toHaveLength(50);
  });
});

describe("GitHub の読み取りの中継", () => {
  async function startGitHub(
    responses: Parameters<typeof upstream>[0],
    accounts: Record<string, string> = { "github.com": "me", "ghe.example.co.jp": "me-corp" },
  ) {
    const up = upstream(responses);
    const tokens: string[] = [];
    gateway = new AiGateway({
      fetchImpl: up.fetchImpl,
      githubToken: async (host, account) => {
        tokens.push(`${host}/${account}`);
        if (account === "logged-out") throw new Error("not signed in");
        return `ghp_${account}`;
      },
    });
    const port = await gateway.listen();
    const run = gateway.register(undefined, undefined, undefined, undefined, accounts);
    const base = `http://127.0.0.1:${port}/r/${run.token}/github`;
    return { ...up, tokens, run, port, base };
  }

  it("REST の GET を、そのホストに選んだアカウントのトークンを付けて API に送る（エージェントの認証は送らない）", async () => {
    const g = await startGitHub([
      json(200, [{ id: 1 }], {
        link: '<https://api.github.com/repos/o/r/pulls/1/comments?page=2>; rel="next"',
      }),
      json(200, { id: 2 }),
    ]);
    const res = await fetch(`${g.base}/github.com/repos/o/r/pulls/1/comments?per_page=100`, {
      headers: {
        authorization: "Bearer agent",
        cookie: "c=1",
        "x-github-api-version": "2022-11-28",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1 }]);
    expect(g.calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls/1/comments?per_page=100");
    expect(g.calls[0]?.headers.get("authorization")).toBe("Bearer ghp_me");
    expect(g.calls[0]?.headers.get("cookie")).toBeNull();
    expect(g.calls[0]?.headers.get("x-github-api-version")).toBe("2022-11-28");
    // ページ送りの URL は中継の URL にする（直接 API に送ると、認証が付かない）
    expect(res.headers.get("link")).toBe(
      `<http://host.docker.internal:${g.port}/r/${g.run.token}/github/github.com/repos/o/r/pulls/1/comments?page=2>; rel="next"`,
    );
    // GitHub Enterprise Server は /api/v3。トークンはホストとアカウントごと
    await fetch(`${g.base}/ghe.example.co.jp/repos/o/r`);
    expect(g.calls[1]?.url).toBe("https://ghe.example.co.jp/api/v3/repos/o/r");
    expect(g.calls[1]?.headers.get("authorization")).toBe("Bearer ghp_me-corp");
    expect(g.tokens).toEqual(["github.com/me", "ghe.example.co.jp/me-corp"]);
  });

  it("トークンは実行の間だけ使い回す", async () => {
    const g = await startGitHub([json(200, {}), json(200, {})]);
    await fetch(`${g.base}/github.com/user`);
    await fetch(`${g.base}/github.com/user`);
    expect(g.tokens).toEqual(["github.com/me"]);
  });

  it("GraphQL は query だけを送り、mutation は断る", async () => {
    const g = await startGitHub([json(200, { data: { viewer: { login: "me" } } })]);
    const ok = await fetch(`${g.base}/github.com/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { login } }" }),
    });
    expect(ok.status).toBe(200);
    expect(g.calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(g.calls[0]?.headers.get("authorization")).toBe("Bearer ghp_me");
    const mutation = await fetch(`${g.base}/github.com/graphql`, {
      method: "POST",
      body: JSON.stringify({
        query: 'mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }',
      }),
    });
    expect(mutation.status).toBe(403);
    expect(g.calls).toHaveLength(1);
  });

  it("GraphQL の本文は 256 KiB を超えたら、受け取り終える前に断る（Content-Length でも chunked でも）", async () => {
    const g = await startGitHub([]);
    const big = JSON.stringify({ query: `{ viewer { login } } ${"#".repeat(300 * 1024)}` });
    const declared = await fetch(`${g.base}/github.com/graphql`, { method: "POST", body: big });
    expect(declared.status).toBe(413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const chunked = await fetch(`${g.base}/github.com/graphql`, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(g.calls).toHaveLength(0);
    expect(gateway?.bodiesInUse()).toBe(0);
  });

  it("書き込み・知らないホスト・おかしなパス・知らないトークンは、上流に送らずに断る", async () => {
    const g = await startGitHub([]);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const res = await fetch(`${g.base}/github.com/repos/o/r/issues/1/comments`, {
        method,
        body: "{}",
      });
      expect(res.status).toBe(405);
    }
    expect((await fetch(`${g.base}/github.com/graphql`)).status).toBe(405);
    const unknown = await fetch(`${g.base}/other.example.com/repos/o/r`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("github.com, ghe.example.co.jp");
    // fetch はパスの %2e%2e をまとめてしまうので、そのまま送る
    const raw = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: g.port, method: "GET", path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await raw(`/r/${g.run.token}/github/github.com/repos/o/r/%2e%2e/x`)).toBe(400);
    expect(await raw(`/r/${g.run.token}/github/github.com/repos/o/r/../../x`)).toBe(400);
    expect(
      (await fetch(`http://127.0.0.1:${g.port}/r/sacty-gw-unknown/github/github.com/user`)).status,
    ).toBe(401);
    g.run.close();
    expect((await fetch(`${g.base}/github.com/user`)).status).toBe(401);
    expect(g.calls).toHaveLength(0);
  });

  it("アカウントを選んでいない実行・トークンを取り出せないときは、理由を返す", async () => {
    const none = await startGitHub([], {});
    expect((await fetch(`${none.base}/github.com/user`)).status).toBe(404);
    await gateway?.close();
    const g = await startGitHub([], { "github.com": "logged-out" });
    const res = await fetch(`${g.base}/github.com/user`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("logged-out");
  });
});
