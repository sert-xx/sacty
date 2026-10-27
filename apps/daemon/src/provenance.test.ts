import type { Provenance, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  buildStepPullRequestBody,
  buildStepPullRequestBodyParts,
  checkProvenance,
  extractBlocks,
  provenanceGuideLines,
  provenanceIds,
  provenanceInputs,
  viewpointRename,
} from "./prompts.js";

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: "t-1",
    title: "決済",
    body: "カードで支払えるようにする",
    steps: [
      { key: "requirements", state: "todo" },
      { key: "design", state: "todo" },
      { key: "implement", state: "todo" },
    ],
    remarks: [],
    outputs: {},
    approved: {},
    testViewpoints: [],
    reproductionTests: [],
    proposals: [],
    stepPullRequests: [],
    ...extra,
  }) as unknown as Task;

describe("提出の前の出典の分類の指示", () => {
  it("Input のディレクトリを渡したときだけ、セルフレビューの後に別のサブエージェントへ分類させる", () => {
    const prompt = buildPrompt(task(), "requirements", { inputDir: "/sacty-input" });
    expect(prompt).toContain("--- 提出の前の出典の分類 ---");
    expect(prompt).toContain("既定のスキル classify-provenance");
    expect(prompt).toContain("要求要件の要求（R-n）ごと");
    expect(prompt).toContain("Input のディレクトリ（/sacty-input。");
    // 書いた側の要約・経緯を渡させない
    expect(prompt).toContain(
      "依頼文に、Input の要約・言い換え・引用と、あなたが書いた経緯・考えたこと・どの項目を足したかを書かない",
    );
    expect(prompt).toContain("担当の答えを、手を加えずに次の形式で付ける");
    expect(prompt).toContain('{"sacty-provenance": {"mode": "subagent"');
    expect(prompt.indexOf("--- 提出の前のセルフレビュー ---")).toBeLessThan(
      prompt.indexOf("--- 提出の前の出典の分類 ---"),
    );
    // 人間の承認での使い分けは書かない
    expect(prompt).not.toContain("確かめる所");
    expect(buildPrompt(task(), "requirements")).not.toContain("出典の分類");
  });

  it("設計はテスト観点を TV-n として分類させ、最終版にテスト観点の JSON を含めさせる", () => {
    const prompt = buildPrompt(
      task({
        approved: { requirements: { output: "# 要求要件", submission: 1 } },
      } as Partial<Task>),
      "design",
      { inputDir: "/sacty-input" },
    );
    expect(prompt).toContain(
      "テスト観点（sacty-test-viewpoints の JSON の n 番目を TV-n とする）ごと",
    );
    expect(prompt).toContain("テスト観点の JSON も含める");
  });
});

describe("出典の分類の Input", () => {
  it("タスクの内容と、その工程の有効な指摘を置く。設計には承認済みの要求要件も置く", () => {
    const t = task({
      remarks: [
        { id: "requirements-1-1", step: "requirements", text: "失敗を通知する" },
        { id: "requirements-1-2", step: "requirements", text: "無効", voided: true },
        { id: "design-1-1", step: "design", text: "再試行は3回" },
      ],
      approved: { requirements: { output: "| R-1 | 支払う |", submission: 1 } },
    } as Partial<Task>);
    const requirements = provenanceInputs(t, "requirements");
    expect(requirements.map((i) => i.name)).toEqual(["task.md", "remarks.md"]);
    expect(requirements[0]?.text).toContain("カードで支払えるようにする");
    expect(requirements[1]?.text).toContain("- [requirements-1-1] 失敗を通知する");
    expect(requirements[1]?.text).not.toContain("無効");
    const design = provenanceInputs(t, "design");
    expect(design.map((i) => i.name)).toEqual(["task.md", "remarks.md", "requirements.md"]);
    expect(design[1]?.text).toContain("- [design-1-1] 再試行は3回");
    expect(design[2]?.text).toContain("| R-1 | 支払う |");
  });
});

describe("出典の分類の読み取りと照合", () => {
  const inputs = [{ text: "# 決済\n\nカードで**支払える**ようにする。\n失敗したら　通知する" }];
  const ids = ["R-1", "R-2", "R-3"];

  it("抜き出しを、空白・Markdown の記号・文字の形をそろえて Input と照らす", () => {
    const provenance = checkProvenance(
      {
        mode: "subagent",
        items: [
          { id: "R-1", kind: "input", excerpt: "カードで支払える ようにする" },
          { id: "R-2", kind: "derived", refs: ["R-1"], excerpt: "失敗したら通知する" },
          { id: "R-3", kind: "input", excerpt: "現金で支払える" },
        ],
      },
      inputs,
      ids,
    );
    expect(provenance?.items.map((i) => [i.id, i.found])).toEqual([
      ["R-1", true],
      ["R-2", true],
      ["R-3", false],
    ]);
    expect(provenance?.sequential).toBe(false);
  });

  it("短すぎる抜き出しは見つからない扱いにし、推論の抜き出しは捨てる", () => {
    const provenance = checkProvenance(
      {
        mode: "subagent",
        items: [
          { id: "R-1", kind: "input", excerpt: "カード" },
          { id: "R-2", kind: "inference", excerpt: "カードで支払える" },
        ],
      },
      inputs,
      ids,
    );
    expect(provenance?.items).toEqual([
      { id: "R-1", kind: "input", refs: [], excerpt: "カード", found: false },
      { id: "R-2", kind: "inference", refs: [], excerpt: "" },
    ]);
    expect(provenance?.unclassified).toEqual(["R-3"]);
  });

  it("成果物に無い ID・重なる ID・知らない区分は捨て、形が違えば読めない", () => {
    const provenance = checkProvenance(
      {
        mode: "sequential",
        items: [
          { id: "R-9", kind: "input" },
          { id: "R-1", kind: "guess" },
          { id: "R-2", kind: "inference" },
          { id: "R-2", kind: "input", excerpt: "カードで支払える" },
        ],
      },
      inputs,
      ids,
    );
    expect(provenance).toEqual({
      sequential: true,
      items: [{ id: "R-2", kind: "inference", refs: [], excerpt: "" }],
      unclassified: ["R-1", "R-3"],
    });
    expect(checkProvenance(undefined, inputs, ids)).toBeUndefined();
    // 誰が分類したか分からない答え（mode が無い・知らない値）は読めない
    for (const mode of [undefined, "", "auto"]) {
      expect(
        checkProvenance({ mode, items: [{ id: "R-1", kind: "derived" }] }, inputs, ids),
        String(mode),
      ).toBeUndefined();
    }
    expect(checkProvenance({ items: "R-1" }, inputs, ids)).toBeUndefined();
    expect(checkProvenance([], inputs, ids)).toBeUndefined();
  });

  it("要求要件は本文の R-n を、設計はテスト観点の ID を項目にする", () => {
    expect(provenanceIds("requirements", "| R-1 | a |\n| R-2 | b |\nR-1 の異常系", [])).toEqual([
      "R-1",
      "R-2",
    ]);
    expect(
      provenanceIds("design", "R-1", [{ id: "TV-1", title: "a", input: "b", expected: "c" }]),
    ).toEqual(["TV-1"]);
  });

  it("設計の答えの TV-n を、元の位置から振った ID に直し、欠けた観点の分類は捨てる", () => {
    const extracted = extractBlocks(
      `# 設計\n\n\`\`\`json\n${JSON.stringify({
        "sacty-test-viewpoints": [
          { title: "欠け", input: "", expected: "x" },
          { title: "B", input: "i", expected: "e" },
          { title: "C", input: "i", expected: "e" },
        ],
      })}\n\`\`\``,
      new Set(),
    );
    expect(extracted.testViewpoints.map((v) => v.id)).toEqual(["TV-1", "TV-2"]);
    expect(extracted.viewpointPositions).toEqual([undefined, "TV-1", "TV-2"]);
    const rename = viewpointRename(extracted.viewpointPositions);
    const provenance = checkProvenance(
      {
        mode: "subagent",
        items: [
          { id: "TV-1", kind: "input", excerpt: "カードで支払える" },
          { id: "TV-2", kind: "inference" },
          { id: "TV-3", kind: "derived", refs: ["R-1", "TV-2", "TV-1", "TV-9"] },
        ],
      },
      inputs,
      ["TV-1", "TV-2"],
      rename,
    );
    expect(provenance?.items).toEqual([
      { id: "TV-1", kind: "inference", refs: [], excerpt: "" },
      // 根拠の参照の TV-n も振った ID に直し、取り込まなかった観点はそれとわかる形にする。対応に無いものはそのまま
      {
        id: "TV-2",
        kind: "derived",
        refs: ["R-1", "TV-1", "TV-1（取り込まなかった観点）", "TV-9"],
        excerpt: "",
      },
    ]);
    expect(provenance?.unclassified).toEqual([]);
  });

  it("答えを本文から取り除き、最後のものを使う", () => {
    const block = (v: unknown) =>
      `\`\`\`json\n${JSON.stringify({ "sacty-provenance": v })}\n\`\`\``;
    const extracted = extractBlocks(
      ["# 要求要件", block({ items: [] }), block({ items: [{ id: "R-1" }] })].join("\n\n"),
      new Set(),
    );
    expect(extracted.output).toBe("# 要求要件");
    expect(extracted.provenance).toEqual({ items: [{ id: "R-1" }] });
    expect(extractBlocks("# 要求要件", new Set()).provenance).toBeUndefined();
  });

  it("最後の答えが先頭以外のキーにあって壊れていれば、前の答えに戻らず読めないものにし、本文から取り除く", () => {
    const valid = `\`\`\`json\n${JSON.stringify({ "sacty-provenance": { mode: "subagent", items: [] } })}\n\`\`\``;
    for (const broken of [
      // 囲みの中：囲みの全体を取り除く
      '```json\n{"sacty-responses": [], "sacty-provenance": {"mode": "subagent", "items": [],},}\n```',
      // 囲みの外：キーのある行だけを取り除く
      '{"sacty-responses": [], "sacty-provenance": {"mode": "subagent", "items": [],},}',
    ]) {
      const extracted = extractBlocks(
        ["# 要求要件", valid, broken, "後ろの本文"].join("\n\n"),
        new Set(),
      );
      expect(extracted.provenance, broken).toBeUndefined();
      // 前の答えも壊れた答えも取り除き、ほかの本文は残す（空行の数は問わない）
      expect(extracted.output.replace(/\n+/g, "\n"), broken).toBe("# 要求要件\n後ろの本文");
      expect(checkProvenance(extracted.provenance, [], [])).toBeUndefined();
    }
    // 同じ囲みの中で、正しい答えの後に壊れた答えがあっても、壊れた答えを最後の答えにする
    const sameFence = extractBlocks(
      [
        "# 要求要件",
        "```json",
        JSON.stringify({ "sacty-provenance": { mode: "subagent", items: [] } }),
        '{"sacty-responses": [], "sacty-provenance": {"mode": "subagent", "items": [],},}',
        "```",
        "後ろの本文",
      ].join("\n"),
      new Set(),
    );
    expect(sameFence.provenance).toBeUndefined();
    expect(sameFence.output.replace(/\n+/g, "\n")).toBe("# 要求要件\n後ろの本文");
    // 読める答えが先頭以外のキーにあれば、それを使う
    const combined = extractBlocks(
      `# 要求要件\n\n\`\`\`json\n${JSON.stringify({ "sacty-responses": [], "sacty-provenance": { mode: "sequential", items: [] } })}\n\`\`\``,
      new Set(),
    );
    expect(combined.provenance).toEqual({ mode: "sequential", items: [] });
    expect(combined.output).toBe("# 要求要件");
  });
});

describe("出典の分類から、人間が確かめる所の案内", () => {
  const provenance: Provenance = {
    sequential: false,
    items: [
      { id: "R-1", kind: "input", refs: [], excerpt: "支払える", found: true },
      { id: "R-2", kind: "input", refs: [], excerpt: "無い文", found: false },
      { id: "R-3", kind: "derived", refs: ["R-1"], excerpt: "" },
      { id: "R-4", kind: "inference", refs: ["src/pay.ts:10"], excerpt: "" },
    ],
    unclassified: ["R-5"],
  };

  it("推論・原文の見つからない引用・分類の無い項目だけを挙げ、ほかは件数にする", () => {
    expect(provenanceGuideLines(provenance)).toEqual([
      "確かめる項目：3件（引用 2・導出 1・推論 1・分類なし 1）",
      "",
      "- R-2：引用の原文が見つからない",
      "- R-4：推論（根拠：src/pay.ts:10）",
      "- R-5：分類なし",
    ]);
  });

  it("書いた本人が分類した・記録が無いときは、すべてを確かめるよう案内し、分類させていなければ何も出さない", () => {
    const sequential = provenanceGuideLines({ ...provenance, sequential: true, unclassified: [] });
    expect(sequential[0]).toBe("確かめる項目：4件（引用 2・導出 1・推論 1）");
    expect(sequential).toContain(
      "サブエージェントを起動できず、書いたエージェントが自分で分類しました。すべての項目を確かめてください。",
    );
    expect(provenanceGuideLines(null)).toEqual([
      "出典の分類の記録がありません。すべての項目を確かめてください。",
    ]);
    expect(provenanceGuideLines(undefined)).toEqual([]);
  });

  it("要求要件・設計の PR の本文に、確かめる所を入れる（テンプレートに沿わせるときも）", () => {
    const t = task({
      outputs: { requirements: "# 要求要件" },
      provenances: { requirements: provenance },
    } as Partial<Task>);
    const body = buildStepPullRequestBody(t, "requirements", "docs/sacty/t-1/requirements.md");
    expect(body).toContain("## 確かめる所\n\n確かめる項目：3件");
    expect(body).toContain("- R-4：推論（根拠：src/pay.ts:10）");
    const parts = buildStepPullRequestBodyParts(t, "requirements", "docs/x.md");
    expect(parts.summary).toContain("**確かめる所**\n\n確かめる項目：3件");
    expect(buildStepPullRequestBody(task(), "requirements", "docs/x.md")).not.toContain(
      "確かめる所",
    );
  });
});
