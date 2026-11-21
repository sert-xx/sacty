import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { mergePullRequestBody, taskMarkerLine, withTaskMarker } from "./pr-body-merge.js";
import { fillTemplate } from "./pr-template.js";
import {
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildStepPullRequestBodyParts,
  buildStepPullRequestBodyText,
  extractBlocks,
  joinBodyText,
} from "./prompts.js";

/*
 * PR の説明を、Sacty を使っていない人が読んで判断できる情報だけにする（PBI-471）。
 * 実装・要求要件・設計の PR の説明（テンプレートの有り無し）に、タスクの ID・指摘の内部の ID・内部の語・書いた時点の状態を
 * 出さず、判断に要る情報（変更・確かめ方・人が確かめること・確認したいこと・指摘の要点と対応・承認の案内）を出す。
 */

const ID = "7f3a9c10-1111-4222-8333-444455556666";
const NO_REQUIREMENTS = "要求要件の文書は作らず、依頼の内容を受け入れの基準にしました。";
const TEMPLATE = "## 概要\n\n## 変更内容\n\n## テスト\n";
const INTERNAL_WORDS = [
  "オーケストレーター",
  "工程",
  "子タスク",
  "担当",
  "サブエージェント",
  "ゴールガーディアン",
  "SEC-MIN",
  "レビューの進め方",
  "AI のレビュー：",
];

/** 表示される文（HTML のコメントの目印を除く）。 */
const visible = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "");

const baseTask = (extra: Record<string, unknown> = {}) =>
  ({
    id: ID,
    title: "予約をキャンセルできるようにする",
    body: "予約をキャンセルできるようにする",
    steps: [{ key: "implement", state: "active" }],
    remarks: [],
    outputs: { implement: "予約のキャンセルを足しました。" },
    approved: {},
    reproductionTests: [],
    testMap: [],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    submissions: {},
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

/** 実装の説明を作り直した後の形（前の提出の説明を土台に、最後の直しを分ける）。 */
const reworked = (whole: string, fix: string, extra: Record<string, unknown> = {}) =>
  baseTask({
    outputs: { implement: `${whole}\n\n## 最後の直し\n\n${fix}` },
    implementBase: whole,
    implementHistory: [whole, `${whole}\n\n## 最後の直し\n\n${fix}`],
    submissions: { implement: 1 },
    ...extra,
  });

const plainBody = (t: Task, stage = {}) => joinBodyText(buildPullRequestBodyText(t, stage));
const templateBody = (t: Task, stage = {}) => {
  const filled = fillTemplate(TEMPLATE, buildPullRequestBodyParts(t, stage));
  return `${filled.main}\n\n${filled.footer}`;
};
const implementBodies = (t: Task, stage = {}) => [plainBody(t, stage), templateBody(t, stage)];

describe("実装の PR の説明に、内部の情報を出さない（TV-1・TV-2）", () => {
  const t = reworked(
    "予約のキャンセルを足しました。",
    "エラーの文言を直しました（implement-1-1 への対応）。",
    {
      testMap: [{ viewpointId: "REQ", tests: ["a.test.ts › キャンセルできる"] }],
    },
  );

  it("TV-1：要求要件を省いた作り直しの後の説明に、タスクの ID・指摘の ID・内部の語・レビューの進め方・AI のレビューの状況が無く、要求要件を省いた文がある", () => {
    const body = plainBody(t, { aiReview: { head: "abc1234def", status: "none" } });
    const text = visible(body);
    expect(text).not.toContain(ID);
    expect(text).not.toContain("implement-1-1");
    for (const word of INTERNAL_WORDS) expect(text, word).not.toContain(word);
    expect(text).toContain(NO_REQUIREMENTS);
    expect(text).toContain("エラーの文言を直しました。");
  });

  it("TV-2：観点の見出しのあるテンプレートを埋めた説明にも、同じ情報が出ない", () => {
    const text = visible(templateBody(t, { aiReview: { head: "abc1234def", status: "none" } }));
    expect(text).not.toContain(ID);
    expect(text).not.toContain("implement-1-1");
    for (const word of INTERNAL_WORDS) expect(text, word).not.toContain(word);
    expect(text).toContain(NO_REQUIREMENTS);
  });
});

describe("固定の文が出る場合の説明に、内部の語と観点の番号が出ない（TV-3）", () => {
  const stacked = {
    stackedOn: { number: 7, url: "https://github.com/acme/app/pull/7", title: "決済の API" },
  };
  const cases: [string, Task, Record<string, unknown>][] = [
    ["重ねた PR", baseTask(), stacked],
    [
      "分割の子タスク",
      baseTask({
        parent: { taskId: "parent-1" },
        childScope: {
          content: "## 実現すること\n\n- 画面を作る",
          parentTitle: "決済をまるごと作る",
        },
      }),
      {},
    ],
    [
      "分割の修正の子タスク",
      baseTask({
        parent: { taskId: "parent-1" },
        childScope: { content: "## 直すこと\n\n- 文言", parentTitle: "決済", fix: true },
      }),
      {},
    ],
    [
      "セキュリティ対応",
      baseTask({ stepsChoice: { plan: "security-fix" }, securityScopeCheck: {} }),
      {},
    ],
    [
      "テストの仕組みが無い",
      baseTask({ noTestsReason: "テストのコードが無い", testsDecidedBy: "orchestrator" }),
      {},
    ],
    [
      "skip-requirements",
      baseTask({
        stepsChoice: { plan: "skip-requirements" },
        steps: [
          { key: "design", state: "done" },
          { key: "implement", state: "active" },
        ],
        approved: {
          design: {
            output: "# 設計",
            submission: 1,
            testViewpoints: [],
            at: "2026-11-01T00:00:00Z",
          },
        },
      }),
      {},
    ],
    [
      "設計の直し",
      baseTask({
        designEdits: [
          {
            at: "2026-11-02T00:00:00Z",
            applied: [
              {
                remarks: ["implement-1-1"],
                viewpoint: "TV-1",
                field: "expected",
                reason: "文言に合わせる",
                before: "失敗しました",
                after: "決済に失敗しました",
              },
            ],
            rejected: [],
          },
        ],
        approved: {
          design: {
            output: "# 設計",
            submission: 1,
            testViewpoints: [],
            at: "2026-11-01T00:00:00Z",
          },
        },
      }),
      {},
    ],
    [
      "不合格のまま進めた記録",
      baseTask({
        lastReview: {
          passed: false,
          viewpoints: [{ viewpointId: "D-1", verified: false, reason: "違う" }],
          remarks: [],
          summary: "エラーの文言が違う",
          agentId: "claude",
          runId: "r1",
          costUsd: 0,
          estimated: false,
          at: "2026-10-24T10:00:00.000Z",
        },
        verificationOverride: { at: "2026-10-27T00:00:00Z", submission: 1 },
      }),
      {},
    ],
  ];

  it.each(cases)("%s：説明に内部の語・観点の番号・指摘の ID が無い", (name, t, stage) => {
    for (const body of implementBodies(t, stage)) {
      const text = visible(body);
      for (const word of [...INTERNAL_WORDS, "D-1", "implement-1-1", ID]) {
        expect(text, `${name}：${word}`).not.toContain(word);
      }
      if (name === "不合格のまま進めた記録") {
        expect(text).toContain("最終レビューの所見：エラーの文言が違う");
      }
    }
  });
});

describe("エージェントが文の中に書いた指摘の ID を、文を壊さずに除く（TV-4）", () => {
  const whole = [
    "直しました（implement-1-1・implement-1-2 への対応）。",
    "指摘 implement-1-3 を直しました。",
    "implement-1-1 と implement-1-2 を直しました。",
    "implement-1-4〜1-6 は直しました。",
    "design-1-2 の件で、エラーの文言を変えました。",
  ].join("\n");
  const t = reworked(
    whole,
    "implement-1-1 と implement-1-2 を直しました。\n指摘 design-1-2 を見直しました。",
  );

  it("決まった形・テンプレートのどちらの説明にも、整えた文があり、ID・壊れた文が無い", () => {
    for (const body of implementBodies(t)) {
      const text = visible(body);
      expect(text).toContain("直しました。");
      expect(text.match(/指摘を直しました。/g)?.length).toBeGreaterThanOrEqual(2);
      expect(text).toContain("指摘は直しました。");
      expect(text).toContain("指摘の件で、エラーの文言を変えました。");
      expect(text).not.toMatch(/implement-1-|design-1-2|〜1-6/);
      expect(text).not.toContain("指摘 と 指摘");
      expect(text).not.toContain("（）");
      expect(text).not.toContain("()");
      expect(text).not.toMatch(/^は直しました。/m);
    }
  });
});

describe("説明に、タスクの ID の目印が1つだけある（TV-5）", () => {
  it("実装（テンプレートの有り無し）・要求要件・設計の説明のそれぞれに、目印がちょうど1回あり、ほかにタスクの ID が無い", () => {
    const impl = baseTask();
    const step = baseTask({ outputs: { design: "# 設計" } });
    const bodies = [
      ...implementBodies(impl),
      joinBodyText(buildStepPullRequestBodyText(step, "requirements", "docs/r.md")),
      (() => {
        const f = fillTemplate(
          TEMPLATE,
          buildStepPullRequestBodyParts(step, "design", "docs/d.md"),
        );
        return `${f.main}\n\n${f.footer}`;
      })(),
    ];
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(body.split(taskMarkerLine(ID))).toHaveLength(2);
      expect(body.replace(taskMarkerLine(ID), "")).not.toContain(ID);
      expect(body.trimEnd().endsWith(taskMarkerLine(ID))).toBe(true);
    }
  });
});

describe("最後の直しの各項目が、説明に1回だけ出る（TV-6）", () => {
  const bullets = Array.from(
    { length: 5 },
    (_, i) => `- 項目${i + 1}：${"直した内容の説明".repeat(6)}${i + 1}`,
  );

  it("字下げの無い箇条書きの5項目（240 文字を超える）は、各項目が1回で、結論に「最後の直し」の行が無い", () => {
    expect(bullets.join(" ").length).toBeGreaterThan(240);
    const t = reworked("予約のキャンセルを足しました。", bullets.join("\n"));
    for (const body of implementBodies(t)) {
      for (const item of bullets) expect(body.split(item.slice(2)).length - 1, item).toBe(1);
    }
    const body = plainBody(t);
    const conclusion = body.slice(
      body.indexOf("## 結論"),
      body.indexOf("\n## ", body.indexOf("## 結論") + 3),
    );
    expect(conclusion).not.toContain("最後の直し");
    expect(body).toContain("## 最後の直し");
  });

  it("1文だけの直しは、結論にだけ1回出て、「## 最後の直し」の節が無い", () => {
    const fix = "文言を直しました。";
    const body = plainBody(reworked("予約のキャンセルを足しました。", fix));
    expect(body.split(fix)).toHaveLength(2);
    expect(body).toContain(`- 最後の直し：${fix}`);
    expect(body).not.toContain("## 最後の直し");
  });
});

describe("確かめ方（TV-7・TV-8）", () => {
  it("TV-7：観点が依頼の1行だけなら、観点の表と詳細を出さず、テストは件数とファイルだけにする", () => {
    const t = baseTask({
      testMap: [
        {
          viewpointId: "REQ",
          tests: ["a.test.ts › 名前1", "a.test.ts › 名前2", "b.test.ts › 名前3"],
        },
      ],
    });
    for (const body of implementBodies(t)) {
      expect(body).not.toContain("| 観点 |");
      expect(body).not.toContain("観点ごとの詳細");
      expect(body).toContain("テスト：3 件（`a.test.ts`・`b.test.ts`）");
      for (const name of ["名前1", "名前2", "名前3"]) expect(body).not.toContain(name);
    }
    expect(plainBody(t)).toContain("## 確かめ方");
  });

  it("TV-8：設計の観点の表でも、テストの名前の全文を並べず、「3 件（ファイル）」の形にする", () => {
    const t = baseTask({
      steps: [
        { key: "design", state: "done" },
        { key: "implement", state: "active" },
      ],
      approved: {
        design: {
          output: "# 設計",
          submission: 1,
          at: "2026-11-01T00:00:00Z",
          testViewpoints: [
            { id: "TV-1", title: "キャンセルできる", input: "入力", expected: "期待" },
          ],
        },
      },
      testMap: [
        {
          viewpointId: "TV-1",
          tests: ["a.test.ts › 名前1", "a.test.ts › 名前2", "a.test.ts › 名前3"],
        },
      ],
    });
    for (const body of implementBodies(t)) {
      expect(body).toContain("| TV-1 キャンセルできる | 3 件（`a.test.ts`） |");
      expect(body).toContain("テスト：3 件（`a.test.ts`）");
      for (const name of ["名前1", "名前2", "名前3"]) expect(body).not.toContain(name);
    }
    expect(plainBody(t)).toContain("## 確かめ方");
  });
});

describe("実装の説明に、判断に要る情報と承認の案内の2文がある（TV-9）", () => {
  it("変更の要約・確かめ方・人が確かめること・AI が作った印・承認の2文が、決まった形・テンプレートの両方にある", () => {
    const t = baseTask({
      testMap: [{ viewpointId: "REQ", tests: ["a.test.ts › x"] }],
      lastReview: {
        passed: true,
        viewpoints: [],
        remarks: [],
        summary: "合格",
        humanChecks: ["実機の画面で確かめる"],
        agentId: "claude",
        runId: "r1",
        costUsd: 0,
        estimated: false,
        at: "2026-10-24T10:00:00.000Z",
      },
    });
    const bodies = implementBodies(t);
    expect(bodies[0]).toContain("- 変更：予約のキャンセルを足しました。");
    expect(bodies[1]).toContain("予約のキャンセルを足しました。");
    for (const body of bodies) {
      expect(body).toContain("テスト：1 件（`a.test.ts`）");
      expect(body).toContain("- [ ] 実機の画面で確かめる");
      expect(body).toContain("この PR は Sacty が作成しました。");
      expect(body).toContain(
        "この PR をマージすると（PR の中で直してからでも）、実装を承認したことになります。",
      );
      expect(body).toContain("直してほしい所は、この PR にコメントかレビューで書いてください。");
    }
  });
});

describe("要求要件・設計の PR の説明（TV-10〜TV-13）", () => {
  const QUESTIONS = [
    "## 確認したいこと",
    "### must",
    "なし",
    "### should",
    "- エラーを日本語にするか（推奨：する）",
  ].join("\n");
  const stepTask = (extra: Record<string, unknown> = {}) =>
    baseTask({
      steps: [
        { key: "design", state: "active" },
        { key: "implement", state: "todo" },
      ],
      outputs: { design: `# 設計\n\n${QUESTIONS}` },
      remarks: [
        {
          id: "design-1-1",
          step: "design",
          round: 1,
          text: "エラーの文言が分かりにくい。詳しい全文の段落。",
          gist: "エラーの文言を直す",
          response: "文言を直した（design-1-1 への対応）",
          status: "addressed",
          voided: false,
        },
      ],
      ...extra,
    });
  const both = (t: Task, step: "requirements" | "design" = "design", secrets?: string[]) => {
    const text = joinBodyText(
      buildStepPullRequestBodyText(t, step, "docs/d.md", undefined, secrets),
    );
    const f = fillTemplate(
      TEMPLATE,
      buildStepPullRequestBodyParts(t, step, "docs/d.md", undefined, secrets),
    );
    return [text, `${f.main}\n\n${f.footer}`];
  };

  it("TV-10：確認したいこと・指摘の要点と対応・AI が作った印・承認の2文があり、目印の外にタスクの ID と指摘の ID が無い", () => {
    for (const body of both(stepTask())) {
      expect(body).toContain("エラーを日本語にするか");
      expect(body).toContain("- エラーの文言を直す");
      expect(body).toContain("  - 対応：文言を直した");
      expect(body).toContain("この PR は Sacty が作成しました。");
      expect(body).toContain(
        "この PR をマージすると（PR の中で直してからでも）、設計を承認したことになります。",
      );
      expect(body).toContain("直してほしい所は、この PR にコメントかレビューで書いてください。");
      const text = visible(body);
      expect(text).not.toContain(ID);
      expect(text).not.toContain("design-1-1");
      expect(text).not.toContain("工程");
    }
  });

  it("TV-11：Sacty のレビューの本文・行へのコメントの写しが、説明に出ない", () => {
    const text = [
      "<!-- sacty-review:8d31baff-06c8-432e-bb8e-28582013b0d8 -->",
      "## Sacty のレビュー",
      "## 総評",
      "全体としては良い。",
      "## 指摘",
      "1. [提案] 文言が分かりにくい",
      "観点ごとの担当（サブエージェント）を 7 件起動しました。",
      "（コメントが付いた行の内容：「- 文言」。直前の行：「空行」）",
    ].join("\n");
    const t = stepTask({
      remarks: [
        {
          id: "design-1-1",
          step: "design",
          round: 1,
          text,
          gist: "エラーの文言を直す",
          source: "sacty_review",
          response: "直した",
          status: "addressed",
          voided: false,
        },
      ],
    });
    for (const body of both(t)) {
      for (const leaked of [
        "sacty-review",
        "## Sacty のレビュー",
        "## 総評",
        "サブエージェント",
        "コメントが付いた行の内容",
      ]) {
        expect(body, leaked).not.toContain(leaked);
      }
      expect(body).not.toMatch(/^## 指摘$/m);
      expect(body).toContain("- エラーの文言を直す");
      expect(body).toContain("  - 対応：直した");
    }
  });

  it("TV-12：確かめる所に、確かめる項目の件数・出典の数え方・サブエージェントが出ず、推論の項目の ID の行はある", () => {
    const items = [
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `R-${i + 1}`,
        kind: "input",
        refs: [],
        excerpt: "x",
        found: true,
      })),
      ...Array.from({ length: 14 }, (_, i) => ({
        id: `R-${i + 4}`,
        kind: "derived",
        refs: [],
        excerpt: "",
      })),
      { id: "R-18", kind: "inference", refs: [], excerpt: "" },
    ];
    const t = stepTask({
      provenances: { design: { items, unclassified: [], sequential: true } },
    });
    for (const body of both(t)) {
      const at = body.indexOf("確かめる所");
      expect(at).toBeGreaterThanOrEqual(0);
      const section = body.slice(at);
      for (const leaked of ["確かめる項目：", "引用 3", "導出 14", "推論 1", "サブエージェント"]) {
        expect(section, leaked).not.toContain(leaked);
      }
      expect(section).toContain("- R-18：推論");
    }
  });

  it("TV-13：要点の記録が無い古い指摘の対応は、「- 対応：」だけを出し、指摘の全文を写さない", () => {
    const t = stepTask({
      remarks: [
        {
          id: "design-1-1",
          step: "design",
          round: 1,
          text: "古い記録の指摘の全文の文。",
          response: "直した",
          status: "addressed",
          voided: false,
        },
      ],
    });
    for (const body of both(t)) {
      expect(body).toContain("- 対応：直した");
      expect(body).not.toContain("古い記録の指摘の全文の文");
      expect(body).not.toContain("\n  - 対応：直した");
    }
  });

  it("TV-14（説明）：要点の秘密の値・内部のパス・@・改行・行頭の #・指摘の ID・長さを整えて出す", () => {
    const secret = "sk-secret-value-1234567890";
    const gist = `# 見出しにならない ${secret} と /sacty-input/a.md を @someone へ\n（implement-1-1 への対応）${"あ".repeat(200)}`;
    const t = stepTask({
      remarks: [
        {
          id: "design-1-1",
          step: "design",
          round: 1,
          text: "全文",
          gist,
          response: "直した",
          status: "addressed",
          voided: false,
        },
      ],
    });
    for (const body of both(t, "design", [secret])) {
      const line =
        body.split("\n").find((l) => l.startsWith("- ") && l.includes("見出しにならない")) ?? "";
      expect(line).not.toBe("");
      expect(line).not.toContain(secret);
      expect(line).not.toContain("/sacty-input");
      expect(line).not.toContain("@someone");
      expect(line).not.toContain("implement-1-1");
      expect(line).not.toContain("（）");
      expect(line.startsWith("- \\#")).toBe(true);
      // 逃がしの `\` を除いた長さが、指摘を示す1行の上限（… を含む 120 文字）以内
      expect(line.slice(2).replace(/\\(.)/g, "$1").length).toBeLessThanOrEqual(120);
      expect(body).not.toMatch(/^#見出しにならない/m);
    }
  });
});

describe("sacty-responses の要点（gist）を取り込む（TV-14・TV-29）", () => {
  it("TV-14：gist の改行・前後の空白を除き、120 文字（末尾の … を含む）で切って記録する。要点が無ければ gist を持たない", () => {
    const long = `${"あ".repeat(200)}`;
    const answer = [
      "説明。",
      "```json",
      JSON.stringify({
        "sacty-responses": [
          { remarkId: "design-1-1", text: "直した", gist: `  一行目\n二行目\n${long}  ` },
          { remarkId: "design-1-2", text: "直した" },
        ],
      }),
      "```",
    ].join("\n");
    const read = extractBlocks(answer, new Set(["design-1-1", "design-1-2"]));
    const [first, second] = read.responses ?? [];
    expect(first?.gist).not.toContain("\n");
    expect(first?.gist?.startsWith("一行目 二行目")).toBe(true);
    expect(first?.gist?.length).toBe(120);
    expect(first?.gist?.endsWith("…")).toBe(true);
    expect(second?.gist).toBeUndefined();
  });
});

describe("人が直した説明の更新（TV-25〜TV-27）", () => {
  const generatedOf = (t: Task) => joinBodyText(buildPullRequestBodyText(t));
  const OLD_VISIBLE = `Sacty のタスク「予約をキャンセルできるようにする」の成果物です（sacty task ${ID}）。`;

  it("TV-25：以前の版の説明（可視のタスク ID の行あり）を人が直した後の更新で、可視の行を残さず、人の補足と目印1つを残す", async () => {
    const t = baseTask({
      outputs: { implement: "予約のキャンセルを足しました。\n\n詳しい説明の段落です。" },
    });
    const generated = generatedOf(t);
    const oldBase = `${OLD_VISIBLE}\n\n${generated.replace(taskMarkerLine(ID), "")}\nこの PR は Sacty が作成しました（sacty task ${ID}）。`;
    const human = oldBase.replace(
      "詳しい説明の段落です。",
      "詳しい説明の段落です。\n\n人が足した補足",
    );
    const merged = await mergePullRequestBody({ base: oldBase, human, generated });
    const text = withTaskMarker(merged.text, ID, oldBase);
    expect(text).toContain("人が足した補足");
    expect(text).not.toContain(OLD_VISIBLE);
    expect(text.replace(taskMarkerLine(ID), "")).not.toContain(`sacty task ${ID}`);
    expect(text.split(taskMarkerLine(ID))).toHaveLength(2);
  });

  it("TV-26：新しい形の説明に、人が補足を足し見出しの言い回しを直しても、人の直しと今回の更新の中身が残る", async () => {
    const before = baseTask({ outputs: { implement: "予約のキャンセルを足しました。" } });
    const after = baseTask({
      outputs: { implement: "予約のキャンセルと一覧の表示を足しました。" },
    });
    const base = generatedOf(before);
    const human =
      `${base.replace("## 確かめ方", "## 確かめ方（人が直した見出し）")}\n\n人の補足`.replace(
        `\n\n人の補足`,
        "\n\n人の補足",
      );
    const generated = generatedOf(after);
    const merged = await mergePullRequestBody({ base, human, generated });
    const text = withTaskMarker(merged.text, ID, base);
    expect(merged.conflicts).toBe(0);
    expect(text).toContain("人の補足");
    expect(text).toContain("## 確かめ方（人が直した見出し）");
    expect(text).toContain("予約のキャンセルと一覧の表示を足しました。");
    expect(text.split(taskMarkerLine(ID))).toHaveLength(2);
  });

  it.each([
    ["消した", (body: string) => body.replace(taskMarkerLine(ID), "")],
    [
      "別の ID に書き換えた",
      (body: string) => body.replace(ID, "00000000-0000-4000-8000-000000000000"),
    ],
  ])("TV-27：人が目印を%s説明の更新で、正しい目印を1つだけ置く", async (_name, edit) => {
    const before = baseTask({ outputs: { implement: "予約のキャンセルを足しました。" } });
    const after = baseTask({
      outputs: { implement: "予約のキャンセルと一覧の表示を足しました。" },
    });
    const base = generatedOf(before);
    const human = `${edit(base)}\n\n人の補足`;
    const merged = await mergePullRequestBody({ base, human, generated: generatedOf(after) });
    const text = withTaskMarker(merged.text, ID, base);
    expect(text.split(taskMarkerLine(ID))).toHaveLength(2);
    expect(text.match(/<!-- sacty task [^>]*-->/g)).toEqual([taskMarkerLine(ID)]);
    expect(text).toContain("人の補足");
    expect(text).toContain("一覧の表示");
  });
});
