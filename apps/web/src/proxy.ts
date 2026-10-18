import type { NextRequest } from "next/server";
import { WEB_AUTH_ENV, WEB_PORT_ENV, WEB_TOKEN_ENV, webAuthDisabled } from "@/lib/web-auth";
import { webGuard } from "@/lib/web-guard";

/** 画面へのすべてのリクエストで、起動した本人のブラウザかを確かめる（PBI-129）。 */
export function proxy(request: NextRequest) {
  return webGuard(request, {
    secret: process.env[WEB_TOKEN_ENV],
    port: process.env[WEB_PORT_ENV],
    authOff: webAuthDisabled(process.env[WEB_AUTH_ENV]),
  });
}

export const config = {
  // ビルドした静的なファイルとアイコンだけは、認証の前でも返す（断る画面も中身を持たない）
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)"],
};
