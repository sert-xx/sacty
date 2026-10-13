import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { MessageError } from "./errors.js";
import { type Platform, PlatformCredentials, PlatformFile, toPlatform } from "./platforms.js";
import { MemorySecretStore } from "./secrets.js";
import { JiraTickets, ticketErrorText, ticketJql } from "./tickets.js";

const jira = (allow: string[]): Platform =>
  toPlatform(
    "jira",
    PlatformFile.parse({
      upstream: "https://jira.example.com/",
      description: "JIRA",
      auth: { header: "Authorization", prefix: "Bearer ", secret: "jira-token" },
      allow,
    }),
  );

const ALL = ["GET /rest/api/**", "POST /rest/api/2/issue/*/comment"];

/** JIRA の偽物。呼ばれた URL・メソッド・ヘッダー・本文を記録する。 */
function fakeJira(responses: Response[]) {
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    body: string;
    redirect?: string;
  }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: new Headers(init.headers),
      body: String(init.body ?? ""),
      redirect: init.redirect,
    });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  }) as typeof fetch;
  const client = new JiraTickets({
    credentials: new PlatformCredentials({
      secrets: new MemorySecretStore({ "jira-token": "jira-secret-value" }),
    }),
    fetchImpl,
  });
  return { client, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("JIRA のチケットの検索とコメント（PBI-52）", () => {
  it("JQL は、キーのプロジェクト・ラベル・終わっていないチケット", () => {
    expect(ticketJql(["PAY", "OPS"], "sacty")).toBe(
      'project in ("PAY", "OPS") AND labels = "sacty" AND statusCategory != Done ORDER BY created ASC',
    );
  });

  it("Server / Data Center は /rest/api/2/search で探し、認証は PF の設定のヘッダーで付ける", async () => {
    const { client, calls } = fakeJira([
      json({
        issues: [
          { key: "PAY-1", fields: { summary: "二重請求" } },
          { key: "bad key", fields: { summary: "x" } },
          { key: "PAY-2", fields: {} },
        ],
      }),
    ]);
    const { tickets: found, cursor } = await client.search({
      platform: jira(ALL),
      service: "jira-server",
      keys: ["PAY"],
      label: "sacty",
    });
    expect(cursor).toBeUndefined();
    expect(found).toEqual([
      {
        platform: "jira",
        service: "jira-server",
        key: "PAY-1",
        summary: "二重請求",
        url: "https://jira.example.com/browse/PAY-1",
      },
      {
        platform: "jira",
        service: "jira-server",
        key: "PAY-2",
        summary: "",
        url: "https://jira.example.com/browse/PAY-2",
      },
    ]);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/rest/api/2/search");
    expect(url.searchParams.get("jql")).toBe(ticketJql(["PAY"], "sacty"));
    expect(url.searchParams.get("fields")).toBe("summary");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jira-secret-value");
    // 転送先に認証を渡さない
    expect(calls[0]?.redirect).toBe("manual");
  });

  it("Cloud は /rest/api/3/search/jql で探す", async () => {
    const { client, calls } = fakeJira([
      json({ issues: [{ key: "OPS-9", fields: { summary: "s" } }] }),
    ]);
    const found = await client.search({
      platform: jira(ALL),
      service: "jira-cloud",
      keys: ["OPS"],
      label: "sacty",
    });
    expect(found.tickets.map((t) => t.key)).toEqual(["OPS-9"]);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/rest/api/3/search/jql");
  });

  it("ページを送って読む（Server は startAt、Cloud は nextPageToken）。読むページには上限がある", async () => {
    const page = (keys: string[], extra: Record<string, unknown>) =>
      json({ issues: keys.map((key) => ({ key, fields: { summary: key } })), ...extra });
    const server = fakeJira([
      page(["PAY-1", "PAY-2"], { total: 3 }),
      page(["PAY-3"], { total: 3 }),
    ]);
    const s1 = await server.client.search({
      platform: jira(ALL),
      service: "jira-server",
      keys: ["PAY"],
      label: "sacty",
    });
    expect(s1.tickets.map((t) => t.key)).toEqual(["PAY-1", "PAY-2", "PAY-3"]);
    expect(s1.cursor).toBeUndefined();
    expect(server.calls.map((c) => new URL(c.url).searchParams.get("startAt"))).toEqual(["0", "2"]);
    const cloud = fakeJira([
      page(["OPS-1"], { nextPageToken: "t2", isLast: false }),
      page(["OPS-2"], { isLast: true }),
    ]);
    const c1 = await cloud.client.search({
      platform: jira(ALL),
      service: "jira-cloud",
      keys: ["OPS"],
      label: "sacty",
    });
    expect(c1.tickets.map((t) => t.key)).toEqual(["OPS-1", "OPS-2"]);
    expect(c1.cursor).toBeUndefined();
    expect(cloud.calls.map((c) => new URL(c.url).searchParams.get("nextPageToken"))).toEqual([
      null,
      "t2",
    ]);
    // 終わらない応答でも、上限のページで止める
    const endless = fakeJira(
      Array.from({ length: 20 }, (_, i) => page([`PAY-${i + 1}`], { total: 1000 })),
    );
    const first = await endless.client.search({
      platform: jira(ALL),
      service: "jira-server",
      keys: ["PAY"],
      label: "sacty",
    });
    expect(endless.calls).toHaveLength(10);
    // 続きの位置を返し、渡されたらそこから読む
    expect(first.cursor).toBe("10");
    await endless.client.search({
      platform: jira(ALL),
      service: "jira-server",
      keys: ["PAY"],
      label: "sacty",
      cursor: first.cursor,
    });
    expect(new URL(endless.calls[10]?.url ?? "").searchParams.get("startAt")).toBe("10");
    // Cloud も、上限で止めたら次のページの印を返す
    const cloudEndless = fakeJira(
      Array.from({ length: 20 }, (_, i) =>
        page([`OPS-${i + 1}`], { nextPageToken: `t${i + 2}`, isLast: false }),
      ),
    );
    const c2 = await cloudEndless.client.search({
      platform: jira(ALL),
      service: "jira-cloud",
      keys: ["OPS"],
      label: "sacty",
    });
    expect(c2.cursor).toBe("t11");
    await cloudEndless.client.search({
      platform: jira(ALL),
      service: "jira-cloud",
      keys: ["OPS"],
      label: "sacty",
      cursor: c2.cursor,
    });
    expect(new URL(cloudEndless.calls[10]?.url ?? "").searchParams.get("nextPageToken")).toBe(
      "t11",
    );
    // 壊れた位置は先頭から
    const bad = fakeJira([page([], { total: 0 })]);
    await bad.client.search({
      platform: jira(ALL),
      service: "jira-server",
      keys: ["PAY"],
      label: "sacty",
      cursor: "-5",
    });
    expect(new URL(bad.calls[0]?.url ?? "").searchParams.get("startAt")).toBe("0");
  });

  it("allow に無い API は呼ばない", async () => {
    const { client, calls } = fakeJira([]);
    const error = await client
      .search({
        platform: jira(["GET /rest/api/2/issue/**"]),
        service: "jira-server",
        keys: ["PAY"],
        label: "sacty",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessageError);
    expect(renderMessage(ticketErrorText(error), "ja")).toContain("GET /rest/api/2/search");
    expect(calls).toHaveLength(0);
    await expect(
      client.comment({
        platform: jira(["GET /rest/api/**"]),
        service: "jira-cloud",
        key: "PAY-1",
        body: "x",
      }),
    ).rejects.toThrow(MessageError);
    expect(calls).toHaveLength(0);
  });

  it("コメントは /rest/api/2/issue/<キー>/comment に書き、コメントの URL を返す", async () => {
    const { client, calls } = fakeJira([json({ id: "10001" }), json({})]);
    for (const service of ["jira-cloud", "jira-server"] as const) {
      await client.comment({ platform: jira(ALL), service, key: "PAY-1", body: "調査の結果" });
    }
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["POST", "/rest/api/2/issue/PAY-1/comment"],
      ["POST", "/rest/api/2/issue/PAY-1/comment"],
    ]);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ body: "調査の結果" });
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    const { client: again } = fakeJira([json({ id: 10002 }), json({})]);
    expect(
      await again.comment({ platform: jira(ALL), service: "jira-server", key: "PAY-1", body: "x" }),
    ).toEqual({ url: "https://jira.example.com/browse/PAY-1?focusedCommentId=10002" });
    // id が無ければ、チケットの URL
    expect(
      await again.comment({ platform: jira(ALL), service: "jira-server", key: "PAY-1", body: "x" }),
    ).toEqual({ url: "https://jira.example.com/browse/PAY-1" });
    // キーの形でなければ呼ばない（パスに混ぜない）
    await expect(
      again.comment({ platform: jira(ALL), service: "jira-server", key: "../x", body: "x" }),
    ).rejects.toThrow();
  });

  it("失敗の理由に、認証の値（接頭辞の有無とも）を出さない。伏せてから切り詰める", async () => {
    const { client } = fakeJira([
      new Response(`${"x".repeat(285)}jira-secret-value / Bearer jira-secret-value`, {
        status: 401,
      }),
    ]);
    const error = await client
      .search({ platform: jira(ALL), service: "jira-server", keys: ["PAY"], label: "sacty" })
      .catch((e: unknown) => e);
    const text = renderMessage(ticketErrorText(error), "ja");
    expect(text).toContain("401");
    expect(text).not.toContain("jira-secret");
    expect(text).not.toContain("jira-se");
  });
});
