import { describe, expect, it } from "vitest";
import { GitHubIssueSearch, GitHubPullRequests } from "./github.js";

type Call = { url: string; method: string; body?: unknown; auth?: string };

/** 決まった応答を順に返す fetch の偽物。 */
function fakeFetch(responses: { status: number; json: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>).authorization,
    });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return new Response(JSON.stringify(next.json), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const input = {
  repo: "acme/app",
  token: "ghp_secret",
  branch: "sacty/task-1234abcd",
  baseBranch: "main",
  title: "決済API",
  body: "本文",
};

describe("GitHub の PR（PBI-10b）", () => {
  it("PRを作る", async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, json: { html_url: "https://github.com/acme/app/pull/7", number: 7 } },
    ]);
    const pr = await new GitHubPullRequests(impl).upsert(input);
    expect(pr).toEqual({ url: "https://github.com/acme/app/pull/7", number: 7 });
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/acme/app/pulls",
        method: "POST",
        body: { title: "決済API", head: "sacty/task-1234abcd", base: "main", body: "本文" },
        auth: "Bearer ghp_secret",
      },
    ]);
  });

  it("同じブランチのPRがすでにあれば、それを使う", async () => {
    const { impl, calls } = fakeFetch([
      { status: 422, json: { message: "Validation Failed" } },
      { status: 200, json: [{ html_url: "https://github.com/acme/app/pull/8", number: 8 }] },
    ]);
    const pr = await new GitHubPullRequests(impl).upsert(input);
    expect(pr.number).toBe(8);
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/acme/app/pulls?state=open&head=acme%3Asacty%2Ftask-1234abcd",
    );
  });

  it("番号があれば本文を更新し、失敗は理由つきのエラーにする（トークンは含めない）", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { html_url: "https://github.com/acme/app/pull/7", number: 7 } },
      { status: 401, json: { message: "Bad credentials" } },
    ]);
    const client = new GitHubPullRequests(impl);
    await client.upsert({ ...input, number: 7 });
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { body: "本文" } });
    const error = await client.upsert({ ...input, number: 7 }).catch((e: Error) => e);
    expect(String(error)).toContain("GitHub API 401 Bad credentials（トークンが無効です）");
    expect(String(error)).not.toContain("ghp_secret");
  });
});

describe("GitHub の Issue の検索（PBI-5a）", () => {
  it("検索の結果を読み、PR は除く", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          items: [
            {
              number: 3,
              title: "冪等性キー",
              body: null,
              html_url: "https://github.com/acme/app/issues/3",
              repository_url: "https://api.github.com/repos/acme/app",
              labels: [{ name: "sacty" }],
            },
            {
              number: 4,
              title: "PR",
              html_url: "https://github.com/acme/app/pull/4",
              repository_url: "https://api.github.com/repos/acme/app",
              labels: [],
              pull_request: {},
            },
          ],
        },
      },
    ]);
    const { issues: found, incomplete } = await new GitHubIssueSearch(impl).search(
      'repo:acme/app label:"sacty"',
      "t",
    );
    expect(incomplete).toBeUndefined();
    expect(found).toEqual([
      {
        repo: "acme/app",
        number: 3,
        title: "冪等性キー",
        body: "",
        url: "https://github.com/acme/app/issues/3",
        labels: ["sacty"],
      },
    ]);
    expect(calls[0]?.url).toContain("q=repo%3Aacme%2Fapp%20label%3A%22sacty%22");
  });
});

/**
 * updated_at の昇順に並んだ Issue を、検索の条件（updated:>=）とページに応じて返す fetch の偽物。
 * limitAfter 回目より後のリクエストは、レート制限（403）にする。
 */
function searchFetch(total: number, updatedAt: (n: number) => string, limitAfter = Infinity) {
  const all = Array.from({ length: total }, (_, i) => ({
    number: i + 1,
    title: `#${i + 1}`,
    html_url: `https://github.com/acme/app/issues/${i + 1}`,
    repository_url: "https://api.github.com/repos/acme/app",
    labels: [{ name: "sacty" }],
    updated_at: updatedAt(i + 1),
  }));
  const queries: string[] = [];
  const impl = (async (url: string) => {
    const params = new URL(url).searchParams;
    const q = params.get("q") ?? "";
    queries.push(`${q} page=${params.get("page")}`);
    if (queries.length > limitAfter) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      });
    }
    const since = q.match(/updated:>=(\S+)/)?.[1];
    const matched = all.filter((i) => !since || i.updated_at >= since);
    const page = Number(params.get("page"));
    // 検索 API と同じく、1つの検索では1,000件までしか返さない
    const items = matched.slice(0, 1000).slice((page - 1) * 100, page * 100);
    return new Response(JSON.stringify({ total_count: matched.length, items }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, queries };
}

describe("検索の上限の先（レビュー指摘）", () => {
  it("100件を超える結果は次のページを、1,000件を超える結果は更新日時で範囲を区切ってたどる", async () => {
    const { impl, queries } = searchFetch(1001, (n) =>
      new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString().replace(".000", ""),
    );
    const { issues, incomplete } = await new GitHubIssueSearch(impl).search("repo:acme/app", "t");
    expect(incomplete).toBeUndefined();
    expect(issues).toHaveLength(1001);
    expect(new Set(issues.map((i) => i.number)).size).toBe(1001);
    expect(queries.at(-1)).toBe("repo:acme/app updated:>=2026-01-01T00:16:40Z page=1");
  });

  it("同じ日時の Issue が多すぎて先へ進めなければ、取り切れなかったことを返す", async () => {
    const { impl } = searchFetch(1200, () => "2026-01-01T00:00:00Z");
    const { issues, incomplete } = await new GitHubIssueSearch(impl).search("repo:acme/app", "t");
    expect(issues).toHaveLength(1000);
    expect(incomplete).toMatch(/すべてを検索できませんでした/);
  });

  it("結果が不完全なら、取れた分は返すが、どこまで読んだかは先へ進めない（レビュー指摘）", async () => {
    const item = (number: number, updated: string) => ({
      number,
      title: `#${number}`,
      html_url: `https://github.com/acme/app/issues/${number}`,
      repository_url: "https://api.github.com/repos/acme/app",
      labels: [],
      updated_at: updated,
    });
    // #1（00:00:01）と #2（00:00:02）があるが、初回の応答は不完全で #2 だけを返した
    const { impl, calls } = fakeFetch([
      { status: 200, json: { incomplete_results: true, items: [item(2, "2026-01-01T00:00:02Z")] } },
      {
        status: 200,
        json: {
          incomplete_results: false,
          items: [item(1, "2026-01-01T00:00:01Z"), item(2, "2026-01-01T00:00:02Z")],
        },
      },
    ]);
    const search = new GitHubIssueSearch(impl);
    const first = await search.search("repo:acme/app", "t", "2026-01-01T00:00:00Z");
    expect(first.issues.map((i) => i.number)).toEqual([2]);
    expect(first.cursor).toBe("2026-01-01T00:00:00Z"); // 先へ進めない
    expect(first.incomplete).toMatch(/検索し直します/);

    const second = await search.search("repo:acme/app", "t", first.cursor);
    expect(second.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(second.cursor).toBe("2026-01-01T00:00:02Z");
    expect(second.incomplete).toBeUndefined();
    expect(new URL(calls[1]?.url ?? "").searchParams.get("q")).toBe(
      "repo:acme/app updated:>=2026-01-01T00:00:00Z",
    );
  });

  it("レート制限で止まっても、それまでに取れた分と、どこまで読んだかを返す（レビュー指摘）", async () => {
    const stamp = (n: number) =>
      new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString().replace(".000", "");
    const first = searchFetch(3100, stamp, 30);
    const partial = await new GitHubIssueSearch(first.impl).search("repo:acme/app", "t");
    expect(partial.rateLimited).toBe(true);
    expect(partial.incomplete).toMatch(/レート制限/);
    expect(partial.issues.length).toBeGreaterThanOrEqual(2900);
    expect(partial.cursor).toBe(stamp(partial.issues.length));

    // 次の取り込みは、読んだところから続け、残りをすべて取れる
    const next = searchFetch(3100, stamp, 30);
    const rest = await new GitHubIssueSearch(next.impl).search(
      "repo:acme/app",
      "t",
      partial.cursor,
    );
    expect(rest.rateLimited).toBeUndefined();
    const all = new Set([...partial.issues, ...rest.issues].map((i) => i.number));
    expect(all.size).toBe(3100);
    expect(next.queries[0]).toBe(`repo:acme/app updated:>=${partial.cursor} page=1`);
  });
});

describe("中止したときに PR を閉じる（PBI-3）", () => {
  it("PR を閉じ（マージはしない）、失敗は理由つきのエラーにする", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: {} },
      { status: 404, json: { message: "Not Found" } },
    ]);
    const client = new GitHubPullRequests(impl);
    await client.close({ repo: "acme/app", token: "t", number: 7 });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/pulls/7",
      method: "PATCH",
      body: { state: "closed" },
    });
    await expect(client.close({ repo: "acme/app", token: "t", number: 8 })).rejects.toThrow(
      /PRを閉じられませんでした：GitHub API 404/,
    );
  });
});
