import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config } from "../proxy";
import { sessionValue } from "./web-auth";
import { webGuard } from "./web-guard";

const SECRET = "now-secret";
const env = { secret: SECRET, port: "4700" };
const COOKIE = "sacty-session-4700";

function request(
  path: string,
  init: { cookie?: string; host?: string; method?: string; headers?: Record<string, string> } = {},
) {
  return new NextRequest(`http://127.0.0.1:4700${path}`, {
    method: init.method ?? "GET",
    headers: {
      host: init.host ?? "127.0.0.1:4700",
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
  });
}
const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("画面の入り口で、起動した本人のブラウザかを確かめる（PBI-129）", () => {
  it("cookie が無ければ、画面・取り直し・ダウンロード・操作（Server Actions）を断り、中身を出さない", async () => {
    for (const r of [
      request("/dashboard"),
      request("/live/projects"),
      request("/live/tasks/t1/runs/r1"),
      request("/tasks/t1/runs/r1/raw/output.log"),
      request("/projects/p1/audit/report"),
      request("/tasks/t1", { method: "POST", headers: { "next-action": "abc" } }),
    ]) {
      const res = webGuard(r, env);
      expect(res.status).toBe(401);
      expect(passed(res)).toBe(false);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("sacty up");
    }
  });

  it("誤った cookie・前の起動の cookie・別のポートの cookie は断る", () => {
    for (const cookie of [
      `${COOKIE}=wrong`,
      `${COOKIE}=${sessionValue("before-secret")}`,
      `${COOKIE}=${SECRET}`,
      `sacty-session-4800=${sessionValue(SECRET)}`,
    ]) {
      expect(webGuard(request("/dashboard", { cookie }), env).status).toBe(401);
    }
  });

  it("今の起動の cookie があれば、今までどおり通す", () => {
    const res = webGuard(
      request("/dashboard", { cookie: `${COOKIE}=${sessionValue(SECRET)}` }),
      env,
    );
    expect(passed(res)).toBe(true);
  });

  it("入り口の URL を開くと cookie を渡してトップへ移し、その cookie で使える", () => {
    const res = webGuard(request(`/auth?token=${SECRET}`), env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:4700/");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const set = res.cookies.get(COOKIE);
    expect(set?.value).toBe(sessionValue(SECRET));
    expect(set?.httpOnly).toBe(true);
    expect(set?.sameSite).toBe("lax");
    expect(set?.path).toBe("/");
    const next = webGuard(request("/dashboard", { cookie: `${COOKIE}=${set?.value}` }), env);
    expect(passed(next)).toBe(true);
  });

  it("入り口の URL の秘密が誤り・前の起動のもの・空なら、cookie を渡さない", () => {
    for (const path of [
      "/auth?token=wrong",
      "/auth?token=before-secret",
      "/auth?token=",
      "/auth",
    ]) {
      const res = webGuard(request(path), env);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("転送先は、ブラウザが開いているホストのまま（cookie を渡したホストから外れない）", () => {
    for (const host of ["127.0.0.1:4700", "localhost:4700", "[::1]:4700"]) {
      const res = webGuard(request(`/auth?token=${SECRET}`, { host }), env);
      expect(res.headers.get("location")).toBe(`http://${host}/`);
    }
  });

  it("入った後に入り口のパスだけを開いたら、トップへ移す（誤った秘密なら断る）", () => {
    const cookie = `${COOKIE}=${sessionValue(SECRET)}`;
    expect(webGuard(request("/auth", { cookie }), env).headers.get("location")).toBe(
      "http://127.0.0.1:4700/",
    );
    expect(webGuard(request("/auth?token=wrong", { cookie }), env).status).toBe(401);
  });

  it("Host を偽っても、cookie が無ければ通さない。ループバック以外の Host は cookie があっても断る", () => {
    // 工程のコンテナが Host と Origin をそろえて偽る
    const forged = request("/tasks/t1", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4700", "next-action": "abc" },
    });
    expect(webGuard(forged, env).status).toBe(401);
    const cookie = `${COOKIE}=${sessionValue(SECRET)}`;
    expect(
      webGuard(request("/dashboard", { host: "host.docker.internal:4700", cookie }), env).status,
    ).toBe(403);
    expect(webGuard(request("/dashboard", { host: "evil.example:4700", cookie }), env).status).toBe(
      403,
    );
    expect(webGuard(request(`/auth?token=${SECRET}`, { host: "evil.example" }), env).status).toBe(
      403,
    );
  });

  it("秘密が無ければ（sacty up で起動していない）、どれも断り、起動の仕方を出す", async () => {
    const res = webGuard(request("/dashboard", { cookie: `${COOKIE}=${sessionValue("")}` }), {
      secret: undefined,
      port: "4700",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("画面の認証が設定されていません");
    expect(webGuard(request("/auth?token="), { secret: "", port: "4700" }).status).toBe(401);
  });

  it("断る画面は、画面の言語で出す", async () => {
    const en = webGuard(request("/dashboard", { headers: { "accept-language": "en-US" } }), env);
    expect(await en.text()).toContain("Sign in to sacty");
    const ja = webGuard(request("/dashboard", { headers: { "accept-language": "ja" } }), env);
    expect(await ja.text()).toContain("sacty に入る");
  });
});

describe("Proxy の範囲（PBI-129）", () => {
  it.each([
    "/",
    "/auth",
    "/dashboard",
    "/live/projects",
    "/tasks/t1/runs/r1/raw/output.log",
    "/projects/p1/export",
    "/switch",
  ])("%s を確かめる", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
  });

  it.each(["/_next/static/chunks/app.js", "/favicon.ico", "/icon.svg"])(
    "%s は確かめない（静的なファイル）",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    },
  );
});
