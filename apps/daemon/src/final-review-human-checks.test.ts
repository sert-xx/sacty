import type { FinalReview, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { fillTemplate, limitBody, PR_BODY_MAX } from "./pr-template.js";
import {
  buildFinalReviewPrompt,
  buildPrompt,
  buildPullRequestBody,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  chatJudgementLines,
  extractFinalReview,
  HUMAN_CHECK_ITEM_MAX,
  HUMAN_CHECKS_BODY_MAX,
} from "./prompts.js";

// 環境が原因のテストの失敗と、作業領域では確かめられない確かめ方を、人が最終承認で確かめる項目に回す（PBI-155）

const block = (b: Record<string, unknown>) =>
  `\`\`\`json\n${JSON.stringify({ "sacty-final-review": b })}\n\`\`\``;

const verdict = (extra: Record<string, unknown> = {}) =>
  block({
    viewpoints: [{ id: "REQ", verified: true, reason: "検証している" }],
    remarks: [],
    summary: "ok",
    ...extra,
  });

const read = (output: string, testCommand: string | null = "npm test") =>
  extractFinalReview(output, ["REQ"], [], testCommand ? { testCommand } : {});

const FAILURE = "processes.test.ts：止めたプロセスが残る。起点のコミットでも同じく失敗する";

describe("最終レビューの、環境によるテストの失敗（PBI-155）", () => {
  it("終了コードが 0 でなくても、失敗がすべて環境によるものと申告されれば合格にし、失敗を記録する", () => {
    const review = read(
      verdict({ tests: { exitCode: 1, output: "16 failed", environmentFailures: [FAILURE] } }),
    );
    expect(review.passed).toBe(true);
    expect(review.tests).toEqual({
      command: "npm test",
      exitCode: 1,
      output: "16 failed",
      environmentFailures: [FAILURE],
    });
  });

  it("環境による失敗の申告が無ければ、終了コードが 0 でないときは、これまでどおり不合格にする", () => {
    for (const environmentFailures of [undefined, [], ["", "  "], [1, null]]) {
      const review = read(verdict({ tests: { exitCode: 1, output: "", environmentFailures } }));
      expect(review.passed, JSON.stringify(environmentFailures)).toBe(false);
      expect(review.tests).not.toHaveProperty("environmentFailures");
    }
  });

  it("終了コードの申告が無ければ、環境による失敗の申告があっても不合格にする", () => {
    const review = read(verdict({ tests: { output: "", environmentFailures: [FAILURE] } }));
    expect(review.passed).toBe(false);
    expect(review.tests).not.toHaveProperty("environmentFailures");
  });

  it("終了コードが 0 なら、環境による失敗の申告は記録しない（合格のまま）", () => {
    const review = read(
      verdict({ tests: { exitCode: 0, output: "", environmentFailures: [FAILURE] } }),
    );
    expect(review.passed).toBe(true);
    expect(review.tests).not.toHaveProperty("environmentFailures");
  });

  it("環境による失敗だけでも、観点を検証していなければ不合格にする", () => {
    const review = read(
      block({
        viewpoints: [{ id: "REQ", verified: false, reason: "形だけ" }],
        remarks: [],
        tests: { exitCode: 1, output: "", environmentFailures: [FAILURE] },
        summary: "ng",
      }),
    );
    expect(review.passed).toBe(false);
    expect(review.tests?.environmentFailures).toEqual([FAILURE]);
  });
});

describe("最終レビューの、人が確かめること（PBI-155）", () => {
  it("humanChecks を、文字列の項目だけ読んで記録する（合否には関わらない）", () => {
    const review = read(
      verdict({
        tests: { exitCode: 0, output: "" },
        humanChecks: [" macOS の日本語入力で、変換中の確定で送らない ", "", 3, null],
      }),
    );
    expect(review.passed).toBe(true);
    expect(review.humanChecks).toEqual(["macOS の日本語入力で、変換中の確定で送らない"]);
  });

  it("テストのコマンドが無いタスクでも読む。無ければ記録しない", () => {
    expect(read(verdict({ humanChecks: ["実機で確かめる"] }), null)).toMatchObject({
      passed: true,
      humanChecks: ["実機で確かめる"],
    });
    expect(read(verdict(), null)).not.toHaveProperty("humanChecks");
    expect(read(verdict({ humanChecks: [] }), null)).not.toHaveProperty("humanChecks");
  });
});

const task = (extra: Partial<Task> = {}) =>
  ({
    id: "t-1",
    title: "ショートカットで送る",
    body: "Ctrl + Enter で送れるようにする",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: { implement: "# 実装の説明" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["form.test.ts"] }],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

const review = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: true,
  viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
  remarks: [],
  summary: "合格",
  tests: { command: "npm test", exitCode: 1, output: "", environmentFailures: [FAILURE] },
  humanChecks: ["macOS の日本語入力で、\n変換中の確定で送らない"],
  agentId: "claude",
  runId: "r1",
  costUsd: 0,
  estimated: false,
  at: "2026-10-24T10:00:00.000Z",
  ...extra,
});

describe("人が確かめることの指示と出し方（PBI-155）", () => {
  it("要求要件の工程に、受け入れの確かめ方を、自動のテストと人が確かめることに分けて書かせる", () => {
    const requirements = buildPrompt(
      task({ steps: [{ key: "requirements", state: "active" }] } as Partial<Task>),
      "requirements",
    );
    expect(requirements).toContain("受け入れの確かめ方を書くときは、次の2つに分けて書く");
    expect(requirements).toContain("合成の入力・イベントで模擬して確かめる形にする");
    expect(requirements).toContain("最終承認で人が確かめる項目になる");
    // ほかの工程には出さない
    expect(buildPrompt(task(), "implement")).not.toContain("受け入れの確かめ方を書くときは");
  });

  it("最終レビューの指示に、人が確かめることと、環境によるテストの失敗の扱いを書く", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff", { testCommand: "npm test" });
    expect(prompt).toContain("--- 人が確かめること ---");
    expect(prompt).toContain("作業領域では確かめられないもの（実機・特定の OS・入力方式");
    expect(prompt).toContain(
      "テストやコードで確かめられるのに確かめていないことは、humanChecks に回さずに不合格の理由にする",
    );
    expect(prompt).toContain("--- 環境によるテストの失敗 ---");
    expect(prompt).toContain("変更を外した起点の状態でも同じように失敗する");
    expect(prompt).toContain(
      "1件でも、変更によるもの・環境によると確かめられないものがあれば、environmentFailures を空にして",
    );
    expect(prompt).toContain('"environmentFailures":[]');
    expect(prompt).toContain('"humanChecks":[]');
  });

  // 要求要件・設計の PR をマージ済みのタスク（成果物のファイルは、タスクブランチにあり、実装の PR に入る）
  const withDocuments = (documentsDir = "docs/sacty") =>
    ({
      stepPullRequests: ["requirements", "design"].map((step) => ({
        step,
        path: `${documentsDir}/t-1/${step}.md`,
      })),
      ...(documentsDir === "docs/sacty" ? {} : { documentsDir }),
    }) as unknown as Partial<Task>;

  it("要求要件・設計の成果物を PR に足すタスクの最終レビューの指示に、写しには成果物が無く、リポジトリ全体の検査の結果は違いうることを書く。写しで通ったものは未確認として人の確認に回し、写しで失敗したものはこれまでどおり不合格にする", () => {
    for (const testCommand of ["npm test", undefined]) {
      const prompt = buildFinalReviewPrompt(
        task(withDocuments()),
        "diff",
        testCommand ? { testCommand } : undefined,
      );
      expect(prompt).toContain("--- PR の中身と作業領域の写し ---");
      // 成果物の置き場所(タスクの短い ID のディレクトリ)を示す
      expect(prompt).toContain("sacty が docs/sacty/t-1/ の下に足す成果物");
      expect(prompt).toContain("作業領域の写しには、このファイルが無い");
      expect(prompt).toContain("prettier --check .");
      // 写しで通った検査は、PR の中身では未確認として humanChecks に書く
      expect(prompt).toContain("作業領域の写しで通った、リポジトリ全体に効く検査は");
      expect(prompt).toContain("PR の中身で通るかは未確認");
      expect(prompt).toContain("humanChecks に書いて、人の確認に回す");
      // 写しで失敗した検査は、これまでどおり不合格の理由にする(人の確認に逃がさない)
      expect(prompt).toContain("作業領域の写しで失敗した検査は、これまでどおり不合格の理由にする");
      expect(prompt).toContain("humanChecks に回さない");
      // 写しで失敗した検査まで、不合格にしないと読める文言は無い
      expect(prompt).not.toContain("それを理由に不合格にはせず");
    }
  });

  it("成果物のディレクトリをオーケストレーターが決めていれば、そのディレクトリを書く", () => {
    const prompt = buildFinalReviewPrompt(task(withDocuments("docs/ai")), "diff");
    expect(prompt).toContain("sacty が docs/ai/t-1/ の下に足す成果物");
    expect(prompt).not.toContain("docs/sacty/");
  });

  it("成果物を PR に足さないタスク(要求要件・設計の PR が無い・既存の PR を引き継ぐ)の最終レビューの指示には、この節を入れない", () => {
    for (const extra of [
      {},
      { continuedPullRequest: { number: 7, url: "https://github.com/acme/app/pull/7" } },
      { ...withDocuments(), continuedPullRequest: { number: 7 } },
    ]) {
      const prompt = buildFinalReviewPrompt(task(extra as unknown as Partial<Task>), "diff", {
        testCommand: "npm test",
      });
      expect(prompt).not.toContain("--- PR の中身と作業領域の写し ---");
      expect(prompt).not.toContain("作業領域の写しには、このファイルが無い");
      expect(prompt).not.toContain("PR の中身で通るかは未確認");
      // ほかの節は残る
      expect(prompt).toContain("--- 人が確かめること ---");
    }
  });

  it("テストのコマンドが無い最終レビューでは、人が確かめることだけを書く", () => {
    const prompt = buildFinalReviewPrompt(
      task({ noTestsReason: "テストが無い" } as Partial<Task>),
      "diff",
    );
    expect(prompt).toContain("--- 人が確かめること ---");
    expect(prompt).toContain('"humanChecks":[]');
    expect(prompt).not.toContain("--- 環境によるテストの失敗 ---");
    expect(prompt).not.toContain("environmentFailures");
  });

  it("実装の PR の本文に、人が確かめることを、改行をまたがないチェックリストで出す", () => {
    const reviewed = task({ lastReview: review() } as Partial<Task>);
    const checklist = [
      "**人が確かめること**（作業領域では確かめられなかったこと。マージの前に確かめてください）",
      "",
      "- [ ] macOS の日本語入力で、 変換中の確定で送らない",
      `- [ ] 環境によると判断したテストの失敗：${FAILURE}`,
    ].join("\n");
    const body = buildPullRequestBody(reviewed);
    expect(body).toContain(checklist);
    expect(body).toContain(
      "→ 合格（ゴールガーディアンが実行。終了コード 1。環境による失敗だけ。下の「人が確かめること」）",
    );
    // 長さの上限で省かれない footer の、承認の案内の前に置く（PR #215 レビュー指摘）
    const parts = buildPullRequestBodyParts(reviewed);
    expect(parts.footer).toContain(checklist);
    expect(parts.record).not.toContain("人が確かめること");
    expect(parts.footer.indexOf("人が確かめること")).toBeLessThan(
      parts.footer.indexOf("この PR をマージすると"),
    );
    expect(buildPullRequestBodyText(reviewed).footer).toContain(checklist);
    // 無ければ出さない
    const plain = buildPullRequestBody(
      task({
        lastReview: review({
          humanChecks: undefined,
          tests: { command: "npm test", exitCode: 0, output: "" },
        }),
      } as Partial<Task>),
    );
    expect(plain).not.toContain("人が確かめること");
    expect(plain).toContain("→ 合格（ゴールガーディアンが実行。終了コード 0）");
  });

  it("実装のやり直しに、環境によると判断した失敗を、直す対象ではないと伝える", () => {
    const failed = review({
      passed: false,
      viewpoints: [{ viewpointId: "REQ", verified: false, reason: "形だけ" }],
    });
    const prompt = buildPrompt(
      task({ verifyFeedback: { kind: "review", review: failed } } as Partial<Task>),
      "implement",
    );
    expect(prompt).toContain(
      `環境によるとゴールガーディアンが判断したテストの失敗（実装で直す対象ではありません）：\n- ${FAILURE}`,
    );
  });

  it("質問への答えに渡す判定に、環境による失敗と人が確かめることを含める", () => {
    const lines = chatJudgementLines(task({ lastReview: review() } as Partial<Task>));
    expect(lines).toContain(`  - 環境によると判断したテストの失敗：${FAILURE}`);
    expect(lines).toContain("  - 人が確かめること：macOS の日本語入力で、\n変換中の確定で送らない");
  });
});

describe("PR の本文の長さの上限と、人が確かめること（PR #215 レビュー指摘）", () => {
  const long = (lastReview: FinalReview) =>
    task({
      lastReview,
      approved: { requirements: { output: "あ".repeat(66_000), submission: 1 } },
    } as Partial<Task>);
  const TEMPLATE = "## 概要\n\n## テスト\n";

  it("要求要件が長くて本文を省いても、通常の本文・テンプレートの本文の両方で、人が確かめることを残す", () => {
    const t = long(review());
    const text = buildPullRequestBodyText(t);
    const filled = fillTemplate(TEMPLATE, buildPullRequestBodyParts(t));
    for (const b of [text, filled]) {
      const { body, truncated } = limitBody(b.main, b.footer, PR_BODY_MAX, b.keep);
      expect(truncated).toBe(true);
      expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
      expect(body).toContain("- [ ] macOS の日本語入力で、 変換中の確定で送らない");
      expect(body).toContain(`- [ ] 環境によると判断したテストの失敗：${FAILURE}`);
      expect(body).toContain("この PR をマージすると");
    }
  });

  it("一覧が上限を超えるときは、入る項目を出し、残りの件数と確かめる場所を書く", () => {
    const many = Array.from({ length: 30 }, (_, i) => `確認 ${i} ${"x".repeat(400)}`);
    const t = long(review({ humanChecks: many }));
    const { footer } = buildPullRequestBodyText(t);
    const shown = footer.split("\n").filter((l) => l.startsWith("- [ ] 確認 "));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.join("\n").length).toBeLessThanOrEqual(HUMAN_CHECKS_BODY_MAX);
    // 環境による失敗の1件も入らなかった分に数える
    expect(footer).toContain(
      `- [ ] ほかに ${31 - shown.length} 件あります。sacty のタスクの画面の最終レビュー（人が確かめること）で確かめてください。`,
    );
    const { body } = limitBody("あ".repeat(70_000), footer, PR_BODY_MAX);
    expect(body).toContain("件あります。sacty のタスクの画面の最終レビュー");
    expect(body).toContain("この PR をマージすると");
  });

  it("長すぎる1項目は、上限で切って、続きの場所を書く（サロゲートペアの途中で切らない）", () => {
    const item = `${"a".repeat(HUMAN_CHECK_ITEM_MAX - 1)}😀tail`;
    const { footer } = buildPullRequestBodyText(
      task({ lastReview: review({ humanChecks: [item], tests: undefined }) } as Partial<Task>),
    );
    expect(footer).toContain(
      `- [ ] ${"a".repeat(HUMAN_CHECK_ITEM_MAX - 1)}…（続きは sacty のタスクの画面で）`,
    );
    expect(footer).not.toContain("tail");
  });
});

describe("人がゴールガーディアンの不合格のままレビューへ進めた PR の本文", () => {
  const failedReview = (summary: string) =>
    review({
      passed: false,
      viewpoints: [{ viewpointId: "REQ", verified: false, reason: "未検証" }],
      summary,
      humanChecks: [],
      tests: undefined,
    });
  const overridden = (summary = "エラーの文言が要求要件と違う") =>
    task({
      lastReview: failedReview(summary),
      submissions: {},
      verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 1 },
      approved: { requirements: { output: "あ".repeat(66_000), submission: 1 } },
    } as Partial<Task>);
  const TEMPLATE = "## 概要\n\n## テスト\n";

  it("要求要件が長くて本文を省いても、通常の本文・テンプレートの本文の両方で、覆した記録と不合格の要点を残す", () => {
    const t = overridden();
    const text = buildPullRequestBodyText(t);
    const filled = fillTemplate(TEMPLATE, buildPullRequestBodyParts(t));
    for (const b of [text, filled]) {
      const { body, truncated } = limitBody(b.main, b.footer, PR_BODY_MAX, b.keep);
      expect(truncated).toBe(true);
      expect(body).toContain("人が、ゴールガーディアンの不合格のまま、レビューへ進めました。");
      expect(body).toContain("- 不合格の観点：REQ");
      expect(body).toContain("- 最終レビューの所見：エラーの文言が要求要件と違う");
    }
  });

  it("長い所見は1行にして上限で切り、前の提出を覆した記録は出さない", () => {
    const { footer } = buildPullRequestBodyText(
      overridden(`a\n${"b".repeat(HUMAN_CHECK_ITEM_MAX)}`),
    );
    expect(footer).toContain(
      `- 最終レビューの所見：a ${"b".repeat(HUMAN_CHECK_ITEM_MAX - 2)}…（続きは sacty のタスクの画面で）`,
    );
    const later = { ...overridden(), submissions: { implement: 1 } } as Task;
    expect(buildPullRequestBodyText(later).footer).not.toContain("不合格のまま");
  });
});
