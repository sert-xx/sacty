import { type DaemonText, message, renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  explainUnreadableAnswer,
  headedObject,
  jsonCandidates,
  type LenientShape,
  lastJsonAnswer,
  lastLenientJsonAnswer,
  safeNear,
  withoutCandidates,
} from "./agent-json.js";
import {
  extractBlocks,
  extractExport,
  extractIntegrationReview,
  extractReproduction,
  extractReviewComments,
  extractRework,
  extractSplitPlan,
  extractStepPlan,
  extractTicketTriage,
} from "./prompts.js";

/**
 * JSON の読み取りを確かめるための、判定の形の答えの読み取り（以前の版の変更の申し出の判定と同じ形。PBI-333 で、本体からは
 * 消した）。読めなければ判定できなかったものとする。
 */
function extractVerdict(output: string): { verdict: string; reason: DaemonText } {
  const found = lastJsonAnswer(output, (value) => {
    const v = headedObject(value, "sacty-verdict") ?? {};
    const verdict = ["approved", "rejected", "undecidable"].find((x) => x === v.verdict);
    const reason = typeof v.reason === "string" ? v.reason.trim() : "";
    return verdict && reason ? { verdict, reason } : undefined;
  });
  return found?.value ?? { verdict: "undecidable", reason: message("guardian.verdictUnreadable") };
}

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
    name: "判定の形の答え",
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
    name: "PR の指摘の戻し先と原因の判断（PBI-268）",
    json: { "sacty-rework": { target: "implement", cause: "base_changed", reason: "競合" } },
    check: (o) =>
      expect(extractRework(o, ["design", "implement"])).toEqual({
        target: "implement",
        cause: "base_changed",
        reason: "競合",
      }),
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

  it("判定のブロックの rework から、指摘ごとの戻し先と原因を読む。知らない値は無いものにする（PBI-332）", () => {
    const verdict = (rework: unknown) =>
      extractReviewComments(
        `本文\n\n${JSON.stringify({ "sacty-review-verdict": { verdict: "changes_required", rework } })}`,
        diff,
      ).rework;
    expect(
      verdict({
        findings: [
          { finding: "上限を変える", target: "requirements", reason: "決定を変える" },
          { finding: "誤字", target: "undecidable", reason: "不明" },
          { finding: "形", target: 3, reason: "" },
          "文字列",
        ],
        cause: "guardian_missed",
      }),
    ).toEqual({
      findings: [
        { finding: "上限を変える", target: "requirements", reason: "決定を変える" },
        { finding: "誤字", reason: "不明" },
        { finding: "形", reason: "" },
      ],
      cause: "guardian_missed",
    });
    expect(verdict({ findings: "x", cause: "unknown" })).toEqual({ findings: [] });
    expect(verdict(["x"])).toBeUndefined();
    expect(verdict(undefined)).toBeUndefined();
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
    const n = 32_000;
    for (const prose of [
      "if (x) { 続く説明 ".repeat(20_000),
      `${"{".repeat(20_000)}${"}".repeat(20_000)}`,
      "[{ 説明 ".repeat(20_000),
      // 深い入れ子の末尾近くが壊れている（PBI-72 レビュー指摘。重なる範囲を読み直すと、出力の長さの2乗の時間）
      `${'{"a":'.repeat(n)}INVALID${"}".repeat(n)}`,
      `${'{"a":['.repeat(n)}INVALID${"]}".repeat(n)}`,
      // 正しい深い入れ子
      `${'{"a":'.repeat(n)}1${"}".repeat(n)}`,
      // 候補が多い（1行に並ぶ・囲みの中・取り除く範囲が多い）
      "{}".repeat(n),
      '{"a":1} '.repeat(n),
      "```\n{}\n```\n".repeat(n / 4),
      // 文字列の中の括弧・読み始めの位置で文字列の内外が入れ替わる・閉じない長い文字列
      `"${"{".repeat(n)}"`,
      '{"a":"{"'.repeat(n),
      `{"a":"${"x".repeat(n * 6)}`,
    ]) {
      const output = `${prose}\n${answer}`;
      const started = performance.now();
      expect(extractVerdict(output)).toEqual({ verdict: "approved", reason: "ok" });
      expect(withoutCandidates(output, jsonCandidates(output))).not.toContain("sacty-");
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it("壊れた外側の JSON の中にある、正しい答えを読む", () => {
    const inner = '{"sacty-verdict": {"verdict": "approved", "reason": "中"}}';
    expect(extractVerdict(`{"x": ${inner}, INVALID}`)).toEqual({
      verdict: "approved",
      reason: "中",
    });
    expect(extractVerdict(`${'{"a":'.repeat(1000)}${inner} INVALID`)).toEqual({
      verdict: "approved",
      reason: "中",
    });
  });

  it("JSON として読めるかの判断は、JSON.parse と同じ", () => {
    // 決まった種から、JSON らしい断片を並べた文字列を作り、JSON.parse と比べる
    let seed = 72;
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    const pieces = [
      "{",
      "}",
      "[",
      "]",
      ":",
      ",",
      " ",
      "\n",
      '"a"',
      '"',
      "\\",
      '\\"',
      "\\n",
      "\\u00e9",
      "\\u12",
      "\\x",
      "1",
      "-",
      "0",
      "01",
      "1.5",
      "1.",
      "1e3",
      "-0.1E+2",
      "true",
      "fals",
      "null",
      "x",
      "\t",
      "\u0001",
      "```",
    ];
    const valid = [
      '{"a": [1, -0.5e+2, true, false, null, {"b": "\\u00e9\\n\\"x\\""}], "c": {}}',
      '{"sacty-steps": {"plan": "bugfix", "reason": "```json {x} [y]"}, "d": [[], [{}]]}',
    ];
    let accepted = 0;
    for (let n = 0; n < 20_000; n++) {
      // ランダムな断片・正しい JSON・正しい JSON の1文字を入れ替えたり削ったりしたもの
      const base = valid[random(valid.length)] ?? "{}";
      const at = random(base.length);
      const piece = random(2) === 0 ? (pieces[random(pieces.length)] ?? "") : "";
      const text =
        n % 2 === 0
          ? `{${Array.from({ length: 1 + random(12) }, () => pieces[random(pieces.length)]).join("")}`
          : n % 4 === 1
            ? base
            : `${base.slice(0, at)}${piece}${base.slice(at + 1)}`;
      let parsed = false;
      try {
        const value: unknown = JSON.parse(text);
        parsed = !!value && typeof value === "object" && !Array.isArray(value);
      } catch {
        parsed = false;
      }
      const length = text.replace(/[ \t\n\r]+$/, "").length;
      const whole = jsonCandidates(text).some((c) => c.start === 0 && c.end === length);
      expect({ text, whole }).toEqual({ text, whole: parsed });
      if (parsed) accepted++;
    }
    // 読める・読めないの両方を試している
    expect(accepted).toBeGreaterThan(5_000);
    expect(accepted).toBeLessThan(15_000);
  });
});

describe("崩れた JSON の寛容な読み取り（PBI-293）", () => {
  const read = (output: string) => lastLenientJsonAnswer(output, "h", (v) => v)?.value;

  it("文字列の中の引用符・改行・JSON にないエスケープ・末尾のカンマを直して読む", () => {
    expect(read('{"h": {"a": "x "y" z", "b": ["p "q" r", "s"], "c": 1,}}')).toEqual({
      h: { a: 'x "y" z', b: ['p "q" r', "s"], c: 1 },
    });
    expect(read('{"h": {"a": "1行目\n2行目\t\\d+ \\u3042"}}')).toEqual({
      h: { a: "1行目\n2行目\t\\d+ あ" },
    });
  });

  it("正しい JSON は、そのまま読む。空のオブジェクト・配列も", () => {
    expect(
      read('前置き\n```json\n{"h": {"a": [], "b": {}, "c": null, "d": true, "e": -1.5e2}}\n```'),
    ).toEqual({
      h: { a: [], b: {}, c: null, d: true, e: -150 },
    });
  });

  it("引用符のあとにカンマと次のキーが続く文字列は、そこで閉じる", () => {
    expect(read('{"h": {"a": "x", "b": "y"}}')).toEqual({ h: { a: "x", b: "y" } });
    expect(read('{"h": {"a": "x"\n}}')).toEqual({ h: { a: "x" } });
  });

  it("最後の答えを選ぶ。見出しの無い JSON・読めないものだけなら undefined", () => {
    expect(read('{"h": {"n": 1}}\n{"h": {"n": "a "b" c"}}')).toEqual({ h: { n: 'a "b" c' } });
    expect(read('{"x": {"a": "b "c" d"}}')).toBeUndefined();
    expect(read('{"h": {"a": "閉じない')).toBeUndefined();
  });

  it("深すぎる入れ子・長い出力でも止まらず、時間が出力の長さに比例する", () => {
    expect(read(`{"h": ${"[".repeat(500)}"a "b" c"${"]".repeat(500)}}`)).toBeUndefined();
    const body = "あ ".repeat(200_000);
    const started = Date.now();
    expect(read(`{"h": {"a": "${body} "x" ${body}"}}`)).toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("閉じない文字列と見出しが繰り返される出力でも、時間が出力の長さに比例する", () => {
    // 候補ごとに末尾まで読み直すと、出力の長さの2乗の時間がかかる（136,000 文字で数秒）
    const output = '{"h": {"a": "'.repeat(10_000);
    const started = Date.now();
    expect(read(output)).toBeUndefined();
    expect(explainUnreadableAnswer(output, "h").kind).toBe("broken");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("桁は JSON の行の頭から数える：同じ行の前置きの長さを足さない", () => {
    expect(explainUnreadableAnswer('{\n"h": {"a": [1 2]}}', "h")).toMatchObject({
      line: 2,
      column: 15,
    });
    const plain = explainUnreadableAnswer('{"h": {"a": [1 2]}}', "h");
    expect(explainUnreadableAnswer('結果: {"h": {"a": [1 2]}}', "h")).toEqual(plain);
  });

  it("読めなかった理由：JSON が無い・壊れている位置・形", () => {
    expect(explainUnreadableAnswer("なし", "h")).toEqual({ kind: "missing" });
    expect(explainUnreadableAnswer('{"h": {"a": 1}}', "h")).toEqual({ kind: "shape" });
    expect(explainUnreadableAnswer('{\n"h": {\n  "a": [1 2]}}', "h")).toEqual({
      kind: "broken",
      line: 3,
      column: 11,
      near: '{ "h": { "a": [1 2]}}',
    });
  });
});

describe("入れ子のオブジェクトの閉じ括弧の欠けを補って読む（PBI-298）", () => {
  // 最終レビューと同じ形：見出し h のオブジェクトの項目 a・t・b・s と、入れ子のオブジェクト t（項目 x・y）
  const shape: LenientShape = {
    heading: "h",
    keys: ["a", "t", "b", "s"],
    objects: { t: ["x", "y"] },
  };
  // 実際の呼び出しと同じに、見出しのオブジェクトを持つ答えだけを採る
  const head = (v: Record<string, unknown>) => (headedObject(v, "h") ? v : undefined);
  const read = (output: string) => lastLenientJsonAnswer(output, "h", head, shape);

  it("入れ子のオブジェクトの中に見出しのオブジェクトの項目が現れたら、「}」を補って、その項目を外に出す", () => {
    const found = read('{"h":{"a":[1],"t":{"x":0,"y":[],"b":["p"],"s":"end"}}');
    expect(found?.value).toEqual({ h: { a: [1], t: { x: 0, y: [] }, b: ["p"], s: "end" } });
    expect(found?.repairs).toEqual([{ kind: "brace", line: 1, column: 33, key: "b" }]);
  });

  it("入れ子のオブジェクトが空のときも補う。補った「}」の位置は、行と桁で分かる", () => {
    const found = read('{"h":{"a":[],\n"t":{\n  "b":[],"s":"end"}}');
    expect(found?.value).toEqual({ h: { a: [], t: {}, b: [], s: "end" } });
    expect(found?.repairs).toEqual([{ kind: "brace", line: 3, column: 3, key: "b" }]);
  });

  it("正しい JSON は、補わずにそのまま読む（repairs は空）", () => {
    const found = read('```json\n{"h":{"a":[],"t":{"x":0,"y":[]},"b":[],"s":"end"}}\n```');
    expect(found?.value).toEqual({ h: { a: [], t: { x: 0, y: [] }, b: [], s: "end" } });
    expect(found?.repairs).toEqual([]);
    // 入れ子のオブジェクトが最後のキーでも、入れ子の外のキーが無くても、補わない
    expect(read('{"h":{"a":[],"t":{"x":0}}}')?.repairs).toEqual([]);
  });

  it("文字列の中の引用符の崩れと、閉じ括弧の欠けが重なっても読む。種類ごとに位置が分かる", () => {
    const found = read('{"h":{"a":[],"t":{"x":"v "q" w","y":[]},"s":"end"}}');
    expect(found?.value).toEqual({ h: { a: [], t: { x: 'v "q" w', y: [] }, s: "end" } });
    expect(found?.repairs.map((r) => r.kind)).toEqual(["quote", "quote"]);
    const both = read('{"h":{"a":[],"t":{"x":"v "q" w","y":[],"s":"end"}}');
    expect(both?.value).toEqual({ h: { a: [], t: { x: 'v "q" w', y: [] }, s: "end" } });
    expect(both?.repairs.map((r) => r.kind)).toEqual(["quote", "quote", "brace"]);
  });

  it("入れ子のオブジェクトに属する項目しか現れなければ、補わない（括弧の数が合わなくても推測しない）", () => {
    // 「}」が1つ足りないが、どこで閉じるか決まらない（入れ子の外の項目が無い）
    expect(read('{"h":{"a":[],"t":{"x":0,"y":[]}')).toBeUndefined();
    expect(explainUnreadableAnswer('{"h":{"a":[],"t":{"x":0,"y":[]}', "h", shape).kind).toBe(
      "broken",
    );
  });

  it("直し方が決まらないときは読まない：見出しのオブジェクトが同じ項目を既に持つ・補ったあとに入れ子の項目が現れる", () => {
    // b が、入れ子の外にも既にある（どちらが本物か決まらない）
    expect(read('{"h":{"a":[],"b":["外"],"t":{"x":0,"b":["中"],"s":"end"}}')).toBeUndefined();
    // 補ったあとの見出しのオブジェクトに、入れ子の項目 y が現れる（入れ子をどこで閉じるか決まらない）
    expect(read('{"h":{"a":[],"t":{"x":0,"b":[],"y":[],"s":"end"}}')).toBeUndefined();
    expect(explainUnreadableAnswer('{"h":{"a":[],"t":{"x":0,"b":[],"y":[]}}', "h", shape)).toEqual(
      expect.objectContaining({ kind: "broken", line: 1 }),
    );
  });

  it("入れ子のオブジェクトが見出しのオブジェクトの項目でないとき・形が無いときは、補わない", () => {
    // t が配列の要素の中にあるオブジェクトのとき（見出しのオブジェクトの直下の t ではない）
    expect(read('{"h":{"a":[{"t":{"x":0,"b":[]}],"s":"end"}}')).toBeUndefined();
    // shape を渡さなければ、補わない（監査など）
    expect(
      lastLenientJsonAnswer('{"h":{"a":[],"t":{"x":0,"b":[],"s":"end"}}', "h", head),
    ).toBeUndefined();
  });

  it("read が形を認めなければ、直した結果を読まない。直さずに読めたものには、repairs は空で渡る", () => {
    const seen: number[] = [];
    const answer = lastLenientJsonAnswer(
      '{"h":{"a":[],"t":{"x":0,"b":[],"s":"end"}}',
      "h",
      (v, repairs) => {
        seen.push(repairs.length);
        return repairs.length > 0 ? undefined : head(v);
      },
      shape,
    );
    expect(answer).toBeUndefined();
    // 直さずに読めるかの確かめ（repairs は空）のあとに、直して読んだ（repairs は1件）ものを渡している
    expect(seen).toEqual([0, 1]);
  });

  it("直した箇所の行と桁は、箇所の数によらず1回の走査で求める（順序・改行をまたぐ位置も正しい）", () => {
    const found = read('{"h":{"a":["x\ny","p\nq\nr"],\n"t":{"x":"u\nv","b":[],"s":"end"}}');
    expect(found?.repairs).toEqual([
      { kind: "control", line: 1, column: 14 },
      { kind: "control", line: 2, column: 6 },
      { kind: "control", line: 3, column: 2 },
      { kind: "control", line: 5, column: 12 },
      { kind: "brace", line: 6, column: 4, key: "b" },
    ]);
  });

  it("本文から取り除く範囲は、囲みの行を含む", () => {
    const around = (json: string) => `説明\n\`\`\`json\n${json}\n\`\`\`\n後ろ`;
    const broken = around('{"h":{"a":[],"t":{"x":0,"b":[],"s":"end"}}');
    const found = read(broken);
    expect(found?.repairs).toHaveLength(1);
    const range = found?.candidate;
    // 正しい JSON のときと同じ範囲を取り除く
    const strict = read(around('{"h":{"a":[],"t":{"x":0},"b":[],"s":"end"}}'));
    expect(strict?.repairs).toEqual([]);
    const text = (o: string, c?: { start: number; end: number }) =>
      c ? withoutCandidates(o, [c]) : undefined;
    expect(text(broken, range)).toBe(
      text(around('{"h":{"a":[],"t":{"x":0},"b":[],"s":"end"}}'), strict?.candidate),
    );
    expect(text(broken, range)).not.toContain("json");
  });

  it("壊れた所の前後は、出力に秘密情報があれば残さず、伏せる関数が無ければ残さない", () => {
    const hide = (t: string) => t.replaceAll("sk-secret", "[REDACTED]");
    expect(safeNear("a", "x y", hide)).toBe("x y");
    expect(safeNear("a", "x y", undefined)).toBe("");
    // エスケープされた秘密情報（"sk-sec\u0072et" の形）が出力のどこかにあれば、残さない
    expect(safeNear('{"k":"sk-sec\\u0072et"}', "x y", hide)).toBe("");
    expect(safeNear("sk-secret", "x y", hide)).toBe("");
  });
});
