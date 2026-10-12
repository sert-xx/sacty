import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  hideSecret,
  isAllowed,
  type Platform,
  PlatformCredentials,
  PlatformFile,
  platformPromptLines,
  toPlatform,
} from "./platforms.js";
import { MemorySecretStore } from "./secrets.js";

const platform = (file: unknown, name = "ticket"): Platform =>
  toPlatform(name, PlatformFile.parse(file));

const ticket = platform({
  upstream: "https://ticket.internal.example.com/",
  description: "社内のチケット管理",
  auth: { header: "X-Internal-Token", secret: "ticket-token" },
  allow: ["GET /api/v1/tickets/**", "POST /api/v1/tickets/*/comments", "GET /health"],
});

/** トークンの窓口の偽物。 */
function tokenEndpoint(responses: (Response | (() => Response))[]) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: new Headers(init.headers),
      body: String(init.body ?? ""),
    });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const deploy = (extra: Record<string, unknown> = {}) =>
  platform(
    {
      upstream: "https://deploy.internal.example.com",
      auth: {
        prefix: "Bearer ",
        token: {
          url: "https://auth.internal.example.com/api/token",
          json: { apiKey: "{{secret}}", scope: ["deploy"] },
          secret: "deploy-key",
          token_path: "data.accessToken",
          expires_in_path: "data.expiresIn",
          ...extra,
        },
      },
      allow: ["GET /api/**"],
    },
    "deploy",
  );

describe("社内 PF の API（PBI-35）", () => {
  it("設定：認証は固定のキーかトークンの取得のどちらか一方。使える API は「メソッド パス」", () => {
    expect(ticket).toMatchObject({
      name: "ticket",
      upstream: "https://ticket.internal.example.com",
      auth: { header: "X-Internal-Token", prefix: "", secret: "ticket-token" },
    });
    const parse = (file: unknown) => {
      const r = PlatformFile.safeParse(file);
      return r.success ? "" : renderMessage(r.error.issues[0]?.message, "ja");
    };
    const base = { upstream: "https://x.example.com", allow: ["GET /a"] };
    expect(parse({ ...base, auth: {} })).toMatch(/どちらか一方/);
    expect(
      parse({
        ...base,
        auth: { secret: "k", token: { url: "https://a", secret: "k", token_path: "t" } },
      }),
    ).toMatch(/どちらか一方/);
    expect(parse({ ...base, auth: { secret: "k" }, allow: ["get /a"] })).toMatch(
      /「メソッド パス」/,
    );
    expect(parse({ ...base, auth: { secret: "k" }, allow: [] })).not.toBe("");
    expect(parse({ ...base, auth: { header: "X Token", secret: "k" } })).toMatch(/ヘッダーの名前/);
  });

  it("ホワイトリスト：* は1階層、** はそれ以下すべて。メソッドも合わせ、.. などは合わない", () => {
    expect(isAllowed(ticket, "GET", "/api/v1/tickets")).toBe(true);
    expect(isAllowed(ticket, "GET", "/api/v1/tickets/42")).toBe(true);
    expect(isAllowed(ticket, "GET", "/api/v1/tickets/42/history?page=2")).toBe(true);
    expect(isAllowed(ticket, "get", "/health")).toBe(true);
    expect(isAllowed(ticket, "POST", "/api/v1/tickets/42/comments")).toBe(true);
    expect(isAllowed(ticket, "POST", "/api/v1/tickets/42/43/comments")).toBe(false);
    expect(isAllowed(ticket, "DELETE", "/api/v1/tickets/42")).toBe(false);
    expect(isAllowed(ticket, "GET", "/api/v1/users")).toBe(false);
    expect(isAllowed(ticket, "GET", "/healthz")).toBe(false);
    expect(isAllowed(ticket, "GET", "/api/v1/tickets/../users")).toBe(false);
    expect(isAllowed(ticket, "GET", "/api/v1/tickets/%2e%2e/users")).toBe(false);
  });

  it("固定のキーは、秘密情報をそのまま（前置きを付けて）ヘッダーの値にする", async () => {
    const creds = new PlatformCredentials({
      secrets: new MemorySecretStore({ "ticket-token": "tkt-123" }),
    });
    expect(await creds.header(ticket)).toBe("tkt-123");
  });

  it("トークン：窓口に秘密情報を入れた本文を送り、応答の場所からトークンと期限を読む。期限の前に取り直す", async () => {
    let now = 0;
    const endpoint = tokenEndpoint([
      () => Response.json({ data: { accessToken: "jwt-1", expiresIn: 300 } }),
      () => Response.json({ data: { accessToken: "jwt-2", expiresIn: 300 } }),
    ]);
    const creds = new PlatformCredentials({
      secrets: new MemorySecretStore({ "deploy-key": "api-key-xyz" }),
      fetchImpl: endpoint.fetchImpl,
      now: () => now,
    });
    const p = deploy();
    // 同時に求められても、窓口には1回だけ問い合わせる
    const [a, b] = await Promise.all([creds.header(p), creds.header(p)]);
    expect([a, b]).toEqual(["Bearer jwt-1", "Bearer jwt-1"]);
    expect(endpoint.calls).toHaveLength(1);
    expect(endpoint.calls[0]).toMatchObject({
      url: "https://auth.internal.example.com/api/token",
      method: "POST",
      body: '{"apiKey":"api-key-xyz","scope":["deploy"]}',
    });
    expect(endpoint.calls[0]?.headers.get("content-type")).toBe("application/json");
    now = 200_000;
    expect(await creds.header(p)).toBe("Bearer jwt-1");
    // 期限（300秒）の30秒前を過ぎたら、取り直す
    now = 271_000;
    expect(await creds.header(p)).toBe("Bearer jwt-2");
    expect(endpoint.calls).toHaveLength(2);
  });

  it("トークン：フォームの本文・ヘッダーにも秘密情報を入れられ、期限が分からなければ持つ時間を使う。拒否されたら捨てて取り直す", async () => {
    let now = 0;
    const endpoint = tokenEndpoint([
      () => Response.json({ token: "t1" }),
      () => Response.json({ token: "t2" }),
    ]);
    const creds = new PlatformCredentials({
      secrets: new MemorySecretStore({ "deploy-key": "k" }),
      fetchImpl: endpoint.fetchImpl,
      now: () => now,
    });
    const p = platform(
      {
        upstream: "https://pf.example.com",
        auth: {
          header: "X-Session",
          token: {
            url: "https://pf.example.com/login",
            headers: { "X-Api-Key": "{{secret}}" },
            form: { grant: "api_key", key: "{{secret}}" },
            secret: "deploy-key",
            token_path: "token",
            ttl_sec: 60,
          },
        },
        allow: ["GET /**"],
      },
      "pf",
    );
    expect(await creds.header(p)).toBe("t1");
    expect(endpoint.calls[0]?.headers.get("x-api-key")).toBe("k");
    expect(endpoint.calls[0]?.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(endpoint.calls[0]?.body).toBe("grant=api_key&key=k");
    now = 29_000;
    expect(await creds.header(p)).toBe("t1");
    creds.invalidate(p);
    expect(await creds.header(p)).toBe("t2");
  });

  it("用意できなければ PF ごとに理由を持ち（秘密情報は出さない）、用意できたら消す", async () => {
    const endpoint = tokenEndpoint([
      () => new Response("invalid key: api-key-xyz", { status: 401 }),
      () => Response.json({ data: { accessToken: "jwt" } }),
    ]);
    const creds = new PlatformCredentials({
      secrets: new MemorySecretStore({ "deploy-key": "api-key-xyz" }),
      fetchImpl: endpoint.fetchImpl,
    });
    const p = deploy();
    await expect(creds.header(p)).rejects.toThrow(/token endpoint returned 401/);
    const [problem] = creds.unavailable(["deploy", "ticket"]);
    const text = renderMessage(problem, "ja");
    expect(text).toMatch(
      /^社内 PF「deploy」の認証情報を用意できません：token endpoint returned 401/,
    );
    expect(text).not.toContain("api-key-xyz");
    expect(await creds.header(p)).toBe("Bearer jwt");
    expect(creds.unavailable(["deploy"])).toEqual([]);
  });

  it("トークンの取得のどの失敗でも、理由に秘密情報を出さない（ヘッダーの組み立ての失敗など。レビュー指摘）", async () => {
    const endpoint = tokenEndpoint([]);
    const creds = new PlatformCredentials({
      secrets: new MemorySecretStore({ "deploy-key": "FAKE-SECRET\nBAD" }),
      fetchImpl: endpoint.fetchImpl,
    });
    const p = platform(
      {
        upstream: "https://pf.example.com",
        auth: {
          token: {
            url: "https://pf.example.com/login",
            headers: { "X-Key": "{{secret}}" },
            secret: "deploy-key",
            token_path: "token",
          },
        },
        allow: ["GET /**"],
      },
      "pf",
    );
    const error = await creds.header(p).catch((e: Error) => e);
    expect(String(error)).toContain("[secret]");
    expect(String(error)).not.toContain("FAKE-SECRET");
    expect(String(error)).not.toContain("BAD");
    const [problem] = creds.unavailable(["pf"]);
    expect(renderMessage(problem, "ja")).not.toContain("FAKE-SECRET");
    expect(endpoint.calls).toHaveLength(0);
    // 値そのもの・JSON の文字列にした形・各行を伏せる
    expect(hideSecret('a "FAKE-SECRET\\nBAD" b FAKE-SECRET\nBAD', "FAKE-SECRET\nBAD")).toBe(
      'a "[secret]" b [secret]',
    );
  });

  it("工程エージェントに、使える PF と API と、呼び方を伝える", () => {
    expect(platformPromptLines([])).toEqual([]);
    const lines = platformPromptLines([ticket]).join("\n");
    expect(lines).toContain('curl "$SACTY_PF_URL/<PF の名前>/api/...');
    expect(lines).toContain("- ticket：社内のチケット管理（$SACTY_PF_URL/ticket）");
    expect(lines).toContain("  - POST /api/v1/tickets/*/comments");
    expect(lines).toContain("認証のヘッダーやキーは付けないでください");
  });
});
