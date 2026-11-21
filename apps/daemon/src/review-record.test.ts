import { describe, expect, it } from "vitest";
import { buildReviewBody, buildReviewComments } from "./prompts.js";
import {
  checkReviewRecord,
  readReviewRecordBlock,
  reviewRecordBlocksNarrowing,
  stripReviewRecord,
  withoutReviewRecord,
} from "./review-record.js";

/** レビューの記録のブロックの取り除きと、記録の検査（PBI-460）。 */
const leak = (n: number) => `LEAK-${n}`;
const payload = (n: number) =>
  `{"viewpoints":[{"id":"C-1","status":"launched","reason":"${leak(n)}"}]}`;
const KEEP = [
  "総評の文です。",
  "verification: 手で確かめた",
  '```json\n{"mode":"production","scope":"read"}\n```',
  "```yaml\nmyverification: 1\n```",
  "最後の地の文です。",
];
const keepText = KEEP.join("\n\n");

/** 記録のブロックの書き方の揺れ（それぞれ、LEAK-n を含む）。 */
const variants: [string, string][] = [
  ["バッククォート 4 つ", `\`\`\`\`sacty-review-record\n${payload(1)}\n\`\`\`\``],
  ["チルダ 3 つ", `~~~sacty-review-record\n${payload(2)}\n~~~`],
  ["空白 2 個の字下げ", `  \`\`\`sacty-review-record\n  ${payload(3)}\n  \`\`\``],
  ["空白 6 個の字下げ", `      \`\`\`sacty-review-record\n      ${payload(4)}\n      \`\`\``],
  ["リスト項目の中", `- 項目\n  \`\`\`sacty-review-record\n  ${payload(5)}\n  \`\`\``],
  ["引用の中", `> \`\`\`sacty-review-record\n> ${payload(6)}\n> \`\`\``],
  ["情報文字列の大小文字と空白", `\`\`\` SACTY-Review-Record \n${payload(7)}\n\`\`\``],
  ["json と見出しが並ぶ情報文字列", `\`\`\`json sacty-review-record\n${payload(8)}\n\`\`\``],
  [
    "見出しの行の後の、情報文字列が空のフェンス",
    `sacty-review-record\n\`\`\`\n${payload(9)}\n\`\`\``,
  ],
  [
    "情報文字列が json だけで、記録に固有の欄名だけの JSON",
    `\`\`\`json\n{"viewpoints": [{"id": "C-1", "status": "launched", "reason": "${leak(10)}"}]}\n\`\`\``,
  ],
  [
    "情報文字列が空で、途中で切れて JSON として読めないフェンス",
    `\`\`\`\n{"dismissed": [{"title": "${leak(11)}", "reas\n\`\`\``,
  ],
  ["単引用符のキー", `\`\`\`\n{'viewpoints': ["${leak(12)}"]}\n\`\`\``],
  ["大小文字違いで : の前に空白", `\`\`\`\n{"Dismissed" : ["${leak(13)}"]}\n\`\`\``],
  ["引用符の無いキー", `\`\`\`yaml\ndropped: 1\nnote: ${leak(14)}\n\`\`\``],
  [
    "フェンスの外の、複数行の JSON",
    `{\n  "notReviewed": [{"id": "C-1", "reason": "${leak(15)}"}]\n}`,
  ],
  ["閉じていないフェンス（文字列の終わりまで）", `\`\`\`sacty-review-record\n${payload(16)}`],
];

describe("stripReviewRecord：記録のブロックを取り除く（PBI-460）", () => {
  it.each(variants)("%s", (_name, block) => {
    // 閉じていないフェンスは文字列の終わりまでなので、残す文より後に置く
    const text = `${keepText}\n\n${block}`;
    const stripped = stripReviewRecord(text);
    expect(stripped).not.toMatch(/LEAK-\d+/);
    expect(stripped.toLowerCase()).not.toContain("sacty-review-record");
    // 記録と関係のないものは残る
    for (const kept of KEEP) expect(stripped).toContain(kept);
  });

  it("入れ子のフェンスで、外側を除いた後に内側が現れるものも除く（何も除かれなくなるまで確かめる）", () => {
    // 外側（情報文字列が空）に、4 つのバッククォートで閉じない 3 つのフェンスが入る
    const nested = `\`\`\`\`\n\`\`\`sacty-review-record\n${payload(20)}\n\`\`\`\n\`\`\`\``;
    const stripped = stripReviewRecord(`前置き\n\n${nested}\n\n後ろ`);
    expect(stripped).not.toContain("LEAK-20");
    expect(stripped).toContain("前置き");
    expect(stripped).toContain("後ろ");
    expect(stripReviewRecord(stripped)).toBe(stripped);
  });

  it("2 つのブロック・文中の見出しの語を含む行・見出しの文字列が残る行も除く", () => {
    const text = [
      "地の文",
      `\`\`\`sacty-review-record\n${payload(21)}\n\`\`\``,
      `\`\`\`sacty-review-record\n${payload(22)}\n\`\`\``,
      "本文の中で Sacty-Review-Record の語に触れる行",
      "残る行",
    ].join("\n");
    const stripped = stripReviewRecord(text);
    expect(stripped).toBe("地の文\n残る行");
  });

  it("記録を含まない文字列は、そのまま返す", () => {
    expect(stripReviewRecord(keepText)).toBe(keepText);
  });

  it("行の途中にバッククォートを含む行は開きではなく、後ろの指摘を巻き込まない", () => {
    const text =
      "```foo``` を使うと\n\n## 指摘\n1. [提案] 直す\n\n```sacty-review-record\n" +
      payload(20) +
      "\n```";
    const stripped = stripReviewRecord(text);
    expect(stripped).toContain("## 指摘");
    expect(stripped).toContain("1. [提案] 直す");
    expect(stripped).toContain("```foo``` を使うと");
    expect(stripped).not.toContain("LEAK-20");
  });

  it("改行が CRLF・CR でも、見出し付きのブロックを閉じた形で除く（mode と scope だけの記録も残らない）", () => {
    for (const nl of ["\r\n", "\r"]) {
      const text = [
        "総評",
        "",
        "```sacty-review-record",
        '{"mode":"sequential","scope":["LEAK-21"]}',
        "```",
        "",
        "末尾",
      ].join(nl);
      const stripped = stripReviewRecord(text);
      expect(stripped).not.toContain("LEAK-21");
      expect(stripped.toLowerCase()).not.toContain("sacty-review-record");
      expect(stripped).toContain("総評");
      expect(stripped).toContain("末尾");
      const block = `\`\`\`sacty-review-record${nl}{"mode":"sequential"}${nl}\`\`\``;
      expect(readReviewRecordBlock(block)).toEqual({ mode: "sequential" });
    }
  });

  it("長いフェンスの中に、mode と scope だけの記録の見出し付きフェンスが入れ子のとき、外側ごと除く", () => {
    const text = [
      "総評",
      "",
      "````md",
      "```sacty-review-record",
      '{"mode":"sequential","scope":["LEAK-22"]}',
      "```",
      "````",
      "",
      "末尾",
    ].join("\n");
    const stripped = stripReviewRecord(text);
    expect(stripped).not.toContain("LEAK-22");
    expect(stripped).not.toContain("````");
    expect(stripped).toContain("総評");
    expect(stripped).toContain("末尾");
  });

  it("行へのコメントの本文とリスク評価の各文にも使える", () => {
    const reviewed = withoutReviewRecord({
      output: `本文\n${variants[0]?.[1]}`,
      comments: [
        { path: "a.ts", line: 1, body: `[提案] 直す\n${variants[1]?.[1]}` },
        { path: "b.ts", line: 2, body: variants[2]?.[1] ?? "" },
      ],
      risk: {
        change: `変更\n${variants[3]?.[1]}`,
        scope: "範囲",
        reversibility: "戻せる",
        verification: `確かめた\n${variants[4]?.[1]}`,
        focus: [{ where: "a.ts:1", why: `理由\n${variants[5]?.[1]}` }],
      },
    });
    const all = JSON.stringify(reviewed);
    expect(all).not.toMatch(/LEAK-\d+/);
    expect(all).not.toContain("sacty-review-record");
    expect(reviewed.output).toBe("本文");
    // 記録のブロックだけだった行へのコメントは捨てる
    expect(reviewed.comments).toEqual([{ path: "a.ts", line: 1, body: "[提案] 直す" }]);
    expect(reviewed.risk?.change).toBe("変更");
    expect(reviewed.risk?.focus[0]?.why).toBe("理由");
  });

  it("投稿の直前の組み立て（本文・行へのコメント・リスク評価）も、残った記録を取り除く", () => {
    const task = {
      id: "t1",
      reviewRound: 1,
      reviewComments: [{ path: "a.ts", line: 1, body: `[提案] 直す\n${variants[0]?.[1]}` }],
      reviewVerdicts: [{ round: 1, verdict: "no_findings" }],
      outputs: { review: `## 総評\n問題なし\n\n${variants[1]?.[1]}\n` },
      reviewTarget: { headCommit: "abcdef1234567" },
      riskAssessment: {
        via: "review",
        commit: "abcdef1234567",
        assessment: {
          level: "low",
          signals: [],
          change: "変更",
          scope: "範囲",
          reversibility: "戻せる",
          verification: `確かめた範囲\n${variants[2]?.[1]}`,
          focus: [],
        },
      },
    };
    const body = buildReviewBody(task as never, { risk: true });
    expect(body).toContain("確かめた範囲");
    expect(body).not.toMatch(/LEAK-\d+/);
    for (const c of buildReviewComments(task as never)) {
      expect(c.body).not.toMatch(/LEAK-\d+/);
      expect(c.body).toContain("[提案] 直す");
    }
  });
});

describe("readReviewRecordBlock・checkReviewRecord（PBI-460）", () => {
  const identity = (s: string) => s;

  it("情報文字列に見出しを含む最初の閉じたブロックだけを読む。見出しの無いブロックは読まない", () => {
    const text = [
      payload(30).replace("LEAK-30", "読まない"),
      '```json\n{"mode":"sequential"}\n```',
      '```sacty-review-record\n{"mode":"subagents"}\n```',
      '```sacty-review-record\n{"mode":"sequential"}\n```',
    ].join("\n");
    expect(readReviewRecordBlock(text)).toEqual({ mode: "subagents" });
    expect(readReviewRecordBlock("本文だけ")).toBeUndefined();
    expect(readReviewRecordBlock("```sacty-review-record\nこれは JSON ではない\n```")).toBeNull();
    expect(readReviewRecordBlock('```sacty-review-record\n{"mode":"subagents"}')).toBeNull();
  });

  it("見出しをキーにした入れ物の中の記録も読める", () => {
    expect(
      readReviewRecordBlock(
        '```sacty-review-record\n{"sacty-review-record": {"mode": "sequential"}}\n```',
      ),
    ).toEqual({ mode: "sequential" });
  });

  it("形の検査：列挙の値・件数の上限・0 以上の整数・表に無い欄のどれか 1 つでも通らなければ、全体を null にする", () => {
    const ok = { mode: "sequential", viewpoints: [{ id: "C-1", status: "failed" }] };
    expect(checkReviewRecord(ok, identity)).toMatchObject({ mode: "sequential" });
    for (const bad of [
      { ...ok, mode: "parallel" },
      { ...ok, viewpoints: [{ id: "C-1", status: "done" }] },
      { ...ok, viewpoints: Array.from({ length: 101 }, () => ({ id: "C", status: "failed" })) },
      { ...ok, scope: Array.from({ length: 21 }, () => "x") },
      { ...ok, verification: [{ kind: "passed", text: "x" }] },
      { ...ok, dropped: { overlapping: 1.5 } },
      { ...ok, dropped: { must: -1 } },
      { ...ok, unknown: 1 },
      { ...ok, dismissed: [{ title: "t", reason: "r", extra: 1 }] },
      "文字列",
      [],
    ]) {
      expect(checkReviewRecord(bad, identity)).toBeNull();
    }
  });

  it("件数の上限は、ちょうどの件数が通り、1 件超えると全体が null になる（欄ごと）", () => {
    const n = (count: number, make: () => unknown) => Array.from({ length: count }, make);
    const fields: [string, number, () => unknown][] = [
      ["viewpoints", 100, () => ({ id: "C", status: "failed" })],
      ["notReviewed", 100, () => ({ id: "C", reason: "r" })],
      ["dismissed", 100, () => ({ title: "t", reason: "r" })],
      ["scope", 20, () => "x"],
      ["verification", 20, () => ({ kind: "ran", text: "x" })],
    ];
    for (const [key, max, make] of fields) {
      expect(checkReviewRecord({ [key]: n(max, make) }, identity)).not.toBeNull();
      expect(checkReviewRecord({ [key]: n(max + 1, make) }, identity)).toBeNull();
    }
  });

  it("リスク評価の文が記録だけのときは、評価を使わない。ほかの文が残る評価は、記録だけを除いて使う", () => {
    const block = variants[0]?.[1] ?? "";
    const base = {
      change: "変更",
      scope: "範囲",
      reversibility: "戻せる",
      verification: "確認",
      focus: [],
    };
    const dropped = withoutReviewRecord({
      output: "本文",
      comments: [],
      risk: { ...base, scope: block },
    });
    expect(dropped.risk).toBeUndefined();
    const kept = withoutReviewRecord({
      output: "本文",
      comments: [],
      risk: { ...base, change: `変更\n${block}` },
    });
    expect(kept.risk?.change).toBe("変更");
  });

  it("欄が欠けた記録は、配列を空にして残す。伏せる関数が例外を投げれば null", () => {
    expect(checkReviewRecord({}, identity)).toEqual({
      viewpoints: [],
      notReviewed: [],
      dismissed: [],
      scope: [],
      verification: [],
    });
    expect(
      checkReviewRecord({ scope: ["x"] }, () => {
        throw new Error("伏せられない");
      }),
    ).toBeNull();
  });

  it("再レビューを絞らない条件は、構造の欄だけで決める（文の中身は読まない）", () => {
    const base = checkReviewRecord({}, identity);
    expect(reviewRecordBlocksNarrowing(undefined)).toBe(true);
    expect(reviewRecordBlocksNarrowing(null)).toBe(true);
    expect(reviewRecordBlocksNarrowing(base)).toBe(false);
    expect(
      reviewRecordBlocksNarrowing(
        checkReviewRecord({ notReviewed: [{ id: "C-1", reason: "x" }] }, identity),
      ),
    ).toBe(true);
    expect(
      reviewRecordBlocksNarrowing(
        checkReviewRecord({ verification: [{ kind: "stopped", text: "x" }] }, identity),
      ),
    ).toBe(true);
    // 文に「止まった」「見られなかった」と書かれていても、種別が止まったでなければ絞らない理由にならない
    expect(
      reviewRecordBlocksNarrowing(
        checkReviewRecord(
          { verification: [{ kind: "ran", text: "止まった。見られなかった観点" }] },
          identity,
        ),
      ),
    ).toBe(false);
  });
});
