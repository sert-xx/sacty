import type { FinalReview, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildFinalReviewPrompt, buildPrompt, extractFinalReview } from "./prompts.js";

// 依頼にも承認済みの要求要件・設計にも無い変更（範囲外の変更）を、最終レビューで不合格にする（PBI-273）

const block = (b: Record<string, unknown>) =>
  `\`\`\`json\n${JSON.stringify({ "sacty-final-review": b })}\n\`\`\``;

const verdict = (extra: Record<string, unknown> = {}) =>
  block({
    viewpoints: [{ id: "REQ", verified: true, reason: "検証している" }],
    remarks: [],
    summary: "ok",
    ...extra,
  });

const read = (output: string, ids: string[] = ["REQ"]) => extractFinalReview(output, ids, [], {});

const OUT = "styles.css の狭い画面のカード表示：どの要求要件・設計にも無い";

const task = (extra: Partial<Task> = {}) =>
  ({
    id: "t-1",
    title: "会議室を廃止する",
    body: "会議室を廃止できるようにする",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: { implement: "# 実装の説明" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["rooms.test.ts"] }],
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

describe("最終レビューの、範囲外の変更（PBI-273）", () => {
  it("outOfScope の申告があれば、観点がすべて検証済みでも、観点 SCOPE を不合格にして足す", () => {
    const review = read(verdict({ outOfScope: [OUT] }));
    expect(review.passed).toBe(false);
    expect(review.viewpoints.map((v) => [v.viewpointId, v.verified])).toEqual([
      ["REQ", true],
      ["SCOPE", false],
    ]);
    const scope = review.viewpoints.find((v) => v.viewpointId === "SCOPE");
    expect(scope?.reason).toMatchObject({ code: "review.outOfScope" });
    expect(JSON.stringify(scope?.reason)).toContain(OUT);
  });

  it("申告が無い・空・「なし」だけなら、何も足さず、これまでどおり合格にする（空の一覧・無い項目・読めない形）", () => {
    for (const outOfScope of [
      undefined,
      [],
      ["", "  "],
      ["なし"],
      "あります",
      { a: 1 },
      [null, 1],
    ]) {
      const review = read(verdict({ outOfScope }));
      expect(review.passed, JSON.stringify(outOfScope)).toBe(true);
      expect(review.viewpoints.map((v) => v.viewpointId)).toEqual(["REQ"]);
    }
  });

  it("項目はオブジェクト（name・reason）でも読み、複数件は1つの観点にまとめる。秘密情報は伏せる", () => {
    const review = read(
      verdict({
        outOfScope: [
          { name: "a.ts の追加ボタン", reason: "依頼に無い" },
          "b.spec.ts の期待の逆転 token=abcdef123456",
        ],
      }),
    );
    const scope = review.viewpoints.filter((v) => v.viewpointId === "SCOPE");
    expect(scope).toHaveLength(1);
    const text = JSON.stringify(scope[0]?.reason);
    expect(text).toContain("a.ts の追加ボタン：依頼に無い");
    expect(text).toContain("b.spec.ts の期待の逆転");
    expect(text).not.toContain("abcdef123456");
  });

  it("判定が読めないとき（観点の判定が無い）は、これまでどおり不合格で、SCOPE は足さない", () => {
    const review = read("判定なし");
    expect(review.passed).toBe(false);
    expect(review.viewpoints.map((v) => v.viewpointId)).toEqual(["REQ"]);
  });

  it("セキュリティ対応（観点 SEC-MIN がある）では、outOfScope を読まない", () => {
    const review = read(
      block({
        viewpoints: [
          { id: "REQ", verified: true, reason: "ok" },
          { id: "SEC-MIN", verified: true, reason: "最小限" },
        ],
        remarks: [],
        outOfScope: [OUT],
        summary: "ok",
      }),
      ["REQ", "SEC-MIN"],
    );
    expect(review.passed).toBe(true);
    expect(review.viewpoints.map((v) => v.viewpointId)).toEqual(["REQ", "SEC-MIN"]);
  });

  it("テストのコマンドがあるときも、SCOPE を不合格にし、テストの記録は変えない", () => {
    const review = extractFinalReview(
      verdict({ outOfScope: [OUT], tests: { exitCode: 0, output: "ok" } }),
      ["REQ"],
      [],
      { testCommand: "npm test" },
    );
    expect(review.passed).toBe(false);
    expect(review.tests).toEqual({ command: "npm test", exitCode: 0, output: "ok" });
    expect(review.viewpoints.find((v) => v.viewpointId === "SCOPE")?.verified).toBe(false);
  });
});

describe("範囲外の変更の指示と、やり直しの伝え方（PBI-273）", () => {
  it("最終レビューの指示に、範囲外の変更と、既存のテストの期待を変える変更を不合格にすること、判断できないものは人の確認に回すことを書く", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff", { testCommand: "npm test" });
    expect(prompt).toContain("--- 範囲外の変更 ---");
    expect(prompt).toContain("outOfScope に書き、不合格にする");
    expect(prompt).toContain("既存のテストの期待を弱める・逆にする変更");
    expect(prompt).toContain("先にベースブランチへマージされたテストも含めて、範囲外");
    // 求められた変更に要る変更は範囲内
    expect(prompt).toContain("求められた変更を実現するのに要る変更");
    // 判断できないものは不合格にしない
    expect(prompt).toContain("範囲内か判断できない：<ファイルと変更の内容>");
    expect(prompt).toContain("不合格の理由にしない");
    expect(prompt).toContain('"outOfScope":[]');
    expect(prompt).toContain("outOfScope には、上の「範囲外の変更」で範囲外と判定した変更");
  });

  it("リポジトリの決まり（AGENTS.md・CONTRIBUTING など）が求める README・CHANGELOG・生成物などの更新は、範囲内として、outOfScope に書かせない。決まりは作業領域で読んで確かめさせ、確かめられないものは人の確認に回す", () => {
    for (const prompt of [
      buildFinalReviewPrompt(task(), "diff", { testCommand: "npm test" }),
      buildFinalReviewPrompt(task(), "diff"),
    ]) {
      expect(prompt).toContain(
        "リポジトリの決まりが、この種の変更に伴って求める変更（README・CHANGELOG・版・ドキュメント・生成物の更新",
      );
      expect(prompt).toContain("要求要件・設計に書かれていなくても範囲内とする");
      expect(prompt).toContain(
        "作業領域の AGENTS.md・CLAUDE.md・CONTRIBUTING・PR テンプレート・既存の変更の慣習を読んで確かめる",
      );
      expect(prompt).toContain("決まりが求めると確かめられる変更は、outOfScope に書かない");
      expect(prompt).toContain("確かめられないものは、範囲外にせず、humanChecks に回す");
    }
  });

  it("テストのコマンドが無い最終レビューにも、同じ指示と出力の形がある", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff");
    expect(prompt).toContain("--- 範囲外の変更 ---");
    expect(prompt).toContain('"outOfScope":[]');
  });

  it("要求要件・設計を省いたタスクにも、指示を入れる", () => {
    const prompt = buildFinalReviewPrompt(
      task({ steps: [{ key: "implement", state: "active" }] } as unknown as Partial<Task>),
      "diff",
    );
    expect(prompt).toContain("--- 範囲外の変更 ---");
  });

  it("セキュリティ対応には入れない（観点 SEC-MIN が同じことを見る）", () => {
    const prompt = buildFinalReviewPrompt(
      task({ requestedPlan: "security-fix" } as unknown as Partial<Task>),
      "diff",
    );
    expect(prompt).not.toContain("--- 範囲外の変更 ---");
    expect(prompt).not.toContain("outOfScope");
  });

  it("ベースブランチ側の変更と成果物を、判定に含めないことは変えない", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff");
    expect(prompt).toContain(
      "ベースブランチ側の変更と、sacty が PR に足す成果物は、判定に含めない",
    );
  });

  const failed = (reason: string): FinalReview => ({
    passed: false,
    viewpoints: [
      { viewpointId: "REQ", verified: true, reason: "ok" },
      { viewpointId: "SCOPE", verified: false, reason },
    ],
    remarks: [],
    summary: "範囲外の変更がある",
    agentId: "claude",
    runId: "r1",
    costUsd: 0,
    estimated: false,
    at: "2026-10-24T10:00:00.000Z",
  });

  it("実装のやり直しに、挙げられた変更だけを起点の状態に戻して外し、ほかは残すこと、外した後に差分で確かめることを伝える", () => {
    const prompt = buildPrompt(
      task({ verifyFeedback: { kind: "review", review: failed(OUT) } } as Partial<Task>),
      "implement",
    );
    expect(prompt).toContain(`[SCOPE] 観点を検証できていない：${OUT}`);
    expect(prompt).toContain("起点のコードの状態に戻して外してください");
    expect(prompt).toContain("外すのは、挙げられた変更だけにする");
    expect(prompt).toContain("起点のコードにあった指定やテストの期待は、そのまま残す");
    expect(prompt).toContain("変更の無い再提出はしないでください");
  });

  it("SCOPE が不合格でない差し戻しには、この伝え方を足さない", () => {
    const other: FinalReview = {
      ...failed("x"),
      viewpoints: [{ viewpointId: "REQ", verified: false, reason: "形だけ" }],
    };
    const prompt = buildPrompt(
      task({ verifyFeedback: { kind: "review", review: other } } as Partial<Task>),
      "implement",
    );
    expect(prompt).not.toContain("[SCOPE]");
    expect(prompt).not.toContain("起点のコードの状態に戻して外してください");
  });
});
