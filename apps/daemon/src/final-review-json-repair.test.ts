import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  extractFinalReview,
  extractIntegrationReview,
  finalReviewUnreadableDetail,
} from "./prompts.js";

/*
 * 最終レビューの出力の JSON が崩れていても、直して読む（PBI-298。S5 r4：最終レビュー6回のうち3回で、tests の閉じ括弧 } が
 * 欠けて読めず、最終レビューをやり直した）。ここでは、実際の3件と同じ形の出力（tests を閉じずに humanChecks が続く）と、
 * 読めた3件と同じ形の正しい出力で、読み方を確かめる。
 */

const COMMAND = "make lint test smoke build";
const OPTIONS = { testCommand: COMMAND };

/** 実際の出力と同じ形：説明の文のあとに、1行の JSON を ```json で囲む。tests の閉じ括弧を fixed のときだけ付ける。 */
function reviewOutput(parts: {
  humanChecks: string[];
  dropped?: string[];
  summary: string;
  /** tests の閉じ括弧 } を付けるか（付けないのが、実際に読めなかった3件の形）。 */
  closeTests: boolean;
  exitCode?: number;
  verified?: boolean;
  environmentFailures?: string[];
}): string {
  const list = (items: string[]) => JSON.stringify(items);
  const tests = `"tests":{"command":${JSON.stringify(COMMAND)},"exitCode":${parts.exitCode ?? 2},"output":"Go が無く make test が失敗","missingCommands":[],"environmentFailures":${list(parts.environmentFailures ?? ["TestOrders：Go 1.22.12 がイメージに無い"])},"otherFailures":[]${parts.closeTests ? "}" : ""}`;
  return [
    "## 最終レビュー",
    "",
    "差分は依頼の受け入れ条件を満たしている。",
    "",
    "```json",
    `{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":${parts.verified ?? true},"reason":"受け入れ条件を満たす"}],"remarks":[],${tests},"humanChecks":${list(parts.humanChecks)}${parts.dropped ? `,"droppedHumanChecks":${list(parts.dropped)}` : ""},"outOfScope":[],"summary":${JSON.stringify(parts.summary)}}}`,
    "```",
  ].join("\n");
}

// 実際に読めなかった3件と同じ形：{ 4 に対して } 3（humanChecks が 2 件・3 件・0 件。3 件目は droppedHumanChecks も持つ）
const BROKEN = [
  reviewOutput({
    humanChecks: [
      "この環境だけの結果：Go 1.22.12 は入っていない",
      "範囲内か判断できない：api/internal",
    ],
    summary: "shipping_country を一貫して足している",
    closeTests: false,
  }),
  reviewOutput({
    humanChecks: [
      "この環境だけの結果：Go 1.22.12 は入っていない",
      "範囲内か判断できない：api/internal/handler",
      "Web の注文一覧の表示は実機で確かめる",
    ],
    summary: "依頼の受け入れ条件をすべて満たしている",
    closeTests: false,
  }),
  reviewOutput({
    humanChecks: [],
    dropped: [],
    summary: "shipping_country を、スキーマ、例、Go、Python、TS に一貫した並びで足している",
    closeTests: false,
  }),
];
// 読めた3件と同じ形（tests を閉じている）
const WELL_FORMED = BROKEN.map((_, i) => {
  const [a, b, c] = [
    reviewOutput({
      humanChecks: [
        "この環境だけの結果：Go 1.22.12 は入っていない",
        "Web の注文一覧は実機で確かめる",
      ],
      summary: "スキーマ・例・Go・Python・TS のモデルを揃えて足している",
      closeTests: true,
    }),
    reviewOutput({
      humanChecks: ["この環境だけの結果：Go 1.22.12 は入っていない"],
      summary: "差分は依頼の受け入れ条件をすべて満たしている",
      closeTests: true,
    }),
    reviewOutput({
      humanChecks: ["この環境だけの結果：pytest 9.2.0 の venv を複写して通した"],
      dropped: [],
      summary: "shipping_country は、スキーマ・共有の例・Go に一貫して足している",
      closeTests: true,
    }),
  ];
  return [a, b, c][i] as string;
});

const read = (output: string) => extractFinalReview(output, ["REQ"], [], OPTIONS);

describe("最終レビューの出力の、tests の閉じ括弧の欠け（PBI-298。S5 r4 の3件）", () => {
  it.each(BROKEN.map((output, i) => [i + 1, output] as const))(
    "実際に読めなかった%i件目と同じ形：tests の閉じ括弧を補って読み、humanChecks などが tests の外になる",
    (_i, output) => {
      const review = read(output);
      expect(review.unreadable).toBe(false);
      expect(review.passed).toBe(true);
      expect(review.viewpoints).toEqual([
        { viewpointId: "REQ", verified: true, reason: "受け入れ条件を満たす" },
      ]);
      // tests は、閉じ括弧の手前までの項目だけを持つ（humanChecks・outOfScope・summary を取り込まない）
      expect(review.tests).toEqual({
        command: COMMAND,
        exitCode: 2,
        output: "Go が無く make test が失敗",
        environmentFailures: ["TestOrders：Go 1.22.12 がイメージに無い"],
      });
      expect(review.summary).not.toBe("");
    },
  );

  it("humanChecks・summary は tests の外から読み、直した箇所は作業履歴に残す（どの項目の前に補ったか・位置）", () => {
    const review = read(BROKEN[0] as string);
    expect(review.humanChecks).toEqual([
      "この環境だけの結果：Go 1.22.12 は入っていない",
      "範囲内か判断できない：api/internal",
    ]);
    expect(review.summary).toBe("shipping_country を一貫して足している");
    const repaired = review.outputRepaired;
    expect(repaired).toMatchObject({
      code: "review.outputRepaired",
      params: { repairs: [{ kind: "brace", count: 1, line: 1, key: "humanChecks" }] },
    });
    const ja = renderMessage(repaired, "ja");
    expect(ja).toContain("直して読みました");
    expect(ja).toContain("humanChecks の前に補った");
    expect(renderMessage(repaired, "en")).toContain("added before humanChecks");
  });

  it("3件目：humanChecks が空・droppedHumanChecks も空でも、tests の外に読む", () => {
    const review = read(BROKEN[2] as string);
    expect(review.passed).toBe(true);
    expect(review.humanChecks).toBeUndefined();
    expect(review.tests?.environmentFailures).toEqual(["TestOrders：Go 1.22.12 がイメージに無い"]);
  });

  it("補って読んだ結果は、閉じ括弧を補った正しい出力を読んだ結果と同じ（作業履歴の注記だけが違う）", () => {
    for (const output of BROKEN) {
      const fixed = output.replace('"otherFailures":[]', '"otherFailures":[]}');
      const { outputRepaired, ...repaired } = read(output);
      expect(outputRepaired).toBeDefined();
      expect(repaired).toEqual(read(fixed));
      expect(read(fixed)).not.toHaveProperty("outputRepaired");
    }
  });

  it.each(WELL_FORMED.map((output, i) => [i + 1, output] as const))(
    "読めた%i件目と同じ形の正しい出力は、今までどおり読め、直した注記は付かない",
    (_i, output) => {
      const review = read(output);
      expect(review.unreadable).toBe(false);
      expect(review.passed).toBe(true);
      expect(review).not.toHaveProperty("outputRepaired");
      expect(review.tests).toMatchObject({
        exitCode: 2,
        environmentFailures: ["TestOrders：Go 1.22.12 がイメージに無い"],
      });
      expect(review.humanChecks?.length ?? 0).toBeGreaterThan(0);
      expect(review.summary).not.toBe("");
    },
  );

  it("補って読んでも、判定を甘くしない：観点が不合格・テストの終了コードが 0 でなく環境の失敗も無いときは、不合格のまま", () => {
    const failedViewpoint = read(
      reviewOutput({ humanChecks: [], summary: "足りない", closeTests: false, verified: false }),
    );
    expect(failedViewpoint.unreadable).toBe(false);
    expect(failedViewpoint.passed).toBe(false);
    const failedTests = read(
      reviewOutput({
        humanChecks: [],
        summary: "テストが落ちる",
        closeTests: false,
        exitCode: 1,
        environmentFailures: [],
      }),
    );
    expect(failedTests.unreadable).toBe(false);
    expect(failedTests.passed).toBe(false);
  });

  it.each([
    ["remarks", '"remarks":[],"summary":"ok"'],
    ["humanChecks", '"humanChecks":["確かめる"],"summary":"ok"'],
    ["droppedHumanChecks", '"droppedHumanChecks":[],"summary":"ok"'],
    ["outOfScope", '"outOfScope":[],"summary":"ok"'],
    ["summary", '"summary":"ok"'],
  ])("tests の次の項目が %s でも（項目の並びが違っても）補う", (key, rest) => {
    const head = `{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],${key === "remarks" ? "" : '"remarks":[],'}"tests":{"command":"${COMMAND}","exitCode":0,"output":"ok","otherFailures":[],`;
    const review = read(`\`\`\`json\n${head}${rest}}}\n\`\`\``);
    expect(review.unreadable).toBe(false);
    expect(review.passed).toBe(true);
    expect(review.summary).toBe("ok");
    expect(review.tests).toMatchObject({ exitCode: 0, output: "ok" });
    expect(review.outputRepaired).toMatchObject({
      params: { repairs: [{ kind: "brace", key }] },
    });
  });

  it("テストのコマンドが無いときも、tests の閉じ括弧を補って読む（humanChecks が tests の外になる）", () => {
    const output = `\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"tests":{"exitCode":0,"humanChecks":["実機で確かめる"],"summary":"ok"}}\n\`\`\``;
    const review = extractFinalReview(output, ["REQ"], []);
    expect(review.unreadable).toBe(false);
    expect(review.passed).toBe(true);
    expect(review.humanChecks).toEqual(["実機で確かめる"]);
    expect(review.summary).toBe("ok");
  });
});

describe("直し方が決まらない・直した結果が期待する形でないときは、推測で読まない（PBI-298）", () => {
  it("括弧が足りなくても、どこで閉じるか決まらない出力（tests の外の項目が無い）は読めない", () => {
    const output = `\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"tests":{"command":"${COMMAND}","exitCode":0,"output":"ok"}\n\`\`\``;
    const review = read(output);
    expect(review.unreadable).toBe(true);
    expect(review.passed).toBe(false);
  });

  it("入れ子の外にも同じ項目が既にある出力は、どちらが本物か決まらないので読まない", () => {
    const output = `\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"humanChecks":["外"],"tests":{"command":"${COMMAND}","exitCode":0,"output":"ok","humanChecks":["中"],"summary":"ok"}}\n\`\`\``;
    expect(read(output).unreadable).toBe(true);
  });

  it("補ったあとの見出しのオブジェクトに、tests の項目が現れる出力は読まない", () => {
    const output = `\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"tests":{"command":"${COMMAND}","exitCode":0,"humanChecks":[],"output":"ok","summary":"ok"}}\n\`\`\``;
    expect(read(output).unreadable).toBe(true);
  });

  it("直した結果に summary が無い・観点が配列でないなら、読まない（合格にしない）", () => {
    const noSummary = `\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"tests":{"command":"${COMMAND}","exitCode":0,"output":"ok","humanChecks":[]}}\n\`\`\``;
    expect(read(noSummary).unreadable).toBe(true);
    const notArray = `\`\`\`json\n{"sacty-final-review":{"viewpoints":{"REQ":true},"remarks":[],"tests":{"command":"${COMMAND}","exitCode":0,"humanChecks":[],"summary":"ok"}}\n\`\`\``;
    const review = read(notArray);
    expect(review.unreadable).toBe(true);
    expect(review.passed).toBe(false);
  });
});

describe("#298（PBI-293）が監査で扱った崩れも、最終レビューで直して読む", () => {
  it("文字列の中の二重引用符・改行を直して読み、直したことを残す", () => {
    const output = `\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"上限は "1,200" 件で、\n次の行も読める"}],"remarks":[],"tests":{"command":"${COMMAND}","exitCode":0,"output":"ok"},"humanChecks":[],"summary":"所見 "ok""}}\n\`\`\``;
    const review = read(output);
    expect(review.unreadable).toBe(false);
    expect(review.passed).toBe(true);
    expect(review.viewpoints[0]?.reason).toBe('上限は "1,200" 件で、\n次の行も読める');
    expect(review.summary).toBe('所見 "ok"');
    expect(review.outputRepaired).toMatchObject({
      code: "review.outputRepaired",
      params: { repairs: [{ kind: "quote" }, { kind: "control" }] },
    });
  });

  it("引用符の崩れと tests の閉じ括弧の欠けが重なっても読む", () => {
    const output = `\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"tests":{"command":"${COMMAND}","exitCode":0,"output":"ok","humanChecks":["確かめる "A" の表示"],"summary":"ok"}}\n\`\`\``;
    const review = read(output);
    expect(review.unreadable).toBe(false);
    expect(review.humanChecks).toEqual(['確かめる "A" の表示']);
    const kinds = (review.outputRepaired as { params: { repairs: { kind: string }[] } }).params
      .repairs;
    expect(kinds.map((r) => r.kind).sort()).toEqual(["brace", "quote"]);
  });
});

describe("直しても読めないときの、何が読めなかったかの記録（PBI-298）", () => {
  const broken = `説明\n\`\`\`json\n{"sacty-final-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"},"remarks":[],"summary":"ok"}}\n\`\`\``;

  it("壊れた位置（JSON の何行目の何文字目）と、壊れた所の前後を残す", () => {
    expect(read(broken).unreadable).toBe(true);
    const detail = finalReviewUnreadableDetail(broken, (t) => t);
    expect(detail).toMatchObject({ code: "review.unreadableAt", params: { line: 1 } });
    const params = (detail as { params: { column: number; near: string } }).params;
    expect(params.column).toBeGreaterThan(1);
    expect(params.near).toContain('"remarks"');
    expect(renderMessage(detail, "ja")).toContain("JSON の 1 行目の");
    expect(renderMessage(detail, "en")).toContain("line 1, column");
  });

  it("伏せる関数が無い・出力に（エスケープされた）秘密情報があるときは、前後の文字を残さず位置だけにする", () => {
    const hide = (t: string) => t.replaceAll("sk-live-secret", "[REDACTED]");
    expect((finalReviewUnreadableDetail(broken) as { params: { near: string } }).params.near).toBe(
      "",
    );
    const withSecret = broken.replace('"summary":"ok"', '"summary":"sk-live-secret"');
    expect(
      (finalReviewUnreadableDetail(withSecret, hide) as { params: { near: string } }).params.near,
    ).toBe("");
    // 境界をまたぐ位置にあっても、前後の文字に秘密情報は出ない
    const escaped = broken.replace('"summary":"ok"', '"summary":"sk-live-sec\\u0072et"');
    const detail = finalReviewUnreadableDetail(escaped, (t) => t.replaceAll("sk-live-secret", "X"));
    expect(JSON.stringify(detail)).not.toContain("sk-live-sec");
    expect((detail as { params: { line: number } }).params.line).toBe(1);
  });

  it("JSON が出力に無ければ理由は付けない。JSON は読めても項目が足りなければ、その旨を残す", () => {
    expect(finalReviewUnreadableDetail("判定なし", (t) => t)).toBeUndefined();
    const shape = '```json\n{"sacty-final-review":"x"}\n```';
    expect(finalReviewUnreadableDetail(shape, (t) => t)).toMatchObject({
      code: "review.unreadableShape",
    });
  });
});

describe("統合レビューの出力", () => {
  const ids = ["REQ"];

  it("文字列の中の二重引用符を直して読み、直したことを残す。本文からは判定の JSON を取り除く", () => {
    const output = `説明の文\n\`\`\`json\n{"sacty-integration-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"上限 "1,200" を満たす"}],"remarks":[],"findings":[],"summary":"ok"}}\n\`\`\``;
    const review = extractIntegrationReview(output, ids, []);
    expect(review.passed).toBe(true);
    expect(review.viewpoints[0]?.reason).toBe('上限 "1,200" を満たす');
    expect(review.output).toBe("説明の文");
    expect(review.outputRepaired).toMatchObject({
      code: "integrate.outputRepaired",
      params: { repairs: [{ kind: "quote", count: 2 }] },
    });
  });

  it("正しい出力は、今までどおり読め、注記は付かない", () => {
    const output = `\`\`\`json\n{"sacty-integration-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"findings":["足りない"],"summary":"ok"}}\n\`\`\``;
    const review = extractIntegrationReview(output, ids, []);
    expect(review.findings).toEqual(["足りない"]);
    expect(review.passed).toBe(false);
    expect(review).not.toHaveProperty("outputRepaired");
  });

  it("直しても読めなければ、不合格のまま、壊れた位置を所見に残す", () => {
    const output = `\`\`\`json\n{"sacty-integration-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"},"remarks":[],"findings":[],"summary":"ok"}}\n\`\`\``;
    const review = extractIntegrationReview(output, ids, [], (t) => t);
    expect(review.passed).toBe(false);
    expect(review.summary).toMatchObject({ code: "integrate.unreadableAt" });
    expect(renderMessage(review.summary, "ja")).toContain("JSON の 1 行目");
    // 伏せる関数が無ければ、位置だけ
    const bare = extractIntegrationReview(output, ids, []);
    expect(renderMessage(bare.summary, "ja")).not.toContain("：");
    // JSON が無ければ、これまでの文言
    expect(extractIntegrationReview("判定なし", ids, []).summary).toMatchObject({
      code: "integrate.unreadable",
    });
  });
});
