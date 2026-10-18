import { type NextRequest, NextResponse } from "next/server";
import { messagesFor } from "@/i18n";
import { LANG_COOKIE, pickLocale } from "@/i18n/locale";
import {
  AUTH_PATH,
  AUTH_TOKEN_PARAM,
  isAllowedHost,
  isValidLoginToken,
  isValidSession,
  SESSION_COOKIE_OPTIONS,
  sessionCookieName,
  sessionValue,
} from "@/lib/web-auth";

/**
 * 画面へのすべてのリクエストの入り口（Proxy から呼ぶ。PBI-129）。Host を確かめ、入り口の URL なら cookie を渡し、
 * それ以外は今の起動の cookie が無ければ断る（中身は出さない）。デーモンへ中継する所（daemonFetch）でも確かめ直す。
 */
export function webGuard(
  request: NextRequest,
  env: { secret: string | undefined; port: string | undefined; authOff?: boolean },
): NextResponse {
  const m = messagesFor(
    pickLocale(request.cookies.get(LANG_COOKIE)?.value, request.headers.get("accept-language")),
  );
  if (!isAllowedHost(request.headers.get("host"))) {
    return refusal(403, m.locale, m.common.auth.title, m.common.auth.wrongHost);
  }
  // 認証を OFF にした（PBI-133）なら、Host だけを確かめて通す。入り口の URL はトップへ移す
  if (env.authOff) {
    return request.nextUrl.pathname === AUTH_PATH ? toHome(request) : NextResponse.next();
  }
  const cookieName = sessionCookieName(env.port);
  const signedIn = isValidSession(request.cookies.get(cookieName)?.value, env.secret);
  if (request.nextUrl.pathname === AUTH_PATH) {
    const token = request.nextUrl.searchParams.get(AUTH_TOKEN_PARAM);
    if (env.secret && isValidLoginToken(token, env.secret)) {
      const res = toHome(request);
      res.cookies.set(cookieName, sessionValue(env.secret), SESSION_COOKIE_OPTIONS);
      return res;
    }
    if (signedIn && token === null) return toHome(request);
  } else if (signedIn) {
    return NextResponse.next();
  }
  return refusal(
    401,
    m.locale,
    m.common.auth.title,
    env.secret ? m.common.auth.signIn : m.common.auth.notConfigured,
  );
}

/**
 * 入れたら、トップへ移す（秘密を含む URL をアドレスバーと履歴の先頭に残さない）。Proxy の転送先は絶対 URL でないと
 * Next.js が 500 にするので、ブラウザが開いている Host（ループバックと確かめ済み）から作る。nextUrl は 127.0.0.1 を
 * localhost に置き換えるので使わない（cookie を渡したホストから外れる）。
 */
function toHome(request: NextRequest): NextResponse {
  const home = `${request.nextUrl.protocol}//${request.headers.get("host")}/`;
  return new NextResponse(null, {
    status: 303,
    headers: { location: home, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/** 断るときの画面。ヘッダーなどの画面の部品はデーモンに問い合わせるので使わず、決まった文だけを返す。 */
function refusal(status: number, lang: string, title: string, text: string): NextResponse {
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>sacty</title><style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.7;color:#222;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}code{font-family:ui-monospace,monospace}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>")}</p></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
