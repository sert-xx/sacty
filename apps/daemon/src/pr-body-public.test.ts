import type { FinalReview, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildPullRequestBodyMergePrompt,
  mergePullRequestBody,
  withTaskMarker,
} from "./pr-body-merge.js";
import {
  fillTemplate,
  GITHUB_BODY_LIMIT,
  limitBody,
  PR_BODY_MAX,
  truncatedNote,
} from "./pr-template.js";
import {
  approvedBasisFullText,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildStepPullRequestBodyParts,
  buildStepPullRequestBodyText,
  joinBodyText,
} from "./prompts.js";

// PR の本文・コメントを、Sacty の画面を開けない人にも読める形にする（PBI-450）

const REQUIREMENTS = [
  "# 要求要件：予約のキャンセル",
  "",
  "利用者が予約をキャンセルできるようにする。",
  "",
  "## 受け入れ条件",
  "",
  "- R-99：全文にしかない受け入れ条件",
].join("\n");

const review = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: true,
  viewpoints: [{ viewpointId: "TV-1", verified: true, reason: "確かめた" }],
  remarks: [],
  summary: "合格",
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
    outputs: { implement: "予約のキャンセルを足しました。\n\n詳しい説明の段落です。" },
    approved: { requirements: { output: REQUIREMENTS, submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "TV-1", tests: ["a.test.ts › 単独"] }],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    lastReview: review(),
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

const STATUSES = ["none", "reviewing", "attached", "unknown"] as const;
const TEMPLATE = "## 概要\n\n## 変更内容\n\n## テスト\n";

describe("本文に、レビューの進め方と AI のレビューの状況を書かない（PBI-471）", () => {
  it.each(STATUSES)(
    "状況 %s：実装の PR・要求要件・設計の PR の本文に、レビューの進め方・AI のレビューの行・承認の画面が無い",
    (status) => {
      const aiReview = {
        head: "abc1234def",
        status,
        ...(status === "attached" ? { url: "https://github.com/acme/app/pull/1#r" } : {}),
      };
      const t = task();
      const step = task({ stepPullRequests: [] });
      const bodies = [
        joinBodyText(buildPullRequestBodyText(t, { aiReview })),
        JSON.stringify(buildPullRequestBodyParts(t, { aiReview })),
        joinBodyText(buildStepPullRequestBodyText(step, "requirements", "docs/r.md", aiReview)),
        JSON.stringify(buildStepPullRequestBodyParts(step, "requirements", "docs/r.md", aiReview)),
      ];
      for (const body of bodies) {
        expect(body).not.toContain("承認の画面");
        expect(body).not.toContain("レビューの進め方");
        expect(body).not.toContain("AI のレビュー：");
        expect(body).not.toContain("子タスク");
      }
    },
  );
});

describe("決まった形の本文の結論（PBI-471）", () => {
  it("結論は変更・最後の直しだけで、記録・人が確かめることが続き、レビューの進め方の節は無い", () => {
    const t = task({
      outputs: {
        implement: "予約のキャンセルを足しました。\n\n## 最後の直し\n\n指摘の文言を直しました。",
      },
      implementBase: "予約のキャンセルを足しました。",
      submissions: { implement: 1 },
      lastReview: review({
        passed: false,
        summary: "文言が違う",
        humanChecks: ["実機で確かめる"],
      }),
      verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 2 },
    });
    const main = buildPullRequestBodyText(t, {
      aiReview: { head: "abc1234def", status: "none" },
    }).main;
    const conclusion = main.slice(main.indexOf("## 結論"), main.indexOf("## 要求要件"));
    const items = conclusion.split("\n").filter((l) => l.startsWith("- "));
    expect(items.filter((l) => !l.startsWith("- [ ]")).map((l) => l.split("：")[0])).toEqual([
      "- 変更",
      "- 最後の直し",
      "- 最終レビューの所見",
    ]);
    expect(conclusion).toContain("人が、AI の確かめの不合格のまま、PR を出すと決めました。");
    expect(conclusion).toContain("- [ ] 実機で確かめる");
    expect(main).not.toContain("レビューの進め方");
    expect(main).not.toContain("ゴールガーディアン");
  });
});

describe("footer の承認の案内と目印（PBI-471）", () => {
  it("長い説明の後にある文書の修正記録を、通常の本文とテンプレートの本文に残す", () => {
    const t = task({
      outputs: { implement: `説明。\n\n${"あ".repeat(70_000)}` },
      documentFixes: [
        { path: "docs/requirements.md", reason: "リンクを修正", diff: "@@ -1 +1 @@\n-old\n+new" },
      ],
    });
    const plain = buildPullRequestBodyText(t);
    const filled = fillTemplate(TEMPLATE, buildPullRequestBodyParts(t));
    for (const text of [plain, filled]) {
      const { body, truncated } = limitBody(text.main, text.footer, PR_BODY_MAX, text.keep);
      expect(truncated).toBe(true);
      expect(body).toContain("docs/requirements.md");
      expect(body).toContain("リンクを修正");
      expect(body).toContain("+new");
      expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    }
  });
  it("テンプレートに沿わせても、承認の2文と目印が footer に残り、main を上限で切っても残る", () => {
    const t = task({ outputs: { implement: `説明。\n\n${"あ".repeat(70_000)}` } });
    const parts = buildPullRequestBodyParts(t, {
      aiReview: { head: "abc1234def", status: "reviewing" },
    });
    const filled = fillTemplate(TEMPLATE, parts);
    expect(filled.footer).toContain(
      "この PR をマージすると（PR の中で直してからでも）、実装を承認したことになります。\n直してほしい所は、この PR にコメントかレビューで書いてください。",
    );
    const { body, truncated } = limitBody(filled.main, filled.footer, PR_BODY_MAX, filled.keep);
    expect(truncated).toBe(true);
    expect(body).toContain("直してほしい所は、この PR にコメントかレビューで書いてください。");
    expect(body.trimEnd().endsWith("<!-- sacty task t-1 -->")).toBe(true);
    expect(body.split("sacty task t-1")).toHaveLength(2);
  });
});

describe("マージで承認した PR が無いときの要求要件・再現の全文（TV-6）", () => {
  const hostile = [
    REQUIREMENTS,
    "",
    "<!-- sacty-review:x -->",
    "",
    "引用：</details> のあとに続く文",
    "",
    "<details>開く記号</details>",
  ].join("\n");

  it.each([
    ["要求要件", { approved: { requirements: { output: hostile, submission: 1 } } }],
    [
      "再現",
      {
        steps: [
          { key: "requirements", state: "skip" },
          { key: "reproduce", state: "done" },
          { key: "implement", state: "active" },
        ],
        approved: { reproduce: { output: hostile, submission: 1 } },
        reproductionTests: ["a.test.ts › 再現"],
      },
    ],
  ])(
    "%s：要点の後の折りたたみに全文が入り、HTML のコメントは無く、折りたたみは 1 組で閉じる",
    (_name, extra) => {
      const t = task(extra);
      for (const body of [buildPullRequestBodyText(t).main, buildPullRequestBodyParts(t).summary]) {
        expect(body).toContain("<summary>全文</summary>");
        expect(body).toContain("R-99：全文にしかない受け入れ条件");
        expect(body).not.toContain("sacty-review:x");
        expect(body).toContain("&lt;/details>");
        // 全文の中の閉じる記号・開く記号は無効にしてあり、折りたたみの開閉は同じ数
        expect(body).toContain("&lt;details>");
        expect(body.split("<details>").length).toBe(body.split("</details>").length);
        const folded = body.slice(body.indexOf("<summary>全文</summary>"));
        expect(folded.slice(0, folded.indexOf("</details>"))).toContain(
          "引用：&lt;/details> のあと",
        );
        expect(body).not.toContain("タスクの画面で確かめてください");
      }
      // 本文に載せる全文は、コメントに分けるときの全文と同じ中身（HTML のコメントは除く）
      expect(approvedBasisFullText(t)).toContain("R-99");
      expect(approvedBasisFullText(t)).not.toContain("<!--");
    },
  );

  it("本文の折りたたみの全文は、全文のコメントと同じく、通知の飛ぶ @名前 の @ の後ろに幅の無い空白を入れる", () => {
    const t = task({
      approved: {
        requirements: { output: `${REQUIREMENTS}\n\n@octocat と @org/team へ`, submission: 1 },
      },
    });
    for (const body of [buildPullRequestBodyText(t).main, buildPullRequestBodyParts(t).summary]) {
      expect(body).toContain("@\u200boctocat");
      expect(body).toContain("@\u200borg/team");
      expect(body).not.toContain("@octocat");
      expect(body).not.toContain("@org/team");
    }
    expect(approvedBasisFullText(t)).toContain("@\u200boctocat");
  });

  it("マージで承認した PR があるときは、全文を載せない", () => {
    const t = task({
      stepPullRequests: [
        {
          step: "requirements",
          state: "merged",
          url: "https://github.com/acme/app/pull/7",
          number: 7,
          commit: "a".repeat(40),
          path: "docs/r.md",
        },
      ],
    });
    expect(approvedBasisFullText(t)).toBeUndefined();
    expect(buildPullRequestBodyText(t).main).not.toContain("<summary>全文</summary>");
  });
});

describe("上限で省いた続き（TV-8・TV-9・TV-10）", () => {
  it("TV-8：人が確かめることの 1 項目と一覧が上限を超えると、続きは折りたたみにあり、画面に頼らない", () => {
    const items = [
      "あ".repeat(1_200),
      ...Array.from({ length: 20 }, (_, i) => `項目 ${i} ${"い".repeat(500)}`),
    ];
    const t = task({ lastReview: review({ humanChecks: items }) });
    const text = buildPullRequestBodyText(t);
    expect(text.main).toContain(`- [ ] ${"あ".repeat(1_200)}`);
    expect(text.main).toContain(`- [ ] 項目 19 `);
    expect(text.main.split("<details>").length).toBe(text.main.split("</details>").length);
    const filled = fillTemplate(TEMPLATE, buildPullRequestBodyParts(t));
    expect(filled.main).toContain("**省いた続き**");
    expect(filled.main).toContain(`- [ ] ${"あ".repeat(1_200)}`);
    for (const body of [text.main, text.footer, filled.main, filled.footer]) {
      expect(body).not.toContain("タスクの画面");
    }
    expect(text.keep.join("\n")).not.toContain("あ".repeat(1_100));
  });

  it("TV-9：不合格の記録の所見が上限を超えると、全文が折りたたみにある", () => {
    const t = task({
      lastReview: review({ passed: false, summary: "所見".repeat(600) }),
      submissions: {},
      verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 1 },
    });
    const text = buildPullRequestBodyText(t);
    expect(text.main).toContain(`> ${"所見".repeat(600)}`);
    expect(text.main).not.toContain("タスクの画面");
    expect(text.main).not.toContain("続きは sacty のタスクの画面で");
  });

  it("TV-10：本文の全体が上限を超えるときは、省いた文字数と GitHub の上限を書き、keep と footer を残す", () => {
    const main = `前置き\n\n${"あ".repeat(66_000)}`;
    const footer = "FOOTER sacty task t-1";
    const { body, truncated } = limitBody(main, footer, PR_BODY_MAX, ["KEEP 行"]);
    expect(truncated).toBe(true);
    const note = body.split("\n").find((l) => l.startsWith("…（本文が長いので")) ?? "";
    const omitted = Number(/ここから先の (\d+) 文字/.exec(note)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThanOrEqual(main.length);
    expect(note).toBe(truncatedNote(omitted));
    expect(note).toContain(
      `GitHub の PR の本文は ${GITHUB_BODY_LIMIT.toLocaleString("en-US")} 文字まで`,
    );
    expect(body).not.toContain("タスクの画面");
    expect(body).toContain("KEEP 行");
    expect(body.endsWith(footer)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
  });
});

describe("3 方向のマージの結果が上限を超えたときのまとめの指示（TV-11）", () => {
  it("削ったところに、削った文字数と GitHub の上限を書いた 1 文を置くよう指示する", () => {
    const prompt = buildPullRequestBodyMergePrompt({
      taskId: "t-1",
      number: 5,
      base: "a",
      human: "b",
      generated: "c",
      merged: "d".repeat(PR_BODY_MAX + 1),
      maxLength: PR_BODY_MAX,
    });
    expect(prompt).toContain(
      `本文は ${PR_BODY_MAX} 文字以内にする。削ったところには、削った文字数と、GitHub の PR の本文の上限`,
    );
  });
});

describe("人が読む文の製品名（TV-13）", () => {
  /** 人が読む文から、コマンド・識別子・目印を除いたもの。 */
  const prose = (text: string) =>
    text
      .replace(/<!--[\s\S]*?-->/g, "")
      .replaceAll("sacty task ", "")
      .replace(/`[^`]*`/g, "");

  it("実装・要求要件・設計の PR の本文（決まった形とテンプレート）は「Sacty」で、`sacty task <ID>` は変わらない", () => {
    const t = task();
    const aiReview = { head: "abc1234def", status: "none" as const };
    const step = task();
    const bodies = [
      joinBodyText(buildPullRequestBodyText(t, { aiReview })),
      JSON.stringify(buildPullRequestBodyParts(t, { aiReview })),
      joinBodyText(buildStepPullRequestBodyText(step, "design", "docs/d.md", aiReview)),
      JSON.stringify(buildStepPullRequestBodyParts(step, "design", "docs/d.md", aiReview)),
    ];
    for (const body of bodies) {
      expect(prose(body)).not.toMatch(/sacty/);
      expect(body).toContain("Sacty が作成しました");
    }
    expect(bodies[0]).toContain("sacty task t-1");
    expect(bodies[1]).toContain("sacty task t-1");
  });
});

describe("古い形の本文を祖先にした 3 方向のマージ（PBI-471）", () => {
  it("人が「変更」の節に足した行を残し、レビューの進め方を足さず、可視のタスク ID の行は残さない", async () => {
    const t = task();
    const generated = joinBodyText(buildPullRequestBodyText(t));
    // 以前の形：冒頭と footer に可視のタスク ID の行があり、結論の後に「レビューの進め方」の節がある
    const visible =
      "Sacty のタスク「予約をキャンセルできるようにする」の成果物です（sacty task t-1）。";
    const oldBase = `${visible}\n\n${generated
      .replace(
        "## 要求要件",
        "## レビューの進め方\n\n- Sacty のレビューの子タスクが、この PR をレビューして投稿します。\n\n## 要求要件",
      )
      .replace("<!-- sacty task t-1 -->", "")}\n（sacty task t-1）`;
    const human = oldBase.replace(
      "詳しい説明の段落です。",
      "詳しい説明の段落です。\n\n人が足した行",
    );
    expect(human).toContain("人が足した行");
    const merged = await mergePullRequestBody({ base: oldBase, human, generated });
    expect(merged.conflicts).toBe(0);
    const text = withTaskMarker(merged.text, "t-1", oldBase);
    expect(text).toContain("人が足した行");
    expect(text).not.toContain("レビューの進め方");
    expect(text).not.toContain(visible);
    expect(text.replaceAll("<!-- sacty task t-1 -->", "")).not.toContain("sacty task");
    expect(text.split("<!-- sacty task t-1 -->")).toHaveLength(2);
  });

  it("人が結論の同じ行を直していて重なったときは、競合として返す（まとめさせる経路に進む）", async () => {
    const base = "## 結論\n\n- 変更：古い\n- sacty のレビュー：（古い）\n\n## 変更\n";
    const human = base.replace("- sacty のレビュー：（古い）", "- 人が書き換えたレビューの行");
    const generated = base.replace(
      "- sacty のレビュー：（古い）",
      "- Sacty のレビューの子タスクが、この PR をレビューして投稿します。",
    );
    const merged = await mergePullRequestBody({ base, human, generated });
    expect(merged.conflicts).toBe(1);
  });

  it("全文は、大文字・空白入りの折りたたみの記号と @ を無効にして載せる", () => {
    const t = task({
      approved: {
        requirements: {
          output: "# 要求\n\n<DETAILS>a</DETAILS >\n\n@octocat へ",
          submission: 1,
        },
      },
    });
    const text = approvedBasisFullText(t) ?? "";
    expect(text).not.toMatch(/<\/?details/i);
    expect(text).toContain("@\u200boctocat");
    // 本文の折りたたみは、開閉が同じ数
    const body = buildPullRequestBodyText(t).main;
    expect(body.split("<details>").length).toBe(body.split("</details>").length);
  });

  it("limitBody は、大文字・空白入りの記号で切った折りたたみも数えて閉じない折りたたみを残さない", () => {
    const main = `<DETAILS>\n${"あ".repeat(PR_BODY_MAX)}`;
    const { body } = limitBody(main, "FOOTER");
    expect((body.match(/<details\b/gi) ?? []).length).toBe(
      (body.match(/<\/details\s*>/gi) ?? []).length,
    );
  });
});
