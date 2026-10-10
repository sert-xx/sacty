import { describe, expect, it } from "vitest";
import { GitHubPullRequests } from "./github.js";

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
