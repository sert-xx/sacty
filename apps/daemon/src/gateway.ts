import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * ホストで動かすゲートウェイ（PBI-37）。エージェントのコンテナからの AI の呼び出しを受け、上流（Bedrock）に
 * 本物の API キーを付けて転送し、レート制限（429）や一時的な失敗（5xx）をリトライする。
 *
 * - 127.0.0.1 だけで待ち受け、実行ごとに発行したトークンを持つリクエストだけを受け付ける
 *   （コンテナからは host.docker.internal で届く。ほかのマシンからは届かず、トークンを知らない処理は使えない）
 * - API キーはゲートウェイだけが持ち、コンテナには実行ごとのトークンだけを渡す
 * - 応答を返し始めた後（ストリーミングの途中）の失敗はリトライしない（同じ応答を二重に返さないため）
 * - 待ち時間の上限は、成功するまでの一続きの失敗ごとに数える。上限に達した後は、待たずに1回だけ転送する
 *   （エージェント自身のやり直しで、待ち時間が何倍にも延びないように。成功すると数え直す）
 */

/** リトライの上限。 */
export type RetryPolicy = {
  /** 1件のリクエストで、上流に送る回数の上限（最初の1回を含む）。 */
  maxAttempts: number;
  /** 一続きの失敗で待つ合計の上限（ミリ秒）。 */
  maxWaitMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 8, maxWaitMs: 600_000 };

/** リトライする上流の状態（レート制限と一時的な失敗）。 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
/** Retry-After が無いときの間隔：1秒から倍にしていき、60秒で頭打ち。 */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/** 転送しないリクエストのヘッダー（宛先・認証・長さ・接続。圧縮は上流に任せず、平文で受ける）。 */
const DROP_REQUEST = new Set([
  "host",
  "authorization",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "accept-encoding",
]);
/** 転送しない応答のヘッダー（fetch が展開した後の本文を流すので、長さ・圧縮は付け直させる）。 */
const DROP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

/** 実行ごとの転送先。 */
export type GatewayRoute = {
  /** 上流の起点（例 https://bedrock-runtime.us-east-2.amazonaws.com）。リクエストのパスを足して転送する。 */
  origin: string;
  /** 上流に付ける API キー（Authorization: Bearer）。 */
  apiKey: string;
};

/** 実行ごとのリトライの記録。 */
export type GatewayStats = {
  /** リトライした回数（最初の1回を除く）。 */
  retries: number;
  /** 待った合計（ミリ秒）。 */
  waitedMs: number;
  /** リトライの原因になった上流の状態（重複なし。上流に届かなかったときは 0）。 */
  statuses: number[];
  /** 上限に達して、リトライをあきらめたか。 */
  gaveUp: boolean;
};

type RunState = GatewayRoute & {
  stats: GatewayStats;
  /** いまの一続きの失敗で待った合計。成功すると0に戻る。 */
  streakWaitedMs: number;
};

export type GatewayDeps = {
  /** リトライの上限（設定を読み直せるよう、リクエストごとに呼ぶ）。無ければ既定の上限。 */
  policy?: () => RetryPolicy | undefined;
  fetchImpl?: typeof fetch;
  /** 待つ（止められたら、すぐに終わる）。テストでは差し替える。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 0〜1 の乱数（間隔のゆらぎ）。 */
  random?: () => number;
  now?: () => number;
};

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/** Retry-After（秒か HTTP の日時）を、待つミリ秒にする。読めなければ undefined。 */
export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class AiGateway {
  private server: Server | undefined;
  private port = 0;
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly deps: GatewayDeps = {}) {}

  /** 127.0.0.1 で待ち受ける（port 0 なら空いているポート）。 */
  async listen(port = 0): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : port;
    return this.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** コンテナから見たゲートウェイの起点。 */
  containerOrigin(): string {
    if (!this.server) throw new Error("the gateway is not listening");
    return `http://host.docker.internal:${this.port}`;
  }

  /** 実行の転送先を登録し、その実行だけが使えるトークンを返す。実行が終わったら close する。 */
  register(route: GatewayRoute): { token: string; stats: () => GatewayStats; close: () => void } {
    const token = `sacty-gw-${randomBytes(24).toString("hex")}`;
    const state: RunState = {
      ...route,
      stats: { retries: 0, waitedMs: 0, statuses: [], gaveUp: false },
      streakWaitedMs: 0,
    };
    this.runs.set(token, state);
    return {
      token,
      stats: () => ({ ...state.stats, statuses: [...state.stats.statuses] }),
      close: () => this.runs.delete(token),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization ?? "";
    const run = header.startsWith("Bearer ") ? this.runs.get(header.slice(7)) : undefined;
    if (!run) return fail(res, 401, "sacty gateway: unknown or expired run token");
    if (!req.url?.startsWith("/openai/v1/")) return fail(res, 404, "sacty gateway: not found");

    // コンテナとの接続が切れたら（人間の一時停止・中止でコンテナを止めた）、待つのも転送もやめる
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });
    const body = await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("authorization", `Bearer ${run.apiKey}`);

    const policy = this.deps.policy?.() ?? DEFAULT_RETRY_POLICY;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const sleep = this.deps.sleep ?? abortableSleep;
    const now = this.deps.now ?? Date.now;
    const random = this.deps.random ?? Math.random;
    const url = `${run.origin}${req.url}`;

    for (let attempt = 1; ; attempt++) {
      if (aborter.signal.aborted) return;
      let upstream: Response | undefined;
      let status: number;
      try {
        upstream = await fetchImpl(url, {
          method: req.method ?? "POST",
          headers,
          ...(body.length > 0 ? { body } : {}),
          signal: aborter.signal,
        });
        status = upstream.status;
      } catch (error) {
        if (aborter.signal.aborted) return;
        status = 0;
        upstream = undefined;
        void error;
      }
      if (status >= 200 && status < 300) run.streakWaitedMs = 0;
      const retryable = status === 0 || RETRYABLE.has(status);
      if (!retryable && upstream) return pipe(upstream, res);

      // 待つ時間：Retry-After に従い、無ければ倍にしていく（ゆらぎを入れて、一斉にやり直さない）
      const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
      const wait =
        retryAfterMs(upstream?.headers.get("retry-after") ?? null, now()) ??
        Math.round(backoff * (0.5 + random() / 2));
      const canRetry =
        attempt < policy.maxAttempts && run.streakWaitedMs + wait <= policy.maxWaitMs;
      if (!canRetry) {
        if (attempt > 1 || run.streakWaitedMs > 0) run.stats.gaveUp = true;
        // 一続きの失敗の上限に達したので、この後のやり直しは待たずに1回だけ転送させる
        run.streakWaitedMs = Math.max(run.streakWaitedMs, policy.maxWaitMs);
        const detail = upstream ? await upstream.text().catch(() => "") : "";
        if (attempt === 1 && upstream) return send(res, upstream, detail);
        return fail(
          res,
          status || 502,
          `sacty gateway: gave up after ${attempt} attempt(s) (waited ${Math.round(run.stats.waitedMs / 1000)}s in total) because the upstream kept failing with ${status === 0 ? "a connection error" : status}${status === 429 ? " (rate limited)" : ""}. Upstream response: ${detail.slice(0, 2_000)}`,
        );
      }
      await upstream?.body?.cancel().catch(() => {});
      run.stats.retries += 1;
      if (!run.stats.statuses.includes(status)) run.stats.statuses.push(status);
      const started = now();
      await sleep(wait, aborter.signal);
      const waited = Math.max(wait, now() - started);
      run.stats.waitedMs += waited;
      run.streakWaitedMs += waited;
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "sacty_gateway" } }));
}

function responseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name)) headers[name] = value;
  });
  return headers;
}

/** 読み終えた本文で、上流の応答をそのまま返す。 */
function send(res: ServerResponse, upstream: Response, body: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(upstream.status, responseHeaders(upstream));
  res.end(body);
}

/** 上流の応答を、ストリーミングのまま返す。 */
function pipe(upstream: Response, res: ServerResponse): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(upstream.status, responseHeaders(upstream));
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
