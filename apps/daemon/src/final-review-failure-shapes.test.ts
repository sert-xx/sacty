import type { FinalReview, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompts.js";

// ゴールガーディアンが、環境による失敗などの一覧を、文字列でなくオブジェクトの配列で返しても読めること。
// 実証（複数言語のモノレポ）で、`environmentFailures` が `{name, reason}` の配列で返され、文字列だけを読む読み取りが
// すべて捨てて、合格のはずの最終レビューが「不合格（0件）」になり、実装が差分なしの再送を繰り返した。

const COMMAND = "make setup && make lint test smoke build";

const failedTask = (review: Partial<FinalReview>, extra: Partial<Task> = {}) =>
  ({
    id: "t-1",
    title: "配送先を足す",
    body: "配送先の国コードを足す",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: { implement: "# 実装の説明" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["order.test.ts"] }],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    verifyFeedback: {
      kind: "review",
      review: {
        passed: false,
        viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
        remarks: [],
        summary: "テストが通らなかった",
        tests: { command: COMMAND, exitCode: 2, output: "make: *** [setup] Error 2" },
        agentId: "claude",
        runId: "r1",
        costUsd: 0,
        estimated: false,
        at: "2026-10-31T15:31:00.000Z",
        ...review,
      },
    },
    ...extra,
  }) as unknown as Task;

const NO_FINDINGS =
  "観点と過去の指摘には、問題は見つかっていません。不合格の理由は、ゴールガーディアンが実行したテストが通らなかったことだけです。";

describe("指摘が無いままテストだけで不合格になったときの、実装のやり直しの指示", () => {
  it("観点・指摘に問題が無く、テストが通らなかったことだけが理由だと伝え、無関係な変更を足させない", () => {
    const prompt = buildPrompt(failedTask({}), "implement");
    expect(prompt).toContain(NO_FINDINGS);
    expect(prompt).toContain("実装で直る失敗が無ければ、無関係な変更を足さないでください");
    expect(prompt).toContain("テスト：make setup && make lint test smoke build（終了コード 2）");
  });

  it("観点が未検証・指摘が再発しているときは、その指摘を挙げ、この文は出さない", () => {
    const unverified = buildPrompt(
      failedTask({ viewpoints: [{ viewpointId: "REQ", verified: false, reason: "形だけ" }] }),
      "implement",
    );
    expect(unverified).toContain("[REQ] 観点を検証できていない：形だけ");
    expect(unverified).not.toContain(NO_FINDINGS);
    const recurred = buildPrompt(
      failedTask({ remarks: [{ remarkId: "r-1", notRecurred: false, reason: "再発" }] }),
      "implement",
    );
    expect(recurred).toContain("[r-1] 過去の指摘が再発している：再発");
    expect(recurred).not.toContain(NO_FINDINGS);
  });
});

describe("成果物のファイルで検査が落ちて不合格になったときの、実装のやり直しの指示", () => {
  // 要求要件・設計の PR をマージ済みのタスク（成果物は PR に入るが、実装の作業領域には無い）
  const withDocuments = (documentsDir = "docs/sacty"): Partial<Task> =>
    ({
      stepPullRequests: ["requirements", "design"].map((step) => ({
        step,
        path: `${documentsDir}/t-1/${step}.md`,
      })),
    }) as unknown as Partial<Task>;
  const OUTPUT = "[warn] docs/sacty/t-1/design.md\n[warn] Code style issues found in 2 files.";

  it("検査の出力に成果物のパスが出ていれば、そのパスを挙げ、書式ではなく検査の設定をリポジトリの方針に合わせて直すよう伝える。変更の無い再提出をさせない", () => {
    const prompt = buildPrompt(
      failedTask(
        { tests: { command: "prettier --check .", exitCode: 1, output: OUTPUT } },
        withDocuments(),
      ),
      "implement",
    );
    expect(prompt).toContain("sacty が PR に足す成果物（docs/sacty/t-1/）のファイルが出ています");
    expect(prompt).toContain("検査は、このファイルで落ちています");
    expect(prompt).toContain("書き換えても PR に残りません");
    expect(prompt).toContain("ファイルの書式を直さない");
    expect(prompt).toContain("リポジトリの検査の設定（例：.prettierignore");
    expect(prompt).toContain("リポジトリの方針に合わせて直す");
    expect(prompt).toContain("成果物の置き場所（docs/sacty/）をまとめて対象外にする");
    expect(prompt).toContain("変更の無い再提出はしないでください");
    // 「直る失敗が無ければ無関係な変更を足さない」と矛盾しない（成果物で落ちた検査を直す対象に含める）
    expect(prompt).toContain(
      "実装の変更で直る失敗も、sacty が足す成果物のファイルで落ちた検査も無ければ、無関係な変更を足さないでください",
    );
    expect(prompt).not.toContain("実装で直る失敗が無ければ、無関係な変更を足さないでください");
  });

  it("出力に成果物のパスが無くても、成果物が PR に入ることと、そのファイルで落ちているときの直し方を伝える。他のタスクのパスでは案内しない", () => {
    const prompt = buildPrompt(failedTask({}, withDocuments()), "implement");
    expect(prompt).not.toContain("のファイルが出ています");
    expect(prompt).toContain("sacty が足す成果物（docs/sacty/t-1/）も入ります");
    expect(prompt).toContain("リポジトリ全体の検査がそのファイルで落ちているときは");
    expect(prompt).toContain("リポジトリの方針に合わせて直す");
    // 別のタスクの ID のディレクトリが出力に出ていても、このタスクの成果物とは見なさない
    const other = buildPrompt(
      failedTask(
        {
          tests: { command: "prettier --check .", exitCode: 1, output: "docs/sacty/zzz/design.md" },
        },
        withDocuments(),
      ),
      "implement",
    );
    expect(other).not.toContain("のファイルが出ています");
  });

  it("成果物を PR に足さないタスクには、成果物の案内を出さない", () => {
    for (const extra of [
      {},
      { ...withDocuments(), continuedPullRequest: { number: 7 } } as unknown as Partial<Task>,
    ]) {
      const prompt = buildPrompt(
        failedTask({ tests: { command: "x", exitCode: 1, output: OUTPUT } }, extra),
        "implement",
      );
      expect(prompt).not.toContain("sacty が足す成果物");
      expect(prompt).not.toContain("sacty が PR に足す成果物");
      expect(prompt).toContain(NO_FINDINGS);
      expect(prompt).toContain("実装で直る失敗が無ければ、無関係な変更を足さないでください");
    }
  });

  it("置き場所が既定の docs/sacty でないときは、置き場所の全体を対象外にせず、タスクの ID のディレクトリに当たる範囲にさせる", () => {
    const prompt = buildPrompt(
      failedTask(
        {
          tests: {
            command: "prettier --check .",
            exitCode: 1,
            output: "[warn] docs/t-1/design.md",
          },
        },
        withDocuments("docs"),
      ),
      "implement",
    );
    expect(prompt).toContain("成果物のディレクトリ（docs/t-1/）に当たる範囲を対象外にする");
    expect(prompt).toContain("置き場所（docs/）はリポジトリのほかのファイルと共有されうる");
    expect(prompt).toContain("その全体は対象外にしない");
    expect(prompt).not.toContain("成果物の置き場所（docs/）をまとめて対象外にする");
  });
});
