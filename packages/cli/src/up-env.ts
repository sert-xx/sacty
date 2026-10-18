/**
 * `sacty up` が子プロセス（デーモン・画面）に渡す環境変数と、端末に表示する入り口の URL（PBI-129）。
 * 画面の秘密（SACTY_WEB_TOKEN）は画面にだけ渡す。デーモンは工程のコンテナを動かすので、デーモンには渡さない
 * （利用者のシェルに同じ名前の変数があっても、取り除いてから渡す）。
 */
export const WEB_TOKEN_ENV = "SACTY_WEB_TOKEN";
export const WEB_PORT_ENV = "SACTY_WEB_PORT";

type Env = Record<string, string | undefined>;

function withoutWebToken(base: Env): Env {
  const { [WEB_TOKEN_ENV]: _, ...rest } = base;
  return rest;
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

export function webEnv(
  base: Env,
  input: { daemonUrl: string; daemonToken: string; webPort: number; webToken: string },
): Env {
  return {
    ...base,
    SACTY_DAEMON_URL: input.daemonUrl,
    SACTY_DAEMON_TOKEN: input.daemonToken,
    [WEB_TOKEN_ENV]: input.webToken,
    [WEB_PORT_ENV]: String(input.webPort),
  };
}

/** 端末に表示する、画面の入り口の URL。開いたブラウザに、今の起動の間だけ使える cookie が渡る。 */
export function signInUrl(webPort: number, webToken: string): string {
  return `http://127.0.0.1:${webPort}/auth?token=${encodeURIComponent(webToken)}`;
}
