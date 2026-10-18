/**
 * `sacty up` が子プロセス（デーモン・画面）に渡す環境変数と、端末に表示する入り口の URL（PBI-129）。
 * 画面の秘密（SACTY_WEB_TOKEN）は画面にだけ渡す。デーモンは工程のコンテナを動かすので、デーモンには渡さない
 * （利用者のシェルに同じ名前の変数があっても、取り除いてから渡す）。
 */
import type { ConfigResult } from "@sacty/daemon/config";

export const WEB_TOKEN_ENV = "SACTY_WEB_TOKEN";
export const WEB_PORT_ENV = "SACTY_WEB_PORT";
/** 画面の認証を OFF にした（config.yaml の web.auth: false。PBI-133）ことを画面に伝える。値は "off"。 */
export const WEB_AUTH_ENV = "SACTY_WEB_AUTH";

type Env = Record<string, string | undefined>;

/** 画面の秘密と、認証を OFF にする指定は、利用者のシェルにあっても取り除く（設定ファイルからだけ決める。PBI-133）。 */
function withoutWebToken(base: Env): Env {
  const { [WEB_TOKEN_ENV]: _, [WEB_AUTH_ENV]: __, ...rest } = base;
  return rest;
}

/**
 * 画面の認証を使うか（PBI-133）。config.yaml の web.auth が false のときだけ使わない。設定ファイルが無い・読めないときは
 * 使う（安全側）。
 */
export function webAuthEnabled(config: ConfigResult): boolean {
  return !config.ok || config.config.webAuth;
}

export function daemonEnv(
  base: Env,
  input: { daemonPort: number; daemonToken: string; webPort: number },
): Env {
  return {
    ...withoutWebToken(base),
    SACTY_DAEMON_PORT: String(input.daemonPort),
    SACTY_DAEMON_TOKEN: input.daemonToken,
    // 通知のリンクに使う、画面の URL（PBI-38）
    SACTY_WEB_URL: `http://127.0.0.1:${input.webPort}`,
  };
}

/** webToken が無ければ、画面の認証を OFF にする（PBI-133）。 */
export function webEnv(
  base: Env,
  input: { daemonUrl: string; daemonToken: string; webPort: number; webToken?: string },
): Env {
  return {
    ...withoutWebToken(base),
    SACTY_DAEMON_URL: input.daemonUrl,
    SACTY_DAEMON_TOKEN: input.daemonToken,
    ...(input.webToken ? { [WEB_TOKEN_ENV]: input.webToken } : { [WEB_AUTH_ENV]: "off" }),
    [WEB_PORT_ENV]: String(input.webPort),
  };
}

/** 端末に表示する、画面の入り口の URL。開いたブラウザに、今の起動の間だけ使える cookie が渡る。 */
export function signInUrl(webPort: number, webToken: string): string {
  return `http://127.0.0.1:${webPort}/auth?token=${encodeURIComponent(webToken)}`;
}

/** 起動したときに端末に表示する文（PBI-133）。認証を OFF にしたなら、画面の URL と、その危険を表示する。 */
export function startMessage(webPort: number, webToken: string | undefined): string {
  if (webToken) return `\n[sacty] Open ${signInUrl(webPort, webToken)} in your browser.\n`;
  return [
    "",
    `[sacty] Open http://127.0.0.1:${webPort} in your browser.`,
    "[sacty] 警告：画面の認証を OFF にしています（config.yaml の web.auth: false）。工程のコンテナで動くコードが、画面を通して承認や設定の変更をできます。",
    "",
  ].join("\n");
}
