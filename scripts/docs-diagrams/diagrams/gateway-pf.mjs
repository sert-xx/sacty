import { t } from "../lib.mjs";

// 仕様書「ゲートウェイ」：組織内 PF の中継の流れ
const X = { agent: 120, gw: 400, token: 690, pf: 930 };
const head = (id, x, icon, tone, title) => ({
  kind: "card",
  id,
  x: x - 95,
  y: 20,
  w: 190,
  h: 52,
  icon,
  tone,
  title,
});
const msg = (y, from, to, label, dashed = false) => ({
  kind: "message",
  y,
  x1: X[from],
  x2: X[to] + (X[to] > X[from] ? -2 : 2),
  label,
  dashed,
});
const self = (y, label) => ({ kind: "message", y, x1: X.gw, self: true, label });

export default {
  name: "gateway-pf",
  outputs: ["spec"],
  width: 1040,
  height: 600,
  title: t("組織内 PF の中継の流れ", "Relaying an internal PF request"),
  desc: t(
    "ゲートウェイはトークン・実行の範囲を確かめて PF を探し、パス・メソッドの上書き・読み取りだけ・allow を確かめ、必要ならトークンを取得してから、認証のヘッダーを付けて PF に送る。401・403 ならトークンを取り直して1回だけ送り直す。",
    "The gateway checks the token and the run's scope, looks up the PF, checks the path, method overrides, read-only, and allow, fetches a token if needed, and sends the request with the auth header. On 401 or 403 it refreshes the token and resends once.",
  ),
  items: [
    head("a", X.agent, "box", "blue", t("エージェント", "Agent")),
    head("g", X.gw, "shield", "green", t("ゲートウェイ", "Gateway")),
    head("t", X.token, "key", "amber", t("トークンの窓口", "Token endpoint")),
    head("p", X.pf, "server", "gray", t("PF（upstream）", "PF (upstream)")),
    ...Object.values(X).map((x) => ({ kind: "lifeline", x, y1: 72, y2: 585 })),
    msg(110, "agent", "gw", t("/r/トークン/pf/名前/パス", "/r/token/pf/name/path")),
    self(
      135,
      t(
        "トークン（401）・実行の範囲（403）を確かめ、PF を探す（404）",
        "Check token (401) and run scope (403); find host or project PF (404)",
      ),
    ),
    self(
      185,
      t(
        "URL で変わるパス・メソッドの上書きは 400、読み取りだけ・allow は 403",
        "Path changes, method overrides: 400; read-only, allow: 403",
      ),
    ),
    {
      kind: "frame",
      x: 330,
      y: 230,
      w: 430,
      h: 112,
      tone: "amber",
      label: t(
        "auth.token で、トークンが無いか期限の30秒前を過ぎた",
        "auth.token, and no token or within 30 s of expiry",
      ),
    },
    msg(282, "gw", "token", t("キーを入れて取得する", "Request a token with the key")),
    msg(320, "token", "gw", t("トークンと期限", "Token and expiry"), true),
    msg(
      380,
      "gw",
      "pf",
      t(
        "エージェントの認証・cookie を除き、認証のヘッダーを付けて送る",
        "Drop the agent's auth and cookies, add the auth header, send",
      ),
    ),
    msg(418, "pf", "gw", t("応答", "Response"), true),
    {
      kind: "frame",
      x: 330,
      y: 440,
      w: 660,
      h: 100,
      tone: "amber",
      label: t("auth.token の PF が 401・403 を返した", "A PF with auth.token returned 401 or 403"),
    },
    msg(484, "gw", "token", t("トークンを取り直す", "Fetch the token again")),
    msg(522, "gw", "pf", t("1回だけ送り直す", "Resend once")),
    msg(
      568,
      "gw",
      "agent",
      t("応答（リダイレクトはたどらない）", "Response (redirects not followed)"),
      true,
    ),
  ],
};
