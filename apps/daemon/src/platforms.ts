import { code, type DaemonText, message } from "@sacty/core";
import { z } from "zod";
import { errorText } from "./errors.js";
import { SecretRef, type SecretStore } from "./secrets.js";

/**
 * 社内 PF の API（PBI-35）。ホストのゲートウェイが、ホワイトリストに合うリクエストだけを、PF の認証を付けて
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

const TokenRequest = z.object({
  /** トークンの窓口。 */
  url: z.url({ protocol: /^https?$/ }),
  method: Method.default("POST"),
  /** 窓口に送るヘッダー（{{secret}} に秘密情報の値を入れる）。 */
  headers: z.record(HeaderName, z.string()).default({}),
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
});

export const PlatformFile = z.object({
  /** 転送先（例 https://ticket.internal.example.com）。 */
  upstream: z.url({ protocol: /^https?$/ }),
  /** エージェントに伝える、PF の説明。 */
  description: z.string().default(""),
  auth: z
    .object({
      /** 認証を付けるヘッダー（社内で定義した独自のヘッダーも書ける）。 */
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
      json?: unknown;
      form?: Record<string, string>;
      secret: string;
      tokenPath: string;
      expiresInPath?: string;
      ttlSec: number;
    };
  };
  allow: string[];
};

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

/** 文から秘密情報を伏せる。値そのもの・JSON の文字列にした形・各行（短すぎる行は除く）を伏せる。 */
export function hideSecret(text: string, secret: string): string {
  if (!secret) return text;
  const forms = [secret, JSON.stringify(secret).slice(1, -1), ...secret.split(/\r?\n/)]
    .filter((f) => f.length >= 4)
    .sort((a, b) => b.length - a.length);
  return forms.reduce((t, f) => t.split(f).join("[secret]"), text);
}

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
      this.problems.delete(platform.name);
      return `${platform.auth.prefix}${value}`;
    } catch (error) {
      this.problems.set(
        platform.name,
        message("gateway.platformUnavailable", { name: platform.name, detail: errorText(error) }),
      );
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
      throw new Error(hideSecret(error instanceof Error ? error.message : String(error), secret));
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
    const res = await (this.deps.fetchImpl ?? fetch)(spec.url, {
      method: spec.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`token endpoint returned ${res.status}: ${text.slice(0, 500)}`);
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

/** 工程エージェントに伝える、使える社内 PF と API（PBI-35）。 */
export function platformPromptLines(platforms: readonly Platform[]): string[] {
  if (platforms.length === 0) return [];
  return [
    "",
    "--- 使える社内 PF の API ---",
    '次の社内 PF の API を、環境変数 SACTY_PF_URL の下の URL で呼べます（例 curl "$SACTY_PF_URL/<PF の名前>/api/..."）。',
    "認証は sacty のゲートウェイが付けるので、認証のヘッダーやキーは付けないでください。一覧に無い API は拒否されます（403）。",
    ...platforms.flatMap((p) => [
      `- ${p.name}${p.description ? `：${p.description}` : ""}（$SACTY_PF_URL/${p.name}）`,
      ...p.allow.map((rule) => `  - ${rule}`),
    ]),
  ];
}
