import { describe, expect, it } from "vitest";
import {
  buildGitHubComment,
  commentAllowed,
  commentTarget,
  requestedGitHubComments,
  withoutGitHubComments,
} from "./github-comments.js";

const block = (value: unknown) =>
  `\`\`\`json\n${JSON.stringify({ "sacty-github-comments": value })}\n\`\`\``;

describe("工程の出力で頼まれた、PR・Issue へのコメント", () => {
  it("頼みを読む（無ければ undefined）", () => {
    expect(requestedGitHubComments("# 結果")).toBeUndefined();
    expect(
      requestedGitHubComments(
        `# 結果\n\n${block({ comments: [{ url: "https://github.com/acme/app/pull/3/", body: " 返信 " }] })}`,
      ),
    ).toEqual({
      ok: true,
      comments: [
        {
          target: "https://github.com/acme/app/pull/3/",
          repo: "https://github.com/acme/app",
          number: 3,
          body: "返信",
        },
      ],
    });
  });

  it("2つ以上・読めない・形が違う・多すぎる・長すぎる頼みは、理由を返す（どれも投稿しない）", () => {
    const one = block({ comments: [{ url: "https://github.com/a/b/issues/1", body: "x" }] });
    expect(requestedGitHubComments(`${one}\n${one}`)?.ok).toBe(false);
    expect(requestedGitHubComments('{"sacty-github-comments": {"comments": [}')?.ok).toBe(false);
    expect(requestedGitHubComments(block({ comments: "x" }))?.ok).toBe(false);
    expect(requestedGitHubComments(block({ comments: [{ url: "u", body: "" }] }))?.ok).toBe(false);
    expect(
      requestedGitHubComments(
        block({ comments: Array.from({ length: 11 }, () => ({ url: "u", body: "b" })) }),
      )?.ok,
    ).toBe(false);
    expect(
      requestedGitHubComments(block({ comments: [{ url: "u", body: "a".repeat(60_001) }] }))?.ok,
    ).toBe(false);
  });

  it("投稿先は PR・Issue の URL で、プロジェクトの対象（リポジトリ・Org）か、タスクのリポジトリだけ", () => {
    expect(commentTarget("https://ghe.example.co.jp/acme/app/issues/9")).toEqual({
      repo: "https://ghe.example.co.jp/acme/app",
      number: 9,
    });
    expect(commentTarget("https://github.com/acme/app/commit/abc")).toEqual({});
    expect(commentTarget("https://github.com/acme/app/pull/0")).toEqual({});
    const targets = [
      { scope: "repo" as const, target: "https://github.com/acme/app" },
      { scope: "org" as const, target: "https://ghe.example.co.jp/corp" },
    ];
    expect(commentAllowed("https://github.com/Acme/App", targets, {})).toBe(true);
    expect(commentAllowed("https://ghe.example.co.jp/corp/x", targets, {})).toBe(true);
    expect(commentAllowed("https://github.com/acme/other", targets, {})).toBe(false);
    expect(
      commentAllowed("https://github.com/acme/other", targets, {
        repo: "https://github.com/acme/other",
      }),
    ).toBe(true);
  });

  it("本文には目印と、AI が書き人間が承認した旨を付ける。成果からは頼みを取り除ける", () => {
    const body = buildGitHubComment({
      taskId: "T-1",
      step: "operation",
      stepName: "作業",
      approvedAt: "2026-10-21T00:00:00.000Z",
      index: 0,
      body: "返信",
    });
    expect(body).toContain("<!-- sacty-comment:T-1:operation:2026-10-21T00:00:00.000Z:0 -->");
    expect(body).toContain("作業の工程で AI が書き、人間が承認しました");
    expect(withoutGitHubComments(`# 結果\n\n${block({ comments: [] })}`)).toBe("# 結果");
  });
});
