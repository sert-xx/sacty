import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  hideSecret,
  isAllowed,
  mergePlatforms,
  type Platform,
  PlatformCredentials,
  PlatformFile,
  platformPromptLines,
  platformSummary,
  tokenUrl,
  toPlatform,
} from "./platforms.js";
import { MemorySecretStore } from "./secrets.js";

const platform = (file: unknown, name = "ticket"): Platform =>
  toPlatform(name, PlatformFile.parse(file));

const ticket = platform({
  upstream: "https://ticket.internal.example.com/",
  description: "チケット管理",
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

describe("組織内 PF の API（PBI-35）", () => {
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
      /^組織内 PF「deploy」の認証情報を用意できません：token endpoint returned 401/,
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
    // 窓口の失敗の応答で、切り詰める境界をまたぐ秘密情報も伏せる（レビュー指摘）
    const secret = "FAKE-SECRET-0123456789-abcdefghijk";
    for (const pad of [470, 480, 590, 595]) {
      const boundary = new PlatformCredentials({
        secrets: new MemorySecretStore({ "deploy-key": secret }),
        fetchImpl: tokenEndpoint([new Response(`${"x".repeat(pad)}${secret}`, { status: 401 })])
          .fetchImpl,
      });
      const failed = String(await boundary.header(deploy()).catch((e: Error) => e));
      expect(failed).not.toContain(secret.slice(0, 8));
      expect(failed.length).toBeLessThan(700);
    }
    // 値そのもの・JSON の文字列にした形・各行を伏せる
    expect(hideSecret('a "FAKE-SECRET\\nBAD" b FAKE-SECRET\nBAD', "FAKE-SECRET\nBAD")).toBe(
      'a "[secret]" b [secret]',
    );
    // URL エンコードできない値（対になっていないサロゲート）でも、伏せる処理は失敗しない（PBI-93）
    expect(hideSecret("x FAKE-\ud800-KEY y", "FAKE-\ud800-KEY")).toBe("x [secret] y");
  });

  describe("キーをクエリのパラメーターで送る窓口（PBI-93）", () => {
    // URL エンコードで形が変わる文字（+ / = & ' # 空白 非 ASCII）を含めたキー
    // encodeURIComponent が残す !'()* も変える
    const key = "FAKE-KEY+a/b=c&d'e#f gé(1)*!";
    const encodedKey = "FAKE-KEY%2Ba%2Fb%3Dc%26d%27e%23f%20g%C3%A9%281%29%2A%21";
    const queryPf = (extra: Record<string, unknown> = {}) =>
      platform(
        {
          upstream: "https://pf.example.com",
          auth: {
            prefix: "Bearer ",
            token: {
              url: "https://pf.example.com/auth/token",
              method: "GET",
              query: { api_token: "{{secret}}" },
              secret: "pf-key",
              token_path: "token",
              ...extra,
            },
          },
          allow: ["GET /**"],
        },
        "pf",
      );

    it("設定：query を書ける。名前・値の誤り・url の {{secret}}・GET の本文は、わかる文で弾く", () => {
      const parse = (token: Record<string, unknown>, lang: "ja" | "en" = "ja") => {
        const r = PlatformFile.safeParse({
          upstream: "https://x.example.com",
          auth: {
            token: { url: "https://a.example.com/t", secret: "k", token_path: "t", ...token },
          },
          allow: ["GET /a"],
        });
        return r.success ? "" : renderMessage(r.error.issues[0]?.message, lang);
      };
      expect(parse({ method: "GET", query: { api_token: "{{secret}}", v: "2" } })).toBe("");
      expect(queryPf().auth.token).toMatchObject({
        method: "GET",
        query: { api_token: "{{secret}}" },
      });
      expect(parse({ query: { api_token: 123 } })).toMatch(/query は「名前: 値」/);
      expect(parse({ query: { "": "{{secret}}" } })).toMatch(/query は「名前: 値」/);
      expect(parse({ query: ["{{secret}}"] })).toMatch(/query は「名前: 値」/);
      expect(parse({ query: { api_token: 123 } }, "en")).toMatch(/Write the query for getting/);
      expect(parse({ url: "https://a.example.com/t?api_token={{secret}}" })).toMatch(
        /url には \{\{secret\}\} を書けません。.*query に書いて/,
      );
      expect(parse({ url: "https://a.example.com/t?api_token={{secret}}" }, "en")).toMatch(
        /cannot contain \{\{secret\}\}/,
      );
      expect(parse({ method: "GET", json: { k: "{{secret}}" } })).toMatch(
        /GET・HEAD のときは、json・form/,
      );
      expect(parse({ method: "HEAD", form: { k: "{{secret}}" } })).toMatch(
        /GET・HEAD のときは、json・form/,
      );
      // 今の検査（url は http・https）は保つ
      expect(parse({ url: "ftp://a.example.com/t", query: { k: "{{secret}}" } })).not.toBe("");
      // POST のときは、クエリと本文を一緒に書ける
      expect(parse({ query: { k: "{{secret}}" }, json: { a: 1 } })).toBe("");
    });

    it("config.yaml の gateway.platforms に書け、誤りはどの項目かを示して弾く", () => {
      const dir = mkdtempSync(join(tmpdir(), "sacty-pbi93-config-"));
      try {
        const write = (token: string) =>
          writeFileSync(
            join(dir, "config.yaml"),
            [
              "default_agent: x",
              "agents:",
              "  x:",
              "    runtime: codex",
              "    auth: { mode: bedrock, secret: bedrock-key, region: us-east-2 }",
              "    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }",
              "gateway:",
              "  platforms:",
              "    pf:",
              "      upstream: https://pf.example.com",
              "      auth:",
              "        token:",
              `          ${token}`,
              "      allow: [GET /**]",
            ].join("\n"),
          );
        write(
          '{ url: "https://pf.example.com/auth/token?v=1", method: GET, query: { api_token: "{{secret}}" }, secret: pf-key, token_path: token }',
        );
        expect(loadConfig(dir)).toMatchObject({
          ok: true,
          config: {
            platforms: [
              {
                name: "pf",
                auth: {
                  token: {
                    url: "https://pf.example.com/auth/token?v=1",
                    method: "GET",
                    query: { api_token: "{{secret}}" },
                  },
                },
              },
            ],
          },
        });
        write(
          '{ url: "https://pf.example.com/auth/token", query: { api_token: 1 }, secret: pf-key, token_path: token }',
        );
        const bad = loadConfig(dir);
        expect(bad.ok).toBe(false);
        expect(!bad.ok && renderMessage(bad.problem, "ja")).toMatch(
          /gateway\.platforms\.pf\.auth\.token\.query\.api_token.*query は「名前: 値」/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("GET で、キーを URL エンコードしたクエリで送り、本文なしで応答の場所からトークンを読む。期限・取り直しは今と同じ", async () => {
      let now = 0;
      const endpoint = tokenEndpoint([
        () => Response.json({ token: "ey-1" }),
        () => Response.json({ token: "ey-2" }),
        () => Response.json({ token: "ey-3" }),
      ]);
      const creds = new PlatformCredentials({
        secrets: new MemorySecretStore({ "pf-key": key }),
        fetchImpl: endpoint.fetchImpl,
        now: () => now,
      });
      const p = queryPf({ ttl_sec: 60 });
      expect(await creds.header(p)).toBe("Bearer ey-1");
      expect(endpoint.calls[0]).toMatchObject({
        url: `https://pf.example.com/auth/token?api_token=${encodedKey}`,
        method: "GET",
        body: "",
      });
      expect(endpoint.calls[0]?.headers.get("content-type")).toBeNull();
      // 送った URL を読み直すと、元のキーに戻る
      expect(new URL(endpoint.calls[0]?.url ?? "").searchParams.get("api_token")).toBe(key);
      now = 29_000;
      expect(await creds.header(p)).toBe("Bearer ey-1");
      now = 31_000;
      expect(await creds.header(p)).toBe("Bearer ey-2");
      creds.invalidate(p);
      expect(await creds.header(p)).toBe("Bearer ey-3");
      expect(endpoint.calls).toHaveLength(3);
    });

    it("url に元からあるクエリは書き換えずに残し、その後ろに足す（# 以降は送らない）", () => {
      expect(
        tokenUrl("https://a.example.com/t?v=2&x=a%20b+c", { api_token: "{{secret}}" }, key),
      ).toBe(`https://a.example.com/t?v=2&x=a%20b+c&api_token=${encodedKey}`);
      expect(
        tokenUrl("https://a.example.com/t?v=2#frag", { "my key": "pre-{{secret}}", n: "1" }, "k"),
      ).toBe("https://a.example.com/t?v=2&my%20key=pre-k&n=1");
      expect(tokenUrl("https://a.example.com/t?", { k: "{{secret}}" }, "s")).toBe(
        "https://a.example.com/t?k=s",
      );
      // クエリを書かなければ、url はそのまま
      expect(tokenUrl("https://a.example.com/t?v=2#frag", undefined, "s")).toBe(
        "https://a.example.com/t?v=2#frag",
      );
      expect(tokenUrl("https://a.example.com/t", {}, "s")).toBe("https://a.example.com/t");
    });

    it("キーの入った URL が、送信の失敗・HTTP のエラー・切り詰めの境界のどこでも理由に出ない", async () => {
      const lowerHex = encodedKey.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase());
      const leaks = (text: string) =>
        [key, encodedKey, lowerHex, encodeURIComponent(key), "FAKE-KEY"].filter((f) =>
          text.includes(f),
        );
      // fetch の失敗の文に、送った URL が入る（Node の fetch の「Failed to parse URL from …」など）
      const throwing = (async (url: string) => {
        throw new TypeError(`Failed to parse URL from ${url}`);
      }) as unknown as typeof fetch;
      const creds = new PlatformCredentials({
        secrets: new MemorySecretStore({ "pf-key": key }),
        fetchImpl: throwing,
      });
      const failed = String(await creds.header(queryPf()).catch((e: Error) => e));
      expect(failed).toContain("Failed to parse URL from https://pf.example.com/auth/token");
      expect(failed).toContain("[secret]");
      expect(leaks(failed)).toEqual([]);
      const [problem] = creds.unavailable(["pf"]);
      expect(leaks(renderMessage(problem, "ja"))).toEqual([]);
      expect(leaks(renderMessage(problem, "en"))).toEqual([]);
      // HTTP のエラーの本文に、窓口が URL を写す（16進の小文字・フォームの形を含む）。切り詰めの境界もまたぐ
      for (const echo of [
        `GET /auth/token?api_token=${encodedKey}`,
        `GET /auth/token?api_token=${lowerHex}`,
        `GET /auth/token?api_token=${encodeURIComponent(key)}`,
        `api_token=${new URLSearchParams({ s: key }).toString().slice(2)}`,
      ]) {
        for (const pad of [0, 560, 580, 595]) {
          const boundary = new PlatformCredentials({
            secrets: new MemorySecretStore({ "pf-key": key }),
            fetchImpl: tokenEndpoint([new Response(`${"x".repeat(pad)}${echo}`, { status: 403 })])
              .fetchImpl,
          });
          const reason = String(await boundary.header(queryPf()).catch((e: Error) => e));
          expect(reason).toContain("token endpoint returned 403");
          expect(leaks(reason)).toEqual([]);
          expect(reason.length).toBeLessThan(700);
        }
      }
    });

    it("エスケープの箇所ごとの16進の大文字・小文字の混在・空白の + と %20 の混在・二重のエンコードも伏せる（レビュー指摘）", () => {
      const k = "FAKE+a/b c d";
      for (const echo of [
        "FAKE%2ba%2Fb%20c%20d",
        "FAKE%2Ba%2fb+c%20d",
        "FAKE+a%2Fb c+d",
        "FAKE%252Ba%252fb%2520c+d",
        "%46AKE%2Ba%2Fb%20c%20d",
      ]) {
        const out = hideSecret(`token endpoint returned 403: GET /t?api_token=${echo}&v=1`, k);
        expect(out, echo).toBe("token endpoint returned 403: GET /t?api_token=[secret]&v=1");
      }
      // 非 ASCII の UTF-8 のバイトごとの混在
      expect(hideSecret("x=KéY-%c3%A9-z", "KéY-é-z")).toBe("x=[secret]");
      // キーと違う値は伏せない
      expect(hideSecret("?api_token=FAKE%2Ba%2Fb%20c%20e", k)).toBe(
        "?api_token=FAKE%2Ba%2Fb%20c%20e",
      );
    });

    it("短いキーのクエリの値の終わりは、値を続けられない文字なら何でもよい（: ) ] , ; 改行など。大文字・小文字・二重のエンコードとの組み合わせも。再レビュー指摘）", () => {
      const ends = [
        ":",
        ": forbidden",
        ")",
        "]",
        ",",
        ";",
        "\n",
        "\r\n",
        "\t",
        "'",
        '"',
        "/",
        "|",
        "!",
        "}",
        "*",
        "&x=1",
        "#f",
        "",
      ];
      for (const [key, value] of [
        ["abc", "abc"],
        ["abc", "%61b%63"],
        ["a+c", "a%2Bc"],
        ["a+c", "a%2bc"],
        ["a+c", "a%252bc"],
        ["a c", "a+c"],
        ["a c", "a%20c"],
      ] as const) {
        for (const end of ends) {
          const text = `403 from https://a.test/t?api_token=${value}${end}`;
          expect(hideSecret(text, key), JSON.stringify(text)).toBe(
            `403 from https://a.test/t?api_token=[secret]${end}`,
          );
        }
      }
      // 値を続ける文字（英数字・-._~・% と +）が後ろにあれば、別の値なので伏せない
      for (const more of ["d", "-", ".", "_", "~", "%41", "+"]) {
        expect(hideSecret(`?api_token=abc${more}`, "abc")).toBe(`?api_token=abc${more}`);
      }
    });

    it("送ったクエリの値（pre-{{secret}} など）は、短いキーでも値の丸ごとを伏せる（再レビュー指摘）", async () => {
      for (const [echo, end] of [
        ["pre-abc", ": forbidden"],
        ["pre-abc", ""],
        ["pre-abc", ")"],
        ["pre%2Dabc", "\n"],
        ["%70re-abc", ","],
        ["pre-abc", "-more"],
      ] as const) {
        // 送信の失敗の文に、送った URL が（書き方を変えて）入る場合
        const creds = new PlatformCredentials({
          secrets: new MemorySecretStore({ "pf-key": "abc" }),
          fetchImpl: (async () => {
            throw new TypeError(`connect failed https://a.test/t?v=1&api_token=${echo}${end}`);
          }) as unknown as typeof fetch,
        });
        const p = queryPf({ query: { api_token: "pre-{{secret}}", v: "1" } });
        const reason = String(await creds.header(p).catch((e: Error) => e));
        // 送る値はキーを入れたものだけを伏せる（キーの無い値 v=1 は残す）
        expect(reason, echo).toContain(`?v=1&api_token=[secret]${end}`);
        expect(renderMessage(creds.unavailable(["pf"])[0], "ja"), echo).toContain(
          `api_token=[secret]${end}`,
        );
      }
    });

    it("キーをクエリで送る窓口の失敗は、本文を写さず状態コードだけにする（名前付き・JSON などどんな形の写しも出さない。再々レビュー指摘）", async () => {
      for (const body of [
        "invalid api_token=abc",
        '{"error":"invalid","api_token":"abc"}',
        "api_token: abc",
        "key abc is not valid",
        `${"x".repeat(595)}abc`,
      ]) {
        const creds = new PlatformCredentials({
          secrets: new MemorySecretStore({ "pf-key": "abc" }),
          fetchImpl: tokenEndpoint([new Response(body, { status: 403 })]).fetchImpl,
        });
        const reason = String(await creds.header(queryPf()).catch((e: Error) => e));
        expect(reason).toBe(
          "Error: token endpoint returned 403 (the response body is not shown because the key is sent in the query)",
        );
        const shown = renderMessage(creds.unavailable(["pf"])[0], "ja");
        expect(shown).toContain("token endpoint returned 403");
        expect(shown).not.toContain("abc");
      }
      // pre-{{secret}} のように値の一部に入れたときも同じ。キーをクエリに入れない窓口は、これまでどおり本文を（伏せて）写す
      const pre = new PlatformCredentials({
        secrets: new MemorySecretStore({ "pf-key": "abc" }),
        fetchImpl: tokenEndpoint([new Response("bad api_token=pre-abc", { status: 401 })])
          .fetchImpl,
      });
      expect(
        String(
          await pre
            .header(queryPf({ query: { api_token: "pre-{{secret}}" } }))
            .catch((e: Error) => e),
        ),
      ).not.toContain("abc");
      const notInQuery = new PlatformCredentials({
        secrets: new MemorySecretStore({ "pf-key": "abcd" }),
        fetchImpl: tokenEndpoint([new Response("bad key abcd (v=2)", { status: 401 })]).fetchImpl,
      });
      expect(
        String(
          await notInQuery
            .header(queryPf({ query: { v: "2" }, headers: { "X-Key": "{{secret}}" } }))
            .catch((e: Error) => e),
        ),
      ).toBe("Error: token endpoint returned 401: bad key [secret] (v=2)");
    });

    it("1〜3文字のキーも、クエリの値として現れたら伏せる（ほかの所の短い文字列は置き換えない。レビュー指摘）", async () => {
      expect(hideSecret("403: GET /auth/token?api_token=abc", "abc")).toBe(
        "403: GET /auth/token?api_token=[secret]",
      );
      expect(hideSecret("?v=1&api_token=abc&x=abc#f", "abc")).toBe(
        "?v=1&api_token=[secret]&x=[secret]#f",
      );
      expect(hideSecret('"url":"https://a/t?k=a%20b"', "a b")).toBe(
        '"url":"https://a/t?k=[secret]"',
      );
      expect(hideSecret("?k=a+b ok", "a b")).toBe("?k=[secret] ok");
      expect(hideSecret("?k=%2b", "+")).toBe("?k=[secret]");
      // 長い文（ログなど）でも、? や & が並ぶ形で遅くならない
      const started = Date.now();
      for (const big of ["?".repeat(200_000), "&a".repeat(100_000), "?a=".repeat(70_000)]) {
        expect(hideSecret(big, "abc")).toBe(big);
      }
      expect(Date.now() - started).toBeLessThan(2_000);
      // 値の一部・クエリの外は、短いので置き換えない
      expect(hideSecret("?api_token=abcdef&n=xabc abc", "abc")).toBe(
        "?api_token=abcdef&n=xabc abc",
      );
      // 送信の失敗の文に URL が入っても、理由に短いキーを出さない
      const creds = new PlatformCredentials({
        secrets: new MemorySecretStore({ "pf-key": "abc" }),
        fetchImpl: (async (url: string) => {
          throw new TypeError(`Failed to parse URL from ${url}`);
        }) as unknown as typeof fetch,
      });
      const reason = String(await creds.header(queryPf()).catch((e: Error) => e));
      expect(reason).toContain("api_token=[secret]");
      expect(reason).not.toContain("api_token=abc");
      expect(renderMessage(creds.unavailable(["pf"])[0], "ja")).not.toContain("api_token=abc");
    });
  });

  it("工程エージェントに、使える PF と API と、呼び方を伝える", () => {
    expect(platformPromptLines([])).toEqual([]);
    const lines = platformPromptLines([ticket]).join("\n");
    expect(lines).toContain('curl "$SACTY_PF_URL/<PF の名前>/api/...');
    expect(lines).toContain("- ticket：チケット管理（$SACTY_PF_URL/ticket）");
    expect(lines).toContain("  - POST /api/v1/tickets/*/comments");
    expect(lines).toContain("認証のヘッダーやキーは付けないでください");
  });
});

describe("ホストの PF とコンテキストの PF を合わせる（PBI-74）", () => {
  const pf = (name: string, from?: string) => ({
    ...toPlatform(
      name,
      PlatformFile.parse({
        upstream: `https://${name}.example.com`,
        description: `${name} の説明`,
        auth: { secret: `${name}-token` },
        allow: ["GET /api/**"],
      }),
    ),
    ...(from ? { from } : {}),
  });

  it("同じ名前ならホストのものを使い、どちらを使ったかの警告を残す。ほかはコンテキストのものを足す", () => {
    const merged = mergePlatforms(
      [pf("jira")],
      [pf("jira", "acme/ctx@c0ffee0"), pf("docs", "acme/ctx@c0ffee0")],
    );
    expect(merged.platforms.map((p) => [p.name, p.from])).toEqual([
      ["jira", undefined],
      ["docs", "acme/ctx@c0ffee0"],
    ]);
    expect(merged.warnings).toEqual([
      { code: "context.hostPlatform", params: { from: "acme/ctx@c0ffee0", name: "jira" } },
    ]);
    expect(renderMessage(merged.warnings[0], "ja")).toBe(
      "acme/ctx@c0ffee0 の platforms.yaml の外部 PF「jira」は、config.yaml の gateway.platforms に同じ名前があるため、config.yaml のものを使いました。",
    );
  });

  it("どちらも無い・コンテキストだけでも合わせられる", () => {
    expect(mergePlatforms([], [])).toEqual({ platforms: [], warnings: [] });
    expect(mergePlatforms([], [pf("docs", "x")]).platforms.map((p) => p.name)).toEqual(["docs"]);
  });

  it("画面・作業履歴に出す要約は、名前・層・説明・allow だけで、秘密情報の名前も含めない", () => {
    const summary = platformSummary(pf("docs", "acme/ctx@c0ffee0"));
    expect(summary).toEqual({
      name: "docs",
      from: "acme/ctx@c0ffee0",
      description: "docs の説明",
      allow: ["GET /api/**"],
    });
    expect(JSON.stringify(summary)).not.toContain("docs-token");
    expect(platformSummary(pf("jira"))).not.toHaveProperty("from");
  });
});
