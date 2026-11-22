import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildPrompt, buildReviewBody, extractReviewComments } from "./prompts.js";

/**
 * PR のレビューの判定が無い回の理由（PBI-378）。レビューが判定を付けなかった回（答えに判定のブロックが無い）と、判定のブロックは
 * あるのに読めなかった回を分ける。答えのデータは、実際に判定が無かった回の形（節の並びと、付いていたブロックの種類）だけを写した
 * 架空のもの。
 */

const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

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

const risk = {
  "sacty-risk-assessment": {
    level: "high",
    signals: ["irreversible"],
    dependencyUpdate: "none",
    change: "再試行の回数を変える。",
    scope: "決済の再試行。",
    reversibility: "外への送信は、コードを戻しても取り消せない。",
    verification: "リンターとテストを実行した。",
    focus: [{ where: "src/retry.ts:2", why: "再試行の上限" }],
  },
};

/** 再レビューで、観点ごとの担当を起動せずに前回の指摘の直しだけを確かめ、判定を付けずに、リスク評価だけを付けた答え。 */
const rereviewWithoutVerdict = [
  "## 総評",
  "",
  "前回の指摘 2 件は、直っていることを確かめました。今回は新しい指摘を出していません。ただし、観点ごとの担当は起動していないので、新規の見落としは否定できません。",
  "",
  "**観点の見方：** 観点ごとの担当は起動していません。親が 1 人で、前回の指摘の直しと、その周辺の変更を読みました。",
  "",
  "## 前回の指摘",
  "",
  "- 再試行に上限が無い：直っています。",
  "- 失敗の記録が残らない：直っています。",
  "",
  "## 指摘",
  "",
  "なし。",
  "",
  "## 確かめられなかったこと",
  "",
  "- ビルドは実行していません。",
  "",
  block(risk),
].join("\n");

/** 初回のレビューで、観点ごとの担当を起動せずに差分の一部だけを読み、行へのコメント（提案）とリスク評価だけを付けた答え。 */
const partialReviewWithoutVerdict = [
  "総評：重大な不具合は見つけられませんでした。直すとよい点が 1 件あります。ただし、観点ごとの担当への分担はしておらず、見た範囲は限られます。",
  "",
  "観点の見方：サブエージェントは起動せず、親が 1 人で、差分の中心の部分だけを読みました。画面と文書は、詳しく読んでいません。",
  "",
  "指摘",
  "",
  "- [提案] src/retry.ts:2 再試行の回数を、設定から読むとよいです。",
  "",
  block({
    "sacty-review-comments": [
      { path: "src/retry.ts", line: 2, severity: "should", body: "回数を設定から読むとよいです。" },
    ],
  }),
  "",
  block(risk),
].join("\n");

const read = (output: string) => extractReviewComments(output, diff, { risk: true });

describe("PR のレビューの判定が無い理由（PBI-378）", () => {
  it("判定のブロックが無い答えは、本文が「指摘：なし」と書いていても、指摘なしにせず、レビューが判定を付けなかったと記録する", () => {
    const result = read(rereviewWithoutVerdict);
    expect(result.verdict).toBeUndefined();
    expect(result.verdictMissing).toBe("absent");
    // 判定が無い回は指摘なしではないので、リスク評価は使わず（PBI-429）、本文に JSON は残らない
    expect(result.risk).toBeUndefined();
    expect(result.output).not.toContain("```");
    expect(result.output).toContain("## 指摘\n\nなし。");
  });

  it("行へのコメント（提案）とリスク評価だけが付いた答えも、提案ありにせず、レビューが判定を付けなかったと記録する", () => {
    const result = read(partialReviewWithoutVerdict);
    expect(result.verdict).toBeUndefined();
    expect(result.verdictMissing).toBe("absent");
    expect(result.comments).toEqual([
      { path: "src/retry.ts", line: 2, body: "[提案] 回数を設定から読むとよいです。" },
    ]);
    expect(result.output).not.toContain("```");
  });

  it("リスクを評価させていないレビューでも、判定のブロックが無ければ、付けなかったと記録する", () => {
    const result = extractReviewComments("総評\n\n指摘：なし。", diff);
    expect(result.verdict).toBeUndefined();
    expect(result.verdictMissing).toBe("absent");
  });

  it.each([
    ["判定が決めた値でない", block({ "sacty-review-verdict": { verdict: "approved" } })],
    ["判定の値が無い", block({ "sacty-review-verdict": {} })],
    ["判定のブロックの中身がオブジェクトでない", block({ "sacty-review-verdict": "no_findings" })],
    // 末尾のカンマで、JSON として読めない
    ["JSON が壊れている", '```json\n{"sacty-review-verdict": {"verdict": "no_findings",}}\n```'],
    // 途中で切れて、閉じていない
    ["ブロックが途中で切れている", '```json\n{"sacty-review-verdict": {"verdict": "no_f'],
    // フェンスの外に、JSON の形で書いて、壊れている
    ["フェンスの外の JSON が壊れている", '{"sacty-review-verdict" : {"verdict": "no_findings",}}'],
  ])(
    "判定を付けようとした跡があるのに読めない答え（%s）は、指摘なしにも、付けなかったことにもしない",
    (_name, tail) => {
      const result = read(`総評\n\n指摘：なし。\n\n${tail}`);
      expect(result.verdict).toBeUndefined();
      expect(result.verdictMissing).toBe("invalid");
    },
  );

  it.each([
    ["名前だけ", "判定（sacty-review-verdict）は、見ていない観点があるので付けません。"],
    ["コードの形の名前", "`sacty-review-verdict` のブロックは付けません。"],
    ["引用符つきの名前", '"sacty-review-verdict" という見出しの読み取りを変える PR です。'],
  ])(
    "本文が判定の見出しの名前に触れているだけ（%s）なら、判定を付けた跡とはせず、レビューが判定を付けなかったと記録する",
    (_name, tail) => {
      const result = read(`総評\n\n指摘：なし。\n\n${tail}\n\n${block(risk)}`);
      expect(result.verdict).toBeUndefined();
      expect(result.verdictMissing).toBe("absent");
    },
  );

  it("最後の判定のブロックが読めなければ、前のブロックの判定を使わず、読めなかったと記録する", () => {
    const result = read(
      [
        "総評",
        block({ "sacty-review-verdict": { verdict: "no_findings" } }),
        block({ "sacty-review-verdict": { verdict: "unknown" } }),
      ].join("\n\n"),
    );
    expect(result.verdict).toBeUndefined();
    expect(result.verdictMissing).toBe("invalid");
  });

  it("判定があるとき・行へのコメントの重さで判定が決まるときは、判定が無い理由を残さない", () => {
    const judged = read(`総評\n\n${block({ "sacty-review-verdict": { verdict: "no_findings" } })}`);
    expect(judged.verdict).toBe("no_findings");
    expect(judged.verdictMissing).toBeUndefined();
    // 判定のブロックが無くても、[要修正] の行へのコメントがあれば、修正が必要
    const must = read(
      `総評\n\n${block({
        "sacty-review-comments": [
          { path: "src/retry.ts", line: 2, severity: "must", body: "上限が無い" },
        ],
      })}`,
    );
    expect(must.verdict).toBe("changes_required");
    expect(must.verdictMissing).toBeUndefined();
  });

  const task = (verdict: NonNullable<Task["reviewVerdicts"]>[number]) =>
    ({
      id: "t-1",
      title: "レビュー",
      body: "",
      steps: [{ key: "review", state: "active" }],
      remarks: [],
      outputs: { review: "総評\n\n指摘：なし。" },
      approved: {},
      reproductionTests: [],
      reviewComments: [],
      reviewTarget: {
        repo: "https://github.com/acme/app",
        number: 12,
        url: "https://github.com/acme/app/pull/12",
        title: "retry",
        body: "",
        headCommit: "h".repeat(40),
        baseCommit: "b".repeat(40),
        author: "alice",
      },
      reviewVerdicts: [verdict],
    }) as unknown as Task;

  it("投稿する本文の判定の行で、レビューが判定を付けなかった回と、判定を読めなかった回を書き分ける", () => {
    const line = (verdict: NonNullable<Task["reviewVerdicts"]>[number]) =>
      buildReviewBody(task(verdict)).split("\n")[3];
    const missing = read("総評\n\nレビューを完了できませんでした。").verdictMissing;
    expect(missing).toBe("absent");
    expect(line({ round: 1, missing })).toBe(
      "@alice 判定：付いていません（レビューが判定を付けませんでした。差分も対象の文書も読めなかったレビューには、判定を付けません。本文と行へのコメントを確かめてください）",
    );
    const unreadable =
      "@alice 判定：読み取れませんでした（本文と行へのコメントを確かめてください）";
    expect(line({ round: 1, missing: "invalid" })).toBe(unreadable);
    // 理由を残す前の作業履歴の回は、今までどおり
    expect(line({ round: 1 })).toBe(unreadable);
    // 判定がある回は、理由が付いていても判定を書く
    expect(line({ round: 1, verdict: "no_findings", missing: "absent" })).toBe(
      "@alice 判定：指摘なし",
    );
  });

  it("レビューの指示は、判定を付けないときに、付けない理由を総評に書かせる", () => {
    const prompt = buildPrompt(task({ round: 1 }), "review", { diff });
    expect(prompt).toContain(
      "判定を付けないときは、付けない理由を、中身の言葉（何が未確認で、読む人が何をすればよいか）で、本文の最初に書きます",
    );
  });
});
