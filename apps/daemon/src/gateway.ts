import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { HostMcpServers } from "./host-mcp.js";
import { isAllowed, type Platform, type PlatformCredentials } from "./platforms.js";

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

/** コンテナから見たホストのアドレスの既定（Docker Desktop。PBI-40）。 */
export const DEFAULT_HOST_ADDRESS = "host-gateway";

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
  /**
   * 転送先の起点（例 https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1、組織の AI gateway の base_url）。
   * エージェントからの /openai/v1/<残り> を、この下の <残り> に送る（PBI-40）。
   */
  base: string;
  /** 上流に付ける API キー（Authorization: Bearer）。認証が要らなければ無い。 */
  apiKey?: string;
};

/** コンテキストリポジトリの HTTP の MCP サーバーの中継先（PBI-49）。 */
export type ContextMcpRoute = { url: string; headers: Record<string, string> };

/**
 * コンテキストの MCP の中継で、エージェントから上流へ送るヘッダー（MCP の Streamable HTTP に要るものだけ）。
 * 認証のヘッダー（ゲートウェイのトークン）などは送らない。
 */
const CONTEXT_MCP_REQUEST = new Set([
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

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

type RunState = Partial<GatewayRoute> & {
  /**
   * コンテキストリポジトリの HTTP の MCP サーバー（PBI-49）。名前ごとに、中継先の URL と、上流に付けるヘッダー
   * （秘密情報の値を入れたもの。ホストだけに持ち、コンテナには渡さない）。
   */
  mcp?: Record<string, ContextMcpRoute>;
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
  /** 組織内 PF の API（PBI-35）。設定を読み直せるよう、リクエストごとに呼ぶ。 */
  platforms?: () => readonly Platform[];
  /** 組織内 PF の認証の値を用意する（PBI-35）。 */
  credentials?: Pick<PlatformCredentials, "header" | "invalidate">;
  /** ホストで動かす MCP サーバー（PBI-36）。 */
  hostMcp?: Pick<HostMcpServers, "handle">;
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
    const server = createServer((req, res) => {
      // 接続の失敗（本文の途中でコンテナを止めたなど）は、そのリクエストだけの終わりとして扱う。
      // 例外やエラーのイベントを取りこぼすと、デーモン全体が終わってしまう（PBI-37 レビュー指摘）
      req.on("error", () => {});
      res.on("error", () => {});
      this.handle(req, res).catch(() => {
        if (!res.headersSent && !res.destroyed) fail(res, 502, "sacty gateway: request failed");
        else res.destroy();
      });
    });
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

  /**
   * 実行を登録し、その実行だけが使えるトークンを返す。実行が終わったら close する。route があれば AI の呼び出しを
   * 中継し（PBI-37）、どの実行も組織内 PF の API を使える（PBI-35。$SACTY_PF_URL にトークンを含める）。
   */
  register(
    route?: GatewayRoute,
    /** コンテキストリポジトリの HTTP の MCP サーバー（PBI-49）。 */
    mcp?: Record<string, ContextMcpRoute>,
  ): { token: string; stats: () => GatewayStats; close: () => void } {
    const token = `sacty-gw-${randomBytes(24).toString("hex")}`;
    const state: RunState = {
      ...route,
      ...(mcp && Object.keys(mcp).length > 0 ? { mcp } : {}),
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

  /** コンテナから見た、実行の組織内 PF の API の起点（PBI-35）。 */
  platformsUrl(token: string): string {
    return `${this.containerOrigin()}/r/${token}/pf`;
  }

  /**
   * 組織内 PF の API を中継する（PBI-35）。実行のトークンと PF を確かめ、ホワイトリストに合うリクエストだけを、PF の
   * 認証を付けて転送する。エージェントが付けた認証のヘッダーは捨てる。トークンを取得する PF で拒否（401・403）
   * されたら、トークンを取り直して1回だけ送り直す。
   */
  private async handlePlatform(
    req: IncomingMessage,
    res: ServerResponse,
    target: { token: string; name: string; path: string; query: string },
  ): Promise<void> {
    if (!this.runs.has(target.token)) {
      return fail(res, 401, "sacty gateway: unknown or expired run token");
    }
    const platform = (this.deps.platforms?.() ?? []).find((p) => p.name === target.name);
    if (!platform || !this.deps.credentials) {
      return fail(res, 404, `sacty gateway: unknown internal platform "${target.name}"`);
    }
    const method = (req.method ?? "GET").toUpperCase();
    // 判定したパスと、実際に送るパスを一致させる。# など、URL として解釈すると変わる入力は送らない
    // （# 以降はフラグメントとして落ち、許可していないパスに送られてしまうため。PBI-35 レビュー指摘）
    const sent = sentUrl(platform.upstream, target.path, target.query);
    if (!sent) {
      return fail(
        res,
        400,
        `sacty gateway: the path "${target.path}" changes when sent as a URL (remove characters such as #)`,
      );
    }
    if (!isAllowed(platform, method, target.path)) {
      return fail(
        res,
        403,
        `sacty gateway: ${method} ${target.path} is not allowed for "${platform.name}". Allowed: ${platform.allow.join(", ")}`,
      );
    }
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      return;
    }
    const authHeader = platform.auth.header.toLowerCase();
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        DROP_REQUEST.has(name) ||
        name === "cookie" ||
        name === authHeader
      ) {
        continue;
      }
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const url = sent;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const credentials = this.deps.credentials;
    for (let attempt = 1; ; attempt++) {
      let value: string;
      try {
        value = await credentials.header(platform);
      } catch (error) {
        return fail(
          res,
          502,
          `sacty gateway: cannot prepare the credentials for "${platform.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      headers.set(platform.auth.header, value);
      let upstream: Response;
      try {
        upstream = await fetchImpl(url, {
          method,
          headers,
          ...(body.length > 0 && method !== "GET" && method !== "HEAD" ? { body } : {}),
          signal: aborter.signal,
          redirect: "manual",
        });
      } catch (error) {
        if (aborter.signal.aborted) return;
        return fail(
          res,
          502,
          `sacty gateway: could not reach "${platform.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        platform.auth.token &&
        attempt === 1 &&
        (upstream.status === 401 || upstream.status === 403)
      ) {
        await upstream.body?.cancel().catch(() => {});
        credentials.invalidate(platform);
        continue;
      }
      return pipe(upstream, res);
    }
  }

  /**
   * コンテキストリポジトリの HTTP の MCP サーバーへ中継する（PBI-49）。MCP の Streamable HTTP に要るヘッダーだけを
   * 送り、認証のヘッダーはホストに持った値を付ける（エージェントが付けたものは送らない）。応答（SSE を含む）は
   * そのまま流す。リダイレクトはたどらない（認証のヘッダーをほかの宛先に送らないため）。
   */
  private async handleContextMcp(
    req: IncomingMessage,
    res: ServerResponse,
    target: ContextMcpRoute,
    query: string,
  ): Promise<void> {
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });
    const method = (req.method ?? "GET").toUpperCase();
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      try {
        body = await readBody(req);
      } catch {
        return;
      }
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || !CONTEXT_MCP_REQUEST.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    Object.assign(headers, target.headers);
    let upstream: Response;
    try {
      const url = new URL(target.url);
      if (query) url.search = query.slice(1);
      upstream = await (this.deps.fetchImpl ?? fetch)(url, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        redirect: "manual",
        signal: aborter.signal,
      });
    } catch {
      return fail(res, 502, "sacty gateway: the MCP server could not be reached");
    }
    return pipe(upstream, res);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 組織内 PF の API：/r/<実行のトークン>/pf/<PF の名前>/<パス>（PBI-35）
    const pf = /^\/r\/([^/]+)\/pf\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? "");
    if (pf) {
      return this.handlePlatform(req, res, {
        token: pf[1] ?? "",
        name: pf[2] ?? "",
        path: pf[3] || "/",
        query: pf[4] ?? "",
      });
    }
    const header = req.headers.authorization ?? "";
    const run = header.startsWith("Bearer ") ? this.runs.get(header.slice(7)) : undefined;
    // コンテキストリポジトリの HTTP の MCP サーバー：/ctx-mcp/<名前>（実行のトークンを Bearer で付ける。PBI-49）
    const contextMcp = /^\/ctx-mcp\/([A-Za-z0-9_-]+)\/?(\?.*)?$/.exec(req.url ?? "");
    if (contextMcp) {
      if (!run) return fail(res, 401, "sacty gateway: unknown or expired run token");
      const target = run.mcp?.[contextMcp[1] ?? ""];
      if (!target) return fail(res, 404, `sacty gateway: unknown MCP server "${contextMcp[1]}"`);
      return this.handleContextMcp(req, res, target, contextMcp[2] ?? "");
    }
    // ホストの MCP サーバー：/mcp/<名前>（実行のトークンを Bearer で付ける。PBI-36）
    const mcp = /^\/mcp\/([A-Za-z0-9_-]+)\/?(\?.*)?$/.exec(req.url ?? "");
    if (mcp) {
      if (!run) return fail(res, 401, "sacty gateway: unknown or expired run token");
      if (!this.deps.hostMcp) return fail(res, 404, "sacty gateway: no host MCP servers");
      let raw: Buffer;
      try {
        raw = await readBody(req);
      } catch {
        return;
      }
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
      } catch {
        return fail(res, 400, "sacty gateway: the MCP request is not JSON");
      }
      return this.deps.hostMcp.handle(mcp[1] ?? "", req, res, body);
    }
    if (!run?.base) {
      return fail(res, 401, "sacty gateway: unknown or expired run token");
    }
    if (!req.url?.startsWith("/openai/v1/")) return fail(res, 404, "sacty gateway: not found");

    // コンテナとの接続が切れたら（人間の一時停止・中止でコンテナを止めた）、待つのも転送もやめる
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      // 本文を受け取り終える前に、コンテナとの接続が切れた
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }

    const policy = this.deps.policy?.() ?? DEFAULT_RETRY_POLICY;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const sleep = this.deps.sleep ?? abortableSleep;
    const now = this.deps.now ?? Date.now;
    const random = this.deps.random ?? Math.random;
    // /openai/v1/<残り> を、転送先の起点（base）の下に送る（PBI-40）
    const url = `${run.base}${req.url.slice("/openai/v1".length)}`;
    if (run.apiKey) headers.set("authorization", `Bearer ${run.apiKey}`);

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

/**
 * 転送する URL。パス・クエリを URL として解釈しても変わらないときだけ返す（# のフラグメント・. や .. の
 * まとめなどで、許可を判定したパスと違うパスに送らないため）。変わるなら undefined。
 */
export function sentUrl(upstream: string, path: string, query: string): string | undefined {
  if (/[#\s]/.test(path) || /[#\s]/.test(query)) return undefined;
  let url: URL;
  try {
    url = new URL(`${upstream}${path}${query}`);
  } catch {
    return undefined;
  }
  const base = new URL(upstream).pathname.replace(/\/+$/, "");
  if (url.pathname !== `${base}${path}` || url.search !== query || url.hash) return undefined;
  return url.toString();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    // 本文の途中で切れたとき、error を出さずに aborted・close だけになることもある
    req.on("close", () => {
      if (!req.complete) reject(new Error("the request was aborted"));
    });
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
