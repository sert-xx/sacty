import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 画面の認証（PBI-129）。`sacty up` が起動ごとに作る秘密（環境変数）を、端末に表示した URL で受け取った
 * ブラウザにだけ cookie を渡す。工程のコンテナもホストの 127.0.0.1 に届くため、呼び出し元を確かめずに
 * デーモンのトークンを付けて中継しないようにする。秘密は、工程のコンテナには渡さない（デーモンにも渡さない）。
 */
export const WEB_TOKEN_ENV = "SACTY_WEB_TOKEN";
/** 画面のポート（cookie の名前に入れる。同じホストで別のポートの sacty の cookie を上書きしないように）。 */
export const WEB_PORT_ENV = "SACTY_WEB_PORT";
/** 端末に表示する、入り口の URL のパスと、秘密を渡すパラメーター。 */
export const AUTH_PATH = "/auth";
export const AUTH_TOKEN_PARAM = "token";

/** 入れたブラウザに渡す cookie。秘密そのものではなく、秘密から作った値を入れる。起動し直すと秘密が変わり、使えなくなる。 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  // 通知（Slack など）のリンクから開いたときも送る。操作（Server Actions）は同じオリジンからだけ
  sameSite: "lax",
  path: "/",
  maxAge: 30 * 24 * 60 * 60,
} as const;

/** cookie の名前。ポートが分からなければ、ポートを付けない。 */
export function sessionCookieName(port: string | undefined): string {
  return port && /^\d{1,5}$/.test(port) ? `sacty-session-${port}` : "sacty-session";
}

/** 秘密から作る、cookie の値。 */
export function sessionValue(secret: string): string {
  return createHmac("sha256", secret).update("sacty-web-session").digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** cookie の値が、今の起動の秘密から作ったものか。秘密が無ければ、どれも認めない。 */
export function isValidSession(value: string | undefined, secret: string | undefined): boolean {
  return !!secret && !!value && safeEqual(value, sessionValue(secret));
}

/** 入り口の URL の秘密が、今の起動の秘密か。 */
export function isValidLoginToken(token: string | null, secret: string | undefined): boolean {
  return !!secret && !!token && safeEqual(token, secret);
}

/**
 * 受け付ける Host か（DNS rebinding の対策）。`sacty up` は 127.0.0.1 で待ち受けるので、ループバックの名前だけを
 * 受け付ける（ポートは問わない。ポートを転送して開くこともあるため）。Host は偽れるので、これだけで認証の代わりにはしない。
 */
export function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d{1,5})?$/.exec(host.trim().toLowerCase());
  return !!m && ["127.0.0.1", "localhost", "[::1]"].includes(m[1] ?? "");
}
