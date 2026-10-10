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
    const found = await new GitHubIssueSearch(impl).search('repo:acme/app label:"sacty"', "t");
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

it("100件を超える結果は、次のページもたどる（DAの見直し）", async () => {
  const page = (from: number, count: number) => ({
    items: Array.from({ length: count }, (_, i) => ({
      number: from + i,
      title: `#${from + i}`,
      html_url: `https://github.com/acme/app/issues/${from + i}`,
      repository_url: "https://api.github.com/repos/acme/app",
      labels: [{ name: "sacty" }],
    })),
  });
  const { impl, calls } = fakeFetch([
    { status: 200, json: page(1, 100) },
    { status: 200, json: page(101, 3) },
  ]);
  const found = await new GitHubIssueSearch(impl).search("repo:acme/app", "t");
  expect(found).toHaveLength(103);
  expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
});
