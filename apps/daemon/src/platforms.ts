import { code, type DaemonText, message } from "@sacty/core";
import { z } from "zod";
import { errorText } from "./errors.js";
import { SecretRef, type SecretStore } from "./secrets.js";

/**
 * 組織内 PF の API（PBI-35）。ホストのゲートウェイが、ホワイトリストに合うリクエストだけを、PF の認証を付けて
 * 転送する。認証情報はゲートウェイだけが持ち、エージェントには渡さない。
 *
 * 認証は「どのヘッダーに・何を付けるか」で書く。値は、秘密情報そのもの（固定のキー）か、秘密情報でトークンの窓口
 * から取得したトークン（JWT など。期限の前に取り直す）。
 */

/** 本文・ヘッダーで、秘密情報の値を入れる所。 */
export const SECRET_PLACEHOLDER = "{{secret}}";

const HeaderName = z.string().regex(/^[A-Za-z0-9-]+$/, code("input.headerName"));
const Method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
/** ホワイトリストの1行：「メソッド パス」。パスの * は1階層、** はそれ以下すべて。 */
const AllowRule = z
  .string()
  .trim()
  .regex(/^(GET|POST|PUT|PATCH|DELETE|HEAD) \/\S*$/, code("input.allowRule"));

const TokenRequest = z
  .object({
    /** トークンの窓口。キーは書けない（クエリで送るなら query に書く。PBI-93）。 */
    url: z
      .url({ protocol: /^https?$/ })
      .refine((url) => !url.includes(SECRET_PLACEHOLDER), code("config.platformTokenUrlSecret")),
    method: Method.default("POST"),
    /** 窓口に送るヘッダー（{{secret}} に秘密情報の値を入れる）。 */
    headers: z.record(HeaderName, z.string()).default({}),
    /**
     * 窓口の URL に足すクエリのパラメーター（{{secret}} に秘密情報の値を入れ、URL エンコードする。url に元からある
     * クエリの後ろに足す。PBI-93）。
     */
    query: z
      .record(
        z.string().min(1, code("config.platformTokenQuery")),
        z.string({ error: code("config.platformTokenQuery") }),
        { error: code("config.platformTokenQuery") },
      )
      .optional(),
    /** 窓口に送る JSON の本文（文字列の中の {{secret}} に秘密情報の値を入れる）。 */
    json: z.unknown().optional(),
    /** 窓口に送るフォームの本文（application/x-www-form-urlencoded）。 */
    form: z.record(z.string(), z.string()).optional(),
    /** 窓口に送る秘密情報（API キーなど）。 */
    secret: SecretRef,
    /** 応答の JSON の、トークンの場所（例 data.accessToken）。 */
    token_path: z.string().trim().min(1),
    /** 応答の JSON の、期限（秒）の場所（例 expires_in）。無ければ ttl_sec。 */
    expires_in_path: z.string().trim().min(1).optional(),
    /** 期限が分からないときに、トークンを持つ時間（秒）。 */
    ttl_sec: z.number().int().positive().default(300),
  })
  // GET・HEAD は本文を送れない（送ると取得のたびに失敗するため、設定の検査で弾く。PBI-93）
  .refine(
    (t) => !((t.method === "GET" || t.method === "HEAD") && (t.json !== undefined || t.form)),
    { error: code("config.platformTokenBody"), path: ["method"] },
  );

export const PlatformFile = z.object({
  /** 転送先（例 https://ticket.internal.example.com）。 */
  upstream: z.url({ protocol: /^https?$/ }),
  /** エージェントに伝える、PF の説明。 */
  description: z.string().default(""),
  auth: z
    .object({
      /** 認証を付けるヘッダー（組織で定義した独自のヘッダーも書ける）。 */
      header: HeaderName.default("Authorization"),
      /** 値の前置き（例 "Bearer "）。 */
      prefix: z.string().default(""),
      /** 固定のキー。 */
      secret: SecretRef.optional(),
      /** API キーなどでトークンを取得する。 */
      token: TokenRequest.optional(),
    })
    .refine(
      (a) => (a.secret === undefined) !== (a.token === undefined),
      code("config.platformAuth"),
    ),
  /** 使える API（メソッドとパス）。書いていないものはすべて拒否する。 */
  allow: z.array(AllowRule).min(1),
});

export type Platform = {
  name: string;
  upstream: string;
  description: string;
  auth: {
    header: string;
    prefix: string;
    secret?: string;
    token?: {
      url: string;
      method: string;
      headers: Record<string, string>;
      query?: Record<string, string>;
      json?: unknown;
      form?: Record<string, string>;
      secret: string;
      tokenPath: string;
      expiresInPath?: string;
      ttlSec: number;
    };
  };
  allow: string[];
  /**
   * プロジェクトのコンテキストの層で定義した PF なら、その層（PBI-74）。config.yaml の gateway.platforms のものは無い。
   */
  from?: string;
};

/**
 * ホストの PF（config.yaml の gateway.platforms）と、プロジェクトのコンテキストで合成した PF を合わせる（PBI-74）。
 * ホストの PF はすべてのプロジェクトで使え、同じ名前ならホストのものを使う（ホストの MCP とコンテキストの MCP の関係と
 * 同じ）。どちらを使ったかがわかるよう、警告を残す。
 */
export function mergePlatforms(
  host: readonly Platform[],
  context: readonly Platform[],
): { platforms: Platform[]; warnings: DaemonText[] } {
  const names = new Set(host.map((p) => p.name));
  const warnings: DaemonText[] = [];
  const own: Platform[] = [];
  for (const p of context) {
    if (names.has(p.name)) {
      warnings.push(message("context.hostPlatform", { from: p.from ?? "", name: p.name }));
    } else {
      own.push(p);
    }
  }
  return { platforms: [...host, ...own], warnings };
}

/** 画面・作業履歴に出す PF の要約（秘密情報の名前も値も含めない。PBI-74）。 */
export type PlatformSummary = { name: string; from?: string; description: string; allow: string[] };

export function platformSummary(p: Platform): PlatformSummary {
  return {
    name: p.name,
    ...(p.from ? { from: p.from } : {}),
    description: p.description,
    allow: [...p.allow],
  };
}

export function toPlatform(name: string, file: z.infer<typeof PlatformFile>): Platform {
  const token = file.auth.token;
  return {
    name,
    upstream: file.upstream.replace(/\/+$/, ""),
    description: file.description,
    auth: {
      header: file.auth.header,
      prefix: file.auth.prefix,
      ...(file.auth.secret ? { secret: file.auth.secret } : {}),
      ...(token
        ? {
            token: {
              url: token.url,
              method: token.method,
              headers: token.headers,
              ...(token.query ? { query: token.query } : {}),
              ...(token.json !== undefined ? { json: token.json } : {}),
              ...(token.form ? { form: token.form } : {}),
              secret: token.secret,
              tokenPath: token.token_path,
              ...(token.expires_in_path ? { expiresInPath: token.expires_in_path } : {}),
              ttlSec: token.ttl_sec,
            },
          }
        : {}),
    },
    allow: file.allow,
  };
}

/** パスのパターン（* は1階層、** はそれ以下すべて）を正規表現にする。 */
function pathPattern(pattern: string): RegExp {
  const parts = pattern.split("/").map((part) => {
    if (part === "**") return "(?:.*)";
    return part
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
  });
  // 末尾の /** は、その階層そのもの（/a）にも合う
  return new RegExp(`^${parts.join("/").replace(/\/\(\?:\.\*\)$/, "(?:/.*)?")}$`);
}

/** ホワイトリストに合うか（クエリは見ない。パスの .. などを含むものは合わない）。 */
export function isAllowed(platform: Platform, method: string, path: string): boolean {
  const clean = path.split("?")[0] ?? "";
  if (!clean.startsWith("/") || /(^|\/)\.\.?(\/|$)|%2e|%2f|\\/i.test(clean)) return false;
  return platform.allow.some((rule) => {
    const [m, p] = rule.split(" ");
    return m === method.toUpperCase() && p !== undefined && pathPattern(p).test(clean);
  });
}

/** JSON のドットで区切った場所の値。 */
function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, key) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined),
      value,
    );
}

/** 値の中の文字列の {{secret}} を、秘密情報の値にする。 */
function fill(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(SECRET_PLACEHOLDER).join(secret);
  if (Array.isArray(value)) return value.map((v) => fill(v, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, secret)]));
  }
  return value;
}

/** 伏せる文字列の、短すぎるものの下限（短い文字列一般は置き換えない。クエリの値として現れたものは除く）。 */
const HIDE_MIN_LENGTH = 4;

/**
 * 文から秘密情報を伏せる。値そのもの・JSON の文字列にした形・URL エンコードした形（クエリで送るため。PBI-93）・
 * 各行（短すぎる行は除く）を伏せる。クエリの値として現れた秘密情報（`?名前=値`・`&名前=値`）は、長さに関係なく伏せる
 * （PBI-93 レビュー指摘）。
 */
export function hideSecret(text: string, secret: string): string {
  if (!secret) return text;
  const encoded = urlPattern(secret);
  // クエリの値の全体が秘密情報のとき（短いキーも）
  let hidden = text.replace(
    new RegExp(`([?&][^=&#?\\s]{0,256}=)(?:${encoded})(?=$|[&#\\s"'<>\\\\,;)\\]}])`, "gu"),
    "$1[secret]",
  );
  // URL エンコードした形（文字ごとに、そのままか・エスケープか。16進の大文字・小文字・空白の + ・二重のエンコードの
  // 混在も含む）。各行より先に置き換える（行を先に伏せると、エンコードした形の残りが出るため）
  if (secret.length >= HIDE_MIN_LENGTH) {
    hidden = hidden.replace(new RegExp(encoded, "gu"), "[secret]");
  }
  const forms = [secret, JSON.stringify(secret).slice(1, -1), ...secret.split(/\r?\n/)]
    .filter((f) => f.length >= HIDE_MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  return forms.reduce((t, f) => t.split(f).join("[secret]"), hidden);
}

/**
 * 秘密情報が URL に現れうる形の正規表現。文字ごとに、そのままか、UTF-8 のパーセントエスケープ（16進の大文字・小文字を
 * 問わない。%25 で二重にエンコードしたものも）。空白は + も。窓口や中継のプロキシがエラーの文に URL を写すときの
 * 書き方の違いを、エスケープの箇所ごとに受け付ける。対になっていないサロゲートは、エンコードできないのでそのままだけ。
 */
function urlPattern(secret: string): string {
  const encoder = new TextEncoder();
  const hex = (b: number) =>
    b
      .toString(16)
      .toUpperCase()
      .padStart(2, "0")
      .replace(/[A-F]/g, (c) => `[${c}${c.toLowerCase()}]`);
  return Array.from(secret, (ch) => {
    const alts = [ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")];
    if (ch === " ") alts.push("\\+");
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0xd800 || code > 0xdfff) {
      alts.push(Array.from(encoder.encode(ch), (b) => `%(?:25)?${hex(b)}`).join(""));
    }
    return `(?:${alts.join("|")})`;
  }).join("");
}

/**
 * クエリの名前・値を URL エンコードする。encodeURIComponent が残す !'()* も変える（URL の組み立てで ' が %27 に
 * 変わり、伏せる形と食い違わないようにするため）。
 */
function encodeQuery(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * トークンの窓口の URL。query の値の {{secret}} を秘密情報の値にし、URL エンコードして、url に元からあるクエリの
 * 後ろに足す（元のクエリは書き換えない。URL の # 以降は送らない。PBI-93）。
 */
export function tokenUrl(
  url: string,
  query: Record<string, string> | undefined,
  secret: string,
): string {
  const entries = Object.entries(query ?? {});
  if (entries.length === 0) return url;
  const target = new URL(url);
  const added = entries
    .map(([k, v]) => `${encodeQuery(k)}=${encodeQuery(fill(v, secret) as string)}`)
    .join("&");
  const base = target.search.replace(/^\?/, "").replace(/&+$/, "");
  target.hash = "";
  target.search = base ? `${base}&${added}` : added;
  return target.href;
}

/** トークンを取得できなかった理由の長さの上限（画面・ログ・ゲートウェイの応答に出す）。 */
const REASON_MAX = 600;

/** トークンを取り直すのは、期限のこの時間前から。 */
const REFRESH_MARGIN_MS = 30_000;

/**
 * PF の認証の値を用意する。トークンは期限の前まで持ち、期限が近い・拒否されたら取り直す（同時の取得は1回にまとめる）。
 * 取得できなかった PF は、理由を持つ（画面の状態に出す）。成功すると消す。
 */
export class PlatformCredentials {
  private readonly tokens = new Map<string, Promise<{ value: string; expiresAt: number }>>();
  private readonly problems = new Map<string, DaemonText>();

  constructor(
    private readonly deps: {
      secrets: SecretStore;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  /** 認証のヘッダーに付ける値（前置きを含む）。 */
  async header(platform: Platform): Promise<string> {
    try {
      const value = platform.auth.secret
        ? await this.deps.secrets.get(platform.auth.secret)
        : await this.token(platform);
      if (!platform.from) this.problems.delete(platform.name);
      return `${platform.auth.prefix}${value}`;
    } catch (error) {
      // 画面の状態に出すのは、ホストの PF だけ（コンテキストの PF は、プロジェクトごとに同じ名前がありうるため、
      // 使ったエージェントへの応答に理由を返す。PBI-74）
      if (!platform.from) {
        this.problems.set(
          platform.name,
          message("gateway.platformUnavailable", { name: platform.name, detail: errorText(error) }),
        );
      }
      throw error;
    }
  }

  /** 持っているトークンを捨てる（上流に拒否されたとき）。 */
  invalidate(platform: Platform): void {
    this.tokens.delete(this.key(platform));
  }

  /** 認証情報を用意できなかった PF の理由。 */
  unavailable(names: readonly string[]): DaemonText[] {
    return names.flatMap((n) => {
      const problem = this.problems.get(n);
      return problem ? [problem] : [];
    });
  }

  private key(platform: Platform): string {
    return `${platform.name}\u0000${JSON.stringify(platform.auth)}`;
  }

  private async token(platform: Platform): Promise<string> {
    const now = this.deps.now ?? Date.now;
    const key = this.key(platform);
    const cached = this.tokens.get(key);
    if (cached) {
      const token = await cached.catch(() => undefined);
      if (token && token.expiresAt - REFRESH_MARGIN_MS > now()) return token.value;
      if (this.tokens.get(key) === cached) this.tokens.delete(key);
    }
    const pending = this.tokens.get(key) ?? this.fetchToken(platform);
    this.tokens.set(key, pending);
    pending.catch(() => {
      if (this.tokens.get(key) === pending) this.tokens.delete(key);
    });
    return (await pending).value;
  }

  private async fetchToken(platform: Platform): Promise<{ value: string; expiresAt: number }> {
    const spec = platform.auth.token;
    if (!spec) throw new Error("the platform does not get a token");
    const secret = await this.deps.secrets.get(spec.secret);
    // 取り出した後の失敗（ヘッダーの組み立て・送信・応答の読み取り）は、どれも理由（画面・ログ・ゲートウェイの応答）
    // に秘密情報を出さない（値そのもの・JSON の文字列にした形・各行を伏せる。PBI-35 レビュー指摘）
    try {
      return await this.requestToken(spec, secret);
    } catch (error) {
      // 伏せてから切り詰める（先に切り詰めると、境界をまたぐ秘密情報の一部が残るため。PBI-35 レビュー指摘）
      const reason = hideSecret(error instanceof Error ? error.message : String(error), secret);
      throw new Error(reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}…` : reason);
    }
  }

  private async requestToken(
    spec: NonNullable<Platform["auth"]["token"]>,
    secret: string,
  ): Promise<{ value: string; expiresAt: number }> {
    const now = this.deps.now ?? Date.now;
    const headers = new Headers(fill(spec.headers, secret) as Record<string, string>);
    let body: string | undefined;
    if (spec.json !== undefined) {
      body = JSON.stringify(fill(spec.json, secret));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (spec.form) {
      body = new URLSearchParams(fill(spec.form, secret) as Record<string, string>).toString();
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded");
      }
    }
    const res = await (this.deps.fetchImpl ?? fetch)(tokenUrl(spec.url, spec.query, secret), {
      method: spec.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      // 本文は切り詰めずに渡す（呼び出し元で、秘密情報を伏せてから切り詰める）
      throw new Error(`token endpoint returned ${res.status}: ${text}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("token endpoint did not return JSON");
    }
    const value = at(parsed, spec.tokenPath);
    if (typeof value !== "string" || !value) {
      throw new Error(`no token at ${spec.tokenPath} in the token endpoint response`);
    }
    const expires = spec.expiresInPath ? Number(at(parsed, spec.expiresInPath)) : Number.NaN;
    const seconds = Number.isFinite(expires) && expires > 0 ? expires : spec.ttlSec;
    return { value, expiresAt: now() + seconds * 1000 };
  }
}

/** 工程エージェントに伝える、使える組織内 PF と API（PBI-35）。 */
export function platformPromptLines(platforms: readonly Platform[]): string[] {
  if (platforms.length === 0) return [];
  return [
    "",
    "--- 使える組織内 PF の API ---",
    '次の組織内 PF の API を、環境変数 SACTY_PF_URL の下の URL で呼べます（例 curl "$SACTY_PF_URL/<PF の名前>/api/..."）。',
    "認証は sacty のゲートウェイが付けるので、認証のヘッダーやキーは付けないでください。一覧に無い API は拒否されます（403）。",
    ...platforms.flatMap((p) => [
      `- ${p.name}${p.description ? `：${p.description}` : ""}（$SACTY_PF_URL/${p.name}）`,
      ...p.allow.map((rule) => `  - ${rule}`),
    ]),
  ];
}
