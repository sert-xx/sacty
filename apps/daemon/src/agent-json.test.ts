import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { jsonCandidates, lastJsonAnswer } from "./agent-json.js";
import {
  extractBlocks,
  extractExport,
  extractFinalReview,
  extractIntegrationReview,
  extractReproduction,
  extractReviewComments,
  extractRework,
  extractSplitPlan,
  extractStepPlan,
  extractTicketTriage,
  extractVerdict,
} from "./prompts.js";

/** AI の答えの囲み方の揺らぎ（PBI-72）。 */
const shapes: [string, (json: string) => string][] = [
  ["```json で囲む", (json) => `説明です。\n\n\`\`\`json\n${json}\n\`\`\`\n`],
  ["言語名なしの ``` で囲む", (json) => `説明です。\n\n\`\`\`\n${json}\n\`\`\`\n`],
  ["```JSON で囲む", (json) => `説明です。\n\n\`\`\`JSON\n${json}\n\`\`\``],
  ["```jsonc で囲む", (json) => `\`\`\`jsonc\n${json}\n\`\`\``],
  ["囲まずに JSON だけ", (json) => json],
  ["囲まずに前後に説明の文", (json) => `判断しました。\n${json}\n以上です。`],
  ["文の途中に JSON", (json) => `答えは ${json} です。`],
  [
    "整形した JSON を ``` で囲む",
    (json) => `\`\`\`\n${JSON.stringify(JSON.parse(json), null, 2)}\n\`\`\``,
  ],
];

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
].join("\n");

/** 呼び出しの種類ごとの、答えの JSON と、読めたことの確かめ。 */
const calls: {
  name: string;
  json: Record<string, unknown>;
  check: (output: string) => void;
  /** 読んだ JSON を表示用の本文から取り除く呼び出し。 */
  cleaned?: (output: string) => string;
}[] = [
  {
    name: "オーケストレーターの工程の選択",
    json: { "sacty-steps": { plan: "bugfix", reason: "不具合のため" } },
    check: (o) =>
      expect(extractStepPlan(o)).toMatchObject({ plan: "bugfix", reason: "不具合のため" }),
  },
  {
    name: "オーケストレーターのチケットのトリアージ",
    json: {
      "sacty-ticket": { repo: "https://github.com/o/r", title: "T", summary: "S", reason: "R" },
    },
    check: (o) =>
      expect(extractTicketTriage(o)).toEqual({
        repo: "https://github.com/o/r",
        title: "T",
        summary: "S",
        reason: "R",
      }),
  },
  {
    name: "ゴールガーディアンの判定",
    json: { "sacty-verdict": { verdict: "rejected", reason: "裏付けが無い" } },
    check: (o) =>
      expect(extractVerdict(o)).toEqual({ verdict: "rejected", reason: "裏付けが無い" }),
  },
  {
    name: "PR の指摘の戻し先の判断",
    json: { "sacty-rework": { target: "implement", reason: "実装の誤り" } },
    check: (o) =>
      expect(extractRework(o, ["design", "implement"])).toEqual({
        target: "implement",
        reason: "実装の誤り",
      }),
  },
  {
    name: "最終レビュー",
    json: {
      "sacty-final-review": {
        viewpoints: [{ id: "TV-1", verified: true, reason: "通る" }],
        remarks: [],
        summary: "合格",
      },
    },
    check: (o) => expect(extractFinalReview(o, ["TV-1"], [])).toMatchObject({ passed: true }),
  },
  {
    name: "統合レビュー",
    json: {
      "sacty-integration-review": {
        viewpoints: [{ id: "TV-1", verified: true, reason: "通る" }],
        remarks: [],
        findings: [],
        summary: "合格",
      },
    },
    check: (o) => expect(extractIntegrationReview(o, ["TV-1"], [])).toMatchObject({ passed: true }),
    cleaned: (o) => extractIntegrationReview(o, ["TV-1"], []).output,
  },
  {
    name: "タスク分割",
    json: {
      "sacty-split": {
        reason: "分ける",
        children: [
          { key: "A", title: "A" },
          { key: "B", title: "B", dependsOn: ["A"] },
        ],
      },
    },
    check: (o) => expect(extractSplitPlan(o)).toMatchObject({ ok: true, reason: "分ける" }),
  },
  {
    name: "書き出し",
    json: { "sacty-export": { url: "https://wiki.example/1" } },
    check: (o) => expect(extractExport(o)).toEqual({ url: "https://wiki.example/1" }),
  },
  {
    name: "再現のテスト",
    json: { "sacty-reproduction": { tests: ["retry.test.ts"] } },
    check: (o) => expect(extractReproduction(o).tests).toEqual(["retry.test.ts"]),
    cleaned: (o) => extractReproduction(o).output,
  },
  {
    name: "工程の指摘への対応",
    json: { "sacty-responses": [{ remarkId: "R-1", text: "直した" }] },
    check: (o) =>
      expect(extractBlocks(o, new Set(["R-1"])).responses).toEqual([
        { remarkId: "R-1", text: "直した" },
      ]),
    cleaned: (o) => extractBlocks(o, new Set(["R-1"])).output,
  },
  {
    name: "レビューの行へのコメント",
    json: { "sacty-review-comments": [{ path: "src/a.ts", line: 1, body: "名前" }] },
    check: (o) =>
      expect(extractReviewComments(o, diff).comments).toEqual([
        { path: "src/a.ts", line: 1, body: "名前" },
      ]),
    cleaned: (o) => extractReviewComments(o, diff).output,
  },
];

describe("エージェントの JSON の答えを、囲み方が揺らいでも受け取る（PBI-72）", () => {
  for (const call of calls) {
    for (const [shape, wrap] of shapes) {
      it(`${call.name}：${shape}`, () => {
        const output = wrap(JSON.stringify(call.json));
        call.check(output);
        if (call.cleaned) {
          const cleaned = call.cleaned(output);
          expect(cleaned).not.toContain("sacty-");
          expect(cleaned).not.toContain("```");
        }
      });
    }
  }

  it("読み取った JSON の囲みだけを取り除き、前後の説明は残す", () => {
    const output =
      "前の説明\n\n```\n" + '{"sacty-reproduction": {"tests": ["t"]}}' + "\n```\n\n後の説明";
    expect(extractReproduction(output).output).toBe("前の説明\n\n\n\n後の説明");
  });

  it("前のコードの囲みの終わりの行を、JSON の囲みと取り違えない", () => {
    const output = [
      "```ts",
      "const a = 1;",
      "```",
      '{"sacty-reproduction": {"tests": ["t"]}}',
      "```",
      "b",
      "```",
    ].join("\n");
    const result = extractReproduction(output);
    expect(result.tests).toEqual(["t"]);
    expect(result.output).toBe("```ts\nconst a = 1;\n```\n\n```\nb\n```");
  });

  it("壊れた JSON は読まず、読めなければこれまでどおりのエラーにする", () => {
    const broken = '```json\n{"sacty-steps": {"plan": "bugfix", "reason": "x"}\n```';
    expect(extractStepPlan(broken)).toBeUndefined();
    expect(extractStepPlan('{"sacty-steps": {"plan": "bugfix", "reason": "x",}}')).toBeUndefined();
    const split = extractSplitPlan('```\n{"sacty-split": {"children": [}\n```');
    expect(split.ok).toBe(false);
    if (!split.ok) expect(renderMessage(split.message, "ja")).toMatch(/読み取れませんでした/);
    expect(renderMessage(extractVerdict("{判定}").reason, "ja")).toMatch(/判定を読み取れません/);
    // 壊れたものの前に正しいものがあれば、正しいものを読む
    const valid = '{"sacty-steps": {"plan": "bugfix", "reason": "前"}}';
    expect(
      extractStepPlan(`${valid}\n\`\`\`json\n{"sacty-steps": {"plan": \n\`\`\``),
    ).toMatchObject({ reason: "前" });
  });

  it("候補が複数あれば、形の合う最後のものを選ぶ", () => {
    const plan = (reason: string, plan = "bugfix") =>
      JSON.stringify({ "sacty-steps": { plan, reason } });
    // 後ろに形の合わないもの（ほかの見出し・選べない工程・指示の書式の写し）があっても、合うものを選ぶ
    const output = [
      plan("前"),
      plan("後"),
      '```json\n{"note": 1}\n```',
      plan("選べない", "nope"),
      '{"sacty-steps": {"plan": "standard または bugfix", "reason": "書式"}}',
      '{"sacty-verdict": {"verdict": "approved", "reason": "別の呼び出し"}}',
    ].join("\n\n");
    expect(extractStepPlan(output)).toMatchObject({ plan: "bugfix", reason: "後" });
    // 選べる組み合わせが限られていれば、それに合うものを選ぶ
    expect(
      extractStepPlan(`${plan("A", "investigate")}\n${plan("B")}`, ["investigate"]),
    ).toMatchObject({ reason: "A" });
    expect(extractVerdict(output)).toEqual({ verdict: "approved", reason: "別の呼び出し" });
  });

  it("文字列の中の ``` や波括弧で、誤って区切らない", () => {
    const body = "```ts\nconst a = { b: 1 };\n```\nと } や { も書ける";
    const output = [
      "レビューしました。{ 補足 } もあります。",
      "```",
      JSON.stringify({ "sacty-review-comments": [{ path: "src/a.ts", line: 1, body }] }),
      "```",
      "以上。",
    ].join("\n");
    const result = extractReviewComments(output, diff);
    expect(result.comments).toEqual([{ path: "src/a.ts", line: 1, body }]);
    expect(result.output).toBe("レビューしました。{ 補足 } もあります。\n\n以上。");
    // 文字列の中の閉じ括弧・引用符のエスケープ
    const reason = 'x"}]} ```json {"sacty-steps": 1}';
    expect(
      extractStepPlan(JSON.stringify({ "sacty-steps": { plan: "bugfix", reason } })),
    ).toMatchObject({ reason });
  });

  it("説明の文の中の波括弧・引用符で、後ろの JSON を読み落とさない", () => {
    const output = [
      '設定は {name} と { "閉じない括弧、引用符 " も書いた。',
      "{ 外側の説明",
      '```json\n{"sacty-verdict": {"verdict": "approved", "reason": "ok"}}\n```',
      "} 外側の説明の終わり",
    ].join("\n");
    expect(extractVerdict(output)).toEqual({ verdict: "approved", reason: "ok" });
  });

  it("オブジェクトの中のオブジェクトは、別の候補にしない", () => {
    const output = '{"wrapper": {"sacty-verdict": {"verdict": "approved", "reason": "中"}}}';
    expect(jsonCandidates(output)).toHaveLength(1);
    expect(renderMessage(extractVerdict(output).reason, "ja")).toMatch(/読み取れません/);
  });

  it("読み取りで例外になる候補は飛ばして、前の候補を試す", () => {
    const output = '{"a": 1}\n{"b": 2}';
    expect(
      lastJsonAnswer(output, (v) => {
        if ("b" in v) throw new Error("合わない");
        return v.a;
      })?.value,
    ).toBe(1);
  });

  it("閉じない括弧・入れ子の括弧が多い長い出力でも、すぐに読める", () => {
    const answer = '```json\n{"sacty-verdict": {"verdict": "approved", "reason": "ok"}}\n```';
    for (const prose of [
      "if (x) { 続く説明 ".repeat(20_000),
      `${"{".repeat(20_000)}${"}".repeat(20_000)}`,
      "[{ 説明 ".repeat(20_000),
    ]) {
      const started = performance.now();
      expect(extractVerdict(`${prose}\n${answer}`)).toEqual({ verdict: "approved", reason: "ok" });
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});
