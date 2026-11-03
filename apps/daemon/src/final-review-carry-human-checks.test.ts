import type { FinalReview, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildFinalReviewPrompt,
  buildPullRequestBody,
  carriedHumanChecks,
  extractFinalReview,
} from "./prompts.js";

/*
 * 最終レビューのやり直しで、前の回が「人が確かめること」に挙げた項目（「範囲内か判断できない」とした変更を含む）を、根拠なしに
 * 次の回で落とさない（PBI-294。S16 r3 の振る舞いの回帰を防ぐ）。引き継ぎは sacty が行い、ゴールガーディアンが外せるのは、
 * 理由を書いたときだけ。前の回が無い最終レビュー（1回目）の振る舞いは変えない。
 */

const RATE = '率の検査が Number() で読むので、1e1・0x10・" 5 " も整数として受ける';
const QUEUE = "範囲内か判断できない：src/queue.ts の直列化のキュー（設計に無い）";

const block = (b: Record<string, unknown>) =>
  `\`\`\`json\n${JSON.stringify({ "sacty-final-review": b })}\n\`\`\``;

const verdict = (extra: Record<string, unknown> = {}) =>
  block({
    viewpoints: [{ id: "REQ", verified: true, reason: "検証している" }],
    remarks: [],
    summary: "ok",
    ...extra,
  });

const read = (
  output: string,
  previousHumanChecks?: readonly string[],
  testCommand: string | null = "npm test",
) =>
  extractFinalReview(output, ["REQ"], [], {
    ...(testCommand ? { testCommand } : {}),
    ...(previousHumanChecks ? { previousHumanChecks } : {}),
  });

const PASSED = { tests: { exitCode: 0, output: "" } };

const task = (extra: Partial<Task> = {}) =>
  ({
    id: "t-1",
    title: "請求の率を設定する",
    body: "率を設定できるようにする",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: { implement: "# 実装の説明" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["rate.test.ts"] }],
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

const review = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: false,
  viewpoints: [{ viewpointId: "REQ", verified: false, reason: "範囲外の変更" }],
  remarks: [],
  summary: "不合格",
  tests: { command: "npm test", exitCode: 0, output: "" },
  humanChecks: [RATE, QUEUE],
  agentId: "claude",
  runId: "r1",
  costUsd: 0,
  estimated: false,
  at: "2026-11-03T10:00:00.000Z",
  ...extra,
});

describe("前の回の人が確かめることを引き継ぐ対象（PBI-294）", () => {
  it("前の回の humanChecks を、順に引き継ぐ。範囲内か判断できないとした変更も含む", () => {
    expect(carriedHumanChecks(task({ lastReview: review() }))).toEqual([RATE, QUEUE]);
  });

  it("前の回が無い・挙げていないときは、引き継ぐものが無い（空・1件・複数件）", () => {
    expect(carriedHumanChecks(task())).toEqual([]);
    expect(carriedHumanChecks(task({ lastReview: review({ humanChecks: undefined }) }))).toEqual(
      [],
    );
    expect(carriedHumanChecks(task({ lastReview: review({ humanChecks: [] }) }))).toEqual([]);
    expect(carriedHumanChecks(task({ lastReview: review({ humanChecks: [RATE] }) }))).toEqual([
      RATE,
    ]);
  });

  it("sacty が毎回作る、実行できなかった検証の項目（最後の1件）は引き継がない", () => {
    const last = review({
      humanChecks: [RATE, "go がイメージに無く、検証を実行できませんでした"],
      tests: { command: "go test", output: "", missingCommands: ["go"] },
    });
    expect(carriedHumanChecks(task({ lastReview: last }))).toEqual([RATE]);
    // 申告された項目だけで、sacty が作った項目が無いときは、最後の項目も引き継ぐ
    expect(carriedHumanChecks(task({ lastReview: review({ humanChecks: [RATE] }) }))).toEqual([
      RATE,
    ]);
  });
});

describe("最終レビューの指示（PBI-294）", () => {
  it("前の回が無い最終レビュー（1回目）の指示には、引き継ぎの節も droppedHumanChecks も出さない", () => {
    for (const t of [task(), task({ lastReview: review({ humanChecks: [] }) })]) {
      for (const testCommand of ["npm test", undefined]) {
        const prompt = buildFinalReviewPrompt(t, "diff", testCommand ? { testCommand } : {});
        expect(prompt).not.toContain("前の回の最終レビューが挙げた");
        expect(prompt).not.toContain("droppedHumanChecks");
        expect(prompt).toContain('"humanChecks":[]');
      }
    }
  });

  it("やり直しの最終レビューの指示に、前の回の項目を番号つきで渡し、根拠なしに落とさないことと外す条件を書く", () => {
    const prompt = buildFinalReviewPrompt(task({ lastReview: review() }), "diff", {
      testCommand: "npm test",
    });
    expect(prompt).toContain("--- 前の回の最終レビューが挙げた、人が確かめること ---");
    expect(prompt).toContain(`- [P1] ${RATE}`);
    expect(prompt).toContain(`- [P2] ${QUEUE}`);
    expect(prompt).toContain("これらを根拠なしに落とさない");
    expect(prompt).toContain("sacty があなたの humanChecks に足して");
    // 外してよいのは、解消を確かめたときと、判定の誤りを確かめたときだけ。理由を書く
    expect(prompt).toContain("droppedHumanChecks に「<番号>：<外す理由>」");
    expect(prompt).toContain("その項目の懸念が、今のコードでは解消している");
    expect(prompt).toContain("前の回の判定が誤りだった");
    expect(prompt).toContain("コードが前の回と変わっていない");
    expect(prompt).toContain("理由を示さずに範囲内として扱わない");
    // 判定の形式にも、外す項目の欄を出す
    expect(prompt).toContain('"humanChecks":[],"droppedHumanChecks":[]');
    expect(prompt).toContain("droppedHumanChecks には、上の「前の回の最終レビューが挙げた");
  });

  it("テストのコマンドが無いタスクの指示にも、判定の形式に外す項目の欄を出す", () => {
    const prompt = buildFinalReviewPrompt(task({ lastReview: review() }), "diff");
    expect(prompt).toContain('"humanChecks":[],"droppedHumanChecks":[]');
  });

  it("前の回の項目は改行を1行にし、長いものは指示に載せるときだけ切り詰める（引き継ぐ本文は切り詰めない）", () => {
    const long = `長い項目：${"あ".repeat(2_000)}`;
    const t = task({ lastReview: review({ humanChecks: ["1行目\n2行目", long] }) });
    const prompt = buildFinalReviewPrompt(t, "diff");
    expect(prompt).toContain("- [P1] 1行目 2行目");
    expect(prompt).not.toContain("あ".repeat(2_000));
    expect(carriedHumanChecks(t)[1]).toBe(long);
  });

  it("指示は、特定の言語・ツールに寄せない", () => {
    const prompt = buildFinalReviewPrompt(task({ lastReview: review() }), "diff");
    const start = prompt.indexOf("--- 前の回の最終レビューが挙げた、人が確かめること ---");
    const section = prompt.slice(start, prompt.indexOf("\n\n", start));
    for (const word of [
      "npm",
      "Node",
      "TypeScript",
      "vitest",
      "Jest",
      "pytest",
      "sacty のコード",
    ]) {
      expect(section, word).not.toContain(word);
    }
  });
});

describe("前の回の人が確かめることの引き継ぎ（PBI-294）", () => {
  it("前の回が無ければ、これまでどおり（引き継がず、droppedHumanChecks も付けない）", () => {
    const first = read(verdict({ ...PASSED, humanChecks: ["実機で確かめる"] }));
    expect(first.humanChecks).toEqual(["実機で確かめる"]);
    expect(first).not.toHaveProperty("droppedHumanChecks");
    expect(read(verdict(PASSED))).not.toHaveProperty("humanChecks");
    // 空の前の回と、前の回の指定が無いときは同じ
    expect(read(verdict(PASSED), [])).not.toHaveProperty("humanChecks");
    // 前の回が無いのに、外す申告があっても読まない
    const stray = read(verdict({ ...PASSED, droppedHumanChecks: ["P1：解消した"] }));
    expect(stray).not.toHaveProperty("droppedHumanChecks");
    expect(stray).not.toHaveProperty("humanChecks");
  });

  it("S16 r3：ゴールガーディアンが humanChecks を空で返しても、前の回の項目が残る（空・1件・複数件）", () => {
    for (const previous of [[RATE], [RATE, QUEUE], [RATE, QUEUE, "目視で確かめる"]]) {
      const second = read(verdict({ ...PASSED, humanChecks: [] }), previous);
      expect(second.humanChecks, String(previous.length)).toEqual(previous);
      expect(second).not.toHaveProperty("droppedHumanChecks");
    }
    // humanChecks の欄が無くても、テストのコマンドが無いタスクでも残る
    expect(read(verdict(PASSED), [RATE]).humanChecks).toEqual([RATE]);
    expect(read(verdict(), [RATE, QUEUE], null).humanChecks).toEqual([RATE, QUEUE]);
  });

  it("新しく見つけた項目は、引き継いだ項目の後ろに足す。同じ文の項目は重ねない", () => {
    const second = read(
      verdict({ ...PASSED, humanChecks: ["新しい確認", ` ${RATE} `, "別の確認"] }),
      [RATE, QUEUE],
    );
    expect(second.humanChecks).toEqual([RATE, QUEUE, "新しい確認", "別の確認"]);
  });

  it("理由を書いて外した項目だけを外し、外した項目と理由を記録する。ほかは引き継ぐ", () => {
    const second = read(
      verdict({
        ...PASSED,
        droppedHumanChecks: [
          "P2：キューは設計の「直列に処理する」に当たると、設計書の節で確かめた。範囲内",
        ],
      }),
      [RATE, QUEUE],
    );
    expect(second.humanChecks).toEqual([RATE]);
    expect(second.droppedHumanChecks).toEqual([
      `${QUEUE} → 外した理由：キューは設計の「直列に処理する」に当たると、設計書の節で確かめた。範囲内`,
    ]);
    // すべて外せば、humanChecks は付けない
    const all = read(
      verdict({
        ...PASSED,
        droppedHumanChecks: [
          "P1：検査が数字の文字列だけを受けるようになった",
          "[P2] 範囲内と確かめた",
        ],
      }),
      [RATE, QUEUE],
    );
    expect(all).not.toHaveProperty("humanChecks");
    expect(all.droppedHumanChecks).toHaveLength(2);
  });

  it("理由が無い・番号が合わない・重なった申告では、外さずに引き継ぐ（根拠なしに落とさない）", () => {
    const previous = [RATE, QUEUE];
    for (const dropped of [
      ["P1"],
      ["P1："],
      ["P1：なし"],
      ["P0：理由"],
      ["P3：理由"],
      ["理由だけ"],
      ["P1.5：理由"],
      [""],
      [42, null],
      "P1：理由",
    ]) {
      const second = read(verdict({ ...PASSED, droppedHumanChecks: dropped }), previous);
      expect(second.humanChecks, JSON.stringify(dropped)).toEqual(previous);
      expect(second, JSON.stringify(dropped)).not.toHaveProperty("droppedHumanChecks");
    }
    // 同じ番号が重なっても、最初の申告で外す（2回目は無視）
    const twice = read(
      verdict({ ...PASSED, droppedHumanChecks: ["P1：理由A", "P1：理由B"] }),
      previous,
    );
    expect(twice.humanChecks).toEqual([QUEUE]);
    expect(twice.droppedHumanChecks).toEqual([`${RATE} → 外した理由：理由A`]);
  });

  it("外す申告が、オブジェクトや全角の番号・区切りでも読める", () => {
    const objectForm = read(
      verdict({ ...PASSED, droppedHumanChecks: [{ name: "P1", reason: "解消した" }] }),
      [RATE, QUEUE],
    );
    expect(objectForm.humanChecks).toEqual([QUEUE]);
    const fullWidth = read(verdict({ ...PASSED, droppedHumanChecks: ["Ｐ２：解消した"] }), [
      RATE,
      QUEUE,
    ]);
    expect(fullWidth.humanChecks).toEqual([RATE]);
  });

  it("不合格の判定でも、合否と関係なく引き継ぐ。判定の合否は変えない", () => {
    const failing = read(
      block({
        viewpoints: [{ id: "REQ", verified: false, reason: "形だけ" }],
        remarks: [],
        ...PASSED,
        summary: "ng",
      }),
      [RATE],
    );
    expect(failing.passed).toBe(false);
    expect(failing.humanChecks).toEqual([RATE]);
    expect(read(verdict(PASSED), [RATE]).passed).toBe(true);
  });

  it("実行できなかった検証の項目（差分が文書だけ）は、引き継いだ項目の後ろに1件だけ付く", () => {
    const second = extractFinalReview(
      verdict({ tests: { exitCode: 127, output: "", missingCommands: ["prettier"] } }),
      ["REQ"],
      [],
      {
        testCommand: "prettier --check . && echo ok",
        documentsOnly: true,
        previousHumanChecks: [RATE],
      },
    );
    expect(second.humanChecks).toHaveLength(2);
    expect(second.humanChecks?.[0]).toBe(RATE);
    expect(second.humanChecks?.[1]).toContain("prettier がテストを実行したイメージに入っていない");
  });

  it("判定を読み取れなかったとき（記録しない）は、引き継ぎも外しも起きない", () => {
    const unreadable = read("判定なし", [RATE]);
    expect(unreadable.unreadable).toBe(true);
    expect(unreadable).not.toHaveProperty("droppedHumanChecks");
  });

  it("3回目以降も、2回目の判定（引き継いだ項目を含む）から引き継ぐ", () => {
    const second = read(verdict({ ...PASSED, humanChecks: ["新しい確認"] }), [RATE, QUEUE]);
    const t = task({
      lastReview: review({ humanChecks: second.humanChecks as string[] }),
    });
    expect(carriedHumanChecks(t)).toEqual([RATE, QUEUE, "新しい確認"]);
    const third = read(verdict({ ...PASSED, humanChecks: [] }), carriedHumanChecks(t));
    expect(third.humanChecks).toEqual([RATE, QUEUE, "新しい確認"]);
  });
});

describe("引き継いだ項目の出方（PBI-294）", () => {
  it("引き継いだ項目は、実装の PR の本文の「人が確かめること」に、今までと同じ形で出る", () => {
    const second = read(verdict({ ...PASSED, humanChecks: [] }), [RATE, QUEUE]);
    const body = buildPullRequestBody(
      task({
        lastReview: review({
          passed: true,
          humanChecks: second.humanChecks as string[],
        }),
      }),
    );
    expect(body).toContain(
      [
        "**人が確かめること**（作業領域では確かめられなかったこと。マージの前に確かめてください）",
        "",
        `- [ ] ${RATE}`,
        `- [ ] ${QUEUE}`,
      ].join("\n"),
    );
  });
});
