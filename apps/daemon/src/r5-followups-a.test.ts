import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FinalReview, humanVisibleEnvironmentFailures, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { aiReviewFor, aiReviewOfHead } from "./ai-review-head.js";
import { DEFAULT_CONTEXT_DIR } from "./context.js";
import {
  aiReviewBodyLine,
  buildFinalReviewPrompt,
  buildPrompt,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildStepPullRequestBodyParts,
  buildStepPullRequestBodyText,
  extractFinalReview,
  internalNameAllowance,
  internalNamesInDiff,
  joinBodyText,
  limitInternalNames,
  withoutInternalPaths,
} from "./prompts.js";
import { WORKSPACE_SCRATCH_DIR, WORKSPACE_TOOLS_DIR } from "./repository.js";

/*
 * r5 の試行で見つかった問題のうち、作業領域・検証・画面・記録（PBI-302 の A・D 群）。
 */

const read = (path: string) => readFileSync(join(DEFAULT_CONTEXT_DIR, path), "utf8");

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: "t-1",
    title: "請求の率を設定する",
    body: "率を設定できるようにする",
    status: "queued",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: { implement: "# 実装の説明\n\n- 率を足した" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["rate.test.ts › 率"] }],
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

const block = (b: Record<string, unknown>) =>
  `\`\`\`json\n${JSON.stringify({ "sacty-final-review": b })}\n\`\`\``;
const verdict = (extra: Record<string, unknown> = {}) =>
  block({
    viewpoints: [{ id: "REQ", verified: true, reason: "検証している" }],
    remarks: [],
    summary: "ok",
    ...extra,
  });
const readReview = (
  output: string,
  options: Parameters<typeof extractFinalReview>[3] = { testCommand: "npm test" },
) => extractFinalReview(output, ["REQ"], [], options);

const diffOf = (path: string, added: string[], start = 10) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},2 +${start},${2 + added.length} @@`,
    " context",
    ...added.map((l) => `+${l}`),
    " context",
  ].join("\n");

describe("A1 作業用のファイルを作業領域の外に置き、リポジトリの検査に影響させない", () => {
  it("検証の記録の置き場所を、作業領域の外の具体的な場所にする（<一時ディレクトリ> のままにしない）", () => {
    const dir = "skills/review/review-dispatch/references";
    for (const file of ["verification-run", "aggregation", "linked-docs", "screen-capture"]) {
      const text = read(`${dir}/${file}.md`);
      expect(text, file).not.toContain("<一時ディレクトリ>");
      expect(text, file).toContain(WORKSPACE_SCRATCH_DIR);
    }
    const run = read(`${dir}/verification-run.md`);
    expect(run).toContain("ツール用のディレクトリなど）を示していても");
    expect(run).toContain("ログ・要約・起点の写しなどの記録を置く場所ではない");
    expect(run).toContain("検証のスクリプトやコマンドにも");
    // 既定のスキルはどのリポジトリにも渡るので、sacty の名前を書かない
    for (const file of ["verification-run", "aggregation", "linked-docs", "screen-capture"]) {
      expect(read(`${dir}/${file}.md`), file).not.toContain("sacty");
    }
  });

  it("既定の規則は、.sacty-tools を道具の置き場だけにし、作業用のファイルを外に置かせる", () => {
    const rules = read("rules.md");
    expect(rules).toContain("`.sacty-tools/` は道具を入れる場所だけです");
    expect(rules).toContain(`\`${WORKSPACE_SCRATCH_DIR}/\` に置いてください`);
    expect(rules).toContain("リポジトリのファイル（スクリプト・テスト・設定）に、");
  });

  it("実装の指示は、.sacty-tools に作業用のファイルを置かせず、内部の名前をリポジトリに書かせない", () => {
    for (const prompt of [
      buildPrompt(task(), "implement"),
      buildPrompt(task({ steps: [{ key: "implement", state: "active" }] } as never), "implement"),
    ]) {
      expect(prompt).toContain(`${WORKSPACE_TOOLS_DIR}/ は入れたツールの置き場だけ`);
      expect(prompt).toContain(`作業領域の外の ${WORKSPACE_SCRATCH_DIR}/ に置く`);
      expect(prompt).toContain("sacty の作業領域の内部の名前を書かない");
    }
  });

  describe("差分に追加された内部の名前を機械的に見つける", () => {
    it("追加された行だけを、パスと行番号つきで見つける（削除した行・前後の行は見つけない）", () => {
      const diff = [
        diffOf("scripts/capture.js", [
          "const base = '.sacty-tools/baseline';",
          "ok();",
          "x('/tmp/agent-scratch/a');",
        ]),
        [
          "diff --git a/b.md b/b.md",
          "--- a/b.md",
          "+++ b/b.md",
          "@@ -1,2 +1,2 @@",
          "-.sacty-tools の記述",
          " /sacty-input は文脈の行",
          "+ふつうの行",
        ].join("\n"),
      ].join("\n");
      expect(internalNamesInDiff(diff)).toEqual([
        { path: "scripts/capture.js", line: 11, name: ".sacty-tools" },
        { path: "scripts/capture.js", line: 13, name: "/tmp/agent-scratch" },
      ]);
    });

    it("0 件・1 件・上限超えで、数が崩れない", () => {
      expect(internalNamesInDiff("")).toEqual([]);
      expect(internalNamesInDiff(diffOf("a.ts", ["const a = 1;"]))).toEqual([]);
      expect(internalNamesInDiff(diffOf("a.ts", [".sacty-tools"]))).toHaveLength(1);
      const many = diffOf(
        "a.ts",
        Array.from({ length: 50 }, (_, i) => `// /sacty-input ${i}`),
      );
      // 見つける段階では絞らない（起点にある名前を除いた後で、limitInternalNames が絞る）
      expect(internalNamesInDiff(many)).toHaveLength(50);
      expect(limitInternalNames(internalNamesInDiff(many))).toHaveLength(20);
      expect(limitInternalNames([])).toEqual([]);
    });

    it("削除したファイル（/dev/null）と、ファイルが複数のときのパスの切り替わりを取り違えない", () => {
      const diff = [
        "diff --git a/old.js b/old.js",
        "--- a/old.js",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-.sacty-tools",
        diffOf("new.js", ["// .sacty-tools"], 1),
      ].join("\n");
      expect(internalNamesInDiff(diff)).toEqual([
        { path: "new.js", line: 2, name: ".sacty-tools" },
      ]);
    });

    it("依頼・要求要件・設計が挙げた名前は、求められたものとして見つけない", () => {
      const diff = diffOf("docs/a.md", ["`.sacty-tools` の説明", "/sacty-input の説明"]);
      expect(internalNamesInDiff(diff, "依頼：.sacty-tools の説明を直す")).toEqual([
        { path: "docs/a.md", line: 12, name: "/sacty-input" },
      ]);
      const t = task({ title: ".sacty-tools の説明を直す" });
      expect(internalNameAllowance(t)).toContain(".sacty-tools");
      expect(internalNamesInDiff(diff, internalNameAllowance(t))).toHaveLength(1);
    });

    it("同じファイルの消した行・前後の行に同じ名前があれば、変更前からある名前の書き直しとして見つけない", () => {
      // sacty 自身のリポジトリの文書が `.sacty-tools` を説明していて、その行を書き直した
      const rewritten = [
        "diff --git a/docs/spec/a.md b/docs/spec/a.md",
        "--- a/docs/spec/a.md",
        "+++ b/docs/spec/a.md",
        "@@ -3,1 +3,1 @@",
        "-道具は `.sacty-tools/` に置く。",
        "+道具は作業領域の `.sacty-tools/` に置く（PR に入れない）。",
      ].join("\n");
      expect(internalNamesInDiff(rewritten)).toEqual([]);
      // 前後の行（後ろにあっても）に同じ名前があるときも
      const context = [
        "diff --git a/docs/a.md b/docs/a.md",
        "--- a/docs/a.md",
        "+++ b/docs/a.md",
        "@@ -1,1 +1,2 @@",
        "+`.sacty-tools/` の下は検査しない。",
        " 道具の置き場は `.sacty-tools/`。",
      ].join("\n");
      expect(internalNamesInDiff(context)).toEqual([]);
      // 別の名前・別のファイルの名前は、変更前からあるものに数えない
      const other = [
        rewritten,
        diffOf("scripts/c.js", ["// .sacty-tools/baseline", "// /tmp/agent-scratch/x"]),
      ].join("\n");
      expect(internalNamesInDiff(other).map((h) => `${h.path}:${h.name}`)).toEqual([
        "scripts/c.js:.sacty-tools",
        "scripts/c.js:/tmp/agent-scratch",
      ]);
      // 消した行が「--」で始まっても、ファイルの見出しと取り違えない
      const dashes = [
        "diff --git a/b.md b/b.md",
        "--- a/b.md",
        "+++ b/b.md",
        "@@ -1,1 +1,1 @@",
        "--- 古い区切り",
        "+.sacty-tools の新しい行",
      ].join("\n");
      expect(internalNamesInDiff(dashes)).toEqual([
        { path: "b.md", line: 1, name: ".sacty-tools" },
      ]);
    });

    it("1 つの追加行にある名前をすべて挙げ、許可・変更前からある名前の除外は名前ごとにかける", () => {
      // 同じ行に、変更前からある名前（.sacty-tools）と新しい名前（/tmp/agent-scratch）がある
      const diff = [
        "diff --git a/docs/a.md b/docs/a.md",
        "--- a/docs/a.md",
        "+++ b/docs/a.md",
        "@@ -1,1 +1,1 @@",
        "-道具は `.sacty-tools/` に置く。",
        "+道具は `.sacty-tools/` に、記録は `/tmp/agent-scratch/` に置く。",
      ].join("\n");
      expect(internalNamesInDiff(diff)).toEqual([
        { path: "docs/a.md", line: 1, name: "/tmp/agent-scratch" },
      ]);
      // 許可した名前と、許可していない名前が同じ行にある
      const both = diffOf("scripts/c.js", ["x('.sacty-tools', '/sacty-input')"]);
      expect(internalNamesInDiff(both, "依頼：.sacty-tools を使う").map((h) => h.name)).toEqual([
        "/sacty-input",
      ]);
      // 同じ名前が 1 行に 2 回あっても 1 件
      expect(internalNamesInDiff(diffOf("a.ts", [".sacty-tools と .sacty-tools"]))).toHaveLength(1);
    });

    it("名前が似ているだけの語（.sacty-tools-x ではない別名など）と、通常のパスは見つけない", () => {
      expect(internalNamesInDiff(diffOf("a.ts", ["import x from './sacty-input.js'"]))).toEqual([]);
      expect(internalNamesInDiff(diffOf("a.ts", ["// /home/me/sacty-input/x"]))).toEqual([]);
    });
  });

  it("最終レビューの指示に、作業用のファイルの扱いと、見つけた名前をデータとして渡す", () => {
    const hits = internalNamesInDiff(diffOf("scripts/c.js", ["// .sacty-tools/baseline"]));
    const prompt = buildFinalReviewPrompt(task(), "diff", {
      testCommand: "npm test",
      internalNames: hits,
    });
    expect(prompt).toContain("--- sacty の作業用のファイル ---");
    expect(prompt).toContain(`作業領域の外の ${WORKSPACE_SCRATCH_DIR}/ に置く`);
    expect(prompt).toContain("そのファイルを作業領域の写しから消して、検査をやり直し");
    expect(prompt).toContain(
      "environmentFailures や humanChecks に、そのファイルや失敗のことを書かない",
    );
    expect(prompt).toContain('"path":"scripts/c.js"');
    expect(prompt).toContain("sacty がこれらを範囲外の変更として不合格にします");
    const none = buildFinalReviewPrompt(task(), "diff");
    expect(none).toContain("内部の名前は、追加された行にありませんでした");
    expect(none).not.toContain("sacty がこれらを範囲外の変更として");
  });

  it("「道具の置き場がある」だけでは、環境だけの結果にしない（入れたツールがあるときだけ）", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff");
    expect(prompt).toContain(
      `作業領域の ${WORKSPACE_TOOLS_DIR}/ に入れたツール（実行ファイル・ブラウザ・フォントなど）があるとき`,
    );
    expect(prompt).not.toContain(`作業領域に ${WORKSPACE_TOOLS_DIR}/ があるとき`);
  });

  describe("日本語・空白・記号を含む名前のファイル（PR #304 のレビュー）", () => {
    it("差分の見出しのパスを、git の書き方（空白の後ろのタブ・引用符の逃がし）から元の名前に戻す", () => {
      const diff = [
        "diff --git a/docs/guide name.md b/docs/guide name.md",
        "--- a/docs/guide name.md\t",
        "+++ b/docs/guide name.md\t",
        "@@ -1,1 +1,2 @@",
        " a",
        "+.sacty-tools/x",
        'diff --git "a/docs/q\\"t\\t.md" "b/docs/q\\"t\\t.md"',
        '--- "a/docs/q\\"t\\t.md"',
        '+++ "b/docs/q\\"t\\t.md"',
        "@@ -1,1 +1,2 @@",
        " a",
        "+.sacty-tools/y",
        // core.quotepath=true の書き方（日本語を 8 進で逃がす）でも
        'diff --git "a/docs/\\346\\227\\245.md" "b/docs/\\346\\227\\245.md"',
        '--- "a/docs/\\346\\227\\245.md"',
        '+++ "b/docs/\\346\\227\\245.md"',
        "@@ -1,1 +1,2 @@",
        " a",
        "+.sacty-tools/z",
        // BMP の外の文字（サロゲートペア）と引用符の名前（core.quotepath=false の git の書き方）
        'diff --git "a/docs/😀\\"guide.md" "b/docs/😀\\"guide.md"',
        '--- "a/docs/😀\\"guide.md"',
        '+++ "b/docs/😀\\"guide.md"',
        "@@ -1,1 +1,2 @@",
        " a",
        "+.sacty-tools/v",
        ...diffOf("docs/日本語.md", [".sacty-tools/w"]).split("\n"),
      ].join("\n");
      expect(internalNamesInDiff(diff).map((h) => h.path)).toEqual([
        "docs/guide name.md",
        'docs/q"t\t.md',
        "docs/日.md",
        'docs/😀"guide.md',
        "docs/日本語.md",
      ]);
    });

    it("起点のファイルを読めず確かめられなかった名前は、不合格にせず、理由とともに人が確かめることに足す", () => {
      const review = readReview(verdict({ tests: { exitCode: 0, output: "" } }), {
        testCommand: "npm test",
        uncheckedInternalNames: [
          { path: "docs/日本語.md", line: 3, name: ".sacty-tools", reason: "大きすぎます" },
          { path: "docs/日本語.md", line: 5, name: "/sacty-input", reason: "大きすぎます" },
        ],
      });
      expect(review.passed).toBe(true);
      expect(review.viewpoints.some((v) => v.viewpointId === "SCOPE")).toBe(false);
      expect(review.humanChecks).toHaveLength(1);
      const item = review.humanChecks?.[0] ?? "";
      expect(item).toContain("docs/日本語.md（3・5 行目）");
      expect(item).toContain("大きすぎます");
      expect(item).toContain("範囲外の変更にはしていない");
      // 内部の名前そのものは書かない（次の回に引き継いでも外れない）
      expect(item).not.toContain(".sacty-tools");
      const next = readReview(verdict({ tests: { exitCode: 0, output: "" } }), {
        testCommand: "npm test",
        previousHumanChecks: [item],
      });
      expect(next.humanChecks).toEqual([item]);
    });
  });

  describe("最終レビューの結果", () => {
    const hits = internalNamesInDiff(diffOf("scripts/c.js", ["// .sacty-tools/baseline"]));

    it("リポジトリのファイルに内部の名前があれば、申告にかかわらず範囲外の変更として不合格にする", () => {
      const review = readReview(verdict({ tests: { exitCode: 0, output: "" } }), {
        testCommand: "npm test",
        internalNames: hits,
      });
      expect(review.passed).toBe(false);
      const scope = review.viewpoints.find((v) => v.viewpointId === "SCOPE");
      expect(scope?.verified).toBe(false);
      expect(JSON.stringify(scope?.reason)).toContain("scripts/c.js:11");
      // 見つからなければ、これまでどおり合格
      expect(readReview(verdict({ tests: { exitCode: 0, output: "" } })).passed).toBe(true);
      expect(
        readReview(verdict({ tests: { exitCode: 0, output: "" } }), {
          testCommand: "npm test",
          internalNames: [],
        }).passed,
      ).toBe(true);
    });

    it("sacty の作業領域の内部の物の項目は、人が確かめることから外し、外した記録を残す", () => {
      const review = readReview(
        verdict({
          tests: { exitCode: 0, output: "" },
          humanChecks: [
            "環境によると判断したテストの失敗：prettier（.sacty-tools/review/summary.json）",
            "macOS の日本語入力で確かめる",
          ],
        }),
      );
      expect(review.humanChecks).toEqual(["macOS の日本語入力で確かめる"]);
      expect(review.droppedHumanChecks?.[0]).toContain("sacty の作業領域の作業記録のファイル");
    });

    it("前の回から引き継ぐ項目にも、同じ扱いをする。内部の名前の無い項目は残る", () => {
      const review = readReview(verdict({ tests: { exitCode: 0, output: "" } }), {
        testCommand: "npm test",
        previousHumanChecks: ["/sacty-review の差分を見る", "本番で確かめる"],
      });
      expect(review.humanChecks).toEqual(["本番で確かめる"]);
      expect(review.droppedHumanChecks).toHaveLength(1);
    });

    it("依頼・要求要件・設計が挙げた名前の項目は、外さず、言い換えない（sacty 自身のリポジトリを直すタスクなど）", () => {
      const review = readReview(
        verdict({
          tests: { exitCode: 1, output: "", environmentFailures: ["a：.sacty-tools の説明が古い"] },
          humanChecks: [".sacty-tools の説明を読んで確かめる", "/sacty-input の項目"],
        }),
        { testCommand: "npm test", internalAllowance: ".sacty-tools の説明を直す" },
      );
      expect(review.humanChecks).toEqual([".sacty-tools の説明を読んで確かめる"]);
      expect(review.tests?.environmentFailures).toEqual(["a：.sacty-tools の説明が古い"]);
    });

    it("検証の道具を起動・実行できなかった失敗は、作業用のファイルの失敗にせず、パスだけを伏せて人が確かめることに残す", () => {
      const review = readReview(
        verdict({
          tests: {
            exitCode: 1,
            output: "",
            environmentFailures: [
              "screenshot：.sacty-tools/chromium/chrome を起動できず、画面の確認を実行できなかった",
              "prettier：.sacty-tools/review/summary.json が整形されていない",
            ],
          },
          humanChecks: [
            ".sacty-tools/bin/playwright が起動できなかったので、画面の操作を手元で確かめ直す",
            "検証の記録 .sacty-tools/review/dispatch.md を見る",
          ],
        }),
      );
      // 道具の失敗：実行できなかった検証・理由・確かめ直すことは残り、内部のパスは出ない
      expect(review.humanChecks).toEqual([
        "sacty が作業領域に入れた検証の道具 が起動できなかったので、画面の操作を手元で確かめ直す",
      ]);
      expect(review.droppedHumanChecks).toHaveLength(1);
      const failures = review.tests?.environmentFailures ?? [];
      expect(failures).toContain(
        "screenshot：sacty が作業領域に入れた検証の道具 を起動できず、画面の確認を実行できなかった",
      );
      expect(failures.join("\n")).not.toContain(".sacty-tools");
      expect(humanVisibleEnvironmentFailures(failures)).toHaveLength(1);
      // PR の本文で「作業用のファイルによる失敗だけ」として合格にしない
      const t = task({
        lastReview: {
          ...(review as unknown as FinalReview),
          agentId: "g",
          runId: "r",
          costUsd: 0,
          estimated: false,
          at: "2026-11-04T00:00:00.000Z",
        },
      } as Partial<Task>);
      const body = joinBodyText(buildPullRequestBodyText(t));
      expect(body).not.toContain("失敗は sacty の作業用のファイルによるものだけ");
      expect(body).toContain("失敗は環境によるものだけと判断して合格にした");
      expect(body).toContain("画面の確認を実行できなかった");
    });

    it("「この環境だけの結果」の項目は、入れたツールの注記なので外さない", () => {
      const item =
        "この環境だけの結果：.sacty-tools/chromium に入れたブラウザで通した。入れていない環境では確かめていない";
      const review = readReview(
        verdict({ tests: { exitCode: 0, output: "" }, humanChecks: [item] }),
      );
      expect(review.humanChecks).toEqual([item]);
      expect(review.droppedHumanChecks).toBeUndefined();
    });

    it("作業用のファイルによる失敗の説明は、パスも説明も載せず、1件の中立な文にする", () => {
      const review = readReview(
        verdict({
          tests: {
            exitCode: 1,
            output: "[warn] .sacty-tools/review/dispatch.md",
            environmentFailures: [
              "prettier：.sacty-tools/review/summary.json が整形されていない",
              "prettier：.sacty-tools/review-fix/dispatch.md が整形されていない",
            ],
          },
        }),
      );
      expect(review.passed).toBe(true);
      expect(review.tests?.environmentFailures).toHaveLength(1);
      expect(review.tests?.environmentFailures?.[0]).not.toContain(".sacty-tools");
      expect(humanVisibleEnvironmentFailures(review.tests?.environmentFailures)).toEqual([]);
      // リポジトリのテストの環境による失敗は、これまでどおり残る
      const mixed = readReview(
        verdict({
          tests: {
            exitCode: 1,
            output: "",
            environmentFailures: [
              "a.test.ts：起点でも失敗する",
              "x：.sacty-tools/a.md が lint に拾われた",
            ],
          },
        }),
      );
      expect(humanVisibleEnvironmentFailures(mixed.tests?.environmentFailures)).toEqual([
        "a.test.ts：起点でも失敗する",
      ]);
    });

    it("タイムアウト・中断・終了コードなど実行の失敗は、記録のファイルのパスやログがあっても道具の失敗として残す", () => {
      const timeout =
        "e2e：タイムアウトで失敗した（ログは .sacty-tools/logs/e2e.log）。画面の操作を確かめられなかった";
      for (const failure of [
        timeout,
        "e2e：/tmp/sacty-run/review.log を見ると、120 秒で timed out した",
        "e2e：中断された（/tmp/agent-scratch/run.log）",
        "e2e：終了コード 137 で終わった（.sacty-tools/logs/e2e.log）",
      ]) {
        const review = readReview(
          verdict({
            tests: { exitCode: 1, output: "", environmentFailures: [failure] },
            humanChecks: [`環境によると判断したテストの失敗：${failure}`],
          }),
        );
        const failures = review.tests?.environmentFailures ?? [];
        expect(humanVisibleEnvironmentFailures(failures), failure).toHaveLength(1);
        expect(failures.join("\n"), failure).not.toContain(".sacty-tools");
        expect(failures.join("\n"), failure).not.toContain("/tmp/");
        expect(review.humanChecks, failure).toHaveLength(1);
        expect(review.droppedHumanChecks, failure).toBeUndefined();
      }
      const review = readReview(
        verdict({ tests: { exitCode: 1, output: "", environmentFailures: [timeout] } }),
      );
      expect(review.tests?.environmentFailures?.[0]).toContain("タイムアウトで失敗した");
      expect(review.tests?.environmentFailures?.[0]).toContain("画面の操作を確かめられなかった");
    });

    it("記録のファイルの失敗で、検査に拾われたと言えないものは、隠さずにパスだけを伏せて残す", () => {
      const review = readReview(
        verdict({
          tests: { exitCode: 1, output: "", environmentFailures: ["x：.sacty-tools/a.md"] },
        }),
      );
      expect(humanVisibleEnvironmentFailures(review.tests?.environmentFailures)).toHaveLength(1);
      expect(review.tests?.environmentFailures?.join("\n")).not.toContain(".sacty-tools");
    });

    it("PR の本文に、作業用のファイルの名前も失敗の説明も出ない。理由だけがテストの行に出る", () => {
      const review = readReview(
        verdict({
          tests: {
            exitCode: 1,
            output: "",
            environmentFailures: ["prettier：.sacty-tools/review/summary.json"],
          },
          humanChecks: ["環境によると判断した失敗：.sacty-tools/dispatch.md", "本番で確かめる"],
        }),
      ) as unknown as FinalReview;
      const t = task({
        lastReview: {
          ...review,
          agentId: "g",
          runId: "r",
          costUsd: 0,
          estimated: false,
          at: "2026-11-04T00:00:00.000Z",
        },
      } as Partial<Task>);
      for (const text of [
        joinBodyText(buildPullRequestBodyText(t)),
        Object.values(buildPullRequestBodyParts(t)).join("\n"),
      ]) {
        expect(text).not.toContain(".sacty-tools");
        expect(text).not.toContain("sacty の作業用のファイルによる失敗");
        expect(text).toContain(
          "失敗は sacty の作業用のファイルによるものだけで、リポジトリの検査の対象ではないため合格にした",
        );
        expect(text).toContain("本番で確かめる");
        expect(text).not.toContain("環境によると判断したテストの失敗");
      }
    });
  });

  it("人が読む文章から、作業用の一時ファイルのパスも除く", () => {
    expect(withoutInternalPaths(`ログは ${WORKSPACE_SCRATCH_DIR}/review-verify/a.log にある`)).toBe(
      "ログは 作業用の一時ファイル にある",
    );
    expect(withoutInternalPaths("下書き /tmp/sacty-self-review/draft.md を直す")).toContain(
      "作業用の一時ファイル",
    );
    expect(withoutInternalPaths("/tmp/agent-scratch を見る")).toBe("作業用の一時ファイル を見る");
    expect(withoutInternalPaths("/tmp/other/x と src/tmp/sacty-x.ts")).toBe(
      "/tmp/other/x と src/tmp/sacty-x.ts",
    );
  });
});

describe("A2 終了コードが 0 でないのに合格にした理由を、「合格」とだけ出さない", () => {
  const withTests = (tests: Record<string, unknown>) =>
    task({
      lastReview: {
        passed: true,
        viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
        remarks: [],
        summary: "所見",
        tests: { command: "npm test", output: "", ...tests },
        agentId: "g",
        runId: "r",
        costUsd: 0,
        estimated: false,
        at: "2026-11-04T00:00:00.000Z",
      },
    } as unknown as Partial<Task>);

  it("環境による失敗だけと判断して合格にしたときは、そう書く。終了コード 0 の合格は、これまでどおり", () => {
    const body = joinBodyText(
      buildPullRequestBodyText(
        withTests({ exitCode: 1, environmentFailures: ["a.test.ts：起点でも失敗する"] }),
      ),
    );
    expect(body).toContain(
      "→ 合格（ゴールガーディアンが実行。終了コード 1。終了コードは 0 でないが、失敗は環境によるものだけと判断して合格にした。下の「人が確かめること」）",
    );
    expect(body).toContain("- [ ] 環境によると判断したテストの失敗：a.test.ts：起点でも失敗する");
    const ok = joinBodyText(buildPullRequestBodyText(withTests({ exitCode: 0 })));
    expect(ok).toContain("→ 合格（ゴールガーディアンが実行。終了コード 0）");
    expect(ok).not.toContain("合格にした");
    const failed = joinBodyText(buildPullRequestBodyText(withTests({ exitCode: 1 })));
    expect(failed).toContain("→ 不合格（ゴールガーディアンが実行。終了コード 1）");
  });
});

describe("D1 今の head に sacty の AI のレビューが付いているか", () => {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const gate = (extra: Partial<Task> = {}) =>
    task({
      id: "impl",
      status: "awaiting_approval",
      gate: { step: "implement", submission: 1 },
      pullRequest: {
        branch: "b",
        commit: "7ed51c5aaaa",
        url: "https://github.com/acme/app/pull/2",
        number: 2,
        repo: "https://github.com/acme/app",
      },
      pullRequestState: "open",
      ...extra,
    } as unknown as Partial<Task>);
  const reviewer = (extra: Record<string, unknown> = {}) =>
    ({
      id: "rev",
      title: "PR のレビュー",
      body: "https://github.com/acme/app/pull/2 をレビューする",
      status: "running",
      steps: [{ key: "review", state: "active" }],
      repository: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "abc" },
      ...extra,
    }) as unknown as Task;

  it("レビューのタスクが無ければ none、動いていれば reviewing、今の head に投稿していれば attached", () => {
    const g = gate();
    expect(aiReviewOfHead(g, [g], same, "7ed51c5aaaa")).toEqual({
      head: "7ed51c5aaaa",
      status: "none",
    });
    expect(aiReviewOfHead(g, [g, reviewer()], same, "7ed51c5aaaa")).toEqual({
      head: "7ed51c5aaaa",
      status: "reviewing",
    });
    const posted = reviewer({
      status: "idle",
      reviewTarget: { headCommit: "7ed51c5" },
      reviewPost: { url: "https://github.com/acme/app/pull/2#r1", at: "x" },
    });
    expect(aiReviewOfHead(g, [g, posted], same, "7ed51c5aaaa")).toEqual({
      head: "7ed51c5aaaa",
      status: "attached",
      url: "https://github.com/acme/app/pull/2#r1",
    });
  });

  it("別の head へのレビュー・別の PR・中止・一時停止は、今の head のレビューに数えない", () => {
    const g = gate();
    const old = reviewer({
      status: "idle",
      reviewTarget: { headCommit: "0000000" },
      reviewPost: { url: "https://github.com/acme/app/pull/2#r0", at: "x" },
    });
    expect(aiReviewOfHead(g, [g, old], same, "7ed51c5aaaa")?.status).toBe("none");
    const runningOld = reviewer({ reviewTarget: { headCommit: "0000000" } });
    expect(aiReviewOfHead(g, [g, runningOld], same, "7ed51c5aaaa")?.status).toBe("none");
    const other = reviewer({ body: "https://github.com/acme/app/pull/9 をレビューする" });
    expect(aiReviewOfHead(g, [g, other], same, "7ed51c5aaaa")?.status).toBe("none");
    expect(
      aiReviewOfHead(g, [g, reviewer({ status: "cancelled" })], same, "7ed51c5aaaa")?.status,
    ).toBe("none");
    expect(
      aiReviewOfHead(g, [g, reviewer({ status: "paused" })], same, "7ed51c5aaaa")?.status,
    ).toBe("none");
    // 再レビューの前の回が今の head に付いていたなら、付いている
    const rerun = reviewer({
      reviewRound: 2,
      previousReview: {
        round: 1,
        url: "https://github.com/acme/app/pull/2#r1",
        at: "x",
        headCommit: "7ed51c5",
      },
    });
    expect(aiReviewOfHead(g, [g, rerun], same, "7ed51c5aaaa")?.status).toBe("attached");
  });

  it("状況は、提出したコミットではなく、PR が開いている間に読んだ最新の head で計算する。読めていなければ unknown", () => {
    const g = gate();
    // 提出したコミット A（7ed51c5）にレビューが付いている
    const posted = reviewer({
      status: "idle",
      reviewTarget: { headCommit: "7ed51c5" },
      reviewPost: { url: "https://github.com/acme/app/pull/2#r1", at: "x" },
    });
    expect(aiReviewOfHead(g, [g, posted], same, "7ed51c5aaaa")?.status).toBe("attached");
    // 人が未レビューのコミット B を足した：A のレビューを「今の head に付いている」としない
    expect(aiReviewOfHead(g, [g, posted], same, "bbbbbbb1111")).toEqual({
      head: "bbbbbbb1111",
      status: "none",
    });
    // 最新の head を読めていない：付いたと誤らない
    expect(aiReviewOfHead(g, [g, posted], same, undefined)).toEqual({
      head: "7ed51c5aaaa",
      status: "unknown",
    });
    expect(aiReviewBodyLine({ head: "7ed51c5aaaa", status: "unknown" })).toContain(
      "状況は分かりません",
    );
  });

  it("承認待ちでない・PR が開いていないタスクは、状況を持たない。作成前の PR（番号なし）は none", () => {
    expect(
      aiReviewOfHead(gate({ status: "running" } as Partial<Task>), [], same, "abc"),
    ).toBeUndefined();
    expect(
      aiReviewOfHead(gate({ pullRequestState: "merged" } as Partial<Task>), [], same, "abc"),
    ).toBeUndefined();
    expect(
      aiReviewFor(
        { repo: "https://github.com/acme/app", number: undefined, head: "abc" },
        "x",
        [reviewer()],
        same,
      ),
    ).toEqual({ head: "abc", status: "none" });
  });

  it("PR の本文に、今の head の AI のレビューの状況を書く（無ければ書かない）", () => {
    const t = task();
    for (const [status, text] of [
      ["none", "この head（7ed51c5）には、sacty の AI のレビューがまだ付いていません"],
      ["reviewing", "この head（7ed51c5）を、sacty の AI のレビューがレビュー中です"],
      ["attached", "この head（7ed51c5）には、sacty の AI のレビューが付いています"],
    ] as const) {
      const aiReview = { head: "7ed51c5aaaa", status };
      expect(aiReviewBodyLine(aiReview)).toContain(text);
      expect(joinBodyText(buildPullRequestBodyText(t, { aiReview }))).toContain(
        `- AI のレビュー：${text}`,
      );
      expect(buildPullRequestBodyParts(t, { aiReview }).summary).toContain(
        `AI のレビュー：${text}`,
      );
    }
    // 要求要件・設計の PR の本文にも書く（承認の案内の前。テンプレートに沿わせる本文は要約）
    const step = task({ stepPullRequests: [] } as Partial<Task>);
    const aiReview = { head: "7ed51c5aaaa", status: "reviewing" as const };
    const stepText = buildStepPullRequestBodyText(
      step,
      "requirements",
      "docs/sacty/t-1/requirements.md",
      aiReview,
    );
    expect(stepText.footer).toContain(
      "この head（7ed51c5）を、sacty の AI のレビューがレビュー中です",
    );
    expect(stepText.footer.indexOf("AI のレビュー：")).toBeLessThan(stepText.footer.indexOf("---"));
    expect(
      buildStepPullRequestBodyParts(
        step,
        "requirements",
        "docs/sacty/t-1/requirements.md",
        aiReview,
      ).summary,
    ).toContain("AI のレビュー：");
    expect(
      buildStepPullRequestBodyText(step, "requirements", "docs/sacty/t-1/requirements.md").footer,
    ).not.toContain("AI のレビュー：");
    expect(aiReviewBodyLine(undefined)).toBeUndefined();
    expect(joinBodyText(buildPullRequestBodyText(t))).not.toContain("AI のレビュー：");
    expect(
      aiReviewBodyLine({
        head: "abcdef1234",
        status: "attached",
        url: "https://github.com/a/b/pull/1#r",
      }),
    ).toContain("（https://github.com/a/b/pull/1#r）");
  });
});

describe("統合：A・B・C・D の本文の行を同じ PR の本文に重ねても、互いに打ち消さない（PBI-302）", () => {
  const summary =
    "率の設定は要求要件どおりに動き、既存の請求の計算も変わっていない。送信のキューは理由があり範囲内とした。";
  const review = readReview(
    verdict({
      summary,
      tests: {
        exitCode: 1,
        output: "",
        environmentFailures: ["prettier：.sacty-tools/review/summary.json"],
      },
      humanChecks: [
        "共有の仕組みを足した：送信のキュー（率の変更を順に反映しないと、同時の更新で古い率が残るため）",
        "環境によると判断した失敗：.sacty-tools/dispatch.md",
      ],
    }),
  ) as unknown as FinalReview;
  const t = task({
    testMap: [
      {
        viewpointId: "REQ",
        tests: ["src/rate.test.ts › rates › returns %j", "src/rate.test.ts › returns %j"],
      },
    ],
    lastReview: {
      ...review,
      agentId: "g",
      runId: "r",
      costUsd: 0,
      estimated: false,
      at: "2026-11-04T00:00:00.000Z",
    },
  } as Partial<Task>);
  const aiReview = { head: "7ed51c5aaaa", status: "reviewing" as const };
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("B4 の共有の仕組みの項目は残り、A1 の内部の名前の項目は外れ、A2 の理由・D1 の行・C2・C3 の重ならない形がそろう", () => {
    for (const text of [
      joinBodyText(buildPullRequestBodyText(t, { aiReview })),
      Object.values(buildPullRequestBodyParts(t, { aiReview })).join("\n"),
    ]) {
      // B4：理由つきの共有の仕組みは、人が確かめることに 1 回だけ
      expect(count(text, "共有の仕組みを足した：送信のキュー")).toBe(1);
      // A1：内部の名前を含む項目と、失敗の説明は出ない
      expect(text).not.toContain(".sacty-tools");
      // A2：終了コード 1 の合格の理由
      expect(text).toContain("失敗は sacty の作業用のファイルによるものだけ");
      // D1：今の head の AI のレビューの状況は 1 回だけ
      expect(count(text, "sacty の AI のレビューがレビュー中です")).toBe(1);
      // C2：総評の文を繰り返さない
      expect(count(text, "率の設定は要求要件どおりに動き")).toBe(1);
      // C3：同じテストは 1 回、書式の文字はそのまま見せない
      expect(text).not.toContain("%j");
      for (const line of text.split("\n").filter((l) => l.includes("returns ‹"))) {
        expect(count(line, "returns ‹"), line).toBe(1);
      }
      expect(text).toContain("src/rate.test.ts › rates › returns ‹…›");
    }
    // C2：空の見出しを出さない（見出しの直後に別の見出しが続かない）
    expect(joinBodyText(buildPullRequestBodyText(t, { aiReview }))).not.toMatch(
      /^#{1,6} .*\n\n#{1,6} /m,
    );
  });
});
