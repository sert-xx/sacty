import type { FinalReview, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { fillTemplate, limitBody, PR_BODY_MAX } from "./pr-template.js";
import {
  buildPrompt,
  buildPullRequestBody,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  extractBlocks,
  withoutProgressReport,
} from "./prompts.js";

// 実装の PR の本文を、短く、結論から読めるようにする（PBI-264）

const REQUIREMENTS = [
  "# 要求要件：予約をキャンセルできるようにする",
  "",
  "利用者が API と予約一覧の画面から予約をキャンセルできるようにする。",
  "キャンセルした予約は日時と理由を持ったまま残る。",
  "",
  "## 確認したいこと",
  "",
  "### must",
  "",
  "なし",
  "",
  "## 受け入れ条件",
  "",
  "| ID | 応答 |",
  "| --- | --- |",
  "| R-1 | 予約の応答に cancelledAt を含める |",
  "| R-99 | 全文にしかない受け入れ条件 |",
].join("\n");

const LONG_REASON = `${"テストが入力を与えて期待結果を確かめている。".repeat(60)}`;
const TESTS = Array.from(
  { length: 6 },
  (_, i) => `apps/api/src/presentation/http/cancellation.test.ts › ケース ${i + 1}`,
);

const review = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: true,
  viewpoints: [
    { viewpointId: "TV-1", verified: true, reason: LONG_REASON },
    { viewpointId: "TV-2", verified: false, reason: "未検証" },
  ],
  remarks: [],
  summary: "合格。合格。変更は最小限で、境界のテストも通っている。",
  tests: { command: "npm test", exitCode: 0, output: "" },
  agentId: "claude",
  runId: "r1",
  costUsd: 0,
  estimated: false,
  at: "2026-10-24T10:00:00.000Z",
  ...extra,
});

const task = (extra: Record<string, unknown> = {}) =>
  ({
    id: "t-1",
    title: "予約をキャンセルできるようにする",
    body: "予約をキャンセルできるようにする",
    steps: [
      { key: "requirements", state: "done" },
      { key: "design", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: {
      implement: [
        "予約のキャンセル API と画面の操作を足しました。",
        "キャンセルした予約は一覧に残り、時間帯は空きます。",
        "",
        "- `npm test`：成功",
        "",
        "コミット・プッシュはしていません。",
      ].join("\n"),
    },
    approved: {
      requirements: { output: REQUIREMENTS, submission: 1 },
      design: {
        output: "# 設計",
        submission: 1,
        testViewpoints: [
          {
            id: "TV-1",
            title: "未キャンセルの予約の応答に 2 項目が null で入る",
            input: "未キャンセルの予約が 1 件ある状態で、GET を送る",
            expected: "どちらの応答も cancelledAt が null になる",
          },
          {
            id: "TV-2",
            title: "終了前の予約を理由付きでキャンセルできる",
            input: "固定の時計で POST を送る",
            expected: "200 で返る",
          },
        ],
      },
    },
    reproductionTests: [],
    testMap: [
      { viewpointId: "TV-1", tests: TESTS },
      { viewpointId: "TV-2", tests: ["a.test.ts › 単独"] },
    ],
    exports: {},
    stepPullRequests: [
      {
        step: "requirements",
        state: "merged",
        url: "https://github.com/acme/app/pull/7",
        path: "docs/sacty/t-1/requirements.md",
      },
      {
        step: "design",
        state: "merged",
        url: "https://github.com/acme/app/pull/8",
        path: "docs/sacty/t-1/design.md",
      },
    ],
    proposals: [],
    lastReview: review(),
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

describe("実装の PR の本文：結論を冒頭に置く（PBI-264）", () => {
  it("冒頭の「結論」に、変更の要約・最終レビューの判定と所見・人が確かめることがあり、後ろの節より先に読める", () => {
    const body = buildPullRequestBody(
      task({ lastReview: review({ humanChecks: ["実機の画面の見た目を確かめる"] }) }),
    );
    const head = body.slice(0, body.indexOf("## 要求要件"));
    expect(head).toContain("## 結論");
    expect(head).toContain(
      "- 変更：予約のキャンセル API と画面の操作を足しました。 キャンセルした予約は一覧に残り、時間帯は空きます。",
    );
    expect(head).toContain("- 最終レビュー：合格。変更は最小限で、境界のテストも通っている。");
    expect(head).toContain("- [ ] 実機の画面の見た目を確かめる");
    expect(body.indexOf("## 結論")).toBeLessThan(body.indexOf("## 観点 → テスト → 実行結果"));
  });

  it("所見の判定の語が本文の判定と重ならない（「合格。合格。」にしない）。不合格も同じ", () => {
    expect(buildPullRequestBody(task())).not.toMatch(/合格。\s*合格/);
    const failed = buildPullRequestBody(
      task({ lastReview: review({ passed: false, summary: "不合格。不合格。指摘がある" }) }),
    );
    expect(failed).toContain("- 最終レビュー：不合格。指摘がある");
    expect(failed).not.toMatch(/不合格。\s*不合格/);
    // 判定の語で始まらない所見は、そのまま残す。「合格基準」のような語は削らない
    const plain = buildPullRequestBody(
      task({ lastReview: review({ summary: "合格基準を満たす" }) }),
    );
    expect(plain).toContain("- 最終レビュー：合格。合格基準を満たす");
  });

  it("所見が長いときは、結論には文の切れ目までの頭だけを出し、全文は折りたたむ", () => {
    const sentence = "境界の入力をテストで確かめている。";
    const summary = sentence.repeat(60);
    const body = buildPullRequestBody(task({ lastReview: review({ summary }) }));
    const conclusion = body.slice(body.indexOf("## 結論"), body.indexOf("## 要求要件"));
    const line = conclusion.split("\n").find((l) => l.startsWith("- 最終レビュー："));
    expect(line?.length).toBeLessThan(300);
    expect(line?.endsWith("。")).toBe(true);
    // 全文は折りたたみの中にある
    const folded = body.slice(body.indexOf("<summary>ゴールガーディアンの最終レビュー（全文）"));
    expect(folded).toContain(summary);
    expect(body.split(summary).length - 1).toBe(1);
  });

  it("所見が短くて再発の確認も無ければ、全文の折りたたみを出さない", () => {
    expect(buildPullRequestBody(task())).not.toContain("最終レビュー（全文）");
    const remarks = [{ remarkId: "implement-1-1", notRecurred: true, reason: "直した" }];
    const body = buildPullRequestBody(task({ lastReview: review({ remarks }) }));
    expect(body).toContain("最終レビュー（全文）");
    expect(body).toContain("- implement-1-1：再発なし（直した）");
  });

  it("最終レビューが無い・検証中のときも、結論に状態を書く", () => {
    expect(buildPullRequestBody(task({ lastReview: undefined }))).toContain(
      "- 最終レビュー：（なし）",
    );
    const verifying = buildPullRequestBodyText(task({ lastReview: undefined }), {
      verifying: true,
    }).main;
    expect(verifying).toContain("- 最終レビュー：（検証中です。");
    expect(verifying).not.toContain("最終レビュー（全文）");
  });

  it("人が不合格のまま進めた記録も、冒頭の結論に置く", () => {
    const body = buildPullRequestBody(
      task({
        lastReview: review({ passed: false, summary: "エラーの文言が違う" }),
        submissions: {},
        verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 1 },
      }),
    );
    const head = body.slice(0, body.indexOf("## 要求要件"));
    expect(head).toContain("人が、ゴールガーディアンの不合格のまま、レビューへ進めました。");
    expect(head).toContain("- 不合格の観点：TV-2");
  });
});

describe("実装の PR の本文：要求要件・設計は全文を載せない（PBI-264）", () => {
  it("要求要件は最初の段落の頭と、マージで承認した PR へのリンクだけにする", () => {
    const body = buildPullRequestBody(task());
    expect(body).toContain("## 要求要件（人間が承認済み）");
    expect(body).toContain(
      "利用者が API と予約一覧の画面から予約をキャンセルできるようにする。 キャンセルした予約は日時と理由を持ったまま残る。",
    );
    expect(body).toContain(
      "- 要求要件：https://github.com/acme/app/pull/7（`docs/sacty/t-1/requirements.md`）",
    );
    expect(body).toContain(
      "- 設計：https://github.com/acme/app/pull/8（`docs/sacty/t-1/design.md`）",
    );
    expect(body).not.toContain("R-99");
    expect(body).not.toContain("確認したいこと");
    // リンクは1か所だけ（独立した「要求要件・設計の PR」の節を重ねない）
    expect(body.split("pull/7").length - 1).toBe(1);
    expect(body).not.toContain("## 要求要件・設計の PR");
  });

  it("リンクできる PR が無いときは、全文のある場所（タスクの画面）を書く", () => {
    const body = buildPullRequestBody(task({ stepPullRequests: [] }));
    expect(body).toContain("全文は sacty のタスクの画面で確かめてください。");
    expect(body).not.toContain("R-99");
  });

  it("要求要件が見出しと表だけでも、落とさず、リンクだけを書く。空のときは（なし）", () => {
    const onlyTable = buildPullRequestBody(
      task({
        approved: {
          requirements: { output: "# 題\n\n| a | b |\n| - | - |\n| 1 | 2 |", submission: 1 },
        },
      }),
    );
    expect(onlyTable).toContain(
      "## 要求要件（人間が承認済み）\n\n全文は、マージで承認した次の PR にあります。",
    );
    const empty = buildPullRequestBody(
      task({ approved: { requirements: { output: "  ", submission: 1 } } }),
    );
    expect(empty).toContain("## 要求要件（人間が承認済み）\n\n（なし）");
  });

  it("長い要求要件でも、本文は短いまま（全文の長さに比例しない）", () => {
    const huge = `概要の段落。\n\n${"| R-9 | 長い受け入れ条件 |\n".repeat(3000)}`;
    const body = buildPullRequestBody(
      task({ approved: { requirements: { output: huge, submission: 1 } } }),
    );
    expect(body.length).toBeLessThan(10_000);
    const parts = buildPullRequestBodyParts(
      task({ approved: { requirements: { output: huge, submission: 1 } } }),
    );
    expect(parts.summary?.length).toBeLessThan(1_000);
  });

  it("要求要件を省いたタスクは従来の文言、再現のタスクは要点とテストの表にする", () => {
    const skipped = buildPullRequestBody(
      task({ steps: [{ key: "implement", state: "active" }], stepPullRequests: [] }),
    );
    expect(skipped).toContain("（オーケストレーターの判断で、要求要件の工程を省きました。");
    const reproduced = buildPullRequestBody(
      task({
        steps: [
          { key: "requirements", state: "skip" },
          { key: "reproduce", state: "done" },
          { key: "implement", state: "active" },
        ],
        approved: { reproduce: { output: `${REQUIREMENTS}\n\n全文にしかない再現`, submission: 1 } },
        reproductionTests: ["a.test.ts › 再現"],
        stepPullRequests: [],
      }),
    );
    expect(reproduced).toContain(
      "## 不具合の再現（失敗するテストで再現し、sacty が失敗を確かめた）",
    );
    expect(reproduced).toContain("全文は sacty のタスクの画面で確かめてください。");
    expect(reproduced).not.toContain("全文にしかない再現");
    expect(reproduced).toContain("| REPRO 再現のテストが通る |");
  });
});

describe("実装の PR の本文：表のセルを短くする（PBI-264）", () => {
  it("表の行は短く、テスト名は1件目と残りの件数だけ。入力・期待結果・テスト全件・所見は折りたたみに出す", () => {
    const body = buildPullRequestBody(task());
    const rows = body.split("\n").filter((l) => l.startsWith("| TV-"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.length).toBeLessThan(220);
    expect(rows[0]).toContain("ケース 1 ほか 5 件");
    expect(rows[0]).toContain("| ✅ |");
    expect(rows[1]).toContain("| ❌ |");
    expect(rows[1]).toContain("a.test.ts › 単独");
    expect(body).toContain("| 観点 | テスト | 最終レビュー |");
    // 折りたたみには、全件・入力・期待結果・所見の全文がある
    const folded = body.slice(body.indexOf("<summary>観点ごとの詳細"));
    expect(folded).toContain(TESTS.join(" / "));
    expect(folded).toContain("入力：未キャンセルの予約が 1 件ある状態で、GET を送る");
    expect(folded).toContain("期待結果：どちらの応答も cancelledAt が null になる");
    expect(folded).toContain(`最終レビューの所見：${LONG_REASON}`);
  });

  it("長い観点の題は切る。縦棒を含むテスト名で表を壊さない", () => {
    const title = "題".repeat(200);
    const body = buildPullRequestBody(
      task({
        approved: {
          requirements: { output: REQUIREMENTS, submission: 1 },
          design: {
            output: "#",
            submission: 1,
            testViewpoints: [{ id: "TV-1", title, input: "i", expected: "e" }],
          },
        },
        testMap: [{ viewpointId: "TV-1", tests: ["a.test.ts › x | y"] }],
        lastReview: review({ viewpoints: [{ viewpointId: "TV-1", verified: true, reason: "ok" }] }),
      }),
    );
    const row = body.split("\n").find((l) => l.startsWith("| TV-1")) ?? "";
    expect(row).toContain(`${"題".repeat(60)}…`);
    expect(row).not.toContain("題".repeat(61));
    expect(row).toContain("x \\| y");
  });

  it("テストが無い観点は、表には短く、理由は折りたたみに出す。観点が1件も無くても壊れない", () => {
    const body = buildPullRequestBody(
      task({
        testMap: [{ viewpointId: "TV-1", tests: [], untested: "差分で確認した".repeat(30) }],
      }),
    );
    const row = body.split("\n").find((l) => l.startsWith("| TV-1")) ?? "";
    expect(row).toContain("（テストなし。差分で確認）");
    expect(body.slice(body.indexOf("<summary>観点ごとの詳細"))).toContain(
      `（テストなし。差分で確認：${"差分で確認した".repeat(30)}）`,
    );
    const none = buildPullRequestBody(
      task({
        steps: [
          { key: "requirements", state: "done" },
          { key: "implement", state: "active" },
        ],
        testMap: [],
        lastReview: undefined,
      }),
    );
    expect(none).toContain("| REQ 要求要件の受け入れ条件 | （なし） | （なし） |");
  });
});

describe("実装の PR の本文：作業の報告を載せない（PBI-264）", () => {
  it("コミット・プッシュの有無などの文を除き、ほかの文は残す", () => {
    const body = buildPullRequestBody(task());
    expect(body).not.toContain("コミット・プッシュはしていません");
    expect(body).toContain("- `npm test`：成功");
    for (const sentence of [
      "コミット・プッシュはしていません。",
      "マージコミットと GitHub への反映は未完了です。",
      "コミットとプッシュは行っていません",
      "コミット・プッシュは sacty が行います。",
    ]) {
      const text = `変更しました。\n${sentence}\n確かめました。`;
      const out = withoutProgressReport(text);
      expect(out, sentence).not.toContain(sentence);
      expect(out).toBe("変更しました。\n確かめました。");
    }
  });

  it("同じ行の中の文だけを除く。長い文・コードブロック・表・見出しは触らない", () => {
    expect(
      withoutProgressReport("対象は未配置です。コミット・プッシュはしていません。確かめました。"),
    ).toBe("対象は未配置です。確かめました。");
    const long = `${"a".repeat(120)}をコミットしていない変更として扱います。`;
    expect(withoutProgressReport(long)).toBe(long);
    const kept = [
      "```",
      "git commit していません",
      "```",
      "| コミットしていません | 未完了 |",
      "## コミットはしていません",
    ].join("\n");
    expect(withoutProgressReport(kept)).toBe(kept);
    // 話題だけ・状態だけの文、機能や内容を指す語（プッシュ通知・コミットメッセージ）の文は残す
    const topic =
      "コミットのメッセージを直しました。\n未完了の予約も表示します。\nプッシュ通知は送信しません。\nコミットメッセージは変更しません。";
    expect(withoutProgressReport(topic)).toBe(topic);
  });

  it("コードブロックは、開始と同じ文字で十分な長さの終了フェンスまで続く。中の文・空行は変えない", () => {
    // 4文字で開いたコードの中の3文字は終わりではない（中の「コミット・プッシュはしていません。」を消さない）
    const outer = [
      "変更しました。",
      "````md",
      "```",
      "コミット・プッシュはしていません。",
      "```",
      "",
      "",
      "",
      "コミット・プッシュはしていません。",
      "````",
      "コミット・プッシュはしていません。",
      "確かめました。",
    ].join("\n");
    expect(withoutProgressReport(outer)).toBe(
      [
        "変更しました。",
        "````md",
        "```",
        "コミット・プッシュはしていません。",
        "```",
        "",
        "",
        "",
        "コミット・プッシュはしていません。",
        "````",
        "確かめました。",
      ].join("\n"),
    );
    // ~~~ の中の ``` は終わりではない。info string 付きの行や短いフェンスも終わりではない
    const tilde =
      "~~~\n```\nコミットはしていません。\n```json\n~~~\nコミットはしていません。\n終わり。";
    expect(withoutProgressReport(tilde)).toBe(
      "~~~\n```\nコミットはしていません。\n```json\n~~~\n終わり。",
    );
    // コードブロックの外の続く空行は1行にまとめる
    expect(withoutProgressReport("a\n\n\n\nb\n\nコミットはしていません。\n\nc")).toBe(
      "a\n\nb\n\nc",
    );
  });

  it("フェンスは CommonMark の字下げ（0〜3空白）で読む。4空白以上の字下げの行は終わりでも始まりでもない", () => {
    // コードの中の4空白で字下げした ``` は終了ではない（中の文を消さない）
    const inside = "```text\n    ```\nコミット・プッシュはしていません。\n```\n終わり。";
    expect(withoutProgressReport(inside)).toBe(inside);
    // 3空白までの字下げ・後ろの空白は終了になる。info string 付きは終了にならない
    const closed = "```\n```json\n   ```  \nコミット・プッシュはしていません。\n終わり。";
    expect(withoutProgressReport(closed)).toBe("```\n```json\n   ```  \n終わり。");
    // 4空白で字下げした ``` はコードの始まりではない（その後の文は通常の文として扱う）
    expect(
      withoutProgressReport("始め。\n    ```\nコミット・プッシュはしていません。\n終わり。"),
    ).toBe("始め。\n    ```\n終わり。");
    // 結論の要約も、コードの中の字下げした ``` で終わらない
    const body = buildPullRequestBody(
      task({
        outputs: { implement: "```text\n    ```\n中の文\n```\n\nキャンセル API を足しました。" },
      }),
    );
    expect(body).toContain("- 変更：キャンセル API を足しました。");
    expect(body).not.toContain("- 変更：中の文");
  });

  it("字下げのある行（リストの中のコード・字下げしたコード）は、報告の文を除かず、要約にも使わない", () => {
    // リストの中のコードブロック（字下げが4空白以上でも、中の文を消さない）
    const inList =
      "- 変更の例\n\n    ```text\n    コミット・プッシュはしていません。\n    ```\n\n確かめました。";
    expect(withoutProgressReport(inList)).toBe(inList);
    const deeper =
      "1. 手順\n\n   ```text\n   コミットはしていません。\n   ```\n   コミットはしていません。\n終わり。";
    expect(withoutProgressReport(deeper)).toBe(deeper);
    // 字下げしたコード（4空白・タブ）を最初の段落として採用しない
    for (const code of ['    console.log("内部用コード");', '\tconsole.log("内部用コード");']) {
      const body = buildPullRequestBody(
        task({ outputs: { implement: `## 変更例\n\n${code}\n\nAPI を足しました。` } }),
      );
      expect(body).toContain("- 変更：API を足しました。");
      expect(body).not.toContain("- 変更：console.log");
    }
    // 字下げのある行しか無ければ、要約は空（結論に「変更」を出さない）
    expect(
      buildPullRequestBody(task({ outputs: { implement: '    console.log("内部用コード");' } })),
    ).not.toContain("- 変更：");
    // 字下げの無い行の報告の文は、従来どおり除く（箇条書きの行頭も）
    expect(withoutProgressReport("- 変更しました。\n- コミットはしていません。")).toBe(
      "- 変更しました。",
    );
  });

  it("抽出（extractBlocks）を通しても、先頭の行の字下げを保つ（実装の工程）", () => {
    const output = '    console.log("内部用コード");\n\nAPI を足しました。\n';
    expect(extractBlocks(output, new Set(), [], { keepIndent: true }).output).toBe(
      output.trimEnd(),
    );
    // 前後の空行は除く。ほかの工程は従来どおり前後の空白を除く
    expect(extractBlocks("\n\n  a\n", new Set(), [], { keepIndent: true }).output).toBe("  a");
    expect(extractBlocks("  a\n", new Set()).output).toBe("a");
    const implement = extractBlocks(
      "    コミット・プッシュはしていません。\n\n変更しました。",
      new Set(),
      [],
      { keepIndent: true },
    ).output;
    expect(withoutProgressReport(implement)).toBe(implement);
    const body = buildPullRequestBody(
      task({
        outputs: { implement: extractBlocks(output, new Set(), [], { keepIndent: true }).output },
      }),
    );
    expect(body).toContain("- 変更：API を足しました。");
  });

  it("結論の「変更」の要約も、4文字で開いたコードの中の3文字のフェンスで終わらない", () => {
    const body = buildPullRequestBody(
      task({
        outputs: {
          implement: "````\n```\n中の文\n```\n````\n\nキャンセル API を足しました。",
        },
      }),
    );
    expect(body).toContain("- 変更：キャンセル API を足しました。");
    expect(body).not.toContain("- 変更：中の文");
  });

  it("改行の無い長い空白列でも、線形時間で本文を作る", () => {
    // 文の途中の長い空白（行の端ではないので、trim では消えない）
    const blanks = " ".repeat(100_000);
    const started = Date.now();
    const body = buildPullRequestBody(
      task({
        outputs: { implement: `x${blanks}y` },
        lastReview: review({ summary: `合格。p${blanks}q` }),
      }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(body).toContain("- 変更：x");
  });

  it("報告だけの説明は「変更」の節ごと出さない。空でも壊れない", () => {
    const body = buildPullRequestBody(
      task({ outputs: { implement: "コミット・プッシュはしていません。" } }),
    );
    expect(body).not.toContain("## 変更");
    expect(body).not.toContain("- 変更：");
    expect(buildPullRequestBody(task({ outputs: {} }))).not.toContain("- 変更：");
  });

  it("説明が1段落だけなら、結論の要約と「変更」の節で重ねない。複数の段落なら「変更」の節に全文を出す", () => {
    const one = buildPullRequestBody(
      task({ outputs: { implement: "キャンセル API を足しました。" } }),
    );
    expect(one).toContain("- 変更：キャンセル API を足しました。");
    // 箇条書きで始まる説明は、結論の「- 変更：」に印を重ねない
    expect(
      buildPullRequestBody(
        task({ outputs: { implement: "- 一覧に列を足した\n- テストを足した" } }),
      ),
    ).toContain("- 変更：一覧に列を足した テストを足した");
    expect(one).not.toContain("## 変更");
    const many = buildPullRequestBody(task());
    expect(many).toContain("## 変更\n\n予約のキャンセル API と画面の操作を足しました。");
    expect(many).not.toContain("コミット・プッシュ");
  });

  it("実装の指示に、説明は PR の本文に載ること・作業の経過は書かないことを書く", () => {
    const prompt = buildPrompt(task(), "implement");
    expect(prompt).toContain("実装の説明は、sacty がそのまま PR の本文に載せる");
    expect(prompt).toContain("作業の経過の報告");
  });
});

describe("PR テンプレートに沿わせる本文（PBI-264。既存の仕様は保つ）", () => {
  const TEMPLATE = "## 概要\n\n## 変更内容\n\n## テスト\n";

  it("概要に結論と要求要件の要点、変更に説明、テストに短い表を入れ、全文は sacty の記録に折りたたむ", () => {
    const t = task({
      lastReview: review({
        summary: "合格。合格。".concat("境界のテストも通っている。".repeat(40)),
        humanChecks: ["実機で確かめる"],
      }),
    });
    const { main, footer } = fillTemplate(TEMPLATE, buildPullRequestBodyParts(t));
    expect(main).toContain("最終レビュー：合格。");
    expect(main).not.toMatch(/合格。\s*合格/);
    expect(main).toContain("人が確かめること：1 件（この PR の末尾にあります）");
    expect(main).toContain("キャンセルした予約は日時と理由を持ったまま残る。");
    expect(main).not.toContain("R-99");
    expect(main).toContain("予約のキャンセル API と画面の操作を足しました。");
    expect(main).not.toContain("コミット・プッシュはしていません");
    expect(main).toContain("ケース 1 ほか 5 件");
    expect(main).toContain("<summary>sacty の記録</summary>");
    expect(main).toContain("ゴールガーディアンの最終レビュー（全文）");
    // 人が確かめることは footer（最後）に置く
    expect(footer).toContain("- [ ] 実機で確かめる");
    expect(footer).toContain("この PR をマージすると");
    expect(footer).toContain("sacty task t-1");
  });

  it("テンプレートの見出しが無くても、要約・変更・テストを畳まずに出す", () => {
    const { main } = fillTemplate("説明だけのテンプレート\n", buildPullRequestBodyParts(task()));
    expect(main).toContain("最終レビュー：合格。");
    expect(main).toContain("| 観点 | テスト | 最終レビュー |");
  });
});

describe("長さの上限（PBI-264）", () => {
  it("冒頭の結論に置いた人が確かめること・不合格のまま進めた記録は、本文を省いても残る", () => {
    const t = task({
      outputs: { implement: "あ".repeat(66_000) },
      lastReview: review({ passed: false, summary: "違う", humanChecks: ["実機で確かめる"] }),
      submissions: {},
      verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 1 },
    });
    const b = buildPullRequestBodyText(t);
    const { body, truncated } = limitBody(b.main, b.footer, PR_BODY_MAX, b.keep);
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).toContain("- [ ] 実機で確かめる");
    expect(body).toContain("人が、ゴールガーディアンの不合格のまま、レビューへ進めました。");
    expect(body).toContain("sacty task t-1");
    expect(body).toContain("この PR をマージすると");
  });

  it("小さな上限で結論の途中が切れても、人が確かめること・不合格のまま進めた記録は、footer の前に出し直す", () => {
    const checks = Array.from(
      { length: 6 },
      (_, i) => `確認 ${i}：${"実機で確かめる。".repeat(10)}`,
    );
    const t = task({
      lastReview: review({ passed: false, summary: "違う".repeat(50), humanChecks: checks }),
      submissions: {},
      verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 1 },
    });
    const b = buildPullRequestBodyText(t);
    const keepLength = b.keep.reduce((sum, k) => sum + k.length + 2, 0);
    // 結論の途中で切れる上限（結論は keep の分も含めて、この上限より長い）
    const max = b.footer.length + keepLength + 400;
    expect(b.main.length).toBeGreaterThan(max);
    const { body, truncated } = limitBody(b.main, b.footer, max, b.keep);
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(max);
    expect(body).toContain("人が、ゴールガーディアンの不合格のまま、レビューへ進めました。");
    for (const check of checks) expect(body.split(`- [ ] ${check}`).length - 1).toBe(1);
    expect(body.indexOf(`- [ ] ${checks[5]}`)).toBeLessThan(body.indexOf("この PR をマージすると"));
    // 上限に収まるなら、重ねて出さない
    expect(limitBody(b.main, b.footer, PR_BODY_MAX, b.keep).truncated).toBe(false);
  });

  it("途中で切れて消えたときだけ、footer の前に出し直す（残っていれば重ねない）", () => {
    const t = task({ lastReview: review({ humanChecks: ["実機で確かめる"] }) });
    const b = buildPullRequestBodyText(t);
    const { body, truncated } = limitBody(b.main, b.footer, PR_BODY_MAX, b.keep);
    expect(truncated).toBe(false);
    expect(body.split("- [ ] 実機で確かめる").length - 1).toBe(1);
  });
});

describe("要約・短縮の前に秘密の値を伏せる（PBI-264）", () => {
  // 切れ目をまたぐ秘密の値：短縮してから完全一致で伏せると、切れた先頭が残る
  const SECRET = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const LEAK = "sk-live";
  const cases: [string, (filler: (n: number) => string) => Record<string, unknown>][] = [
    // 変更の要約（240 文字）
    ["変更の要約", (f) => ({ outputs: { implement: `${f(230)}${SECRET}` } })],
    // 最終レビューの所見の頭（240 文字）
    [
      "最終レビューの所見の頭",
      (f) => ({ lastReview: review({ summary: `合格。${f(230)}${SECRET}` }) }),
    ],
    // 表のテスト名（70 文字）
    ["テスト名", (f) => ({ testMap: [{ viewpointId: "TV-1", tests: [`${f(60)}${SECRET}`] }] })],
    // 表の観点の題（60 文字）
    [
      "観点の題",
      (f) => ({
        approved: {
          requirements: { output: REQUIREMENTS, submission: 1 },
          design: {
            output: "# 設計",
            submission: 1,
            testViewpoints: [
              { id: "TV-1", title: `${f(50)}${SECRET}`, input: "入力", expected: "期待" },
            ],
          },
        },
      }),
    ],
    // 承認済みの要求要件の要点（240 文字）
    [
      "要求要件の要点",
      (f) => ({
        approved: {
          requirements: { output: `# 要求要件\n\n${f(230)}${SECRET}`, submission: 1 },
          design: { output: "# 設計", submission: 1, testViewpoints: [] },
        },
      }),
    ],
    // 人が確かめること（1 項目 1000 文字）
    ["人が確かめること", (f) => ({ lastReview: review({ humanChecks: [`${f(990)}${SECRET}`] }) })],
    // 不合格のまま進めた記録の所見（1000 文字）
    [
      "不合格のまま進めた記録",
      (f) => ({
        lastReview: review({ passed: false, summary: `${f(990)}${SECRET}` }),
        submissions: {},
        verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 1 },
      }),
    ],
  ];

  for (const [name, build] of cases) {
    it(`${name}：切れ目をまたぐ秘密の値の先頭が残らない`, () => {
      const t = task(build((n) => "あ".repeat(n)));
      // 伏せる前の本文では、切れた先頭が残る（このテストが切れ目をまたいでいること）
      const raw = buildPullRequestBodyText(t);
      expect(`${raw.main}${raw.footer}`, "切れ目をまたいでいない").toContain(LEAK);
      // 秘密の値を渡すと、要約・短縮の前に伏せるので、切れた先頭も残らない
      const text = buildPullRequestBodyText(t, { secrets: [SECRET] });
      expect(text.main + text.footer + text.keep.join("\n")).not.toContain(LEAK);
      const parts = buildPullRequestBodyParts(t, { secrets: [SECRET] });
      expect(JSON.stringify(parts)).not.toContain(LEAK);
    });
  }

  it("秘密の値を渡さなければ、本文は従来どおり", () => {
    const t = task();
    expect(buildPullRequestBodyText(t, { secrets: [] })).toEqual(buildPullRequestBodyText(t));
  });
});
