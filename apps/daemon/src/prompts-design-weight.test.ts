import type { StepKey, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  buildPullRequestBodyText,
  buildReworkPrompt,
  designEditRemarkIds,
  extractBlocks,
} from "./prompts.js";

/*
 * 実装の PR の指摘の戻し先を、決定の重さ（方針の変更か、局所の変更か）で分ける基準（PBI-446）の指示。
 * 実装の PR だけが、重さで分ける基準を持つ。要求要件・設計の PR の基準は変えない。
 */

const DESIGN = "# 設計\n\n## エラー表\n\n- 決済失敗：「決済に失敗しました」";
const VIEWPOINTS = [
  { id: "TV-1", title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回だけ" },
];
const REMARK = {
  id: "implement-1-1",
  step: "implement",
  round: 1,
  text: "エラー表の文言を直してください",
};

const taskOf = (extra: Record<string, unknown> = {}): Task =>
  ({
    id: "t1",
    title: "決済API",
    body: "本文",
    steps: [
      { key: "requirements", state: "done" },
      { key: "design", state: "done" },
      { key: "implement", state: "active" },
    ],
    approved: {
      requirements: { output: "# 承認済みの要求要件" },
      design: { output: DESIGN, testViewpoints: VIEWPOINTS, at: "2026-11-21T00:00:00.000Z" },
    },
    outputs: { design: DESIGN },
    testViewpoints: VIEWPOINTS,
    remarks: [REMARK],
    submissions: { implement: 1 },
    stepPullRequests: [],
    exports: {},
    testMap: [],
    reviews: [],
    ...extra,
  }) as unknown as Task;

const judged = {
  target: "implement",
  decided: true,
  reason: "決定を変える（局所）：エラー表の1行の文言",
  at: "2026-11-21T01:00:00.000Z",
  round: 1,
  remarkIds: ["implement-1-1"],
};

const TARGETS: StepKey[] = ["implement", "design", "requirements"];
const reviewTask = {
  id: "r1",
  title: "レビュー",
  body: "",
  steps: [{ key: "review", state: "active" }],
  approved: {},
  remarks: [],
  outputs: {},
  reviewTarget: {
    repo: "https://github.com/acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "t",
    body: "",
    headCommit: "h".repeat(40),
    baseCommit: "b".repeat(40),
    author: "alice",
  },
} as unknown as Task;
const review = (gateStep: StepKey, parent: Task) =>
  buildPrompt(reviewTask, "review", {
    diff: "diff",
    reviewRework: {
      gateStep,
      targets: gateStep === "implement" ? TARGETS : ["design", "requirements"],
      parent,
    },
  });

/** 実装の PR の基準の文（局所は実装、方針は設計と読める指示）。 */
const WEIGHT_LINES = [
  "方針の変更（方式・構成の選び直し、範囲・受け入れ条件の変更、外に公開するインターフェースや保存するデータの形の変更、セキュリティ・認可、移行など、取り返しにくい決定）だけ、design（設計）に戻します。",
  "局所の変更（文言、表や一覧の1行、既定値、行の追加など、ほかの決定に波及しない決定）は、implement（実装）で直します。",
  "局所の変更と方針の変更が1回の指摘に混ざるとき（1つでも方針の変更があるとき）は、全部を design に戻します。",
  "どちらとも言い切れないときは、implement に倒します。ただし、セキュリティ・認可・保存するデータの形・移行に触れる指摘は、迷えば design に戻します。",
  "テスト観点は、文言だけの変更（何を確かめるか＝入力・期待結果の中身を変えないもの）は implement で直します。入力・期待結果の中身を変える指摘、観点を足す・消す指摘は、design に戻します。",
  "人の指摘が、戻し先を明示しているとき（「設計に戻す」「実装の工程で直す」など）は、上の基準よりそれに従います（セキュリティ・認可・保存するデータの形・移行に触れる指摘でも同じです）。",
];
/** 要求要件・設計の PR の基準の文（起点と同じ）。 */
const BASELINE_LINES = [
  "戻し先は、指摘が承認済みの前の工程の決定（受け入れ条件・振る舞い・画面・API やデータの形・テスト観点・確認して決めたこと）を変えるかで決めてください。",
  "- 決定そのものを変える指摘（決まった振る舞い・画面・API やデータの形を別のものにする、決まっていないことを新しく決める、など）だけ、その決定を持つ工程に戻します。",
  "- 複数の指摘のうち1つでも決定を変えるなら、その決定を持つ工程に戻します（複数の工程にまたがるなら、前の工程）。",
  "理由の先頭に、指摘がどの決定を変えるか、または変えないかを短く書いてください",
];

describe("実装の PR：戻し先を決定の重さで分ける基準（PBI-446）", () => {
  it("工程のエージェントの戻し先の指示に、局所は実装・方針は設計と読める基準が入る（TV-1）", () => {
    const p = buildReworkPrompt(taskOf(), ["エラー表の文言を直してください"], TARGETS, "implement");
    for (const line of WEIGHT_LINES) expect(p).toContain(line);
    expect(p).toContain("- design（設計）：解消するには、承認済みの設計の方針の変更");
    // 理由に、変える（局所）／変える（方針）を書かせる例が入る
    expect(p).toContain("決定を変える（局所）：");
    expect(p).toContain("決定を変える（方針）：");
    expect(p).toContain(
      "決定を変えない／変える（局所）／変える（方針）：承認済みの○○の△△（判断の理由）",
    );
  });

  it("レビューの子タスクの指示にも、同じ基準が入り、候補 design の説明は方針の変更が要るものになる（TV-2）", () => {
    const p = review("implement", taskOf());
    for (const line of WEIGHT_LINES) expect(p).toContain(line);
    expect(p).toContain(
      "- design（設計）：解消するには、承認済みの設計の方針の変更が必要（局所の変更は、この PR の実装で直す）",
    );
    expect(p).toContain(
      "決定を変えない／変える（局所）／変える（方針）：承認済みの○○の△△（判断の理由）",
    );
  });

  it("承認済みの要求要件の決定を変える指摘を要求要件に戻す文は、今の文のまま入っている（TV-3）", () => {
    const worker = buildReworkPrompt(taskOf(), ["x"], TARGETS, "implement");
    const child = review("implement", taskOf());
    for (const p of [worker, child]) {
      for (const line of BASELINE_LINES.slice(0, 3)) expect(p).toContain(line);
      expect(p).toContain("承認済みの要求要件の決定を変える指摘は、上のとおり、要求要件に戻します");
    }
    expect(worker).toContain(
      "- requirements（要求要件）：解消するには、承認済みの要求要件の決定（受け入れ条件・範囲・確認して決めたこと）を変える必要がある",
    );
  });

  it("要求要件・設計の PR の基準は起点のまま変わらず、重さの文と人の明示に従う文は入らない（TV-4）", () => {
    for (const gate of ["design", "requirements"] as const) {
      const targets: StepKey[] = gate === "design" ? ["design", "requirements"] : ["requirements"];
      const prompts = [buildReworkPrompt(taskOf(), ["x"], targets, gate), review(gate, taskOf())];
      for (const p of prompts) {
        for (const line of BASELINE_LINES) expect(p).toContain(line);
        expect(p).toContain("決定を変えない／変える：承認済みの○○の△△（判断の理由）");
        for (const line of WEIGHT_LINES) expect(p).not.toContain(line);
        expect(p).not.toContain("変える（局所）");
        expect(p).not.toContain("局所の変更");
      }
    }
  });

  it("人の指摘が戻し先を明示していれば、セキュリティ等に触れる指摘でもそれに従う文が入る（TV-5）", () => {
    const p = buildReworkPrompt(taskOf(), ["設計に戻してください"], TARGETS, "implement");
    expect(p).toContain("「設計に戻す」「実装の工程で直す」など");
    expect(p).toContain("セキュリティ・認可・保存するデータの形・移行に触れる指摘でも同じです");
    expect(p).toContain("上の基準よりそれに従います");
  });

  describe("設計の直しの出し方（TV-6）", () => {
    const edit = (task: Task) => buildPrompt(task, "implement", { pullRequestReview: true });

    it("PR の指摘で実装に戻した回にだけ、sacty-design-edit の形・今回の指摘の ID・sensitive・方針は申し出で出す文が入る", () => {
      const p = edit(taskOf({ prRework: judged }));
      expect(designEditRemarkIds(taskOf({ prRework: judged }))).toEqual(["implement-1-1"]);
      expect(p).toContain("--- 承認済みの設計の局所の直し ---");
      expect(p).toContain('"sacty-design-edit"');
      expect(p).toContain('"viewpoint": "TV-n');
      expect(p).toContain('"field"');
      expect(p).toContain("implement-1-1");
      expect(p).toContain('"sensitive": true を付ける');
      expect(p).toContain("変更の申し出（sacty-change-proposal）で出す");
      // 承認済みの設計は作業領域に入れない（指示に入る）
      expect(p).toContain("承認済みの設計は、あなたの作業領域には無く、書き換えられません");
    });

    it("最初の実装・人が画面から差し戻した回・設計が承認済みでないタスクには入らない", () => {
      const first = taskOf({ prRework: undefined, remarks: [] });
      const screen = taskOf({ prRework: undefined });
      const noDesign = taskOf({
        prRework: judged,
        approved: { requirements: { output: "# 要求要件" } },
      });
      // 設計に戻す判断の回（実装の工程ではない）
      const toDesign = taskOf({ prRework: { ...judged, target: "design" } });
      for (const t of [first, screen, noDesign, toDesign]) {
        expect(designEditRemarkIds(t)).toEqual([]);
        expect(edit(t)).not.toContain("sacty-design-edit");
      }
    });

    it("選り分けで対応しないとした提案・無効にした指摘は、今回の指摘の ID に含めない", () => {
      const t = taskOf({
        prRework: { ...judged, remarkIds: ["implement-1-1", "implement-1-2", "implement-1-3"] },
        remarks: [
          REMARK,
          { ...REMARK, id: "implement-1-2", triaged: true },
          { ...REMARK, id: "implement-1-3", voided: true },
        ],
      });
      expect(designEditRemarkIds(t)).toEqual(["implement-1-1"]);
    });

    it("すでに提出に渡した回の指摘には、出し方を伝えない", () => {
      const t = taskOf({ prRework: judged, remarks: [{ ...REMARK, submittedIn: 2 }] });
      expect(designEditRemarkIds(t)).toEqual([]);
    });

    it("出力から、設計の直しのブロックを読み、本文から取り除く（読ませない回は、本文のまま残す）", () => {
      const block =
        '```json\n{"sacty-design-edit": {"edits": [{"remarks": ["implement-1-1"]}]}}\n```';
      const output = `# 実装の説明\n\n${block}`;
      const read = extractBlocks(output, new Set(["implement-1-1"]), [], { designEdit: true });
      expect(read.designEdit).toEqual({ value: { edits: [{ remarks: ["implement-1-1"] }] } });
      expect(read.output).toBe("# 実装の説明");
      const ignored = extractBlocks(output, new Set(["implement-1-1"]), []);
      expect(ignored.designEdit).toBeUndefined();
      expect(ignored.output).toContain("sacty-design-edit");
      const broken = extractBlocks(
        '# 説明\n\n```json\n{"sacty-design-edit": {"edits": [\n```',
        new Set(),
        [],
        {
          designEdit: true,
        },
      );
      expect(broken.designEdit).toEqual({ unreadable: true });
    });
  });

  it("変えないもの：cause の選択肢・変更の申し出の形・選り分けの扱いが、実装の PR の判断の指示に残る（TV-19）", () => {
    const p = buildReworkPrompt(taskOf(), ["x"], TARGETS, "implement");
    expect(p).toContain(
      '"cause": "guardian_missed または new_request または base_changed または undecidable"',
    );
    expect(p).toContain('"no_action": [対応を求めていない人間の指摘の番号]');
    const impl = buildPrompt(taskOf({ prRework: judged }), "implement", {
      pullRequestReview: true,
    });
    expect(impl).toContain(
      '{"sacty-change-proposal": {"target": "requirements" または "design", "reason": "変更したい理由", "facts": ["根拠となる事実（仕様、コード、実行結果など）"], "proposed": "変更後の成果物の全文"}}',
    );
    expect(impl).toContain("申し出は1回の実行で1件までです");
    const child = review("implement", taskOf());
    expect(child).toContain(
      "- guardian_missed：承認済みの要求要件・設計、リポジトリのコードやテストから、成果物を作るときに確かめられたはずの不備",
    );
    expect(child).toContain("- base_changed：ベースブランチが進んだこと");
  });
});

describe("実装の PR の本文の「設計の直し」（PBI-446）", () => {
  const body = (secrets: string[] = []) => {
    const task = taskOf({
      designEdits: [
        {
          runId: "r1",
          round: 2,
          at: "2026-11-21T02:00:00.000Z",
          applied: [
            {
              remarks: ["implement-1-1"],
              before: "「失敗しました」",
              after: "「@alice に連絡しました」 SECRET-VALUE-123 /sacty-input/x",
              reason: "文言を直す SECRET-VALUE-123",
            },
          ],
          rejected: [
            {
              remarks: ["implement-1-1"],
              viewpoint: "TV-1",
              field: "expected",
              before: "あ",
              after: "い @bob",
              reason: "理由",
              rejection: "秘密情報の値を含むため、反映しません（値は載せていません）。",
            },
          ],
          committed: false,
        },
      ],
    });
    const parts = buildPullRequestBodyText(task, { secrets });
    return `${parts.main}\n${parts.footer}`;
  };

  it("反映した直しと反映しなかった直しを、前・後・指摘・理由で載せる", () => {
    const text = body(["SECRET-VALUE-123"]);
    expect(text).toContain("## 設計の直し");
    expect(text).toContain("この PR のマージが、設計の直しの承認を兼ねます");
    expect(text).toContain("反映した直し（1 件）");
    expect(text).toContain("反映しなかった直し（1 件）");
    expect(text).toContain("指摘 implement-1-1（観点 TV-1の expected）");
    expect(text).toContain("    > 「失敗しました」");
  });

  it("秘密情報の値・内部のパスを残さず、@ の後に幅の無い空白を挟む", () => {
    const text = body(["SECRET-VALUE-123"]);
    expect(text).not.toContain("SECRET-VALUE-123");
    expect(text).not.toContain("/sacty-input");
    expect(text).toContain("@\u200balice");
    expect(text).toContain("@\u200bbob");
    expect(text).not.toContain("@alice");
  });

  it("直しの記録が無いタスクの本文には、節を出さない", () => {
    const parts = buildPullRequestBodyText(taskOf(), {});
    expect(parts.main).not.toContain("設計の直し");
  });
});
