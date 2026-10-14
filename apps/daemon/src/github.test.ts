import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { errorText } from "./errors.js";
import { GitHubIssueSearch, GitHubPullRequests } from "./github.js";

/** 記録した文言（コードと引数）を、日本語の文にする（PBI-11）。 */
const ja = (text: unknown) => renderMessage(text, "ja");

type Call = { url: string; method: string; body?: unknown; auth?: string };

/** 決まった応答を順に返す fetch の偽物。 */
function fakeFetch(
  responses: { status: number; json: unknown; headers?: Record<string, string> }[],
) {
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
    return new Response(JSON.stringify(next.json), {
      status: next.status,
      ...(next.headers ? { headers: next.headers } : {}),
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const input = {
  repo: "https://github.com/acme/app",
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

  it("GitHub Enterprise Server のリポジトリは、そのホストの /api/v3 で PR を作る（PBI-40）", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        json: { html_url: "https://ghe.example.co.jp/acme/app/pull/3", number: 3 },
      },
      { status: 201, json: { html_url: "https://ghe.example.co.jp/acme/app/issues/3#c1" } },
    ]);
    const client = new GitHubPullRequests(impl);
    await client.upsert({ ...input, repo: "https://ghe.example.co.jp/acme/app" });
    await client.commentIssue({
      repo: "https://ghe.example.co.jp/acme/app",
      token: "t",
      number: 3,
      body: "b",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://ghe.example.co.jp/api/v3/repos/acme/app/pulls",
      "https://ghe.example.co.jp/api/v3/repos/acme/app/issues/3/comments",
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
    // 理由はコードと引数で持ち、GitHub の文は翻訳せずに引数で渡す（PBI-11b）
    expect(errorText(error)).toEqual({
      code: "github.failed",
      params: { action: "updatePr", status: 401, detail: "Bad credentials", hint: "token" },
    });
  });
});

describe("GitHub の Issue の検索（PBI-5a）", () => {
  it("検索の結果を読み、PR も PR であることを添えて読む（PBI-26）", async () => {
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
      "github.com",
      'repo:acme/app label:"sacty"',
      "t",
    );
    expect(incomplete).toBeUndefined();
    expect(found).toEqual([
      {
        repo: "https://github.com/acme/app",
        number: 3,
        title: "冪等性キー",
        body: "",
        url: "https://github.com/acme/app/issues/3",
        labels: ["sacty"],
      },
      {
        repo: "https://github.com/acme/app",
        number: 4,
        title: "PR",
        body: "",
        url: "https://github.com/acme/app/pull/4",
        labels: [],
        pullRequest: true,
      },
    ]);
    expect(calls[0]?.url).toContain("q=repo%3Aacme%2Fapp%20label%3A%22sacty%22");
  });
});

describe("GitHub Enterprise Server の検索・Org（PBI-40）", () => {
  it("そのホストの /api/v3 で検索し、リポジトリは Issue の URL で返す（ほかのホストのものは除く）", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          items: [
            {
              number: 3,
              title: "GHE",
              html_url: "https://ghe.example.co.jp/acme/app/issues/3",
              labels: [],
            },
            // 先頭がドットのリポジトリ名も読む（PBI-40 レビュー指摘）
            {
              number: 5,
              title: "ドットのリポジトリ",
              html_url: "https://ghe.example.co.jp/acme/.github/issues/5",
              labels: [],
            },
            // 検索したホストではない URL は、取り込まない
            {
              number: 4,
              title: "ほかのホスト",
              html_url: "https://github.com/acme/app/issues/4",
              labels: [],
            },
          ],
        },
      },
    ]);
    const { issues } = await new GitHubIssueSearch(impl).search(
      "ghe.example.co.jp",
      "repo:acme/app",
      "t",
    );
    expect(calls[0]?.url).toMatch(/^https:\/\/ghe\.example\.co\.jp\/api\/v3\/search\/issues\?/);
    expect(issues.map((i) => i.repo)).toEqual([
      "https://ghe.example.co.jp/acme/app",
      "https://ghe.example.co.jp/acme/.github",
    ]);
  });

  it("Org のリポジトリを、そのホストの /api/v3 で読み、URL で返す。ほかのホストの次のページはたどらない", async () => {
    const api = "https://ghe.example.co.jp/api/v3";
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: [{ full_name: "acme/web" }],
        headers: { link: `<https://api.github.com/orgs/acme/repos?page=2>; rel="next"` },
      },
    ]);
    expect(
      await new GitHubPullRequests(impl).repositories({
        org: "https://ghe.example.co.jp/acme",
        token: "t",
      }),
    ).toEqual(["https://ghe.example.co.jp/acme/web"]);
    expect(calls.map((c) => c.url)).toEqual([`${api}/orgs/acme/repos?per_page=100&type=all`]);
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
    const { issues, incomplete } = await new GitHubIssueSearch(impl).search(
      "github.com",
      "repo:acme/app",
      "t",
    );
    expect(incomplete).toBeUndefined();
    expect(issues).toHaveLength(1001);
    expect(new Set(issues.map((i) => i.number)).size).toBe(1001);
    expect(queries.at(-1)).toBe("repo:acme/app updated:>=2026-01-01T00:16:40Z page=1");
  });

  it("同じ日時の Issue が多すぎて先へ進めなければ、取り切れなかったことを返す", async () => {
    const { impl } = searchFetch(1200, () => "2026-01-01T00:00:00Z");
    const { issues, incomplete } = await new GitHubIssueSearch(impl).search(
      "github.com",
      "repo:acme/app",
      "t",
    );
    expect(issues).toHaveLength(1000);
    expect(ja(incomplete)).toMatch(/すべてを検索できませんでした/);
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
    const first = await search.search("github.com", "repo:acme/app", "t", "2026-01-01T00:00:00Z");
    expect(first.issues.map((i) => i.number)).toEqual([2]);
    expect(first.cursor).toBe("2026-01-01T00:00:00Z"); // 先へ進めない
    expect(ja(first.incomplete)).toMatch(/検索し直します/);

    const second = await search.search("github.com", "repo:acme/app", "t", first.cursor);
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
    const partial = await new GitHubIssueSearch(first.impl).search(
      "github.com",
      "repo:acme/app",
      "t",
    );
    expect(partial.rateLimited).toBe(true);
    expect(ja(partial.incomplete)).toMatch(/レート制限/);
    expect(partial.issues.length).toBeGreaterThanOrEqual(2900);
    expect(partial.cursor).toBe(stamp(partial.issues.length));

    // 次の取り込みは、読んだところから続け、残りをすべて取れる
    const next = searchFetch(3100, stamp, 30);
    const rest = await new GitHubIssueSearch(next.impl).search(
      "github.com",
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
    await client.close({ repo: "https://github.com/acme/app", token: "t", number: 7 });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/pulls/7",
      method: "PATCH",
      body: { state: "closed" },
    });
    await expect(
      client.close({ repo: "https://github.com/acme/app", token: "t", number: 8 }),
    ).rejects.toThrow(/PRを閉じられませんでした：GitHub API 404/);
  });
});

describe("成果物チェックの間の PR の状態（PBI-14a）", () => {
  it("マージ済み・閉じられた・開いているを読み分け、失敗は理由つきのエラーにする", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          state: "closed",
          merged: true,
          merged_by: { login: "reviewer" },
          head: { sha: "abc" },
          merge_commit_sha: "def",
        },
      },
      { status: 200, json: { state: "closed", merged: false } },
      { status: 200, json: { state: "open", merged: false } },
      { status: 404, json: { message: "Not Found" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const pr = { repo: "https://github.com/acme/app", token: "ghp_secret", number: 7 };
    expect(await client.status(pr)).toEqual({
      state: "merged",
      mergedBy: "reviewer",
      headSha: "abc",
      mergeCommit: "def",
    });
    expect(await client.status(pr)).toEqual({ state: "closed" });
    expect(await client.status(pr)).toEqual({ state: "open" });
    expect(errorText(await client.status(pr).catch((e: unknown) => e))).toEqual({
      code: "github.failed",
      params: { action: "getPr", status: 404, detail: "Not Found", hint: "permission" },
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/pulls/7",
      method: "GET",
      auth: "Bearer ghp_secret",
    });
  });
});

describe("PR へのフィードバック（PBI-14b）", () => {
  it("レビュー（Request changes・本文のあるコメント）、行ごとのコメント、通常のコメントを、時刻の順に読む", async () => {
    const human = { login: "reviewer", type: "User" };
    const bot = { login: "ci[bot]", type: "Bot" };
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            state: "APPROVED",
            user: human,
            body: "LGTM",
            submitted_at: "2026-10-11T00:00:01Z",
          },
          {
            id: 2,
            state: "CHANGES_REQUESTED",
            user: human,
            body: "",
            submitted_at: "2026-10-11T00:00:05Z",
          },
          {
            id: 3,
            state: "COMMENTED",
            user: human,
            body: "",
            submitted_at: "2026-10-11T00:00:02Z",
          },
          {
            id: 4,
            state: "COMMENTED",
            user: bot,
            body: "coverage 80%",
            submitted_at: "2026-10-11T00:00:03Z",
          },
          {
            id: 5,
            state: "COMMENTED",
            user: human,
            body: "ログが足りない",
            submitted_at: "2026-10-11T00:00:04Z",
            html_url: "https://github.com/acme/app/pull/7#pullrequestreview-5",
          },
        ],
      },
      {
        status: 200,
        json: [
          {
            id: 10,
            user: human,
            path: "src/pay.ts",
            line: 12,
            body: "例外を握りつぶしている",
            created_at: "2026-10-11T00:00:06Z",
          },
          {
            id: 11,
            user: human,
            path: "src/old.ts",
            line: null,
            original_line: 3,
            body: "古い行",
            created_at: "2026-10-11T00:00:07Z",
          },
        ],
      },
      {
        status: 200,
        json: [
          { id: 20, user: human, body: "テストも足してほしい", created_at: "2026-10-11T00:00:08Z" },
          { id: 21, user: bot, body: "deployed", created_at: "2026-10-11T00:00:09Z" },
        ],
      },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      number: 7,
    });
    expect(feedback.map((f) => [f.key, f.body, f.path ?? "", f.line ?? 0])).toEqual([
      ["review:5", "ログが足りない", "", 0],
      ["review:2", "", "", 0],
      ["review_comment:10", "例外を握りつぶしている", "src/pay.ts", 12],
      ["review_comment:11", "古い行", "src/old.ts", 3],
      ["comment:20", "テストも足してほしい", "", 0],
    ]);
    // 承認・本文の無いコメントだけのレビュー・bot は含めない。本文の無い Request changes は含める
    expect(feedback.find((f) => f.key === "review:2")?.requestChanges).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/app/pulls/7/reviews?per_page=100",
      "https://api.github.com/repos/acme/app/pulls/7/comments?per_page=100",
      "https://api.github.com/repos/acme/app/issues/7/comments?per_page=100",
    ]);
  });
});

describe("フィードバックの次のページ（PBI-14b レビュー指摘）", () => {
  it("Link の next をたどってすべてのページを読み、API と違う場所の URL はたどらない", async () => {
    const human = { login: "reviewer", type: "User" };
    const comment = (id: number) => ({
      id,
      user: human,
      body: `指摘${id}`,
      created_at: `2026-10-11T00:00:${String(id).padStart(2, "0")}Z`,
    });
    const api = "https://api.github.com/repos/acme/app";
    const { impl, calls } = fakeFetch([
      { status: 200, json: [] }, // reviews
      { status: 200, json: [] }, // review comments
      {
        status: 200,
        json: [comment(1)],
        headers: {
          link: `<${api}/issues/7/comments?per_page=100&page=2>; rel="next", <${api}/issues/7/comments?per_page=100&page=3>; rel="last"`,
        },
      },
      {
        status: 200,
        json: [comment(2)],
        // ほかの場所へは、トークンを送らない
        headers: { link: '<https://evil.example.com/next>; rel="next"' },
      },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      number: 7,
    });
    expect(feedback.map((f) => f.key)).toEqual(["comment:1", "comment:2"]);
    expect(calls.map((c) => c.url)).toEqual([
      `${api}/pulls/7/reviews?per_page=100`,
      `${api}/pulls/7/comments?per_page=100`,
      `${api}/issues/7/comments?per_page=100`,
      `${api}/issues/7/comments?per_page=100&page=2`,
    ]);
  });
});

describe("Issue へのコメント（PBI-18）", () => {
  it("Issue にコメントして URL を返し、失敗は理由つきのエラーにする", async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, json: { html_url: "https://github.com/acme/app/issues/5#issuecomment-9" } },
      { status: 403, json: { message: "Resource not accessible by integration" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const input = {
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      number: 5,
      body: "## 調査の結果",
    };
    expect(await client.commentIssue(input)).toEqual({
      url: "https://github.com/acme/app/issues/5#issuecomment-9",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/issues/5/comments",
      method: "POST",
      body: { body: "## 調査の結果" },
      auth: "Bearer ghp_secret",
    });
    expect(errorText(await client.commentIssue(input).catch((e: unknown) => e))).toMatchObject({
      code: "github.failed",
      params: { action: "commentIssue", status: 403 },
    });
  });

  it("目印を含むコメントを、すべてのページから探す", async () => {
    const api = "https://api.github.com/repos/acme/app";
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: [
          {
            body: "ほかのコメント",
            html_url: "https://github.com/acme/app/issues/5#issuecomment-1",
          },
        ],
        headers: { link: `<${api}/issues/5/comments?per_page=100&page=2>; rel="next"` },
      },
      {
        status: 200,
        json: [
          {
            body: "<!-- sacty-investigation:t1 -->\n## sacty の調査の結果",
            html_url: "https://github.com/acme/app/issues/5#issuecomment-2",
          },
        ],
      },
      { status: 200, json: [] },
      { status: 404, json: { message: "Not Found" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const target = { repo: "https://github.com/acme/app", token: "ghp_secret", number: 5 };
    expect(
      await client.findIssueComment({ ...target, marker: "<!-- sacty-investigation:t1 -->" }),
    ).toEqual({ url: "https://github.com/acme/app/issues/5#issuecomment-2" });
    expect(calls.map((c) => c.url)).toEqual([
      `${api}/issues/5/comments?per_page=100`,
      `${api}/issues/5/comments?per_page=100&page=2`,
    ]);
    expect(calls[0]?.auth).toBe("Bearer ghp_secret");
    expect(
      await client.findIssueComment({ ...target, marker: "<!-- sacty-investigation:t2 -->" }),
    ).toBeUndefined();
    expect(
      errorText(
        await client
          .findIssueComment({ ...target, marker: "<!-- sacty-investigation:t1 -->" })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({
      code: "github.failed",
      params: { action: "listIssueComments", status: 404 },
    });
  });
});

describe("PR のレビュー（PBI-19）", () => {
  const api = "https://api.github.com/repos/acme/app";
  const target = { repo: "https://github.com/acme/app", token: "ghp_secret", number: 12 };

  it("PR の先頭・向き先のコミットと説明を読み、失敗は理由つきのエラーにする", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          number: 12,
          html_url: "https://github.com/acme/app/pull/12",
          title: "再試行",
          body: null,
          head: { sha: "h".repeat(40) },
          base: { sha: "b".repeat(40) },
        },
      },
      { status: 404, json: { message: "Not Found" } },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(await client.pullRequest(target)).toEqual({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      title: "再試行",
      body: "",
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
    });
    expect(calls[0]).toMatchObject({ url: `${api}/pulls/12`, auth: "Bearer ghp_secret" });
    expect(errorText(await client.pullRequest(target).catch((e: unknown) => e))).toMatchObject({
      code: "github.failed",
      params: { action: "getPr", status: 404 },
    });
  });

  it("コメントのレビュー（承認も変更の要求もしない）を、読んだコミットに投稿する", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: { html_url: "https://github.com/acme/app/pull/12#pullrequestreview-5" },
      },
      { status: 422, json: { message: "Unprocessable" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const input = {
      ...target,
      commit: "h".repeat(40),
      body: "## sacty のレビュー",
      comments: [{ path: "src/retry.ts", line: 3, body: "上限が無い" }],
    };
    expect(await client.postReview(input)).toEqual({
      url: "https://github.com/acme/app/pull/12#pullrequestreview-5",
    });
    expect(calls[0]).toMatchObject({
      url: `${api}/pulls/12/reviews`,
      method: "POST",
      body: {
        commit_id: "h".repeat(40),
        body: "## sacty のレビュー",
        event: "COMMENT",
        // 行へのコメントは、PR の先頭のファイルの行（差分の右側）に付ける
        comments: [{ path: "src/retry.ts", line: 3, side: "RIGHT", body: "上限が無い" }],
      },
    });
    expect(errorText(await client.postReview(input).catch((e: unknown) => e))).toMatchObject({
      code: "github.failed",
      params: { action: "postReview", status: 422 },
    });
  });

  it("プロジェクトのアカウントが投稿した、目印で始まるレビューを、すべてのページから探す", async () => {
    const me = { login: "sacty-bot", type: "User" };
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: [
          {
            user: me,
            body: "LGTM",
            html_url: "https://github.com/acme/app/pull/12#pullrequestreview-1",
          },
          // 他人が目印を書いても、投稿済みと見なさない
          {
            user: { login: "someone" },
            body: "<!-- sacty-review:t1 -->",
            html_url: "https://github.com/acme/app/pull/12#pullrequestreview-9",
          },
          // 目印を引用しただけ（目印で始まらない）のものも、投稿済みと見なさない
          {
            user: me,
            body: "> <!-- sacty-review:t1 -->\n引用",
            html_url: "https://github.com/acme/app/pull/12#pullrequestreview-8",
          },
        ],
        headers: { link: `<${api}/pulls/12/reviews?per_page=100&page=2>; rel="next"` },
      },
      {
        status: 200,
        json: [
          {
            user: me,
            body: "<!-- sacty-review:t1 -->\n## sacty のレビュー",
            html_url: "https://github.com/acme/app/pull/12#pullrequestreview-2",
          },
        ],
      },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(
      await client.findReview({
        ...target,
        account: "sacty-bot",
        marker: "<!-- sacty-review:t1 -->",
      }),
    ).toEqual({ url: "https://github.com/acme/app/pull/12#pullrequestreview-2" });
    expect(calls.map((c) => c.url)).toEqual([
      `${api}/pulls/12/reviews?per_page=100`,
      `${api}/pulls/12/reviews?per_page=100&page=2`,
    ]);
  });

  it("プロジェクトのアカウントが投稿した sacty のレビューと行へのコメントは取り込まず、人間が目印を写したものは取り込む", async () => {
    const human = { login: "reviewer", type: "User" };
    const me = { login: "sacty-bot", type: "User" };
    const at = (n: number) => `2026-10-11T00:00:0${n}Z`;
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:t1 -->\n## sacty のレビュー\n\n- 上限が無い",
            submitted_at: at(1),
          },
          { id: 2, user: human, state: "COMMENTED", body: "ここを直して", submitted_at: at(2) },
          // 人間が本文に目印を写しても、人間の指摘として取り込む
          {
            id: 3,
            user: human,
            state: "COMMENTED",
            body: "<!-- sacty-review:t1 -->\nAI の指摘に同意",
            submitted_at: at(3),
          },
        ],
      },
      {
        status: 200,
        json: [
          {
            id: 4,
            user: me,
            body: "<!-- sacty-review:t1 -->\n上限が無い",
            path: "src/retry.ts",
            line: 3,
            created_at: at(4),
          },
          // 同じアカウントでも、目印で始まらないもの（人間が手で書いた）は取り込む
          { id: 5, user: me, body: "手で書いた指摘", path: "a.ts", line: 1, created_at: at(5) },
        ],
      },
      { status: 200, json: [] },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      ...target,
      account: "sacty-bot",
    });
    expect(feedback.map((f) => f.key)).toEqual(["review:2", "review:3", "review_comment:5"]);
  });
});

describe("対象の Org のリポジトリ（PBI-25）", () => {
  const api = "https://api.github.com";

  it("Org のリポジトリをすべてのページから読み、アーカイブしたものを除いて並べる", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: [
          { full_name: "acme/web", archived: false },
          { full_name: "acme/old", archived: true },
        ],
        headers: { link: `<${api}/orgs/acme/repos?per_page=100&type=all&page=2>; rel="next"` },
      },
      { status: 200, json: [{ full_name: "acme/api", private: true }] },
      { status: 403, json: { message: "Forbidden" } },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(
      await client.repositories({ org: "https://github.com/acme", token: "ghp_secret" }),
    ).toEqual(["https://github.com/acme/api", "https://github.com/acme/web"]);
    expect(calls[0]).toMatchObject({
      url: `${api}/orgs/acme/repos?per_page=100&type=all`,
      auth: "Bearer ghp_secret",
    });
    expect(
      errorText(
        await client
          .repositories({ org: "https://github.com/acme", token: "ghp_secret" })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({ code: "github.failed", params: { action: "listRepositories", status: 403 } });
  });

  it("個人のアカウントは、公開リポジトリに加えて、トークンで読めるその持ち主の非公開リポジトリも含める（レビュー指摘）", async () => {
    const { impl, calls } = fakeFetch([
      { status: 404, json: { message: "Not Found" } },
      // 公開のものだけ
      {
        status: 200,
        json: [{ full_name: "Someone/dotfiles", owner: { login: "Someone" } }],
      },
      // トークンで読めるもの（ほかの持ち主のものも含む）
      {
        status: 200,
        json: [
          {
            full_name: "Someone/private-app",
            owner: { login: "Someone" },
            private: true,
          },
          { full_name: "Someone/dotfiles", owner: { login: "Someone" } },
          {
            full_name: "other/shared",
            owner: { login: "other" },
            private: true,
          },
          {
            full_name: "Someone/archived",
            owner: { login: "Someone" },
            archived: true,
          },
        ],
      },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(
      await client.repositories({ org: "https://github.com/someone", token: "ghp_secret" }),
    ).toEqual(["https://github.com/Someone/dotfiles", "https://github.com/Someone/private-app"]);
    expect(calls.map((c) => c.url)).toEqual([
      `${api}/orgs/someone/repos?per_page=100&type=all`,
      `${api}/users/someone/repos?per_page=100&type=owner`,
      `${api}/user/repos?per_page=100&affiliation=owner,collaborator,organization_member`,
    ]);
  });
});

describe("sacty が作る PR の取り込むラベル（PBI-88）", () => {
  const pr = { repo: "https://github.com/acme/app", token: "ghp_secret", number: 7 };

  it("取り込むラベルを付けたレビューのタスクの、sacty のレビューと行へのコメントは、PR の指摘として取り込む（ほかのタスクのものは除く）", async () => {
    const me = { login: "sacty-bot", type: "User" };
    const at = (n: number) => `2026-10-11T00:00:0${n}Z`;
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1 -->\n## sacty のレビュー\n\n- 上限が無い",
            submitted_at: at(1),
          },
          // 再レビューは回ごと（含める回だけ）
          {
            id: 2,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1:2 -->\n## sacty のレビュー",
            submitted_at: at(2),
          },
          {
            id: 5,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1:3 -->\n直す点なし",
            submitted_at: at(5),
          },
          // ほかのタスク（ID が前方一致するものも）のレビューは除く
          {
            id: 3,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:r10 -->\n別のタスク",
            submitted_at: at(3),
          },
        ],
      },
      {
        status: 200,
        json: [
          {
            id: 4,
            user: me,
            body: "<!-- sacty-review:r1 -->\n上限が無い",
            path: "src/retry.ts",
            line: 3,
            created_at: at(4),
          },
        ],
      },
      { status: 200, json: [] },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      ...pr,
      account: "sacty-bot",
      sactyReviews: [
        { key: "r1", account: "sacty-bot", allowed: true },
        { key: "r1:2", account: "sacty-bot", allowed: true },
        { key: "r1:3", account: "sacty-bot", allowed: false },
      ],
    });
    expect(feedback.map((f) => f.key)).toEqual(["review:1", "review:2", "review_comment:4"]);
  });

  it("リポジトリにラベルがあれば、そのまま PR に付ける", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { name: "sacty ai" } },
      { status: 200, json: [{ name: "sacty ai" }] },
    ]);
    const result = await new GitHubPullRequests(impl).addLabel({ ...pr, label: "sacty ai" });
    expect(result).toEqual({ created: false });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["GET", "https://api.github.com/repos/acme/app/labels/sacty%20ai", undefined],
      ["POST", "https://api.github.com/repos/acme/app/issues/7/labels", { labels: ["sacty ai"] }],
    ]);
    expect(calls[0]?.auth).toBe("Bearer ghp_secret");
  });

  it("リポジトリにラベルが無ければ作ってから付ける。作っている間にほかで作られていても付ける", async () => {
    const made = fakeFetch([
      { status: 404, json: { message: "Not Found" } },
      { status: 201, json: { name: "sacty" } },
      { status: 200, json: [] },
    ]);
    expect(await new GitHubPullRequests(made.impl).addLabel({ ...pr, label: "sacty" })).toEqual({
      created: true,
    });
    expect(made.calls[1]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/app/labels",
      body: { name: "sacty" },
    });
    expect(made.calls[2]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/app/issues/7/labels",
    });
    const raced = fakeFetch([
      { status: 404, json: { message: "Not Found" } },
      {
        status: 422,
        json: { message: "Validation Failed", errors: [{ code: "already_exists" }] },
      },
      { status: 200, json: [] },
    ]);
    expect(await new GitHubPullRequests(raced.impl).addLabel({ ...pr, label: "sacty" })).toEqual({
      created: false,
    });
    expect(raced.calls).toHaveLength(3);
  });

  it("ラベルを確かめる・作る・付けるの失敗は、どれが失敗したかの理由つきのエラーにする（トークンは含めない）", async () => {
    const cases: [{ status: number; json: unknown }[], string][] = [
      [
        [{ status: 401, json: { message: "Bad credentials" } }],
        "リポジトリのラベルを確かめられませんでした",
      ],
      [
        [
          { status: 404, json: {} },
          { status: 403, json: { message: "Resource not accessible by integration" } },
        ],
        "リポジトリにラベルを作れませんでした",
      ],
      [
        [
          { status: 404, json: {} },
          { status: 422, json: { message: "Validation Failed", errors: [{ code: "invalid" }] } },
        ],
        "リポジトリにラベルを作れませんでした",
      ],
      [
        [
          { status: 200, json: {} },
          { status: 403, json: { message: "Must have admin rights" } },
        ],
        "PR にラベルを付けられませんでした",
      ],
    ];
    for (const [responses, expected] of cases) {
      const { impl } = fakeFetch(responses);
      const error = await new GitHubPullRequests(impl)
        .addLabel({ ...pr, label: "sacty" })
        .catch((e: unknown) => e);
      const text = ja(errorText(error));
      expect(text).toContain(expected);
      expect(text).not.toContain("ghp_secret");
    }
  });
});

describe("Bot のアカウントの sacty のレビュー（PBI-88 レビュー指摘）", () => {
  it("プロジェクトのアカウントが Bot でも、含めるレビューのタスクの投稿は指摘として取り込み、ほかの Bot の投稿は除く", async () => {
    const bot = { login: "sacty[bot]", type: "Bot" };
    const ci = { login: "ci[bot]", type: "Bot" };
    const at = (n: number) => `2026-10-11T00:00:0${n}Z`;
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            user: bot,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1 -->\n## sacty のレビュー",
            submitted_at: at(1),
          },
          // 含めないタスクの目印・目印の無い Bot の投稿は除く
          {
            id: 2,
            user: bot,
            state: "COMMENTED",
            body: "<!-- sacty-review:r2 -->\n別のタスク",
            submitted_at: at(2),
          },
          { id: 3, user: ci, state: "COMMENTED", body: "CI が通りました", submitted_at: at(3) },
          // ほかの Bot が目印を写しても含めない
          {
            id: 4,
            user: ci,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1 -->\n写し",
            submitted_at: at(4),
          },
        ],
      },
      {
        status: 200,
        json: [
          {
            id: 5,
            user: bot,
            body: "<!-- sacty-review:r1 -->\n上限が無い",
            path: "src/retry.ts",
            line: 3,
            created_at: at(5),
          },
        ],
      },
      { status: 200, json: [] },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      number: 7,
      account: "sacty[bot]",
      sactyReviews: [{ key: "r1", account: "sacty[bot]", allowed: true }],
    });
    expect(feedback.map((f) => f.key)).toEqual(["review:1", "review_comment:5"]);
  });
});

describe("元のタスクと違うアカウントの sacty のレビュー（PBI-88 再レビューの指摘）", () => {
  const at = (n: number) => `2026-10-11T00:00:0${n}Z`;
  const reviews = (user: { login: string; type: string }) => [
    {
      id: 1,
      user,
      state: "COMMENTED",
      body: "<!-- sacty-review:r1 -->\n指摘なしの回",
      submitted_at: at(1),
    },
    {
      id: 2,
      user,
      state: "COMMENTED",
      body: "<!-- sacty-review:r1:2 -->\n指摘ありの回",
      submitted_at: at(2),
    },
    // 元のタスクのアカウントの、知らない sacty のレビューは除く
    {
      id: 3,
      user: { login: "parent", type: "User" },
      state: "COMMENTED",
      body: "<!-- sacty-review:other -->\n別のタスク",
      submitted_at: at(3),
    },
    // 回のアカウントと違う人が目印を写したものは、人の指摘として取り込む
    {
      id: 4,
      user: { login: "someone", type: "User" },
      state: "COMMENTED",
      body: "<!-- sacty-review:r1 -->\n写して同意",
      submitted_at: at(4),
    },
  ];
  const lines = (user: { login: string; type: string }) => [
    {
      id: 5,
      user,
      body: "<!-- sacty-review:r1 -->\n指摘なしの回の行",
      path: "a.ts",
      line: 1,
      created_at: at(5),
    },
    {
      id: 6,
      user,
      body: "<!-- sacty-review:r1:2 -->\n指摘ありの回の行",
      path: "a.ts",
      line: 2,
      created_at: at(6),
    },
  ];

  for (const type of ["Bot", "User"]) {
    it(`投稿者が ${type} でも、そのタスクのアカウントと回で判定し、許可した回だけを取り込む`, async () => {
      const login = type === "Bot" ? "reviewer[bot]" : "reviewer";
      const user = { login, type };
      const { impl } = fakeFetch([
        { status: 200, json: reviews(user) },
        { status: 200, json: lines(user) },
        { status: 200, json: [] },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        repo: "https://github.com/acme/app",
        token: "ghp_secret",
        number: 7,
        account: "parent",
        sactyReviews: [
          { key: "r1", account: login, allowed: false },
          { key: "r1:2", account: login, allowed: true },
        ],
      });
      expect(feedback.map((f) => f.key)).toEqual(["review:2", "review:4", "review_comment:6"]);
    });
  }
});
