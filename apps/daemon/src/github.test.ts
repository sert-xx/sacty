import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { errorText } from "./errors.js";
import {
  apiError,
  GitHubIssueSearch,
  GitHubPullRequests,
  githubRetryAfterMs,
  isTransientGitHubFailure,
  retryAfterOf,
} from "./github.js";

/** 記録した文言（コードと引数）を、日本語の文にする（PBI-11）。 */
const ja = (text: unknown) => renderMessage(text, "ja");

type Call = { url: string; method: string; body?: unknown; auth?: string };

/** 決まった応答を順に返す fetch の偽物。 */
function fakeFetch(
  responses: {
    status: number;
    json: unknown;
    headers?: Record<string, string>;
  }[],
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

/** 要求の前の最後の外しの読み取り・タイムラインの答え（PBI-468）。 */
const timelineAnswer = (...nodes: unknown[]) => ({
  status: 200,
  json: { data: { node: { timelineItems: { nodes } } } },
});
const readyEvent = (id: string) => ({
  __typename: "ReadyForReviewEvent",
  id,
  createdAt: "t1",
});
const convertEvent = (id: string) => ({
  __typename: "ConvertToDraftEvent",
  id,
  createdAt: "t2",
});
const markedAnswer = (...nodes: unknown[]) => ({
  status: 200,
  json: {
    data: {
      markPullRequestReadyForReview: {
        pullRequest: { isDraft: false, timelineItems: { nodes } },
      },
    },
  },
});

const input = {
  repo: "https://github.com/acme/app",
  token: "ghp_secret",
  branch: "sacty/task-1234abcd",
  baseBranch: "main",
  title: "決済API",
  body: "本文",
};

/** status の答えから fork を除く（fork 以外の項目を、完全一致で確かめるため）。 */
async function statusWithoutFork(
  client: GitHubPullRequests,
  pr: { repo: string; token: string; number: number },
) {
  const { fork: _fork, ...rest } = await client.status(pr);
  return rest;
}

describe("GitHub の PR（PBI-10b）", () => {
  it("PRを作る", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        json: { html_url: "https://github.com/acme/app/pull/7", number: 7 },
      },
    ]);
    const pr = await new GitHubPullRequests(impl).upsert(input);
    expect(pr).toEqual({
      url: "https://github.com/acme/app/pull/7",
      number: 7,
      draft: false,
    });
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/acme/app/pulls",
        method: "POST",
        body: {
          title: "決済API",
          head: "sacty/task-1234abcd",
          base: "main",
          body: "本文",
        },
        auth: "Bearer ghp_secret",
      },
    ]);
  });

  it("draft なら PR をドラフトで作る", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        json: {
          html_url: "https://github.com/acme/app/pull/7",
          number: 7,
          draft: true,
        },
      },
    ]);
    const pr = await new GitHubPullRequests(impl).upsert({
      ...input,
      draft: true,
    });
    expect(pr).toEqual({
      url: "https://github.com/acme/app/pull/7",
      number: 7,
      draft: true,
    });
    expect(calls[0]?.body).toMatchObject({ draft: true });
  });

  it("リポジトリがドラフトの PR を使えなければ（422）、ドラフトでない PR にする", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 422,
        json: {
          message: "Draft pull requests are not supported in this repository.",
        },
      },
      {
        status: 201,
        json: { html_url: "https://github.com/acme/app/pull/8", number: 8 },
      },
    ]);
    const pr = await new GitHubPullRequests(impl).upsert({
      ...input,
      draft: true,
    });
    expect(pr).toEqual({
      url: "https://github.com/acme/app/pull/8",
      number: 8,
      draft: false,
    });
    expect(calls.map((c) => (c.body as { draft?: boolean }).draft)).toEqual([true, undefined]);
  });

  it("requireDraft なら、リポジトリがドラフトの PR を使えなくても、ドラフトでない PR にしない（PBI-317）", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 422,
        json: {
          message: "Draft pull requests are not supported in this repository.",
        },
      },
      // 同じブランチの開いた PR は無い
      { status: 200, json: [] },
    ]);
    await expect(
      new GitHubPullRequests(impl).upsert({
        ...input,
        draft: true,
        requireDraft: true,
      }),
    ).rejects.toThrow();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("ドラフトを外すときは、PR の node_id で GraphQL の markPullRequestReadyForReview を呼ぶ", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { number: 7, draft: true, node_id: "PR_node" } },
      timelineAnswer(),
      markedAnswer(readyEvent("RFR_1")),
    ]);
    const result = await new GitHubPullRequests(impl).setDraft({
      repo: input.repo,
      token: input.token,
      number: 7,
      draft: false,
    });
    expect(result).toEqual({
      draft: false,
      changed: true,
      previous: "none",
      readyId: "RFR_1",
    });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://api.github.com/repos/acme/app/pulls/7"],
      ["POST", "https://api.github.com/graphql"],
      ["POST", "https://api.github.com/graphql"],
    ]);
    const body = calls[2]?.body as { query: string; variables: unknown };
    expect(body.query).toContain("markPullRequestReadyForReview");
    expect(body.variables).toEqual({ id: "PR_node" });
    expect(calls[2]?.auth).toBe("Bearer ghp_secret");
  });

  it("ドラフトの切り替えの通信には、渡した中断の合図を付ける（PBI-331）", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const answers = [
      { number: 7, draft: true, node_id: "PR_node" },
      timelineAnswer().json,
      markedAnswer().json,
    ];
    const impl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      return new Response(JSON.stringify(answers[seen.length - 1]), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const abort = new AbortController();
    await new GitHubPullRequests(impl).setDraft({
      repo: input.repo,
      token: input.token,
      number: 7,
      draft: false,
      signal: abort.signal,
    });
    expect(seen).toEqual([abort.signal, abort.signal, abort.signal]);
  });

  it("ドラフトに戻すときは convertPullRequestToDraft を呼び、すでにその状態なら何もしない", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { number: 7, draft: false, node_id: "PR_node" } },
      {
        status: 200,
        json: {
          data: {
            convertPullRequestToDraft: { pullRequest: { isDraft: true } },
          },
        },
      },
      { status: 200, json: { number: 7, draft: true, node_id: "PR_node" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const args = {
      repo: input.repo,
      token: input.token,
      number: 7,
      draft: true,
    };
    expect(await client.setDraft(args)).toEqual({ draft: true, changed: true });
    expect(await client.setDraft(args)).toEqual({
      draft: true,
      changed: false,
    });
    expect(JSON.stringify(calls[1]?.body)).toContain("convertPullRequestToDraft");
    expect(calls).toHaveLength(3);
  });

  it("draftHistory：ドラフトならタイムラインを読まずにドラフトを返し、ドラフトでなければ最後の切り替えの id・種類を返し、読めなければ読めないことを返す（PBI-468）", async () => {
    const args = { repo: input.repo, token: input.token, number: 7 };
    const read = async (
      responses: { status: number; json: unknown }[],
    ): Promise<{ history: unknown; calls: number }> => {
      const { impl, calls } = fakeFetch(responses);
      const history = await new GitHubPullRequests(impl).draftHistory(args);
      return { history, calls: calls.length };
    };
    const rest = (draft: boolean) => ({
      status: 200,
      json: { number: 7, draft, node_id: "PR_node" },
    });
    // ドラフト：REST だけ
    expect(await read([rest(true)])).toEqual({
      history: { read: true, draft: true },
      calls: 1,
    });
    // ドラフトでない：最後の切り替え（外した・ドラフトにした）
    expect((await read([rest(false), timelineAnswer(readyEvent("RFR_1"))])).history).toEqual({
      read: true,
      draft: false,
      last: { id: "RFR_1", kind: "ready_for_review", at: "t1" },
    });
    expect((await read([rest(false), timelineAnswer(convertEvent("CTD_1"))])).history).toEqual({
      read: true,
      draft: false,
      last: { id: "CTD_1", kind: "convert_to_draft", at: "t2" },
    });
    // 切り替えが1件も無い
    expect((await read([rest(false), timelineAnswer()])).history).toEqual({
      read: true,
      draft: false,
    });
    // 読めない：draft の読み取りのエラー・タイムラインのエラー
    expect((await read([{ status: 502, json: {} }])).history).toEqual({
      read: false,
    });
    expect((await read([rest(false), { status: 502, json: {} }])).history).toEqual({
      read: false,
    });
    expect(
      (await read([rest(false), { status: 200, json: { errors: [{ message: "boom" }] } }])).history,
    ).toEqual({ read: false });
    // 読む型は、外しとドラフトにした切り替えの両方
    const { impl, calls } = fakeFetch([rest(false), timelineAnswer()]);
    await new GitHubPullRequests(impl).draftHistory(args);
    const query = (calls[1]?.body as { query: string } | undefined)?.query;
    expect(query).toContain("READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT");
    expect(query).toContain("last: 1");
  });

  it("draftHistory：通信が例外になる・PR の答えに node_id が無いときも、読めないことを返す（PBI-468）", async () => {
    const args = { repo: input.repo, token: input.token, number: 7 };
    const rejecting = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    expect(await new GitHubPullRequests(rejecting).draftHistory(args)).toEqual({
      read: false,
    });
    const { impl, calls } = fakeFetch([{ status: 200, json: { number: 7, draft: false } }]);
    expect(await new GitHubPullRequests(impl).draftHistory(args)).toEqual({
      read: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("setDraft の外し：すでに外れていれば何も呼ばず changed: false。変えたときは、要求の前の最後の外しの id（無ければ none・読めなければ unreadable）と、答えの外しの id（あれば）を返す（PBI-468）", async () => {
    const args = {
      repo: input.repo,
      token: input.token,
      number: 7,
      draft: false,
    };
    const rest = (draft: boolean) => ({
      status: 200,
      json: { number: 7, draft, node_id: "PR_node" },
    });
    // すでに外れている：mutation も要求の前の読み取りも呼ばない
    const already = fakeFetch([rest(false)]);
    expect(await new GitHubPullRequests(already.impl).setDraft(args)).toEqual({
      draft: false,
      changed: false,
    });
    expect(already.calls).toHaveLength(1);
    // 要求の前に外しがあった・答えにも id がある
    const before = fakeFetch([
      rest(true),
      timelineAnswer(readyEvent("RFR_old")),
      markedAnswer(readyEvent("RFR_new")),
    ]);
    expect(await new GitHubPullRequests(before.impl).setDraft(args)).toEqual({
      draft: false,
      changed: true,
      previous: { id: "RFR_old" },
      readyId: "RFR_new",
    });
    // 要求の前の読み取りは、外しの切り替えだけを読む
    const previousQuery = (before.calls[1]?.body as { query: string } | undefined)?.query;
    expect(previousQuery).toContain("itemTypes: [READY_FOR_REVIEW_EVENT]");
    expect(previousQuery).not.toContain("CONVERT_TO_DRAFT_EVENT");
    // 要求の前の読み取りが失敗しても、外す要求は呼ぶ。答えに id が無ければ返さない
    const failed = fakeFetch([rest(true), { status: 502, json: {} }, markedAnswer()]);
    const answer = await new GitHubPullRequests(failed.impl).setDraft(args);
    expect(answer).toEqual({
      draft: false,
      changed: true,
      previous: "unreadable",
    });
    expect("readyId" in answer).toBe(false);
    expect(failed.calls).toHaveLength(3);
  });

  it("PR の答えを読めない・ドラフトかが書かれていないときは、切り替えずに失敗にする（ドラフトのまま進めない）", async () => {
    for (const json of [undefined, { number: 7, node_id: "PR_node" }]) {
      const { impl, calls } = fakeFetch([{ status: 200, json }]);
      const error = await new GitHubPullRequests(impl)
        .setDraft({
          repo: input.repo,
          token: input.token,
          number: 7,
          draft: false,
        })
        .catch((e: unknown) => e);
      expect(ja(errorText(error)), JSON.stringify(json)).toContain(
        "PR のドラフトを切り替えられませんでした",
      );
      expect(calls).toHaveLength(1);
    }
  });

  it("GraphQL の答えを読めない・変えた後の状態が求めたものでないときは、失敗にする", async () => {
    for (const answer of [
      undefined,
      { data: { markPullRequestReadyForReview: {} } },
      {
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: true } },
        },
      },
    ]) {
      const { impl } = fakeFetch([
        { status: 200, json: { number: 7, draft: true, node_id: "PR_node" } },
        timelineAnswer(),
        { status: 200, json: answer },
      ]);
      const error = await new GitHubPullRequests(impl)
        .setDraft({
          repo: input.repo,
          token: input.token,
          number: 7,
          draft: false,
        })
        .catch((e: unknown) => e);
      expect(ja(errorText(error)), JSON.stringify(answer)).toContain(
        "PR のドラフトを切り替えられませんでした",
      );
    }
  });

  it("GraphQL の答えにエラーがあれば、ドラフトの切り替えの失敗にする", async () => {
    const { impl } = fakeFetch([
      { status: 200, json: { number: 7, draft: true, node_id: "PR_node" } },
      timelineAnswer(),
      {
        status: 200,
        json: {
          errors: [{ message: "Resource not accessible by integration" }],
        },
      },
    ]);
    const error = await new GitHubPullRequests(impl)
      .setDraft({
        repo: input.repo,
        token: input.token,
        number: 7,
        draft: false,
      })
      .catch((e: unknown) => e);
    expect(ja(errorText(error))).toContain("PR のドラフトを切り替えられませんでした");
    expect(ja(errorText(error))).toContain("Resource not accessible by integration");
  });

  it("GitHub Enterprise Server のリポジトリは、そのホストの /api/v3 で PR を作る（PBI-40）", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        json: {
          html_url: "https://ghe.example.co.jp/acme/app/pull/3",
          number: 3,
        },
      },
      {
        status: 201,
        json: { html_url: "https://ghe.example.co.jp/acme/app/issues/3#c1" },
      },
    ]);
    const client = new GitHubPullRequests(impl);
    await client.upsert({
      ...input,
      repo: "https://ghe.example.co.jp/acme/app",
    });
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
      {
        status: 200,
        json: [{ html_url: "https://github.com/acme/app/pull/8", number: 8 }],
      },
    ]);
    const pr = await new GitHubPullRequests(impl).upsert(input);
    expect(pr.number).toBe(8);
    // 本文は書いていないので、そう示す（PBI-334。前回の版として記録しない）
    expect(pr.existing).toBe(true);
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/acme/app/pulls?state=open&head=acme%3Asacty%2Ftask-1234abcd",
    );
  });

  it("更新で retarget なら、向き先（base）も baseBranch に付け替える。無ければ向き先を送らない（PBI-317）", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: { html_url: "https://github.com/acme/app/pull/7", number: 7 },
      },
      {
        status: 200,
        json: { html_url: "https://github.com/acme/app/pull/7", number: 7 },
      },
    ]);
    const client = new GitHubPullRequests(impl);
    await client.upsert({
      ...input,
      number: 7,
      baseBranch: "main",
      retarget: true,
    });
    await client.upsert({ ...input, number: 7, baseBranch: "main" });
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: { body: "本文", base: "main" },
    });
    expect(calls[1]?.body).toEqual({ body: "本文" });
  });

  it("更新で本文が無ければ、本文を送らない（人が直した本文に触れない。PBI-334）。作った PR は existing にしない", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: { html_url: "https://github.com/acme/app/pull/7", number: 7 },
      },
      {
        status: 201,
        json: { html_url: "https://github.com/acme/app/pull/9", number: 9 },
      },
    ]);
    const client = new GitHubPullRequests(impl);
    await client.upsert({ ...input, number: 7, body: undefined });
    expect(calls[0]).toMatchObject({ method: "PATCH" });
    expect(calls[0]?.body).toEqual({});
    expect((await client.upsert(input)).existing).toBeUndefined();
  });

  it("PR の今の本文を読む。本文が無ければ空、読めない・答えが JSON でなければ失敗にする（PBI-334）", async () => {
    const ok = fakeFetch([{ status: 200, json: { body: "人の本文" } }]);
    expect(
      await new GitHubPullRequests(ok.impl).pullRequestBody({
        ...input,
        number: 7,
      }),
    ).toBe("人の本文");
    const empty = fakeFetch([{ status: 200, json: { body: null } }]);
    expect(
      await new GitHubPullRequests(empty.impl).pullRequestBody({
        ...input,
        number: 7,
      }),
    ).toBe("");
    const denied = fakeFetch([{ status: 404, json: { message: "Not Found" } }]);
    await expect(
      new GitHubPullRequests(denied.impl).pullRequestBody({
        ...input,
        number: 7,
      }),
    ).rejects.toThrow();
  });

  it("番号があれば本文を更新し、失敗は理由つきのエラーにする（トークンは含めない）", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: { html_url: "https://github.com/acme/app/pull/7", number: 7 },
      },
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
      params: {
        action: "updatePr",
        status: 401,
        detail: "Bad credentials",
        hint: "token",
      },
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
        headers: {
          link: `<https://api.github.com/orgs/acme/repos?page=2>; rel="next"`,
        },
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
      {
        status: 200,
        json: {
          incomplete_results: true,
          items: [item(2, "2026-01-01T00:00:02Z")],
        },
      },
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
    await client.close({
      repo: "https://github.com/acme/app",
      token: "t",
      number: 7,
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/pulls/7",
      method: "PATCH",
      body: { state: "closed" },
    });
    await expect(
      client.close({
        repo: "https://github.com/acme/app",
        token: "t",
        number: 8,
      }),
    ).rejects.toThrow(/PRを閉じられませんでした：GitHub API 404/);
  });
});

describe("承認待ちの間の PR の状態（PBI-14a）", () => {
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
    const pr = {
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      number: 7,
    };
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "merged",
      mergedBy: "reviewer",
      headSha: "abc",
      mergeCommit: "def",
    });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "closed" });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "open" });
    expect(errorText(await client.status(pr).catch((e: unknown) => e))).toEqual({
      code: "github.failed",
      params: {
        action: "getPr",
        status: 404,
        detail: "Not Found",
        hint: "permission",
      },
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/pulls/7",
      method: "GET",
      auth: "Bearer ghp_secret",
    });
  });
});

describe("承認待ちの PR のベースブランチとの競合（mergeable）", () => {
  it("開いている PR の mergeable を、true・false のときだけ答えに含める（計算中の null・無いときは含めない）。追加の問い合わせはしない", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          state: "open",
          merged: false,
          head: { sha: "a" },
          mergeable: false,
        },
      },
      {
        status: 200,
        json: {
          state: "open",
          merged: false,
          head: { sha: "a" },
          mergeable: true,
        },
      },
      { status: 200, json: { state: "open", merged: false, mergeable: null } },
      {
        status: 200,
        json: { state: "open", merged: false, mergeable: "dirty" },
      },
      // 閉じた・マージ済みの PR には含めない
      {
        status: 200,
        json: { state: "closed", merged: false, mergeable: false },
      },
    ]);
    const client = new GitHubPullRequests(impl);
    const pr = { repo: "https://github.com/acme/app", token: "t", number: 7 };
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "open",
      headSha: "a",
      mergeable: false,
    });
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "open",
      headSha: "a",
      mergeable: true,
    });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "open" });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "open" });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "closed" });
    // PR の状態を読む 1 回の問い合わせだけ
    expect(calls).toHaveLength(5);
  });
});

describe("PR の更新の時刻（PBI-411）", () => {
  it("PR の状態の答えに、updated_at が文字列のときだけ、更新の時刻を含める（どの状態でも。追加の問い合わせはしない）", async () => {
    const at = "2026-11-20T00:10:00Z";
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          state: "open",
          merged: false,
          updated_at: at,
          head: { sha: "abc" },
        },
      },
      { status: 200, json: { state: "closed", merged: false, updated_at: at } },
      { status: 200, json: { state: "closed", merged: true, updated_at: at } },
      { status: 200, json: { state: "open", merged: false, updated_at: 5 } },
      { status: 200, json: { state: "open", merged: false, updated_at: "" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const pr = { repo: "https://github.com/acme/app", token: "t", number: 7 };
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "open",
      headSha: "abc",
      updatedAt: at,
    });
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "closed",
      updatedAt: at,
    });
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "merged",
      updatedAt: at,
    });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "open" });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "open" });
    expect(calls).toHaveLength(5);
  });
});

describe("承認待ちの PR のドラフト（PBI-331）", () => {
  it("開いている PR の draft を、真偽値のときだけ答えに含める（閉じた PR には含めない。PR #348 9回目のレビュー指摘）", async () => {
    const { impl } = fakeFetch([
      { status: 200, json: { state: "open", merged: false, draft: true } },
      { status: 200, json: { state: "open", merged: false, draft: false } },
      { status: 200, json: { state: "open", merged: false, draft: "yes" } },
      { status: 200, json: { state: "closed", merged: false, draft: true } },
    ]);
    const client = new GitHubPullRequests(impl);
    const pr = { repo: "https://github.com/acme/app", token: "t", number: 7 };
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "open",
      draft: true,
    });
    expect(await statusWithoutFork(client, pr)).toEqual({
      state: "open",
      draft: false,
    });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "open" });
    expect(await statusWithoutFork(client, pr)).toEqual({ state: "closed" });
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
          {
            id: 20,
            user: human,
            body: "テストも足してほしい",
            created_at: "2026-10-11T00:00:08Z",
          },
          {
            id: 21,
            user: bot,
            body: "deployed",
            created_at: "2026-10-11T00:00:09Z",
          },
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

describe("PR の行へのコメントへの返信（PBI-352）", () => {
  const target = {
    repo: "https://github.com/acme/app",
    token: "ghp_secret",
    number: 7,
  };

  it("GitHub が示す待ちは、retry-after と x-ratelimit-reset の両方があれば、遅い方（PBI-356）", () => {
    const now = 1_800_000_000_000;
    const reset = (seconds: number) => String(now / 1000 + seconds);
    const of = (headers: Record<string, string>) => retryAfterOf(new Headers(headers), now);
    // retry-after の方が早い：reset まで待つ
    expect(
      of({
        "retry-after": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset(600),
      }),
    ).toBe(600_000);
    // reset の方が早い：retry-after まで待つ
    expect(
      of({
        "retry-after": "900",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset(600),
      }),
    ).toBe(900_000);
    // 残りが 0 でなければ、reset は待ちの条件にしない
    expect(
      of({
        "retry-after": "60",
        "x-ratelimit-remaining": "12",
        "x-ratelimit-reset": reset(600),
      }),
    ).toBe(60_000);
    // 片方だけ・どちらも無い・読めない値
    expect(of({ "retry-after": "30" })).toBe(30_000);
    expect(of({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(45) })).toBe(45_000);
    expect(of({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(-45) })).toBe(0);
    expect(of({})).toBeUndefined();
    expect(of({ "retry-after": "soon" })).toBeUndefined();
  });

  it("レート制限で断られたときは、GitHub が示した、次に試せるまでの時間を、エラーに持たせる（retry-after・x-ratelimit-reset）", async () => {
    const limit = { message: "You have exceeded a secondary rate limit." };
    const reset = Math.floor(Date.now() / 1000) + 600;
    const { impl } = fakeFetch([
      { status: 403, json: limit, headers: { "retry-after": "120" } },
      {
        status: 403,
        json: limit,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      },
      { status: 404, json: { message: "Not Found" } },
      { status: 429, json: limit, headers: { "retry-after": "30" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const input = { ...target, commentId: 501, body: "x" };
    const after = await client.replyToReviewComment(input).catch((e: unknown) => e);
    expect(githubRetryAfterMs(after)).toBe(120_000);
    const untilReset = githubRetryAfterMs(
      await client.commentIssue({ ...target, body: "x" }).catch((e: unknown) => e),
    );
    expect(untilReset).toBeGreaterThan(590_000);
    expect(untilReset).toBeLessThanOrEqual(600_000);
    // 本文を読めなくても、ヘッダーが制限を示していれば、持たせる
    const unreadable = new GitHubPullRequests(
      fakeFetch([
        {
          status: 403,
          json: {},
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        },
      ]).impl,
    );
    expect(
      githubRetryAfterMs(
        await unreadable
          .listIssueComments({ ...target, prefix: "x", complete: true })
          .catch((e: unknown) => e),
      ),
    ).toBeGreaterThan(590_000);
    // 本文が null でも、状態とヘッダーからエラーを作る（一覧・返信・PR のコメント）
    const nullBody = () => ({
      status: 403,
      json: null,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
    });
    const nulls = new GitHubPullRequests(fakeFetch([nullBody(), nullBody(), nullBody()]).impl);
    for (const failed of [
      await nulls
        .listReviewComments({ ...target, prefix: "x", complete: true })
        .catch((e: unknown) => e),
      await nulls.replyToReviewComment(input).catch((e: unknown) => e),
      await nulls.commentIssue({ ...target, body: "x" }).catch((e: unknown) => e),
    ]) {
      expect(errorText(failed)).toMatchObject({
        code: "github.failed",
        params: { status: 403 },
      });
      expect(githubRetryAfterMs(failed)).toBeGreaterThan(590_000);
    }
    // 示されていなければ、無い
    expect(
      githubRetryAfterMs(await client.replyToReviewComment(input).catch((e: unknown) => e)),
    ).toBeUndefined();
    // 一覧の読み取りでも持たせる
    expect(
      githubRetryAfterMs(
        await client.listReviewComments({ ...target, prefix: "x" }).catch((e: unknown) => e),
      ),
    ).toBe(30_000);
  });

  it("行へのコメントに返信して URL を返し、失敗（消えたコメント・返信への返信）は理由つきのエラーにする", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        json: { html_url: "https://github.com/acme/app/pull/7#discussion_r99" },
      },
      { status: 404, json: { message: "Not Found" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const input = { ...target, commentId: 501, body: "**対応しました。**" };
    expect(await client.replyToReviewComment(input)).toEqual({
      url: "https://github.com/acme/app/pull/7#discussion_r99",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/pulls/7/comments/501/replies",
      method: "POST",
      body: { body: "**対応しました。**" },
      auth: "Bearer ghp_secret",
    });
    expect(
      errorText(await client.replyToReviewComment(input).catch((e: unknown) => e)),
    ).toMatchObject({
      code: "github.failed",
      params: { status: 404 },
    });
  });

  it("行へのコメントから、本文が目印で始まる、そのアカウントの投稿だけを選ぶ（まねた・引用した投稿は選ばない）", async () => {
    const marker = "<!-- sacty-reply:t1:implement-1-1:";
    const c = (id: number, login: string, body: string) => ({
      id,
      body,
      user: { login },
      html_url: `https://github.com/acme/app/pull/7#discussion_r${id}`,
    });
    const list = [
      c(1, "alice", "人のコメント"),
      c(2, "mallory", `${marker}2 -->\nまねた投稿`),
      c(3, "Sacty-Bot", `> 引用\n${marker}2 -->`),
      c(4, "Sacty-Bot", `${marker}2 -->\n直しました`),
    ];
    const { impl, calls } = fakeFetch([{ status: 200, json: list }]);
    const client = new GitHubPullRequests(impl);
    expect(
      await client.listReviewComments({
        ...target,
        prefix: marker,
        account: "sacty-bot",
      }),
    ).toEqual([
      {
        id: 4,
        url: "https://github.com/acme/app/pull/7#discussion_r4",
        body: `${marker}2 -->\n直しました`,
        author: "Sacty-Bot",
      },
    ]);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/app/pulls/7/comments?per_page=100",
    );
  });

  it("最後まで読む指定では、ページ数の上限で読み切れなかったら失敗する（途中までの結果を、無いことの根拠にしない）。指定が無ければ、今までどおり途中までを返す", async () => {
    const page = (n: number) => ({
      status: 200,
      json: [{ id: n, body: "x", user: { login: "a" } }],
      headers: {
        link: `<https://api.github.com/repos/acme/app/pulls/7/comments?per_page=100&page=${n + 1}>; rel="next"`,
      },
    });
    const pages = () => Array.from({ length: 50 }, (_, i) => page(i + 1));
    const complete = new GitHubPullRequests(fakeFetch(pages()).impl);
    expect(
      errorText(
        await complete
          .listReviewComments({ ...target, prefix: "x", complete: true })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({ code: "github.commentsIncomplete" });
    const issue = new GitHubPullRequests(fakeFetch(pages()).impl);
    expect(
      errorText(
        await issue
          .listIssueComments({ ...target, prefix: "x", complete: true })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({ code: "github.commentsIncomplete" });
    // 読めない答え（配列でない）も、空の一覧として扱わない
    const unreadable = new GitHubPullRequests(fakeFetch([{ status: 200, json: {} }]).impl);
    expect(
      errorText(
        await unreadable
          .listReviewComments({ ...target, prefix: "x", complete: true })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({ code: "github.commentsIncomplete" });
    const unreadableIssue = new GitHubPullRequests(fakeFetch([{ status: 200, json: {} }]).impl);
    expect(
      errorText(
        await unreadableIssue
          .listIssueComments({ ...target, prefix: "x", complete: true })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({ code: "github.commentsIncomplete" });
    // 照合に要る項目（本文・ID・投稿者）を読めないコメントも、黙って除かない
    for (const broken of [
      { id: 1, body: null, user: { login: "a" } },
      { id: "1", body: "x", user: { login: "a" } },
      { id: 1, body: "x", user: null },
    ]) {
      const client = new GitHubPullRequests(fakeFetch([{ status: 200, json: [broken] }]).impl);
      expect(
        errorText(
          await client
            .listReviewComments({ ...target, prefix: "x", complete: true })
            .catch((e: unknown) => e),
        ),
      ).toMatchObject({ code: "github.commentsIncomplete" });
    }
    // たどれない次のページ（API の外の URL）を、読み終わりとして扱わない
    const outside = new GitHubPullRequests(
      fakeFetch([
        {
          status: 200,
          json: [],
          headers: {
            link: '<https://evil.example.com/next?page=2>; rel="next"',
          },
        },
      ]).impl,
    );
    expect(
      errorText(
        await outside
          .listIssueComments({ ...target, prefix: "x", complete: true })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({ code: "github.commentsIncomplete" });
    const partial = new GitHubPullRequests(fakeFetch(pages()).impl);
    expect(await partial.listReviewComments({ ...target, prefix: "x" })).toHaveLength(50);
  });
});

describe("Issue へのコメント（PBI-18）", () => {
  it("Issue にコメントして URL を返し、失敗は理由つきのエラーにする", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        json: {
          html_url: "https://github.com/acme/app/issues/5#issuecomment-9",
        },
      },
      {
        status: 403,
        json: { message: "Resource not accessible by integration" },
      },
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

  it("Issue を作って URL と番号を返し、失敗は理由つきのエラーにする（PBI-370）", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        json: { html_url: "https://github.com/acme/app/issues/12", number: 12 },
      },
      { status: 410, json: { message: "Issues are disabled for this repo" } },
    ]);
    const client = new GitHubPullRequests(impl);
    const input = {
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      title: "[PR #7 follow-up] 稀な条件",
      body: "本文",
    };
    expect(await client.createIssue(input)).toEqual({
      url: "https://github.com/acme/app/issues/12",
      number: 12,
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/issues",
      method: "POST",
      body: { title: "[PR #7 follow-up] 稀な条件", body: "本文" },
      auth: "Bearer ghp_secret",
    });
    expect(errorText(await client.createIssue(input).catch((e: unknown) => e))).toMatchObject({
      code: "github.failed",
      params: { action: "createIssue", status: 410 },
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
        headers: {
          link: `<${api}/issues/5/comments?per_page=100&page=2>; rel="next"`,
        },
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
    const target = {
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      number: 5,
    };
    expect(
      await client.findIssueComment({
        ...target,
        marker: "<!-- sacty-investigation:t1 -->",
      }),
    ).toEqual({ url: "https://github.com/acme/app/issues/5#issuecomment-2" });
    expect(calls.map((c) => c.url)).toEqual([
      `${api}/issues/5/comments?per_page=100`,
      `${api}/issues/5/comments?per_page=100&page=2`,
    ]);
    expect(calls[0]?.auth).toBe("Bearer ghp_secret");
    // accounts を渡すと、そのアカウントが投稿し、本文が目印で始まるものだけを見つける（他人が目印をまねても、書き済みと見なさない）
    const marker = "<!-- sacty-merge-approval:t1:8 -->";
    const posted = (login: string, body: string) => ({
      user: { login },
      body,
      html_url: `https://github.com/acme/app/issues/8#issuecomment-${login}`,
    });
    const mimic = new GitHubPullRequests(
      fakeFetch([
        { status: 200, json: [posted("mallory", `${marker}\nまね`)] },
        {
          status: 200,
          json: [posted("mallory", `${marker}\nまね`), posted("Sacty-Bot", `${marker}\n本物`)],
        },
      ]).impl,
    );
    expect(
      await mimic.findIssueComment({
        ...target,
        marker,
        accounts: ["sacty-bot"],
      }),
    ).toBeUndefined();
    expect(
      await mimic.findIssueComment({
        ...target,
        marker,
        accounts: ["sacty-bot"],
      }),
    ).toEqual({
      url: "https://github.com/acme/app/issues/8#issuecomment-Sacty-Bot",
    });
    expect(
      await client.findIssueComment({
        ...target,
        marker: "<!-- sacty-investigation:t2 -->",
      }),
    ).toBeUndefined();
    expect(
      errorText(
        await client
          .findIssueComment({
            ...target,
            marker: "<!-- sacty-investigation:t1 -->",
          })
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
  const target = {
    repo: "https://github.com/acme/app",
    token: "ghp_secret",
    number: 12,
  };

  it("PR の先頭・向き先のコミットと説明・作者を読み、失敗は理由つきのエラーにする", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          number: 12,
          html_url: "https://github.com/acme/app/pull/12",
          title: "再試行",
          body: null,
          user: { login: "alice" },
          head: { sha: "h".repeat(40) },
          base: { sha: "b".repeat(40) },
          // チームへの依頼（requested_teams）は含めない。login の無いものは除く
          requested_reviewers: [{ login: "me" }, { login: "" }, null, { id: 1 }, { login: "bob" }],
          requested_teams: [{ slug: "core" }],
        },
      },
      { status: 404, json: { message: "Not Found" } },
      // 作者が読めない（削除されたアカウントなど）ときは空
      { status: 200, json: { number: 12, user: null, head: {}, base: {} } },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(await client.pullRequest(target)).toEqual({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      title: "再試行",
      body: "",
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
      author: "alice",
      requestedReviewers: ["me", "bob"],
    });
    expect(calls[0]).toMatchObject({
      url: `${api}/pulls/12`,
      auth: "Bearer ghp_secret",
    });
    expect(errorText(await client.pullRequest(target).catch((e: unknown) => e))).toMatchObject({
      code: "github.failed",
      params: { action: "getPr", status: 404 },
    });
    // 作者も依頼先も読めないときは空
    expect(await client.pullRequest(target)).toMatchObject({
      author: "",
      requestedReviewers: [],
    });
  });

  it("引き継ぐ PR の状態・元のブランチとそのリポジトリ・向き先のブランチを読み、読めなければ持たない", async () => {
    const pr = (patch: Record<string, unknown>) => ({
      status: 200,
      json: {
        number: 12,
        html_url: "https://github.com/acme/app/pull/12",
        state: "open",
        merged: false,
        head: {
          sha: "h".repeat(40),
          ref: "feature/retry",
          repo: { html_url: "https://github.com/acme/app" },
        },
        base: { sha: "b".repeat(40), ref: "main" },
        ...patch,
      },
    });
    const { impl } = fakeFetch([
      pr({}),
      pr({ state: "closed", merged: true }),
      pr({ state: "closed", merged: false, merged_at: null }),
      // フォークが消された PR は、元のブランチのリポジトリが null
      pr({
        head: { sha: "h".repeat(40), ref: "x", repo: null },
        base: {},
        state: undefined,
      }),
    ]);
    const client = new GitHubPullRequests(impl);
    expect(await client.pullRequest(target)).toMatchObject({
      state: "open",
      headRef: "feature/retry",
      headRepo: "https://github.com/acme/app",
      baseRef: "main",
    });
    expect((await client.pullRequest(target)).state).toBe("merged");
    expect((await client.pullRequest(target)).state).toBe("closed");
    const unknown = await client.pullRequest(target);
    expect(unknown.headRef).toBe("x");
    expect("headRepo" in unknown || "baseRef" in unknown || "state" in unknown).toBe(false);
  });

  it("PR で、その人に最後にレビューを依頼した日時を、できごとのすべてのページから読む（PBI-143）", async () => {
    const page2 = `${api}/issues/12/events?per_page=100&page=2`;
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        headers: { link: `<${page2}>; rel="next"` },
        json: [
          {
            event: "review_requested",
            requested_reviewer: { login: "me" },
            created_at: "2026-10-19T01:00:00Z",
          },
          {
            event: "review_requested",
            requested_reviewer: { login: "bob" },
            created_at: "2026-10-19T05:00:00Z",
          },
          // チームへの依頼は含めない
          {
            event: "review_requested",
            requested_team: { slug: "core" },
            created_at: "2026-10-19T06:00:00Z",
          },
        ],
      },
      {
        status: 200,
        json: [
          // login の大文字・小文字は区別しない。新しいものを返す（並びに頼らない）
          {
            event: "review_requested",
            requested_reviewer: { login: "Me" },
            created_at: "2026-10-19T03:00:00Z",
          },
          {
            event: "review_requested",
            requested_reviewer: { login: "me" },
            created_at: "2026-10-19T02:00:00Z",
          },
          {
            event: "review_request_removed",
            requested_reviewer: { login: "me" },
            created_at: "2026-10-19T04:00:00Z",
          },
          { event: "labeled", created_at: "2026-10-19T07:00:00Z" },
        ],
      },
      { status: 200, json: [] },
      { status: 404, json: { message: "Not Found" } },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(await client.lastReviewRequest({ ...target, reviewer: "me" })).toBe(
      "2026-10-19T03:00:00Z",
    );
    expect(calls.map((c) => c.url)).toEqual([`${api}/issues/12/events?per_page=100`, page2]);
    // 依頼が無ければ undefined
    expect(await client.lastReviewRequest({ ...target, reviewer: "me" })).toBeUndefined();
    expect(
      errorText(
        await client.lastReviewRequest({ ...target, reviewer: "me" }).catch((e: unknown) => e),
      ),
    ).toMatchObject({
      code: "github.failed",
      params: { action: "listEvents", status: 404 },
    });
  });

  it("最後の依頼をした人（actor）を返す。人が分からなければ undefined（PBI-461）", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            event: "review_requested",
            requested_reviewer: { login: "me" },
            actor: { login: "old" },
            created_at: "2026-10-19T01:00:00Z",
          },
          {
            event: "review_requested",
            requested_reviewer: { login: "Me" },
            actor: { login: "mallory" },
            created_at: "2026-10-19T03:00:00Z",
          },
          {
            event: "review_requested",
            requested_reviewer: { login: "other" },
            actor: { login: "x" },
            created_at: "2026-10-19T05:00:00Z",
          },
        ],
      },
      {
        status: 200,
        json: [
          {
            event: "review_requested",
            requested_reviewer: { login: "me" },
            created_at: "2026-10-19T03:00:00Z",
          },
        ],
      },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(await client.lastReviewRequester({ ...target, reviewer: "me" })).toBe("mallory");
    expect(await client.lastReviewRequester({ ...target, reviewer: "me" })).toBeUndefined();
  });

  it.each([
    ["write", { permission: "write", role_name: "write" }, true],
    ["maintain", { permission: "write", role_name: "maintain" }, true],
    ["admin", { permission: "admin", role_name: "admin" }, true],
    ["triage", { permission: "read", role_name: "triage" }, false],
    ["read", { permission: "read", role_name: "read" }, false],
    ["none", { permission: "none" }, false],
  ])("書き込みの権限を読む：%s（PBI-461）", async (_n, json, expected) => {
    const { impl, calls } = fakeFetch([{ status: 200, json }]);
    const result = await new GitHubPullRequests(impl).canWrite({
      repo: "https://github.com/acme/app",
      token: "t",
      login: "someone",
    });
    expect(result).toBe(expected);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/app/collaborators/someone/permission",
    );
  });

  it("権限を読めないときは、権限が無いとは扱わず、失敗にする（PBI-461）", async () => {
    const { impl } = fakeFetch([{ status: 403, json: { message: "Forbidden" } }]);
    const error = await new GitHubPullRequests(impl)
      .canWrite({
        repo: "https://github.com/acme/app",
        token: "t",
        login: "someone",
      })
      .catch((e: unknown) => e);
    expect(errorText(error)).toMatchObject({
      code: "github.failed",
      params: { action: "getPermission", status: 403 },
    });
  });

  it.each([50, 51])(
    "依頼のできごとが%dページなら、上限内の完了と未完了を区別する",
    async (pages) => {
      const { impl, calls } = fakeFetch(
        Array.from({ length: pages }, (_, index) => ({
          status: 200,
          headers:
            index + 1 < pages
              ? {
                  link: `<${api}/issues/12/events?per_page=100&page=${index + 2}>; rel="next"`,
                }
              : {},
          json: [
            {
              event: "review_requested",
              requested_reviewer: { login: "me" },
              created_at: index === 50 ? "2026-10-19T03:00:00Z" : "2026-10-19T01:00:00Z",
            },
          ],
        })),
      );
      const result = new GitHubPullRequests(impl).lastReviewRequest({
        ...target,
        reviewer: "me",
      });
      if (pages === 50) await expect(result).resolves.toBe("2026-10-19T01:00:00Z");
      else {
        expect(errorText(await result.catch((error: unknown) => error))).toMatchObject({
          code: "github.eventsIncomplete",
        });
      }
      expect(calls).toHaveLength(50);
    },
  );

  it("コメントのレビュー（承認も変更の要求もしない）を、読んだコミットに投稿する", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          html_url: "https://github.com/acme/app/pull/12#pullrequestreview-5",
        },
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
        headers: {
          link: `<${api}/pulls/12/reviews?per_page=100&page=2>; rel="next"`,
        },
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
    ).toEqual({
      url: "https://github.com/acme/app/pull/12#pullrequestreview-2",
      // 投稿した本文も返す（本文に残した、投稿の直前の PR の先頭を記録し直すため。PR 121 レビュー指摘）
      body: "<!-- sacty-review:t1 -->\n## sacty のレビュー",
    });
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
          {
            id: 2,
            user: human,
            state: "COMMENTED",
            body: "ここを直して",
            submitted_at: at(2),
          },
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
          {
            id: 5,
            user: me,
            body: "手で書いた指摘",
            path: "a.ts",
            line: 1,
            created_at: at(5),
          },
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
        headers: {
          link: `<${api}/orgs/acme/repos?per_page=100&type=all&page=2>; rel="next"`,
        },
      },
      { status: 200, json: [{ full_name: "acme/api", private: true }] },
      { status: 403, json: { message: "Forbidden" } },
    ]);
    const client = new GitHubPullRequests(impl);
    expect(
      await client.repositories({
        org: "https://github.com/acme",
        token: "ghp_secret",
      }),
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
    ).toMatchObject({
      code: "github.failed",
      params: { action: "listRepositories", status: 403 },
    });
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
      await client.repositories({
        org: "https://github.com/someone",
        token: "ghp_secret",
      }),
    ).toEqual(["https://github.com/Someone/dotfiles", "https://github.com/Someone/private-app"]);
    expect(calls.map((c) => c.url)).toEqual([
      `${api}/orgs/someone/repos?per_page=100&type=all`,
      `${api}/users/someone/repos?per_page=100&type=owner`,
      `${api}/user/repos?per_page=100&affiliation=owner,collaborator,organization_member`,
    ]);
  });
});

describe("sacty が作る PR の取り込むラベル（PBI-88）", () => {
  const pr = {
    repo: "https://github.com/acme/app",
    token: "ghp_secret",
    number: 7,
  };

  describe("レビューが止まったことの投稿（PBI-292）", () => {
    const notice = (task: string, key = "k1", state = "") =>
      `<!-- sacty-review-stopped:${task}:${key}${state} -->\n## Sacty のレビューが止まりました`;
    const comment = (id: number, login: string, body: string) => ({
      id,
      user: { login, type: "User" },
      body,
      html_url: `https://github.com/acme/app/pull/7#issuecomment-${id}`,
      created_at: `2026-11-03T03:18:0${id}Z`,
    });

    it("目印で始まる、自分のアカウントのコメントだけを探す（他人が目印を書いても、引用しても対象にしない）", async () => {
      const { impl, calls } = fakeFetch([
        {
          status: 200,
          json: [
            comment(1, "Sacty-Bot", notice("t1")),
            comment(2, "someone", notice("t1")),
            comment(3, "sacty-bot", `> ${notice("t1")}\n引用`),
            comment(4, "sacty-bot", notice("t10")),
            comment(5, "sacty-bot", notice("t1", "k1", ":resolved")),
            comment(6, "sacty-bot", "ふつうのコメント"),
          ],
        },
      ]);
      const found = await new GitHubPullRequests(impl).listIssueComments({
        ...pr,
        prefix: "<!-- sacty-review-stopped:t1:",
        account: "sacty-bot",
      });
      expect(found.map((c) => c.id)).toEqual([1, 5]);
      expect(found[0]).toMatchObject({
        url: "https://github.com/acme/app/pull/7#issuecomment-1",
        body: notice("t1"),
      });
      expect(calls[0]?.url).toBe(
        "https://api.github.com/repos/acme/app/issues/7/comments?per_page=100",
      );
    });

    it("コメントの本文を直す（失敗したら理由を返す）", async () => {
      const { impl, calls } = fakeFetch([
        { status: 200, json: {} },
        { status: 403, json: { message: "Resource not accessible" } },
      ]);
      const client = new GitHubPullRequests(impl);
      await client.editIssueComment({
        repo: pr.repo,
        token: pr.token,
        id: 31,
        body: "解消済み",
      });
      expect(calls).toEqual([
        {
          url: "https://api.github.com/repos/acme/app/issues/comments/31",
          method: "PATCH",
          body: { body: "解消済み" },
          auth: "Bearer ghp_secret",
        },
      ]);
      const error = await client
        .editIssueComment({ repo: pr.repo, token: pr.token, id: 31, body: "x" })
        .catch((e: unknown) => e);
      expect(errorText(error)).toMatchObject({
        code: "github.failed",
        params: { action: "editIssueComment", status: 403 },
      });
    });

    it("sacty のタスクのアカウントが投稿した止まったことの投稿は、PR の指摘に取り込まない（人間のコメントは取り込む）", async () => {
      const { impl } = fakeFetch([
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", notice("t1")),
            comment(2, "Review-Bot", notice("t2", "k", ":resolved")),
            comment(3, "alice", "人間のコメント"),
            // 他人が目印をまねても、人間の指摘として取り込む（指摘を隠されないように）
            comment(4, "mallory", notice("t1")),
          ],
        },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        ...pr,
        account: "sacty-bot",
        sactyReviews: [{ key: "t2", account: "review-bot", allowed: false }],
      });
      expect(feedback.map((f) => f.key)).toEqual(["comment:3", "comment:4"]);
    });

    it("中断の印（signal）を通信に渡す：中断された一覧の取得・投稿・書き換えは、リクエストの途中で止まる", async () => {
      const seen: (AbortSignal | undefined)[] = [];
      const impl = (async (_url: string, init: RequestInit) => {
        seen.push(init.signal ?? undefined);
        if (init.signal?.aborted) throw init.signal.reason;
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch;
      const client = new GitHubPullRequests(impl);
      const controller = new AbortController();
      const base = {
        repo: pr.repo,
        token: pr.token,
        signal: controller.signal,
      };
      await client.listIssueComments({ ...base, number: 7, prefix: "x" });
      await client.commentIssue({ ...base, number: 7, body: "b" });
      await client.editIssueComment({ ...base, id: 1, body: "b" });
      expect(seen).toEqual([controller.signal, controller.signal, controller.signal]);
      controller.abort(new Error("期限"));
      await expect(client.listIssueComments({ ...base, number: 7, prefix: "x" })).rejects.toThrow(
        "期限",
      );
      await expect(client.commentIssue({ ...base, number: 7, body: "b" })).rejects.toThrow("期限");
      await expect(client.editIssueComment({ ...base, id: 1, body: "b" })).rejects.toThrow("期限");
    });

    it("sacty が頼みで投稿したコメント（指摘への返信など）は、そのアカウントのものだけ、PR の指摘に取り込まない（PBI-301）", async () => {
      const reply =
        "<!-- sacty-comment:t1:implement:submission-1:0 -->\nご指摘の件は、こう直します";
      const { impl } = fakeFetch([
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", reply),
            comment(2, "alice", "人間のコメント"),
            // 他人が目印をまねても、人間の指摘として取り込む（指摘を隠されないように）
            comment(3, "mallory", reply),
            comment(4, "sacty-bot", "同じアカウントの、目印の無いコメント"),
          ],
        },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        ...pr,
        account: "sacty-bot",
      });
      expect(feedback.map((f) => f.key)).toEqual(["comment:2", "comment:3", "comment:4"]);
    });

    it("sacty の、指摘への返信（PBI-352）は、行への返信も PR のコメントも、そのアカウントのものだけ、PR の指摘に取り込まない。含める指定があれば含める（再レビューの作者の返答）", async () => {
      const reply = "<!-- sacty-reply:t1:implement-1-1:2 -->\n**対応しました。**\n\n直しました";
      const responses = () => [
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            // 行へのコメントへの返信（スレッドの中の投稿）
            {
              ...comment(11, "sacty-bot", reply),
              path: "src/a.ts",
              line: 3,
              in_reply_to_id: 10,
            },
            { ...comment(12, "mallory", reply), path: "src/a.ts", line: 3 },
          ],
        },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", reply),
            comment(2, "alice", "人間のコメント"),
            // 他人が目印をまねても、人間の指摘として取り込む（指摘を隠されないように）
            comment(3, "mallory", reply),
            comment(4, "sacty-bot", "同じアカウントの、目印の無いコメント"),
          ],
        },
      ];
      const imported = await new GitHubPullRequests(fakeFetch(responses()).impl).feedback({
        ...pr,
        account: "sacty-bot",
      });
      expect(imported.map((f) => f.key).sort()).toEqual([
        "comment:2",
        "comment:3",
        "comment:4",
        "review_comment:12",
      ]);
      // 今のアカウントが変わっていても、返信に使ったアカウント（noticeAccounts）の返信は除く
      const changed = await new GitHubPullRequests(fakeFetch(responses()).impl).feedback({
        ...pr,
        account: "new-bot",
        noticeAccounts: ["Sacty-Bot"],
      });
      expect(changed.map((f) => f.key).sort()).toEqual([
        "comment:2",
        "comment:3",
        "comment:4",
        "review_comment:12",
      ]);
      // アカウントが分からなければ、除かない（誰の投稿か確かめられない）
      const unknown = await new GitHubPullRequests(fakeFetch(responses()).impl).feedback(pr);
      expect(unknown).toHaveLength(6);
      const forReview = await new GitHubPullRequests(fakeFetch(responses()).impl).feedback({
        ...pr,
        account: "sacty-bot",
        includeSactyReplies: true,
      });
      expect(forReview.map((f) => f.key).sort()).toEqual([
        "comment:1",
        "comment:2",
        "comment:3",
        "comment:4",
        "review_comment:11",
        "review_comment:12",
      ]);
      // PR の作者が Bot のアカウントでも、sacty の返信は、含める指定があれば渡す（ほかの Bot の投稿は除いたまま）
      const bot = (id: number, login: string, body: string) => ({
        ...comment(id, login, body),
        user: { login, type: "Bot" },
      });
      const botResponses = () => [
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            bot(21, "sacty[bot]", reply),
            bot(22, "ci[bot]", reply),
            bot(23, "sacty[bot]", "CI の結果"),
          ],
        },
      ];
      const botForReview = await new GitHubPullRequests(fakeFetch(botResponses()).impl).feedback({
        ...pr,
        account: "sacty[bot]",
        includeSactyReplies: true,
      });
      expect(botForReview.map((f) => f.key)).toEqual(["comment:21"]);
      const botImported = await new GitHubPullRequests(fakeFetch(botResponses()).impl).feedback({
        ...pr,
        account: "sacty[bot]",
      });
      expect(botImported).toEqual([]);
      expect(forReview.find((f) => f.key === "review_comment:11")).toMatchObject({
        kind: "review_comment",
        author: "sacty-bot",
        path: "src/a.ts",
        body: reply,
      });
    });

    it("人に確かめてほしいことの投稿（PBI-301）は、sacty のタスクのアカウントのものだけ、PR の指摘に取り込まない", async () => {
      const ask =
        "<!-- sacty-human-ask:t1:implement:2 -->\n## Sacty：人に確かめてほしいことがあります";
      const { impl } = fakeFetch([
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", ask),
            comment(2, "alice", "人間のコメント"),
            // 他人が目印をまねても、人間の指摘として取り込む（指摘を隠されないように）
            comment(3, "mallory", ask),
            // 目印の無い、同じアカウントのコメントは除かない
            comment(4, "sacty-bot", "同じアカウントの、目印の無いコメント"),
          ],
        },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        ...pr,
        account: "sacty-bot",
      });
      expect(feedback.map((f) => f.key)).toEqual(["comment:2", "comment:3", "comment:4"]);
    });

    it("後続に回したい案への決定の投稿（PBI-370）は、sacty のタスクのアカウントのものだけ、PR の指摘に取り込まない", async () => {
      const notice = "<!-- sacty-deferral:t1:1 -->\n## Sacty：後続に回したい案を、人が決めました";
      const { impl } = fakeFetch([
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", notice),
            comment(2, "alice", "人間のコメント"),
            // 他人が目印をまねても、人間の指摘として取り込む（指摘を隠されないように）
            comment(3, "mallory", notice),
          ],
        },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        ...pr,
        account: "sacty-bot",
      });
      expect(feedback.map((f) => f.key)).toEqual(["comment:2", "comment:3"]);
    });

    it("要求要件の全文のコメント（PBI-450）は、sacty のタスクのアカウントのものだけ、PR の指摘に取り込まない。続きのコメントも同じ", async () => {
      const basis = "<!-- sacty-basis:t1 -->\n## 承認済みの要求要件・不具合の再現（全文）";
      const more =
        "<!-- sacty-basis:t1:2 -->\n## 承認済みの要求要件・不具合の再現（全文の続き 2/2）";
      const { impl } = fakeFetch([
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", basis),
            comment(2, "sacty-bot", more),
            comment(3, "alice", "人間のコメント"),
            // 他人が目印をまねても、人間の指摘として取り込む（指摘を隠されないように）
            comment(4, "mallory", basis),
          ],
        },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        ...pr,
        account: "sacty-bot",
      });
      expect(feedback.map((f) => f.key)).toEqual(["comment:3", "comment:4"]);
    });

    it("設計に戻したことの知らせ（PBI-446）は、sacty のタスクのアカウントのものだけ、PR の指摘に取り込まない", async () => {
      const notice = "<!-- sacty-rework-notice:t1:1 -->\n## Sacty：指摘を設計に戻しました";
      const { impl } = fakeFetch([
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", notice),
            comment(2, "alice", "人間のコメント"),
            // 他人が目印をまねても、人間の指摘として取り込む（指摘を隠されないように）
            comment(3, "mallory", notice),
          ],
        },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        ...pr,
        account: "sacty-bot",
      });
      expect(feedback.map((f) => f.key)).toEqual(["comment:2", "comment:3"]);
    });

    it("マージを承認として扱った知らせと、承認として扱わなかった知らせ（PBI-462）は、sacty のアカウントのものだけ、PR の指摘に取り込まない。人（PR の作者を含む）のコメントは指摘として取り込む", async () => {
      const approval =
        "<!-- sacty-merge-approval:t1:8 -->\n## Sacty：このマージを承認として扱いました";
      const notApproved =
        "<!-- sacty-merge-not-approved:t1:8 -->\n## Sacty：このマージを設計の承認として扱っていません";
      const { impl } = fakeFetch([
        { status: 200, json: [] },
        { status: 200, json: [] },
        {
          status: 200,
          json: [
            comment(1, "sacty-bot", approval),
            comment(2, "sacty-bot", notApproved),
            comment(3, "alice", "人間のコメント"),
            comment(4, "mallory", approval),
            comment(5, "mallory", notApproved),
          ],
        },
      ]);
      const feedback = await new GitHubPullRequests(impl).feedback({
        ...pr,
        account: "sacty-bot",
      });
      expect(feedback.map((f) => f.key)).toEqual(["comment:3", "comment:4", "comment:5"]);
    });

    it("ほかに知っている sacty のアカウント（noticeAccounts）の止まったことの投稿も除く（それ以外のコメントは除かない）", async () => {
      const comments = [
        comment(1, "other-project-bot", notice("t3")),
        comment(2, "alice", "人間のコメント"),
        comment(3, "other-project-bot", "同じアカウントの、目印の無いコメント"),
      ];
      const read = (extra?: string[]) =>
        new GitHubPullRequests(
          fakeFetch([
            { status: 200, json: [] },
            { status: 200, json: [] },
            { status: 200, json: comments },
          ]).impl,
        ).feedback({
          ...pr,
          account: "sacty-bot",
          ...(extra ? { noticeAccounts: extra } : {}),
        });
      expect((await read(["Other-Project-Bot"])).map((f) => f.key)).toEqual([
        "comment:2",
        "comment:3",
      ]);
      // 渡さなければ、知らない人のコメントとして取り込む
      expect((await read()).map((f) => f.key)).toEqual(["comment:1", "comment:2", "comment:3"]);
    });
  });

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

  it("includeApprovals なら、本文のある承認のレビューも含める（本文の無い承認は含めない。PR #161 レビュー指摘）", async () => {
    const human = { login: "reviewer", type: "User" };
    const reviews = [
      {
        id: 1,
        state: "APPROVED",
        user: human,
        body: "承認しますが、src/retry.ts の上限は改善してください",
        submitted_at: "2026-10-11T00:00:01Z",
      },
      {
        id: 2,
        state: "APPROVED",
        user: human,
        body: "",
        submitted_at: "2026-10-11T00:00:02Z",
      },
      {
        id: 3,
        state: "COMMENTED",
        user: human,
        body: "ログが足りない",
        submitted_at: "2026-10-11T00:00:03Z",
      },
    ];
    const responses = () => [
      { status: 200, json: reviews },
      { status: 200, json: [] },
      { status: 200, json: [] },
    ];
    const withApprovals = await new GitHubPullRequests(fakeFetch(responses()).impl).feedback({
      ...pr,
      includeApprovals: true,
    });
    expect(withApprovals.map((f) => [f.key, f.approved])).toEqual([
      ["review:1", true],
      ["review:3", undefined],
    ]);
    expect(withApprovals[0]?.body).toBe("承認しますが、src/retry.ts の上限は改善してください");
    // 既定（PR の指摘の取り込み）では、承認は指摘ではないので含めない
    const without = await new GitHubPullRequests(fakeFetch(responses()).impl).feedback(pr);
    expect(without.map((f) => f.key)).toEqual(["review:3"]);
  });

  it("リポジトリにラベルがあれば、そのまま PR に付ける", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { name: "sacty ai" } },
      { status: 200, json: [{ name: "sacty ai" }] },
    ]);
    const result = await new GitHubPullRequests(impl).addLabel({
      ...pr,
      label: "sacty ai",
    });
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
    expect(
      await new GitHubPullRequests(made.impl).addLabel({
        ...pr,
        label: "sacty",
      }),
    ).toEqual({
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
        json: {
          message: "Validation Failed",
          errors: [{ code: "already_exists" }],
        },
      },
      { status: 200, json: [] },
    ]);
    expect(
      await new GitHubPullRequests(raced.impl).addLabel({
        ...pr,
        label: "sacty",
      }),
    ).toEqual({
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
          {
            status: 403,
            json: { message: "Resource not accessible by integration" },
          },
        ],
        "リポジトリにラベルを作れませんでした",
      ],
      [
        [
          { status: 404, json: {} },
          {
            status: 422,
            json: {
              message: "Validation Failed",
              errors: [{ code: "invalid" }],
            },
          },
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
          {
            id: 3,
            user: ci,
            state: "COMMENTED",
            body: "CI が通りました",
            submitted_at: at(3),
          },
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

describe("sacty 自身の AI のレビューの印と、対象にしたコミット（PBI-275）", () => {
  const at = (n: number) => `2026-10-11T00:00:0${n}Z`;
  const me = { login: "sacty-bot", type: "User" };
  const head = "a".repeat(40);
  const target = {
    repo: "https://github.com/acme/app",
    token: "ghp_secret",
    number: 7,
  };

  it("投稿の印で見分けて source を付け、レビューと行へのコメントの対象のコミットを添える。人のコメントには付けない（アカウントは同じ）", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1 -->\n## sacty のレビュー",
            commit_id: head,
            submitted_at: at(1),
          },
          // 同じアカウントでも、印の無い人の指摘は人の指摘
          {
            id: 2,
            user: me,
            state: "CHANGES_REQUESTED",
            body: "手で書いた",
            commit_id: head,
            submitted_at: at(2),
          },
        ],
      },
      {
        status: 200,
        json: [
          {
            id: 3,
            user: me,
            body: "<!-- sacty-review:r1 -->\n上限が無い",
            path: "src/retry.ts",
            line: 3,
            pull_request_review_id: 1,
            commit_id: head,
            created_at: at(3),
          },
          {
            id: 4,
            user: me,
            body: "手で書いた行",
            path: "a.ts",
            line: 1,
            created_at: at(4),
          },
        ],
      },
      // 印を写した通常のコメントでも、タスクの回と一致して、アカウントが同じなら AI のレビュー（コミットは無い）
      {
        status: 200,
        json: [
          {
            id: 5,
            user: me,
            body: "<!-- sacty-review:r1 -->\n要約",
            created_at: at(5),
          },
          { id: 6, user: me, body: "人のコメント", created_at: at(6) },
        ],
      },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      ...target,
      account: "sacty-bot",
      sactyReviews: [{ key: "r1", account: "sacty-bot", allowed: true }],
    });
    expect(feedback.map((f) => [f.key, f.source, f.commit])).toEqual([
      ["review:1", "sacty_review", head],
      ["review:2", undefined, undefined],
      ["review_comment:3", "sacty_review", head],
      ["review_comment:4", undefined, undefined],
      ["comment:5", "sacty_review", undefined],
      ["comment:6", undefined, undefined],
    ]);
  });

  it("AI のレビューには、投稿したレビューのタスクと回（目印の中身）を添える。人の指摘には付けない（PR #350 レビュー指摘）", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1:2 -->\n## sacty のレビュー",
            commit_id: head,
            submitted_at: at(1),
          },
        ],
      },
      {
        status: 200,
        json: [
          {
            id: 3,
            user: me,
            body: "<!-- sacty-review:r1 -->\n上限",
            path: "a.ts",
            line: 1,
            pull_request_review_id: 1,
            commit_id: head,
            created_at: at(3),
          },
        ],
      },
      {
        status: 200,
        json: [{ id: 6, user: me, body: "人のコメント", created_at: at(6) }],
      },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      ...target,
      account: "sacty-bot",
      sactyReviews: [
        { key: "r1", account: "sacty-bot", allowed: true },
        { key: "r1:2", account: "sacty-bot", allowed: true },
      ],
    });
    expect(feedback.map((f) => [f.key, f.review])).toEqual([
      ["review:1", "r1:2"],
      ["review_comment:3", "r1"],
      ["comment:6", undefined],
    ]);
  });

  it("行へのコメントの commit_id は後の push で今の head に付け替わるので、親レビューの commit_id（無ければ original_commit_id）を使う", async () => {
    const reviewed = "b".repeat(40);
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            user: me,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1 -->\n## sacty のレビュー",
            commit_id: reviewed,
            submitted_at: at(1),
          },
        ],
      },
      {
        status: 200,
        json: [
          // レビューの後に push があり、commit_id は今の head、original_commit_id はレビューの時点
          {
            id: 3,
            user: me,
            body: "<!-- sacty-review:r1 -->\n上限が無い",
            path: "src/retry.ts",
            line: 3,
            pull_request_review_id: 1,
            commit_id: head,
            original_commit_id: reviewed,
            created_at: at(3),
          },
          // 親レビューが分からないときは original_commit_id
          {
            id: 4,
            user: me,
            body: "<!-- sacty-review:r1 -->\n別の指摘",
            path: "src/retry.ts",
            line: 4,
            commit_id: head,
            original_commit_id: reviewed,
            created_at: at(4),
          },
          // どちらも無ければ、今の head を使わず、コミットは無し
          {
            id: 5,
            user: me,
            body: "<!-- sacty-review:r1 -->\nコミット不明",
            path: "src/retry.ts",
            line: 5,
            commit_id: head,
            created_at: at(5),
          },
        ],
      },
      { status: 200, json: [] },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      ...target,
      account: "sacty-bot",
      sactyReviews: [{ key: "r1", account: "sacty-bot", allowed: true }],
    });
    expect(feedback.map((f) => [f.key, f.commit])).toEqual([
      ["review:1", reviewed],
      ["review_comment:3", reviewed],
      ["review_comment:4", reviewed],
      ["review_comment:5", undefined],
    ]);
  });

  it("人が本文に印を写したものや、別のアカウントの投稿は AI のレビューにしない", async () => {
    const human = { login: "alice", type: "User" };
    const { impl } = fakeFetch([
      {
        status: 200,
        json: [
          {
            id: 1,
            user: human,
            state: "COMMENTED",
            body: "<!-- sacty-review:r1 -->\nAI の指摘に同意",
            commit_id: head,
            submitted_at: at(1),
          },
        ],
      },
      { status: 200, json: [] },
      { status: 200, json: [] },
    ]);
    const feedback = await new GitHubPullRequests(impl).feedback({
      ...target,
      account: "sacty-bot",
      sactyReviews: [{ key: "r1", account: "sacty-bot", allowed: true }],
    });
    expect(feedback.map((f) => [f.key, f.source, f.commit])).toEqual([
      ["review:1", undefined, undefined],
    ]);
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

describe("一時的な失敗か（PBI-301）", () => {
  const failure = (status: number, detail = "") =>
    apiError("getPr", status, detail ? { message: detail } : {});

  it("GitHub の 5xx・429・レート制限と説明する 403・接続の失敗は一時的", () => {
    for (const status of [500, 502, 503, 504, 429]) {
      expect(isTransientGitHubFailure(failure(status)), String(status)).toBe(true);
    }
    expect(isTransientGitHubFailure(failure(403, "API rate limit exceeded"))).toBe(true);
    expect(isTransientGitHubFailure(failure(403, "You have exceeded a secondary rate limit"))).toBe(
      true,
    );
    expect(isTransientGitHubFailure(new TypeError("fetch failed"))).toBe(true);
    expect(
      isTransientGitHubFailure(Object.assign(new Error("boom"), { cause: { code: "ETIMEDOUT" } })),
    ).toBe(true);
  });

  it("権限・見つからない・トークン・入力の誤りと、GitHub の失敗でないエラーは一時的でない", () => {
    expect(isTransientGitHubFailure(failure(401, "Bad credentials"))).toBe(false);
    expect(isTransientGitHubFailure(failure(403, "Resource not accessible"))).toBe(false);
    expect(isTransientGitHubFailure(failure(403))).toBe(false);
    for (const status of [400, 404, 410, 422]) {
      expect(isTransientGitHubFailure(failure(status)), String(status)).toBe(false);
    }
    expect(isTransientGitHubFailure(new Error("GitHub API 503"))).toBe(false);
    expect(
      isTransientGitHubFailure(Object.assign(new Error("x"), { cause: { code: "EACCES" } })),
    ).toBe(false);
    expect(isTransientGitHubFailure("fetch failed")).toBe(false);
    expect(isTransientGitHubFailure(undefined)).toBe(false);
  });
});

describe("PR がフォークからのものか（status の fork。PBI-461）", () => {
  it("head と base のリポジトリが違えば fork: true、同じなら false（大文字小文字は区別しない）、head のリポジトリが消えていれば true、読めなければ true（フォークとして扱う）", async () => {
    const repo = (full_name: string) => ({ full_name });
    const { impl } = fakeFetch([
      {
        status: 200,
        json: {
          state: "open",
          head: { sha: "a", repo: repo("someone/app") },
          base: { repo: repo("acme/app") },
        },
      },
      {
        status: 200,
        json: {
          state: "open",
          head: { sha: "a", repo: repo("Acme/App") },
          base: { repo: repo("acme/app") },
        },
      },
      { status: 200, json: { state: "open", head: { sha: "a", repo: null } } },
      { status: 200, json: { state: "open", head: { sha: "a" } } },
    ]);
    const client = new GitHubPullRequests(impl);
    const pr = { repo: "https://github.com/acme/app", token: "t", number: 7 };
    expect(await client.status(pr)).toEqual({
      state: "open",
      headSha: "a",
      fork: true,
    });
    expect(await client.status(pr)).toEqual({
      state: "open",
      headSha: "a",
      fork: false,
    });
    expect(await client.status(pr)).toEqual({
      state: "open",
      headSha: "a",
      fork: true,
    });
    expect(await client.status(pr)).toEqual({
      state: "open",
      headSha: "a",
      fork: true,
    });
  });
});
