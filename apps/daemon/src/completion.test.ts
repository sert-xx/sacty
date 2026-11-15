import { COMPLETION_REMAINING_ITEM_MAX, COMPLETION_REMAINING_MAX } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { DUPLICATE_KEYS_DEPTH_MAX, hasDuplicateKeys, takeFences } from "./agent-json.js";
import {
  COMPLETION_FENCE,
  completionBlock,
  extractCompletion,
  implementCompletionLines,
} from "./completion.js";
import { extractBlocks } from "./prompts.js";

/** 申告のコードブロック（中身は、渡した文字列のまま）。 */
const fenced = (body: string, marker = "```") => `${marker}${COMPLETION_FENCE}\n${body}\n${marker}`;
const declare = (value: unknown) => fenced(JSON.stringify(value));
const COMPLETE = declare({ status: "complete" });
const read = (output: string) => extractCompletion(output).completion;

describe("実装の完了の申告（PBI-347）", () => {
  it("指示は、実行の終わりが提出になることと、申告の場所と形を伝える（受け入れ条件 1）", () => {
    const lines = implementCompletionLines().join("\n");
    expect(lines).toContain("--- 完了の申告 ---");
    expect(lines).toContain("この実行が終わると、sacty は作業領域の内容をそのまま提出する");
    expect(lines).toContain("必ず申告する");
    expect(lines).toContain(
      "申告は、言語の名前を sacty-completion にしたコードブロックの中にだけ、下の形の JSON で書く。出力の最後に、1つだけ書く",
    );
    expect(lines).toContain("このコードブロックの外に書いたものは申告として扱わない");
    expect(lines).toContain("申告が無い実行は、未完了として扱い、提出しない");
    expect(lines).toContain("申告を下の形どおりに読めない実行も同じ");
    expect(lines).toContain('```sacty-completion\n{"status":"complete"}\n```');
    expect(lines).toContain('```sacty-completion\n{"status":"incomplete","remaining":[');
    // 指示の例は、そのまま書けば読める
    expect(read(completionBlock({ status: "complete" }))).toEqual({ status: "complete" });
    expect(read(completionBlock({ status: "incomplete", remaining: ["docs"] }))).toEqual({
      status: "incomplete",
      remaining: ["docs"],
    });
  });

  it("完了の申告を読み、申告のコードブロックを本文から取り除く", () => {
    const extracted = extractCompletion(`# 実装の説明\n\n本文\n\n${COMPLETE}`);
    expect(extracted.completion).toEqual({ status: "complete" });
    expect(extracted.output.trim()).toBe("# 実装の説明\n\n本文");
    // 前後に空白・改行のある JSON、~~~ のフェンス、3つまでの字下げ、言語の名前の後ろの語も読む
    expect(read(fenced('\n  { "status" : "complete" }\n'))).toEqual({ status: "complete" });
    expect(read(fenced('{"status":"complete"}', "~~~"))).toEqual({ status: "complete" });
    expect(read('   ```sacty-completion\n{"status":"complete"}\n   ```')).toEqual({
      status: "complete",
    });
    expect(read('```sacty-completion json\n{"status":"complete"}\n````')).toEqual({
      status: "complete",
    });
  });

  it("未完了の申告は、残っていることと一緒に読む。空の項目は除く", () => {
    expect(
      read(declare({ status: "incomplete", remaining: ["API の入力", "  ", " docs の更新 "] })),
    ).toEqual({ status: "incomplete", remaining: ["API の入力", "docs の更新"] });
    // 残っていることを書いていなくても、未完了
    expect(read(declare({ status: "incomplete" }))).toEqual({
      status: "incomplete",
      remaining: [],
    });
  });

  it("完了と申告していても、残っていることがあれば未完了にする", () => {
    expect(read(declare({ status: "complete", remaining: ["docs の更新"] }))).toEqual({
      status: "incomplete",
      remaining: ["docs の更新"],
    });
    // 残っていることが空・空の項目だけなら完了
    expect(read(declare({ status: "complete", remaining: [] }))).toEqual({ status: "complete" });
    expect(read(declare({ status: "complete", remaining: ["", "  "] }))).toEqual({
      status: "complete",
    });
  });

  it("残っていることは、件数と1件の長さの上限で切る。文字の途中（サロゲートペアの間）では切らない", () => {
    const remaining = Array.from({ length: COMPLETION_REMAINING_MAX + 5 }, (_, i) =>
      i === 0 ? "あ".repeat(COMPLETION_REMAINING_ITEM_MAX + 50) : `残り${i}`,
    );
    const cutList = read(declare({ status: "incomplete", remaining }));
    expect(cutList?.status).toBe("incomplete");
    if (cutList?.status !== "incomplete") return;
    expect(cutList.remaining).toHaveLength(COMPLETION_REMAINING_MAX);
    expect(cutList.remaining[0]?.length).toBeLessThanOrEqual(COMPLETION_REMAINING_ITEM_MAX);
    expect(cutList.remaining[0]?.endsWith("…")).toBe(true);
    // 上限の位置が絵文字（サロゲートペア）の途中に当たる
    const emoji = `${"a".repeat(COMPLETION_REMAINING_ITEM_MAX - 2)}😀😀😀`;
    const cutEmoji = read(declare({ status: "incomplete", remaining: [emoji] }));
    if (cutEmoji?.status !== "incomplete") throw new Error("not incomplete");
    const [item = ""] = cutEmoji.remaining;
    expect(item.length).toBeLessThanOrEqual(COMPLETION_REMAINING_ITEM_MAX);
    // 壊れたサロゲート（対になっていない上位・下位）が残っていない
    expect(item).toBe(item.toWellFormed());
  });

  it("申告のコードブロックが無ければ、申告なしにする。コードブロックの外に書いたものは、申告として扱わない", () => {
    for (const output of [
      "# 実装の説明\n\n実装は完了しました。",
      // 言語の名前が違うコードブロック・囲みの無い JSON・見出しを付けた JSON
      '```json\n{"status":"complete"}\n```',
      '```\n{"status":"complete"}\n```',
      '{"status":"complete"}',
      '```json\n{"sacty-completion":{"status":"complete"}}\n```',
      'sacty-completion: {"status":"complete"}',
      // 言語の名前が、決まった名前と違う（大文字・前後の文字）
      '```Sacty-Completion\n{"status":"complete"}\n```',
      '```json sacty-completion\n{"status":"complete"}\n```',
      '```sacty-completion-v2\n{"status":"complete"}\n```',
      // 4つ以上の字下げ（コードブロックにならない）
      '    ```sacty-completion\n    {"status":"complete"}\n    ```',
    ]) {
      const extracted = extractCompletion(output);
      expect(extracted.completion, output).toBeUndefined();
      // 申告でないものは、本文に残す
      expect(extracted.output, output).toBe(output);
    }
  });

  it("ほかのコードブロックの中に例として書いた申告は、申告として扱わず、本文に残す", () => {
    const quoted = `書き方の例：\n\n\`\`\`\`markdown\n${COMPLETE}\n\`\`\`\``;
    expect(extractCompletion(quoted)).toEqual({ output: quoted });
    // 例の後ろに書いた本物の申告は読む
    const both = extractCompletion(`${quoted}\n\n${declare({ status: "incomplete" })}`);
    expect(both.completion).toEqual({ status: "incomplete", remaining: [] });
    expect(both.output.trim()).toBe(quoted);
  });

  it("決まった形どおりに読めない申告は、申告なしにする（完了として提出に進めない）", () => {
    for (const body of [
      // JSON として読めない
      '{"status": "complete",}',
      '{"status": "complete"',
      "{status: complete}",
      "complete",
      "",
      '{"status":"complete"}\n{"status":"complete"}',
      '{"status":"complete"} 以上です',
      // オブジェクトでない
      '"complete"',
      '["complete"]',
      "null",
      // status が complete でも incomplete でもない
      "{}",
      '{"status": "done"}',
      '{"status": "Complete"}',
      '{"status": true}',
      '{"status": ["complete"]}',
      '{"remaining": []}',
      // status と remaining のほかのキーがある
      '{"status": "complete", "note": "docs は後で"}',
      '{"status": "complete", "incomplete": true}',
      '{"status": "incomplete", "remaining": ["docs"], "todo": ["test"]}',
      '{"sacty-completion": {"status": "complete"}}',
      '{"status": "complete", "__proto__": {"status": "incomplete"}}',
      // remaining が、文の一覧でない
      '{"status": "complete", "remaining": "docs"}',
      '{"status": "complete", "remaining": [3]}',
      '{"status": "complete", "remaining": ["docs", 3]}',
      '{"status": "complete", "remaining": {"a": 1}}',
      '{"status": "complete", "remaining": null}',
      '{"status": "incomplete", "remaining": "全部"}',
      '{"status": "incomplete", "remaining": ["API", 3]}',
    ]) {
      const extracted = extractCompletion(`# 実装の説明\n\n${fenced(body)}`);
      expect(extracted.completion, body).toBeUndefined();
      // 読めない申告も、本文からは取り除く
      expect(extracted.output.trim(), body).toBe("# 実装の説明");
    }
  });

  it("同じキーが重複した申告は、後の値で上書きして読まれるので、申告なしにする", () => {
    for (const body of [
      // status の重複（未完了の後に完了・完了の後に未完了・同じ値）
      '{"status": "incomplete", "remaining": ["docs"], "status": "complete"}',
      '{"status": "complete", "status": "incomplete"}',
      '{"status": "complete", "status": "complete"}',
      // remaining の重複
      '{"status": "complete", "remaining": ["docs"], "remaining": []}',
      // エスケープで書いた同じキー
      '{"status": "incomplete", "st\\u0061tus": "complete"}',
      '{"remaining": ["docs"], "status": "complete", "rem\\u0061ining": []}',
    ]) {
      expect(read(fenced(body)), body).toBeUndefined();
    }
    // 値に同じ文字列があっても、キーの重複ではない
    expect(read(fenced('{"status": "incomplete", "remaining": ["status", "status"]}'))).toEqual({
      status: "incomplete",
      remaining: ["status", "status"],
    });
  });

  it("閉じていない申告のコードブロックは、どこまでが申告かを決められないので、申告なしにする", () => {
    const unclosed = extractCompletion(
      '# 実装の説明\n\n```sacty-completion\n{"status":"complete"}\n\n後ろの文',
    );
    expect(unclosed.completion).toBeUndefined();
    expect(unclosed.output.trim()).toBe("# 実装の説明");
    // 閉じるフェンスが、開くフェンスと違う文字・短い
    expect(read('```sacty-completion\n{"status":"complete"}\n~~~')).toBeUndefined();
    expect(read('````sacty-completion\n{"status":"complete"}\n```')).toBeUndefined();
    // 読める申告の後ろに、閉じていない申告がある
    expect(read(`${COMPLETE}\n\n\`\`\`sacty-completion\n{"status":"complete"}`)).toBeUndefined();
  });

  it("申告が複数あるときは、すべてを読めて、すべてが完了のときだけ完了にする。最後が未完了なら未完了にする", () => {
    const unfinished = declare({ status: "incomplete", remaining: ["テスト"] });
    // すべて完了
    expect(read(`${COMPLETE}\n\n続き\n\n${COMPLETE}`)).toEqual({ status: "complete" });
    // 最後が未完了なら、前の申告が完了でも未完了（残っていることは、最後の申告のもの）
    expect(read(`${COMPLETE}\n\n続き\n\n${unfinished}`)).toEqual({
      status: "incomplete",
      remaining: ["テスト"],
    });
    expect(
      read(`${unfinished}\n\n${declare({ status: "incomplete", remaining: ["docs"] })}`),
    ).toEqual({ status: "incomplete", remaining: ["docs"] });
    // 最後が完了でも、ほかに未完了の申告があれば、どちらを意図したかを決められないので、申告なし
    expect(read(`${unfinished}\n\n続き\n\n${COMPLETE}`)).toBeUndefined();
    expect(read(`${COMPLETE}\n\n${unfinished}\n\n続き\n\n${COMPLETE}`)).toBeUndefined();
    // 完了と書いて残っていることを挙げた申告（未完了として読む）が前にあっても同じ
    expect(
      read(`${declare({ status: "complete", remaining: ["docs"] })}\n\n${COMPLETE}`),
    ).toBeUndefined();
    // 読めない申告が1つでもあれば、順序にかかわらず、申告なし
    for (const unreadable of [
      fenced('{"status": "incomplete",}'),
      fenced('{"status": "incomplete", "status": "complete"}'),
      fenced('{"status": "partial"}'),
      fenced('{"status": "complete", "note": "x"}'),
      fenced('{"sacty\\u002dcompletion": {"status": "incomplete",}}'),
      fenced(""),
    ]) {
      expect(read(`${unreadable}\n\n続き\n\n${COMPLETE}`), unreadable).toBeUndefined();
      expect(read(`${COMPLETE}\n\n続き\n\n${unreadable}`), unreadable).toBeUndefined();
      expect(read(`${unreadable}\n\n続き\n\n${unfinished}`), unreadable).toBeUndefined();
      expect(read(`${unfinished}\n\n続き\n\n${unreadable}`), unreadable).toBeUndefined();
    }
  });

  it("重複を調べられないほど入れ子が深い申告は、例外にせず、申告なしにする", () => {
    const nest = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    // 後の remaining で上書きされて、読んだ値は決まった形になる。重複は、元の文字列で調べる
    for (const depth of [DUPLICATE_KEYS_DEPTH_MAX, 5_000, 200_000]) {
      const hidden = `{"remaining": ${nest(depth)}, "status": "complete", "remaining": []}`;
      expect(read(fenced(hidden)), String(depth)).toBeUndefined();
    }
    expect(() => hasDuplicateKeys(`{"a": ${nest(DUPLICATE_KEYS_DEPTH_MAX)}}`)).toThrow();
    expect(hasDuplicateKeys(`{"a": ${nest(DUPLICATE_KEYS_DEPTH_MAX - 1)}}`)).toBe(false);
  });

  it("キーの重複は、入れ子のオブジェクト・配列の中も見て、エスケープを戻して比べる", () => {
    expect(hasDuplicateKeys('{"a": 1, "b": {"a": 2}}')).toBe(false);
    expect(hasDuplicateKeys('{"a": 1, "a": 2}')).toBe(true);
    expect(hasDuplicateKeys('{"a": {"b": 1, "b": 2}}')).toBe(true);
    expect(hasDuplicateKeys('{"a": [{"b": 1}, {"b": 2, "b": 3}]}')).toBe(true);
    expect(hasDuplicateKeys('{"a": [{"b": 1}, {"b": 2}]}')).toBe(false);
    expect(hasDuplicateKeys('{"a": "\\"a\\": 1, \\"a\\": 2", "b": [1, 2.5e3, true, null]}')).toBe(
      false,
    );
    expect(hasDuplicateKeys('{"a": 1, "\\u0061": 2}')).toBe(true);
    expect(hasDuplicateKeys(' \n{"a": 1, "a": 2}\n')).toBe(true);
    expect(hasDuplicateKeys("{}")).toBe(false);
    expect(hasDuplicateKeys("")).toBe(false);
  });

  it("コードブロックの取り出しは、名前の合うものだけを、出てきた順に取り出して、本文から取り除く", () => {
    const output = [
      "前",
      "```sacty-x",
      "1行目",
      "2行目",
      "```",
      "間",
      "```json",
      '{"a": 1}',
      "```",
      "~~~~sacty-x extra",
      "```",
      "~~~~",
      "後ろ",
    ].join("\n");
    expect(takeFences(output, "sacty-x")).toEqual({
      output: ["前", "間", "```json", '{"a": 1}', "```", "後ろ"].join("\n"),
      fences: [
        { body: "1行目\n2行目", closed: true },
        { body: "```", closed: true },
      ],
    });
    // 名前の合うものが無ければ、本文はそのまま
    expect(takeFences(output, "sacty-y")).toEqual({ output, fences: [] });
    // 閉じていないものは、出力の終わりまでを中身にする
    expect(takeFences("前\n```sacty-x\n中身\n後ろ", "sacty-x")).toEqual({
      output: "前",
      fences: [{ body: "中身\n後ろ", closed: false }],
    });
  });

  it("実装の工程の出力からは、申告を読んで本文から取り除く。読めない申告も本文から取り除く", () => {
    const output = ["# 実装の説明", declare({ status: "incomplete", remaining: ["docs"] })].join(
      "\n\n",
    );
    const extracted = extractBlocks(output, new Set(), [], { completion: true });
    expect(extracted.completion).toEqual({ status: "incomplete", remaining: ["docs"] });
    expect(extracted.output).toBe("# 実装の説明");
    const broken = `# 実装の説明\n\n${fenced('{"status": "complete",}')}`;
    const unread = extractBlocks(broken, new Set(), [], { completion: true });
    expect(unread.completion).toBeUndefined();
    expect(unread.output).toBe("# 実装の説明");
  });

  it("申告の中身は、ほかの報告（観点とテストの対応など）の JSON として読まない", () => {
    const map = '```json\n{"sacty-test-map": [{"viewpointId": "TV-1", "tests": ["a › b"]}]}\n```';
    // 申告のコードブロックに、ほかの報告の見出しを書いても、報告として読まない（申告としても読めない）
    const smuggled = fenced('{"sacty-test-map": [{"viewpointId": "TV-9", "tests": ["x › y"]}]}');
    const extracted = extractBlocks(`# 実装の説明\n\n${map}\n\n${smuggled}`, new Set(), [], {
      completion: true,
    });
    expect(extracted.testMap).toEqual([{ viewpointId: "TV-1", tests: ["a › b"] }]);
    expect(extracted.completion).toBeUndefined();
    expect(extracted.output).toBe("# 実装の説明");
  });

  it("実装でない工程の成果物にある同じ名前のコードブロックは、申告として扱わず、本文に残す", () => {
    const output = ["# 設計", COMPLETE].join("\n\n");
    const extracted = extractBlocks(output, new Set(), []);
    expect(extracted.completion).toBeUndefined();
    expect(extracted.output).toContain("sacty-completion");
  });
});
