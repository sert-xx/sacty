import { readFileSync } from "node:fs";
import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { GitHubPullRequests } from "./github.js";
import {
  buildPrompt,
  buildReviewBody,
  buildReviewComments,
  buildReworkPrompt,
  extractReviewComments,
} from "./prompts.js";
import { buildRemarkReply } from "./remark-reply.js";
import { annotateReviewComments } from "./review-comments.js";
import { droppedRemarks, splitSuggestions, suggestionUnitsOf } from "./suggestion-triage.js";

// 行へのコメントにした指摘を、レビューの本文に重ねて書かない（PBI-479）。指示・本文の組み立て・指摘の読み取りを確かめる。

const target = {
  repo: "https://github.com/acme/app",
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  title: "retry",
  body: "",
  headCommit: "h".repeat(40),
  baseCommit: "b".repeat(40),
  author: "alice",
};
const diff = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,3 +1,3 @@",
  " import { pay } from './pay';",
  "-export const retry = 1;",
  "+export const retry = 3;",
  " export const once = 1;",
].join("\n");
const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const COUNT_LINE = (n: number) => `行へのコメントに ${n} 件の指摘があります。`;

const reviewTask = (extra: Partial<Task> = {}): Task =>
  ({
    id: "t-479",
    title: "レビュー",
    body: "",
    steps: [{ key: "review", state: "active" }],
    remarks: [],
    outputs: { review: "## 総評\n\n直すとよい点があります。" },
    approved: {},
    reproductionTests: [],
    reviewComments: [],
    reviewRound: 1,
    reviewVerdicts: [{ round: 1, verdict: "suggestions" }],
    reviewTarget: target,
    ...extra,
  }) as unknown as Task;

const comments = [
  { path: "src/retry.ts", line: 2, body: "[要修正] 回数に上限が無い。" },
  { path: "src/retry.ts", line: 3, body: "[提案] 名前を直す。" },
];

describe("レビューの指示：行へのコメントにした指摘を本文に重ねて書かせない（TV-1・TV-2）", () => {
  const prompt = buildPrompt(reviewTask({ reviewRound: undefined }), "review", { diff });

  it("TV-1：本文のどの節にも同じ内容を書かず、総評に件数を書かない。本文の指摘の行は、行へのコメントにしない指摘だけを対象にする", () => {
    expect(prompt).toContain(
      "行へのコメントにした指摘（JSON に入れた指摘）は、本文のどの節（総評・指摘・前回の指摘など）にも、同じ内容（言い換えを含む。起きる条件・実害・直し方）を書かないでください",
    );
    expect(prompt).toContain("総評に件数を書かないでください");
    // 行へのコメントにするのは行番号を特定できる指摘だけ。JSON に入れた指摘は本文に重ねない
    expect(prompt).toContain(
      "行へのコメントにするのは、行番号を特定できる指摘だけです。行へのコメントにした指摘（JSON に入れた指摘）は",
    );
    expect(prompt).toContain(
      "行番号を付けない差分の外の指摘は、下のとおり本文の「指摘」の節に書きます",
    );
    // 本文の記録の指示（reviewRecordInstructionLines）も、本文には行へのコメントにしない指摘だけを書かせる
    expect(prompt).toContain("本文には、行へのコメントにしない指摘だけを書く");
    // 本文の「指摘」の節に書かせる行は、すべて「行へのコメントにしない指摘」に限っている
    const lines = prompt
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("- ") &&
          (l.includes("本文の「指摘」の節には") || l.includes("指摘の節の見出し")),
      );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain("行へのコメントにしない指摘");
  });

  it("TV-2：位置を付けられない指摘は頭を付けて本文の「指摘」の節に書かせ、差分の外の行へのコメントは本文の「指摘」の節に書かせない", () => {
    expect(prompt).toContain(
      "差分の中に付けられる行が無い指摘（ファイル全体・PR 全体・差分の外のコード・PR の説明で示された文書についての指摘）は、人に確かめずに、頭を付けて本文の「指摘」の節に書いてください",
    );
    expect(prompt).toContain(
      "差分の外の行へのコメントは、sacty が本文に回すので、本文の「指摘」の節にも書かないでください",
    );
    expect(prompt).toContain("本文の「指摘」の節には、行へのコメントにしない指摘だけを書く");
  });
});

describe("差分の外の行へのコメントは、本文に 1 回だけ出る（TV-3）", () => {
  it("本文の「指摘」の節に無い、差分の外の行への要修正は、「### 行についての指摘」に 1 回だけ現れ、comments は空になる", () => {
    const answer = [
      "## 総評\n\n要修正が 1 件あります。",
      block({
        "sacty-review-comments": [
          { path: "src/other.ts", line: 40, severity: "must", body: "外の行の問題の文。" },
        ],
      }),
      block({ "sacty-review-verdict": { verdict: "changes_required" } }),
    ].join("\n\n");
    const result = extractReviewComments(answer, diff);
    expect(result.comments).toEqual([]);
    expect(result.output.match(/外の行の問題の文。/g)).toHaveLength(1);
    expect(result.output).toContain("### 行についての指摘");
    expect(result.output.indexOf("### 行についての指摘")).toBeLessThan(
      result.output.indexOf("外の行の問題の文。"),
    );
  });
});

describe("本文に指摘が無くても、行へのコメントの重さが判定に効く（TV-4）", () => {
  const read = (severity: string, verdict: string) =>
    extractReviewComments(
      [
        "## 総評\n\n総評だけの本文。",
        block({
          "sacty-review-comments": [{ path: "src/retry.ts", line: 2, severity, body: "問題。" }],
        }),
        block({ "sacty-review-verdict": { verdict } }),
      ].join("\n\n"),
      diff,
    );
  it("判定 suggestions でも行へのコメントに must があれば changes_required。判定 no_findings で should があれば suggestions", () => {
    const must = read("must", "suggestions");
    expect(must.comments).toHaveLength(1);
    expect(must.verdict).toBe("changes_required");
    expect(read("should", "no_findings").verdict).toBe("suggestions");
  });
});

describe("投稿する本文の、行へのコメントの件数の行（TV-5・TV-6）", () => {
  it("TV-5：判定の行のすぐ下に件数の行が付き（頭と <パス>:<行>： の形を使わない）、判定が無い回の案内は本文と行へのコメントを指す", () => {
    for (const verdicts of [
      [{ round: 1, verdict: "suggestions" as const }],
      [{ round: 1, missing: "absent" as const }],
    ]) {
      const body = buildReviewBody(
        reviewTask({ reviewComments: comments, reviewVerdicts: verdicts }),
      );
      const lines = body.split("\n");
      const at = lines.findIndex((l) => l.includes("判定："));
      expect(at).toBeGreaterThan(-1);
      expect(lines[at + 1]).toBe(COUNT_LINE(2));
      expect(lines[at + 1]).not.toMatch(/\[(要修正|提案)\]|\S+:\d+：/);
      if (verdicts[0]?.missing)
        expect(lines[at]).toContain("本文と行へのコメントを確かめてください");
      // 件数の行は、本文を単位に読む選り分けの 1 件にならない
      expect(suggestionUnitsOf(body)).toEqual([]);
    }
  });

  it("TV-6：行へのコメントが 0 件のとき、本文に入れて投稿し直す（foldComments）ときは、件数の行が付かない", () => {
    expect(buildReviewBody(reviewTask())).not.toContain("件の指摘があります");
    const folded = buildReviewBody(reviewTask({ reviewComments: comments }), {
      foldComments: true,
    });
    expect(folded).not.toContain("件の指摘があります");
    expect(folded).toContain("### 行についての指摘");
    for (const c of comments) expect(folded.split(c.body).length - 1).toBe(1);
  });
});

describe("本文が減っても、指摘の選り分けが行へのコメントを取りこぼさない（TV-7・TV-8）", () => {
  const body = `<!-- sacty-review:t-479 -->\n## Sacty のレビュー\n\n判定：提案あり\n${COUNT_LINE(2)}\n\n## 総評\n\n直すとよい点があります。`;
  const inline = (i: number, head: string) =>
    `src/a.ts:${i}：<!-- sacty-review:t-479 -->\n${head} 指摘 ${i}`;
  const aiReviewFrom = { "0": "k:1", "1": "k:1", "2": "k:1" };

  it("TV-7：提案ありの回で、総評と件数の行だけの本文は単位にならず、行へのコメントの提案がすべて対応しないなら、本文ごと外れる", () => {
    const remarks = [body, inline(1, "[提案]"), inline(2, "[提案]")];
    const units = splitSuggestions(
      remarks,
      [0, 1, 2],
      () => true,
      () => 1,
    );
    expect(units.map((u) => u.remark)).toEqual([1, 2]);
    expect(
      droppedRemarks({
        remarks,
        units,
        items: units.map((u) => ({ remark: u.remark, decision: "decline" as const })),
        aiReviewFrom,
        verdictOf: () => "suggestions",
      }).sort(),
    ).toEqual([0, 1, 2]);
  });

  it("TV-8：要修正の回で、行へのコメントの要修正は must の単位になり、本文も要修正の指摘も、直しから外れない", () => {
    const remarks = [body.replace("提案あり", "修正が必要"), inline(1, "[要修正]")];
    const units = splitSuggestions(
      remarks,
      [0, 1],
      () => false,
      () => 1,
    );
    expect(units.filter((u) => u.remark === 1).map((u) => u.kind)).toEqual(["must"]);
    expect(
      droppedRemarks({
        remarks,
        units,
        items: units.map((u) => ({ remark: u.remark, decision: "decline" as const })),
        aiReviewFrom: { "0": "k:1", "1": "k:1" },
        verdictOf: () => "changes_required",
      }),
    ).toEqual([]);
  });
});

describe("再レビューの指示の、本文の指摘の節（TV-1）", () => {
  it("HEAD_CHECK_LINES は、本文の「指摘」の節に、行へのコメントにしない指摘だけを書かせる", () => {
    const prompt = buildPrompt(
      reviewTask({
        reviewRound: 2,
        previousReview: {
          round: 1,
          url: "https://github.com/acme/app/pull/12#pullrequestreview-1",
          at: "2026-11-22T01:00:00.000Z",
          headCommit: "p".repeat(40),
          body: "## 総評\n\n総評だけ。",
          comments: [],
        },
      }),
      "review",
      { diff },
    );
    expect(prompt).toContain(
      "この節に書くのは、行へのコメントにしない指摘（差分の中に付けられる行が無い指摘）だけにする（行へのコメントにした指摘は、この節に書かない）",
    );
  });
});

describe("再レビューの指示（TV-9）", () => {
  it("「前回の指摘」の節を作らせ、前回の行へのコメントを場所と状況だけで挙げさせ、前回の件数の行を指摘として扱わせない。データに前回の行へのコメントが入る", () => {
    const previous = {
      round: 1,
      url: "https://github.com/acme/app/pull/12#pullrequestreview-1",
      at: "2026-11-22T01:00:00.000Z",
      headCommit: "p".repeat(40),
      body: `## Sacty のレビュー\n${COUNT_LINE(1)}\n\n## 総評\n\n総評だけ。`,
      comments: [comments[0]],
    };
    const prompt = buildPrompt(reviewTask({ reviewRound: 2, previousReview: previous }), "review", {
      diff,
    });
    expect(prompt).toContain("本文に「前回の指摘」の節を作り");
    expect(prompt).toContain(
      "前回の行へのコメントにした指摘（下のデータの previousReview.comments）も、場所と状況（直っている・未対応など）だけを短く挙げる（起きる条件・実害・直し方の中身は繰り返さない）",
    );
    expect(prompt).toContain(
      "「行へのコメントに N 件の指摘があります。」の行は、sacty が足した行で、前回の指摘でも今回の件数でもない",
    );
    const data = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"previousReview"')) ?? "{}",
    );
    expect(data.previousReview.comments).toEqual([comments[0]]);
  });
});

describe("直しの側への説明（TV-10）", () => {
  it("AI のレビューの指摘の節に、本文の件数の行は別の指摘ではないことが書かれる", () => {
    const task = { id: "t1", approved: {}, outputs: {}, testViewpoints: [] } as unknown as Task;
    const prompt = buildReworkPrompt(
      task,
      ["AI: 上限が無い"],
      ["implement", "requirements"],
      undefined,
      [0],
    );
    const section = prompt.slice(prompt.indexOf("--- PR への AI のレビューの指摘 ---"));
    expect(section).toContain(
      "本文の「行へのコメントに N 件の指摘があります。」の行は、sacty が行へのコメントの指摘を数えて足した行で、別の指摘ではありません",
    );
  });
});

describe("自己レビューの指示は変わらない（TV-11）", () => {
  it("セルフレビューを行う設計の工程の指示に、行へのコメントを本文に重ねない決まりの文が無い", () => {
    const task = {
      id: "t-1",
      title: "決済",
      body: "失敗したら再試行する",
      steps: [{ key: "design", state: "todo" }],
      remarks: [],
      outputs: {},
      approved: { requirements: { output: "# 要求要件", submission: 1 } },
      testViewpoints: [],
      reproductionTests: [],
      proposals: [],
      repository: { url: target.repo, baseBranch: "main", baseCommit: "abcdef1234" },
    } as unknown as Task;
    const prompt = buildPrompt(task, "design", {});
    expect(prompt).toContain("セルフレビュー");
    expect(prompt).not.toContain("行へのコメントにした指摘は、本文のどの節");
    expect(prompt).not.toContain("行へのコメントの件数は、sacty が判定の行の下に足す");
  });
});

describe("前回の指摘が行へのコメントだけにある再レビューの、材料（TV-14）", () => {
  const TASK = "t-479";
  const api = "https://api.github.com/repos/acme/app";
  const me = { login: "sacty-bot", type: "User" };
  const reply = (remarkId: string, status: "addressed" | "declined") =>
    buildRemarkReply({
      taskId: TASK,
      stepName: "実装",
      remarkId,
      submission: 1,
      text: "理由の文",
      status,
      secrets: [],
    });

  it("二度出さない・却下と対応済みの照合の材料として、前回の行へのコメント 2 件が previousReview.comments に、2 件の返信が by sacty・状態つきの既存の指摘（review_comment）に載り、元の行へのコメントは既存の指摘に載らない", async () => {
    const previous = reviewTask({ reviewComments: comments });
    const posted = buildReviewComments(previous);
    const fetchComments = [
      ...posted.map((c, i) => ({
        id: 10 + i,
        user: me,
        body: c.body,
        path: c.path,
        line: c.line,
        created_at: `2026-11-22T00:0${i}:00Z`,
        author_association: "OWNER",
      })),
      {
        id: 20,
        user: me,
        body: reply("r-1", "declined"),
        path: "src/retry.ts",
        line: 2,
        created_at: "2026-11-22T00:10:00Z",
        author_association: "OWNER",
      },
      {
        id: 21,
        user: me,
        body: reply("r-2", "addressed"),
        path: "src/retry.ts",
        line: 3,
        created_at: "2026-11-22T00:11:00Z",
        author_association: "OWNER",
      },
    ];
    const fetchImpl = (async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(String(url).startsWith(`${api}/pulls/12/comments`) ? fetchComments : []),
        {
          status: 200,
        },
      )) as typeof fetch;
    const fed = await new GitHubPullRequests(fetchImpl).feedback({
      repo: target.repo,
      token: "t",
      number: 12,
      account: "sacty-bot",
      noticeAccounts: ["sacty-bot"],
      includeSactyReplies: true,
      sactyReplyTasks: [TASK],
    });
    const existing = annotateReviewComments(fed, "alice");
    expect(existing.map((f) => [f.key, f.kind, f.by, f.reply?.status])).toEqual([
      ["review_comment:20", "review_comment", "sacty", "declined"],
      ["review_comment:21", "review_comment", "sacty", "addressed"],
    ]);
    expect(existing.some((f) => f.body.includes("sacty-review:"))).toBe(false);

    const prompt = buildPrompt(
      reviewTask({
        reviewRound: 2,
        previousReview: {
          round: 1,
          url: "https://github.com/acme/app/pull/12#pullrequestreview-1",
          at: "2026-11-22T00:00:00.000Z",
          headCommit: "p".repeat(40),
          body: `## Sacty のレビュー\n${COUNT_LINE(2)}\n\n## 総評\n\n総評だけ。`,
          comments,
        },
      }),
      "review",
      { diff, existing, replies: existing },
    );
    const lines = prompt.split("\n");
    const data = (key: string) => JSON.parse(lines.find((l) => l.startsWith(`{"${key}"`)) ?? "{}");
    expect(data("previousReview").previousReview.comments).toEqual(comments);
    const seen = data("existingReviews").existingReviews as {
      kind: string;
      by: string;
      reply?: { status?: string };
    }[];
    expect(seen.map((r) => [r.kind, r.by, r.reply?.status])).toEqual([
      ["review_comment", "sacty", "declined"],
      ["review_comment", "sacty", "addressed"],
    ]);
  });
});

describe("既定のスキル（TV-12）の読み取りの対象", () => {
  it("自己レビューの手順（self-review.md）に、重ねない決まりの文が足されていない", () => {
    const dir = new URL(
      "../default-context/skills/review/review-dispatch/references/",
      import.meta.url,
    );
    expect(readFileSync(new URL("self-review.md", dir), "utf-8")).not.toContain(
      "本文に重ねて書かない",
    );
  });
});
