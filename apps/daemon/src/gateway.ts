import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";
import {
  GITHUB_GRAPHQL_BODY_MAX,
  GITHUB_RELAY_REQUEST,
  githubGraphqlUrl,
  githubRestBase,
  isReadOnlyGraphql,
  relayHeaderValue,
} from "./github-relay.js";
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

/**
 * 転送しないリクエストのヘッダー（宛先・認証・長さ・接続。圧縮は上流に任せず、平文で受ける）。expect（curl などが大きな本文に
 * 付ける 100-continue）は、ゲートウェイが本文を受け取り終えてから送るので要らず、fetch が受け付けない（PBI-132 の確認で発見）。
 */
const DROP_REQUEST = new Set([
  "host",
  "authorization",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "accept-encoding",
  "expect",
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

/**
 * コンテキストリポジトリの MCP サーバーの中継先。HTTP のサーバーは上流の URL（PBI-49）、ホストで起動した command の
 * サーバーは、ゲートウェイの中の名前（host。プロジェクトと中身ごと。PBI-84）。
 */
export type ContextMcpRoute = HttpContextMcpRoute | { host: string };

/** コンテキストリポジトリの HTTP の MCP サーバーの中継先（PBI-49）。 */
export type HttpContextMcpRoute = {
  url: string;
  headers: Record<string, string>;
  /**
   * 上流の応答を待つ上限（ミリ秒。mcp.yaml の時間切れの大きい方。PBI-75）。fetch の既定（応答のヘッダーと、本文の
   * 途切れをそれぞれ5分）より長いときだけ、それに合わせて延ばす（エージェントより先に、ゲートウェイで切らない）。
   */
  timeoutMs?: number;
};

/** fetch（undici）が、上流の応答のヘッダーと本文の途切れを待つ既定の上限（ミリ秒）。 */
export const FETCH_DEFAULT_TIMEOUT_MS = 300_000;

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
  /**
   * プロジェクトのコンテキストで定義した外部 PF（PBI-74）。この実行のトークンでだけ使える（ほかのプロジェクトの実行の
   * トークンでは、名前を知っていても使えない）。認証は秘密情報の名前のまま持ち、使うときにホストで取り出す。
   */
  platforms?: readonly Platform[];
  access?: { platforms: readonly string[]; hostMcp: readonly string[] };
  /**
   * 読み取りだけの実行（タスクの開始時の情報収集）。外部 PF の API は、ホワイトリストに合っても GET・HEAD だけを中継する
   * （チケットのコメント・リンク先などの外部の本文に書かれた指示に誘導されても、書き込めないようにする）。
   */
  readOnly?: boolean;
  /**
   * GitHub の読み取りの中継で使える、ホストごとの gh のアカウント（タスクのプロジェクトで選んだもの）。トークンは
   * 使うときにホストで取り出し、この実行の間だけ持つ。
   */
  github?: Record<string, string>;
  githubTokens?: Map<string, Promise<string>>;
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
  /** GitHub の読み取りの中継に付けるトークン（ホストの gh のアカウントから取り出す）。 */
  githubToken?: (host: string, account: string) => Promise<string>;
  /**
   * ホストで起動した、コンテキストの command の MCP サーバー（PBI-84）。実行の登録で結びつけた名前（host）でだけ
   * 中継する（/mcp/ からは使えない）。
   */
  contextHostMcp?: Pick<HostMcpServers, "handle">;
  /**
   * 待つ上限を延ばした中継で使う fetch（PBI-75。既定は undici の fetch。待つ上限は dispatcher で渡す）。テストでは
   * 差し替える。
   */
  longFetchImpl?: (url: URL, init: Record<string, unknown>) => Promise<Response>;
  /**
   * 受け取る本文の上限（PBI-132）。テストでは小さくする。無ければ GATEWAY_BODY_MAX・GATEWAY_BODIES_MAX・
   * GATEWAY_BODY_BLOCK。
   */
  bodyLimits?: { perRequest: number; total: number; block?: number };
};

/**
 * コンテナから受け取る本文の上限（1 つの要求。PBI-132）。上流へ送る前にホストのメモリーにためるので、1 つの工程のコンテナが
 * デーモンのメモリーを使い尽くせないようにする。AI の要求（画像・長いコンテキスト）を妨げない大きさにする。
 */
export const GATEWAY_BODY_MAX = 64 * 1024 * 1024;
/** 同時に受け取っている本文（応答を返し終えるまで）の合計の上限（PBI-132）。 */
export const GATEWAY_BODIES_MAX = 256 * 1024 * 1024;
/**
 * 本文をためるブロックの大きさ（PBI-132。PR #144 レビュー指摘）。受け取った分は、このブロックに写して持ち、合計には確保した
 * ブロックの大きさで数える。届いた chunk をそのまま持つと、1 バイトの chunk ごとに Buffer と配列の要素が残り、数えた量より
 * ずっと多くのメモリーを使う（chunk が、より大きな受信のバッファーを指したままのこともある）。
 */
export const GATEWAY_BODY_BLOCK = 16 * 1024;

/** 受け取っている本文の量（確保したブロックの合計。すべての実行で共有する。PBI-132）。 */
class BodyBudget {
  used = 0;
  constructor(
    readonly perRequest: number,
    readonly total: number,
    readonly block: number,
  ) {}
}

/** 本文を上限で断った（413：1 つの要求が大きすぎる、503：同時に受け取っている量が多すぎる）。 */
class BodyRefused extends Error {
  constructor(
    readonly status: 413 | 503,
    message: string,
  ) {
    super(message);
  }
}

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
  /** 待つ上限ごとの接続（PBI-75。使い回す）。 */
  private readonly dispatchers = new Map<number, Agent>();
  private readonly bodies: BodyBudget;

  constructor(private readonly deps: GatewayDeps = {}) {
    this.bodies = new BodyBudget(
      deps.bodyLimits?.perRequest ?? GATEWAY_BODY_MAX,
      deps.bodyLimits?.total ?? GATEWAY_BODIES_MAX,
      deps.bodyLimits?.block ?? GATEWAY_BODY_BLOCK,
    );
  }

  /** いま受け取っている本文のために確保している量（バイト。PBI-132）。テストで、受け取ったことを確かめるのに使う。 */
  bodiesInUse(): number {
    return this.bodies.used;
  }

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
    for (const dispatcher of this.dispatchers.values()) void dispatcher.close().catch(() => {});
    this.dispatchers.clear();
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
    /** プロジェクトのコンテキストで定義した外部 PF（PBI-74）。この実行だけが使える。 */
    platforms?: readonly Platform[],
    access?: { platforms: readonly string[]; hostMcp: readonly string[] },
    /** GitHub の読み取りの中継で使える、ホストごとの gh のアカウント。 */
    github?: Record<string, string>,
    /** readOnly：外部 PF の API を GET・HEAD だけにする（情報収集）。 */
    options?: { readOnly?: boolean },
  ): { token: string; stats: () => GatewayStats; close: () => void } {
    const token = `sacty-gw-${randomBytes(24).toString("hex")}`;
    const state: RunState = {
      ...route,
      ...(access ? { access } : {}),
      ...(options?.readOnly ? { readOnly: true } : {}),
      ...(github && Object.keys(github).length > 0
        ? {
            github: Object.fromEntries(
              Object.entries(github).map(([host, account]) => [host.toLowerCase(), account]),
            ),
          }
        : {}),
      ...(mcp && Object.keys(mcp).length > 0 ? { mcp } : {}),
      ...(platforms && platforms.length > 0 ? { platforms: [...platforms] } : {}),
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

  /** コンテナから見た、実行の GitHub の読み取りの中継の起点（この下に <ホスト>/<API のパス>）。 */
  githubUrl(token: string): string {
    return `${this.containerOrigin()}/r/${token}/github`;
  }

  /**
   * GitHub の API を、読み取りだけ中継する。REST は GET・HEAD、GraphQL（/graphql）は query の操作の POST だけを、
   * そのホストに選んだ gh のアカウントのトークンを付けて転送する。ページ送り（link）とリダイレクト（location）の
   * API の URL は、中継の URL に書き換えて返す。
   */
  private async handleGitHub(
    req: IncomingMessage,
    res: ServerResponse,
    target: { token: string; host: string; path: string; query: string },
  ): Promise<void> {
    const run = this.runs.get(target.token);
    if (!run) return fail(res, 401, "sacty gateway: unknown or expired run token");
    // 転送先のホストは、要求の値ではなく、実行に結びつけたホスト（プロジェクトで選んだもの）の中から取る
    const requested = target.host.toLowerCase();
    const host = Object.keys(run.github ?? {}).find((h) => h === requested);
    const account = host !== undefined ? run.github?.[host] : undefined;
    if (host === undefined || !account || !this.deps.githubToken) {
      const hosts = Object.keys(run.github ?? {});
      return fail(
        res,
        404,
        `sacty gateway: no GitHub account is selected for "${requested}" in the project settings${hosts.length > 0 ? ` (available: ${hosts.join(", ")})` : ""}`,
      );
    }
    const method = (req.method ?? "GET").toUpperCase();
    const graphql = target.path === "/graphql" || target.path === "/graphql/";
    if (graphql ? method !== "POST" : method !== "GET" && method !== "HEAD") {
      return fail(
        res,
        405,
        `sacty gateway: the GitHub relay is read-only (GET and HEAD for the REST API, POST of a GraphQL query for /graphql). ${method} ${target.path} is not allowed. Write your comment to the output instead (sacty posts it after approval).`,
      );
    }
    if (/(^|\/)\.{1,2}(\/|$)|%2e|%2f|\\/i.test(target.path)) {
      return fail(res, 400, `sacty gateway: the path "${target.path}" is not allowed`);
    }
    const sent = graphql
      ? target.query
        ? undefined
        : githubGraphqlUrl(host)
      : sentUrl(githubRestBase(host), target.path, target.query);
    if (!sent) {
      return fail(
        res,
        400,
        `sacty gateway: the path "${target.path}" changes when sent as a URL (remove characters such as #)`,
      );
    }
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });
    let body: Buffer | undefined;
    if (graphql) {
      try {
        // GraphQL の問い合わせは小さいので、上限を超えたら受け取り終える前に断る
        body = await readBody(req, res, this.bodies, GITHUB_GRAPHQL_BODY_MAX);
      } catch (error) {
        return refuseBody(req, res, error);
      }
      if (!isReadOnlyGraphql(body.toString("utf8"))) {
        return fail(
          res,
          403,
          "sacty gateway: the GitHub relay is read-only. Only a GraphQL query (no mutation or subscription) can be sent.",
        );
      }
    }
    let token: string;
    try {
      run.githubTokens ??= new Map();
      let pending = run.githubTokens.get(host);
      if (!pending) {
        pending = this.deps.githubToken(host, account);
        run.githubTokens.set(host, pending);
        // 取り出せなかったら、次の要求で取り出し直す
        pending.catch(() => run.githubTokens?.delete(host));
      }
      token = await pending;
    } catch (error) {
      return fail(
        res,
        502,
        `sacty gateway: cannot get the token of the GitHub account "${account}" on ${host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || !GITHUB_RELAY_REQUEST.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json");
    if (!headers.has("user-agent")) headers.set("user-agent", "sacty-gateway");
    headers.set("authorization", `Bearer ${token}`);
    let upstream: Response;
    try {
      upstream = await (this.deps.fetchImpl ?? fetch)(sent, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: aborter.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (aborter.signal.aborted) return;
      return fail(
        res,
        502,
        `sacty gateway: could not reach GitHub (${host}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const relayBase = `${this.githubUrl(target.token)}/${host}`;
    return pipe(upstream, res, (name, value) =>
      name === "link" || name === "location" ? relayHeaderValue(value, host, relayBase) : value,
    );
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
    const run = this.runs.get(target.token);
    if (!run) {
      return fail(res, 401, "sacty gateway: unknown or expired run token");
    }
    if (run.access && !run.access.platforms.includes(target.name)) {
      return fail(res, 403, "sacty gateway: platform is outside the selected operation");
    }
    // ホストの PF（config.yaml）を先に引き、無ければこの実行のプロジェクトのコンテキストの PF（PBI-74）。同じ名前なら
    // ホストのものを使う（合成と同じ規則。設定を読み直したときも、ホストのものが優先される）
    const platform =
      (this.deps.platforms?.() ?? []).find((p) => p.name === target.name) ??
      run.platforms?.find((p) => p.name === target.name);
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
    if (run.readOnly && method !== "GET" && method !== "HEAD") {
      return fail(
        res,
        403,
        `sacty gateway: this run is read-only (information gathering). ${method} ${target.path} is not allowed for "${platform.name}"; only GET and HEAD are relayed.`,
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
      body = await readBody(req, res, this.bodies);
    } catch (error) {
      return refuseBody(req, res, error);
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
          `sacty gateway: cannot prepare the credentials for "${platform.name}"${platform.from ? ` (platforms.yaml of ${platform.from})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
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
    name: string,
    target: HttpContextMcpRoute,
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
        body = await readBody(req, res, this.bodies);
      } catch (error) {
        return refuseBody(req, res, error);
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
      const init = {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        redirect: "manual" as const,
        signal: aborter.signal,
      };
      // mcp.yaml の時間切れが fetch の既定より長いなら、ゲートウェイで先に切らないよう待つ上限を延ばす（PBI-75）
      const timeoutMs = target.timeoutMs ?? 0;
      upstream =
        timeoutMs > FETCH_DEFAULT_TIMEOUT_MS
          ? await (this.deps.longFetchImpl ?? longFetch)(url, {
              ...init,
              dispatcher: this.dispatcher(timeoutMs),
            })
          : await (this.deps.fetchImpl ?? fetch)(url, init);
    } catch {
      // どの MCP サーバーか（mcp.yaml の名前）を返す（PBI-92）
      return fail(res, 502, `sacty gateway: the MCP server "${name}" could not be reached`);
    }
    return pipe(upstream, res);
  }

  /** 待つ上限（応答のヘッダーと、本文の途切れ）を延ばした接続。 */
  private dispatcher(timeoutMs: number): Agent {
    let dispatcher = this.dispatchers.get(timeoutMs);
    if (!dispatcher) {
      dispatcher = contextMcpDispatcher(timeoutMs);
      this.dispatchers.set(timeoutMs, dispatcher);
    }
    return dispatcher;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // GitHub の読み取り：/r/<実行のトークン>/github/<ホスト>/<API のパス>
    const github = /^\/r\/([^/]+)\/github\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? "");
    if (github) {
      return this.handleGitHub(req, res, {
        token: github[1] ?? "",
        host: github[2] ?? "",
        path: github[3] || "/",
        query: github[4] ?? "",
      });
    }
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
      // 実行のトークンに結びつけたものだけを引く（ほかのプロジェクトの実行のものは、名前を知っていても使えない）
      const name = contextMcp[1] ?? "";
      const target = run.mcp && Object.hasOwn(run.mcp, name) ? run.mcp[name] : undefined;
      if (!target) return fail(res, 404, `sacty gateway: unknown MCP server "${name}"`);
      if ("host" in target) {
        // ホストで起動したコンテキストの command の MCP サーバー（PBI-84）
        if (!this.deps.contextHostMcp) return fail(res, 404, "sacty gateway: no host MCP servers");
        return relayHostMcp(this.deps.contextHostMcp, target.host, req, res, this.bodies);
      }
      return this.handleContextMcp(req, res, name, target, contextMcp[2] ?? "");
    }
    // ホストの MCP サーバー：/mcp/<名前>（実行のトークンを Bearer で付ける。PBI-36）
    const mcp = /^\/mcp\/([A-Za-z0-9_-]+)\/?(\?.*)?$/.exec(req.url ?? "");
    if (mcp) {
      if (!run) return fail(res, 401, "sacty gateway: unknown or expired run token");
      if (run.access && !run.access.hostMcp.includes(mcp[1] ?? "")) {
        return fail(res, 403, "sacty gateway: MCP server is outside the selected operation");
      }
      if (!this.deps.hostMcp) return fail(res, 404, "sacty gateway: no host MCP servers");
      return relayHostMcp(this.deps.hostMcp, mcp[1] ?? "", req, res, this.bodies);
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
      body = await readBody(req, res, this.bodies);
    } catch (error) {
      // 本文を受け取り終える前に、コンテナとの接続が切れた（か、上限で断った）
      return refuseBody(req, res, error);
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

/** ホストで動かす MCP サーバーへ、JSON の MCP のリクエストを中継する（PBI-36・84）。 */
async function relayHostMcp(
  servers: Pick<HostMcpServers, "handle">,
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  bodies: BodyBudget,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readBody(req, res, bodies);
  } catch (error) {
    return refuseBody(req, res, error);
  }
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {
    return fail(res, 400, "sacty gateway: the MCP request is not JSON");
  }
  return servers.handle(name, req, res, body);
}

/** 応答のヘッダーと、本文の途切れを、それぞれ timeoutMs まで待つ接続（PBI-75）。 */
export function contextMcpDispatcher(timeoutMs: number): Agent {
  return new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
}

/** undici の fetch（dispatcher を渡すため。応答は標準の Response と同じように使える）。 */
const longFetch = (url: URL, init: Record<string, unknown>) =>
  undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

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

/**
 * 本文を受け取る。1 つの要求の上限と、同時に受け取っている合計の上限を超えたら、それ以上ためずに断る（PBI-132）。
 * Content-Length が上限を超えていれば、読む前に断る（無くても、chunked でも、受け取った量で止める）。受け取った分は
 * 決まった大きさのブロックに写して持ち、合計には確保したブロックの大きさで数える（細かい chunk を大量に送られても、数えた量
 * より多くのメモリーを使わない。PR #144 レビュー指摘）。ためた分は、応答を返し終える（接続が閉じる）まで合計に数える
 * （上流へ送っている間も、ホストのメモリーにあるため）。
 */
function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  bodies: BodyBudget,
  /** 1 つの要求の上限（この経路だけ小さくするとき。無ければ bodies の上限）。 */
  limit = bodies.perRequest,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    /** 受け取った本文の量（1 つの要求の上限と比べる）。 */
    let held = 0;
    /** 確保したブロックの合計（合計に数える量）。 */
    let reserved = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      bodies.used -= reserved;
    };
    res.on("close", release);
    const refuse = (error: BodyRefused) => {
      req.off("data", onData);
      req.pause();
      release();
      reject(error);
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      return refuse(tooLarge(limit));
    }
    const blocks: Buffer[] = [];
    let current: Buffer | undefined;
    let offset = 0;
    function onData(chunk: Buffer) {
      if (held + chunk.length > limit) return refuse(tooLarge(limit));
      for (let from = 0; from < chunk.length; ) {
        if (!current || offset === current.length) {
          if (bodies.used + bodies.block > bodies.total) {
            return refuse(
              new BodyRefused(
                503,
                `sacty gateway: too many request bodies are being received at once (over ${bodies.total} bytes in total). Retry later`,
              ),
            );
          }
          // 共有のプールから切り出さない（ほかの小さな Buffer と同じ領域を持ち続けないように）
          current = Buffer.allocUnsafeSlow(bodies.block);
          offset = 0;
          blocks.push(current);
          bodies.used += bodies.block;
          reserved += bodies.block;
        }
        const copied = chunk.copy(current, offset, from);
        offset += copied;
        from += copied;
      }
      held += chunk.length;
    }
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(blocks, held)));
    req.on("error", (error) => {
      release();
      reject(error);
    });
    // 本文の途中で切れたとき、error を出さずに aborted・close だけになることもある
    req.on("close", () => {
      if (!req.complete) {
        release();
        reject(new Error("the request was aborted"));
      }
    });
  });
}

function tooLarge(limit: number): BodyRefused {
  return new BodyRefused(
    413,
    `sacty gateway: the request body is larger than the limit (${limit} bytes)`,
  );
}

/**
 * 本文を受け取れなかったときの終わり方。上限で断ったなら、理由を返してから接続を切る（残りの本文を受け取らない）。
 * 接続が切れたなら、何もしない。
 */
function refuseBody(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (!(error instanceof BodyRefused)) return;
  if (res.headersSent || res.destroyed) {
    req.destroy();
    return;
  }
  res.writeHead(error.status, {
    "content-type": "application/json",
    connection: "close",
    ...(error.status === 503 ? { "retry-after": "1" } : {}),
  });
  res.end(JSON.stringify({ error: { message: error.message, type: "sacty_gateway" } }), () =>
    req.destroy(),
  );
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "sacty_gateway" } }));
}

function responseHeaders(
  upstream: Response,
  rewrite?: (name: string, value: string) => string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name)) headers[name] = rewrite ? rewrite(name, value) : value;
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
function pipe(
  upstream: Response,
  res: ServerResponse,
  rewrite?: (name: string, value: string) => string,
): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(upstream.status, responseHeaders(upstream, rewrite));
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
