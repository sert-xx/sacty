import { type FinalReview, LAST_FIX_HEADING, splitLastFix, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildFinalReviewPrompt,
  buildPrompt,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  carriedHumanChecks,
  extractFinalReview,
  joinBodyText,
} from "./prompts.js";

/*
 * 作り直しの後の PR の本文を、最後の直しの説明ではなく PR 全体の説明にし、「人が確かめること」を回をまたいで重複させない
 * （PBI-299。S5 r4 の F44）。
 */

const FEATURE = [
  "注文に shipping_country を足し、スキーマ・Go の API・Python のワーカー・Web に通しました。",
  "",
  "- スキーマ：shipping_country を必須にし、pattern ^[A-Z]{2}$ を付けた",
  "- API：入力検証と seed を足した",
  "- ワーカー：国別かつ通貨別の売上集計を足した",
  "- Web：注文一覧に配送先の列を足した",
  "",
  "## 検証",
  "",
  "`make lint test smoke build` がすべて成功しました。",
].join("\n");

const FIX1 = "最終レビューの指摘で、Go の Validate の検査の順番を元に戻しました。";
const FIX2 = "人の差し戻しで、Python の Order と共有の例の項目の位置を揃えました。";
const FIX3 = "AI のレビューの指摘で、README の集計の説明を直しました。";

const withFix = (whole: string, fix: string) => `${whole}\n\n## ${LAST_FIX_HEADING}\n\n${fix}`;

const task = (extra: Record<string, unknown> = {}) =>
  ({
    id: "t-1",
    title: "注文に配送先の国コードを足す",
    body: "注文に配送先の国コードを足す",
    steps: [{ key: "implement", state: "active" }],
    remarks: [],
    outputs: { implement: FEATURE },
    approved: {},
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["a.test.ts › 国コード"] }],
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

const reviewed = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: true,
  viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
  remarks: [],
  summary: "合格。shipping_country が全体に通っている。",
  tests: { command: "make test", exitCode: 0, output: "" },
  agentId: "claude",
  runId: "r1",
  costUsd: 0,
  estimated: false,
  at: "2026-11-04T10:00:00.000Z",
  ...extra,
});

const bodyOf = (t: Task) => joinBodyText(buildPullRequestBodyText(t));

/**
 * 本文の節（sacty が付ける次の見出しの手前まで。実装の説明の中の「## 検証」などは、節の中に含まれる）。
 */
const SACTY_HEADINGS = ["結論", "要求要件", "変更", LAST_FIX_HEADING, "観点 → テスト → 実行結果"];
const section = (body: string, heading: string) => {
  const start = body.indexOf(`\n## ${heading}\n`);
  if (start < 0) return undefined;
  const rest = body.slice(start + 1);
  const ends = SACTY_HEADINGS.filter((h) => h !== heading)
    .map((h) => rest.indexOf(`\n## ${h}\n`))
    .filter((at) => at > 0);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
};

describe("実装の説明から「最後の直し」の節を分ける（PBI-299）", () => {
  it("節が無ければ、説明は変えない", () => {
    expect(splitLastFix(FEATURE)).toEqual({ whole: FEATURE });
  });

  it("節を分け、残りを全体の説明にする。節は次の同じかより上の階層の見出しまで", () => {
    const text = `${FEATURE}\n\n## ${LAST_FIX_HEADING}\n\n${FIX1}\n\n### 補足\n\n小見出しは節の中\n\n## この環境だけの結果\n\nGo を入れた`;
    const split = splitLastFix(text);
    expect(split.fix).toBe(`${FIX1}\n\n### 補足\n\n小見出しは節の中`);
    expect(split.whole).toContain("## 検証");
    expect(split.whole).toContain("## この環境だけの結果\n\nGo を入れた");
    expect(split.whole).not.toContain(FIX1);
  });

  it("コードブロックの中の見出しは読まない。節だけが空なら fix は空文字", () => {
    const code = `${FEATURE}\n\n\`\`\`md\n## ${LAST_FIX_HEADING}\n\`\`\``;
    expect(splitLastFix(code)).toEqual({ whole: code });
    expect(splitLastFix(`${FEATURE}\n\n## ${LAST_FIX_HEADING}\n`).fix).toBe("");
  });
});

describe("作り直しの後の PR の本文は、PR 全体の説明にする（PBI-299）", () => {
  // S5 r4：最初の実装 → 最終レビューの不合格で直す → 人の差し戻しで直す、の3回の提出
  const reworked = (history: string[]) =>
    task({ outputs: { implement: history[history.length - 1] }, implementHistory: history });

  it("2回作り直しても、結論・変更・検証に機能全体が残り、最後の直しは別の節に分かれる", () => {
    const history = [FEATURE, withFix(FEATURE, FIX1), withFix(FEATURE, FIX2)];
    const body = bodyOf(reworked(history));
    // 結論：変更は全体、最後の直しは別の行
    const conclusion = section(body, "結論") ?? "";
    expect(conclusion).toContain("- 変更：注文に shipping_country を足し");
    expect(conclusion).toContain(`- ${LAST_FIX_HEADING}：${FIX2}`);
    // 変更・検証は全体の説明。最後の直しの文も、前の直しの文も混ざらない
    const changes = section(body, "変更") ?? "";
    expect(changes).toContain("- Web：注文一覧に配送先の列を足した");
    expect(changes).toContain("## 検証");
    expect(changes).not.toContain(FIX2);
    expect(body).not.toContain(FIX1);
    // 最後の直しは結論に載せた1段落で足りるので、同じ文を別の節に重ねない（PBI-302 C2）
    expect(section(body, LAST_FIX_HEADING)).toBeUndefined();
    expect(body.split(FIX2)).toHaveLength(2);
  });

  it("エージェントが節を書かず、最後の直しだけを書いたときも、最後に全体の説明だった提出を土台にして、最後の説明を最後の直しに回す", () => {
    // 2回目は全体の説明に直した（節あり）。3回目は直しだけを書いた（節なし）
    const history = [FEATURE, withFix(`${FEATURE}\n- 2回目で足した行`, FIX1), FIX2];
    const body = bodyOf(reworked(history));
    const changes = section(body, "変更") ?? "";
    expect(changes).toContain("- 2回目で足した行");
    expect(changes).toContain("- Web：注文一覧に配送先の列を足した");
    expect(changes).not.toContain(FIX1);
    expect(section(body, "結論")).toContain(`- ${LAST_FIX_HEADING}：${FIX2}`);
    expect(section(body, "結論")).toContain("- 変更：注文に shipping_country を足し");
  });

  it("直しだけを書く提出が続いたら、最初の提出（機能全体）を土台にする。1件・2件・3件の履歴", () => {
    for (const history of [
      [FEATURE, FIX1],
      [FEATURE, FIX1, FIX2],
      [FEATURE, FIX1, FIX2, FIX3],
    ]) {
      const body = bodyOf(reworked(history));
      const last = history[history.length - 1] ?? "";
      expect(section(body, "変更"), history.length.toString()).toContain(
        "- Web：注文一覧に配送先の列を足した",
      );
      expect(section(body, "結論")).toContain(`- ${LAST_FIX_HEADING}：${last}`);
      // 最後以外の直しの説明は、本文に出さない
      for (const middle of history.slice(1, -1)) expect(body).not.toContain(middle);
    }
  });

  it("作り直しが無いタスクの本文は、履歴の有無にかかわらず、今までと変わらない", () => {
    const plain = bodyOf(task());
    expect(bodyOf(task({ implementHistory: [FEATURE] }))).toBe(plain);
    expect(plain).not.toContain(LAST_FIX_HEADING);
    expect(section(plain, "変更")).toContain("- Web：注文一覧に配送先の列を足した");
    // テンプレートに沿わせる本文も同じ
    expect(buildPullRequestBodyParts(task({ implementHistory: [FEATURE] }))).toEqual(
      buildPullRequestBodyParts(task()),
    );
  });

  it("最初の提出（前の提出が無い）は、節を書いていても、説明を変えない（直す対象が無い）", () => {
    const text = `${FEATURE}\n\n## ${LAST_FIX_HEADING}\n\n何かを直した`;
    const body = bodyOf(task({ outputs: { implement: text }, implementHistory: [text] }));
    expect(body).toBe(bodyOf(task({ outputs: { implement: text } })));
    expect(body).not.toContain(`- ${LAST_FIX_HEADING}：`);
  });

  it("履歴が上限で古い提出を捨てていても、持っている土台（implementBase）を全体の説明に使う", () => {
    const fixes = Array.from({ length: 10 }, (_, i) => `直し ${i + 2}`);
    const body = bodyOf(
      task({
        outputs: { implement: "直し 12" },
        implementBase: FEATURE,
        implementHistory: [...fixes.slice(0, 9), "直し 12"],
      }),
    );
    expect(section(body, "変更")).toContain("- Web：注文一覧に配送先の列を足した");
    expect(section(body, "結論")).toContain(`- ${LAST_FIX_HEADING}：直し 12`);
    expect(body).not.toContain("直し 5");
  });

  it("履歴の最後が現在の説明と食い違っても（人が直した等）、現在の説明を最後の直しとして扱い、落とさない", () => {
    const body = bodyOf(task({ outputs: { implement: FIX3 }, implementHistory: [FEATURE, FIX1] }));
    expect(section(body, "結論")).toContain(`- ${LAST_FIX_HEADING}：${FIX3}`);
    expect(section(body, "変更")).toContain("- Web：注文一覧に配送先の列を足した");
  });

  it("使った秘密の値は、全体の説明の土台にした前の提出の説明からも伏せる", () => {
    const secret = "sk-test-1234567890abcdef";
    const t = task({
      outputs: { implement: FIX1 },
      implementHistory: [`${FEATURE}\n- 接続の鍵は ${secret}`, FIX1],
    });
    const body = joinBodyText(buildPullRequestBodyText(t, { secrets: [secret] }));
    expect(body).toContain("- Web：注文一覧に配送先の列を足した");
    expect(body).not.toContain(secret);
    expect(JSON.stringify(buildPullRequestBodyParts(t, { secrets: [secret] }))).not.toContain(
      secret,
    );
  });

  it("テンプレートに沿わせる本文の「変更」にも、全体の説明に続けて、最後の直しを分けて載せる", () => {
    const parts = buildPullRequestBodyParts(
      reworked([FEATURE, withFix(FEATURE, FIX1), withFix(FEATURE, FIX2)]),
    );
    expect(parts.changes).toContain("- API：入力検証と seed を足した");
    expect(parts.changes).toContain(`**${LAST_FIX_HEADING}**\n\n${FIX2}`);
    expect(parts.changes).not.toContain(FIX1);
    expect(parts.changes?.indexOf("- API：")).toBeLessThan(
      parts.changes?.indexOf(`**${LAST_FIX_HEADING}**`) ?? -1,
    );
  });

  it("観点表のテストは、直しの後も全体のまま出る", () => {
    const tests = Array.from({ length: 18 }, (_, i) => `t${i}.test.ts › ケース ${i}`);
    const body = bodyOf(
      task({
        testMap: [{ viewpointId: "REQ", tests }],
        outputs: { implement: withFix(FEATURE, FIX2) },
        implementHistory: [FEATURE, withFix(FEATURE, FIX2)],
      }),
    );
    expect(body).toContain("ほか 17 件");
  });
});

describe("直しの実行の指示（PBI-299）", () => {
  it("前の実装の説明があるときだけ、全体の説明にすることと、最後の直しの節を指示する。最初の実行の指示は変えない", () => {
    const first = buildPrompt(task({ outputs: {} }), "implement");
    expect(first).not.toContain(LAST_FIX_HEADING);
    for (const t of [
      task({ approved: { requirements: { output: "# 要求要件", submission: 1 } } }),
      task({ noTestsReason: "テストの仕組みが無い" }),
    ]) {
      const prompt = buildPrompt(t, "implement");
      expect(prompt).toContain("--- 前回の実装の説明 ---");
      expect(prompt).toContain("この PR が加える変更の全体の説明にする");
      expect(prompt).toContain(`「## ${LAST_FIX_HEADING}」の節を1つだけ作って書く`);
      expect(prompt).toContain("観点とテストの対応も、この PR の全体の対応にする");
    }
  });
});

describe("回をまたいだ「人が確かめること」は同じ趣旨を1件にまとめる（PBI-299）", () => {
  // S5 r4：回ごとに少しずつ違う文で、同じ趣旨の「この環境だけの結果」が挙がった
  const ENV1 =
    "この環境だけの結果：Go 1.22.12（.sacty-tools/go）と、pip・pytest 9.2.0・ruff 0.17.3 の venv を入れて make lint test smoke build を通した。入れていない環境では確かめていない";
  const ENV2 =
    "この環境だけの結果：Go 1.22.12（.sacty-tools/go）と、pytest・ruff を入れた venv を入れて make lint test smoke build を通した（make setup はイメージに python3-venv が無く失敗）。入れていない環境では確かめていない";
  const ENV3 =
    "この環境だけの結果：Go 1.22.12（.sacty-tools/go）と、pytest 9.2.0・ruff 0.17.3 の venv（複写した worker/.venv）を入れて make lint test smoke build を通した（make setup はイメージに python3-venv が無く失敗）。入れていない環境では確かめていない";
  const WEB =
    "Web の注文一覧に「配送先」の列が顧客の次に出て、国コードが見やすく表示されることを、ブラウザで目で見て確かめる";

  const block = (b: Record<string, unknown>) =>
    `\`\`\`json\n${JSON.stringify({ "sacty-final-review": b })}\n\`\`\``;
  const verdict = (extra: Record<string, unknown> = {}) =>
    block({
      viewpoints: [{ id: "REQ", verified: true, reason: "検証している" }],
      remarks: [],
      summary: "ok",
      tests: { exitCode: 0, output: "" },
      ...extra,
    });
  const read = (output: string, previous?: readonly string[]) =>
    extractFinalReview(output, ["REQ"], [], {
      testCommand: "make test",
      ...(previous ? { previousHumanChecks: previous } : {}),
    });

  it("S5 r4：3回の最終レビューが言い換えた「この環境だけの結果」は、本文に1件だけ出る。同じ趣旨でない項目は残る", () => {
    const first = read(verdict({ humanChecks: [ENV1, WEB] }));
    expect(first.humanChecks).toEqual([ENV1, WEB]);
    expect(first.mergedHumanChecks).toBeUndefined();
    const second = read(verdict({ humanChecks: [ENV2] }), first.humanChecks);
    expect(second.humanChecks).toEqual([ENV2, WEB]);
    const third = read(verdict({ humanChecks: [ENV3] }), second.humanChecks);
    expect(third.humanChecks).toEqual([ENV3, WEB]);
    expect(third.mergedHumanChecks).toEqual([`${ENV2} → 書き直し：${ENV3}`]);
    // PR の本文でも、環境だけの結果は1件
    const body = bodyOf(
      task({ lastReview: reviewed({ humanChecks: third.humanChecks as string[] }) }),
    );
    expect(body.match(/この環境だけの結果：/g)).toHaveLength(1);
    expect(body).toContain(`- [ ] ${WEB}`);
  });

  it("ゴールガーディアンが前の回の項目を書き直した申告（updatedHumanChecks）は、その項目を置き換える。元の文は記録に残る", () => {
    const previous = [WEB, "決済の画面を実機で確かめる"];
    const updated =
      "Web の注文一覧に「配送先」の列が出て、JP・FR・US の国コードが表示されることを、ブラウザで確かめる";
    const result = read(
      verdict({ humanChecks: [], updatedHumanChecks: [`P1：${updated}`] }),
      previous,
    );
    expect(result.humanChecks).toEqual([updated, "決済の画面を実機で確かめる"]);
    expect(result.mergedHumanChecks).toEqual([`${WEB} → 書き直し：${updated}`]);
    expect(result.droppedHumanChecks).toBeUndefined();
  });

  it("#296 の決まりは弱めない：書き直しの申告が無い・番号が合わない・文が空なら、前の項目を元のまま引き継ぐ", () => {
    const previous = [WEB, "決済の画面を実機で確かめる"];
    for (const updatedHumanChecks of [
      undefined,
      [],
      ["P3：存在しない番号"],
      ["P0：番号が小さすぎる"],
      ["P1：なし"],
      ["P1："],
      ["書き直した、番号のない文"],
    ]) {
      const result = read(
        verdict({ humanChecks: [], ...(updatedHumanChecks ? { updatedHumanChecks } : {}) }),
        previous,
      );
      expect(result.humanChecks, JSON.stringify(updatedHumanChecks)).toEqual(previous);
      expect(result.mergedHumanChecks).toBeUndefined();
    }
  });

  it("#296 の決まりは弱めない：理由なしに外せない。外す申告と書き直しが重なったら外す理由のほうを使う", () => {
    const previous = [WEB, "決済の画面を実機で確かめる"];
    // 外す理由が無い（書き直しだけ）ときは外さない
    const kept = read(verdict({ humanChecks: [], droppedHumanChecks: ["P1："] }), previous);
    expect(kept.humanChecks).toEqual(previous);
    // 外す理由があり、書き直しも重なったら、外す
    const dropped = read(
      verdict({
        humanChecks: [],
        droppedHumanChecks: ["P1：画面を直して列が出ることをテストで確かめた"],
        updatedHumanChecks: ["P1：書き直した文"],
      }),
      previous,
    );
    expect(dropped.humanChecks).toEqual(["決済の画面を実機で確かめる"]);
    expect(dropped.droppedHumanChecks).toHaveLength(1);
    expect(dropped.mergedHumanChecks).toBeUndefined();
  });

  it("書き直しと同じ趣旨の新しい項目を、さらに書いても、重ならない（書き方の違いだけの項目は1件）", () => {
    const previous = [WEB];
    const rewritten = "Web の注文一覧の「配送先」の列を、ブラウザで確かめる";
    const result = read(
      verdict({
        humanChecks: ["web の注文一覧の「配送先」の列を、ブラウザで確かめる。", "別の確認"],
        updatedHumanChecks: [`P1：${rewritten}`],
      }),
      previous,
    );
    // 書き直した文と、全角半角・文末の句点・大文字小文字だけが違う項目は重ねない
    expect(result.humanChecks).toEqual([rewritten, "別の確認"]);
    // 書き方の違いでまとめたことも記録する
    expect(result.mergedHumanChecks).toEqual([
      `${WEB} → 書き直し：${rewritten}`,
      `web の注文一覧の「配送先」の列を、ブラウザで確かめる。 → 同じ項目：${rewritten}`,
    ]);
  });

  it("書き方の違いだけの項目をまとめたら、前の回の項目と新しい項目のどちらの場合も記録する。文字列として同じ項目は記録しない", () => {
    const a = "Web の表示を確かめる";
    const b = "web の表示を確かめる。";
    const carried = read(verdict({ humanChecks: [b] }), [a]);
    expect(carried.humanChecks).toEqual([a]);
    expect(carried.mergedHumanChecks).toEqual([`${b} → 同じ項目：${a}`]);
    const within = read(verdict({ humanChecks: [a, b] }));
    expect(within.humanChecks).toEqual([a]);
    expect(within.mergedHumanChecks).toEqual([`${b} → 同じ項目：${a}`]);
    // 同じ文は、情報が減らないので記録しない（空・1件・複数件の境界）
    expect(read(verdict({ humanChecks: [a] }), [a]).mergedHumanChecks).toBeUndefined();
    expect(read(verdict({ humanChecks: [a, a] })).mergedHumanChecks).toBeUndefined();
  });

  it("記号だけが違う別の項目（版の番号・パス）は、同じ項目として落とさない", () => {
    const result = read(
      verdict({ humanChecks: ["Go 1.22.12 で確かめる", "src/a.ts を確かめる"] }),
      ["Go 1.2.212 で確かめる", "src/at.s を確かめる"],
    );
    expect(result.humanChecks).toHaveLength(4);
  });

  it("同じ見出しでない項目や、前の回が無いときは、まとめない（空・1件・複数件）", () => {
    expect(read(verdict({ humanChecks: [] })).humanChecks).toBeUndefined();
    expect(read(verdict({ humanChecks: [WEB] })).humanChecks).toEqual([WEB]);
    const two = read(verdict({ humanChecks: [WEB, "Web の注文詳細に配送先が出ることを確かめる"] }));
    expect(two.humanChecks).toHaveLength(2);
    expect(two.mergedHumanChecks).toBeUndefined();
    // 前の回の環境だけの結果は、新しい回が書かなければそのまま引き継ぐ
    expect(read(verdict({ humanChecks: [] }), [ENV1]).humanChecks).toEqual([ENV1]);
  });

  it("同じ回に、同じ見出しの項目が複数挙がっても、1件にまとめる。最初の項目の位置に、最後の文を置く", () => {
    const result = read(verdict({ humanChecks: [ENV1, WEB, ENV3] }));
    expect(result.humanChecks).toEqual([ENV3, WEB]);
    expect(result.mergedHumanChecks).toHaveLength(1);
  });

  it("全角のコロンの見出しも、同じ見出しとして1件にまとめる", () => {
    const result = read(verdict({ humanChecks: [ENV2.replace("：", ":")] }), [ENV1]);
    expect(result.humanChecks).toHaveLength(1);
  });

  it("実行できなかった検証の項目（差分が文書だけ）は、まとめた項目の後ろに1件だけ付く", () => {
    const output = block({
      viewpoints: [{ id: "REQ", verified: true, reason: "ok" }],
      remarks: [],
      summary: "ok",
      humanChecks: [ENV2],
      tests: { exitCode: 1, output: "make: not found", missingCommands: ["make"] },
    });
    const result = extractFinalReview(output, ["REQ"], [], {
      testCommand: "make test",
      documentsOnly: true,
      previousHumanChecks: [ENV1],
    });
    expect(result.humanChecks?.[0]).toBe(ENV2);
    expect(result.humanChecks).toHaveLength(2);
  });

  it("指示：前の回の項目と同じ趣旨なら、新しく書かず updatedHumanChecks に書き直す。弱めないこと・違う趣旨は別にすることも書く", () => {
    const prompt = buildFinalReviewPrompt(
      task({ lastReview: reviewed({ humanChecks: [ENV1, WEB] }) }),
      "diff",
      { testCommand: "make test" },
    );
    expect(prompt).toContain('"humanChecks":[],"droppedHumanChecks":[],"updatedHumanChecks":[]');
    expect(prompt).toContain("updatedHumanChecks に「<番号>：<書き直した項目>」");
    expect(prompt).toContain(
      "前の回の項目が人に確かめさせようとしたことを弱めたり、落としたりしない",
    );
    expect(prompt).toContain("違う趣旨の項目は、書き直さず、別の項目のまま");
    expect(prompt).toContain(
      "updatedHumanChecks には、この回で見つけたことが、上の項目と同じ趣旨のとき",
    );
    // 前の回の項目が「この環境だけの結果」なら、その見出しの扱いも書く
    expect(prompt).toContain("「この環境だけの結果」の項目は、タスクで1件にする");
    // 前の回が無い1回目と、環境だけの結果が無い回には出さない
    const firstRound = buildFinalReviewPrompt(task(), "diff", { testCommand: "make test" });
    expect(firstRound).not.toContain("updatedHumanChecks");
    const noEnvironment = buildFinalReviewPrompt(
      task({ lastReview: reviewed({ humanChecks: [WEB] }) }),
      "diff",
      { testCommand: "make test" },
    );
    expect(noEnvironment).toContain("updatedHumanChecks");
    expect(noEnvironment).not.toContain("「この環境だけの結果」の項目は、タスクで1件にする");
    expect(
      carriedHumanChecks(task({ lastReview: reviewed({ humanChecks: [ENV1, WEB] }) })),
    ).toEqual([ENV1, WEB]);
  });
});
