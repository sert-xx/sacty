import { describe, expect, it } from "vitest";
import { extractIntegrationReview } from "./prompts.js";

/**
 * 統合レビューの、前の回の「人が確かめること」を外す申告の読み取り（PBI-382）。外すのは、答えの外す申告のすべてが、
 * 番号・外す種類・理由のそろったオブジェクトのときだけ。決まった形でない申告が1つでもあれば、その回は、何も外さない。
 * 文の中身・区切りの記号・番号らしい並びでは、外すかどうかを決めない。
 */

/** 前の回が checks を挙げ、今回の統合レビューが claims を外す申告（droppedHumanChecks）として答えたときの、読み取った結果。 */
function read(checks: readonly string[], claims: unknown, humanChecks: readonly string[] = []) {
  const output = [
    "# 統合できている",
    "",
    "```json",
    JSON.stringify({
      "sacty-integration-review": {
        viewpoints: [{ id: "TV-1", verified: true, reason: "満たす" }],
        remarks: [],
        findings: [],
        humanChecks,
        droppedHumanChecks: claims,
        summary: "満たす",
      },
    }),
    "```",
  ].join("\n");
  return extractIntegrationReview(output, ["TV-1"], [], undefined, checks);
}

/** 記録に残る、採らなかった申告の文字（文字列は前後の空白を除いたもの。空の文字列と、ほかの値は JSON の文字）。 */
const recorded = (claim: unknown) =>
  (typeof claim === "string" ? claim.trim() : "") || JSON.stringify(claim);

const CHECKS = ["実機で確かめる", "本番で確かめる", "目視で確かめる", "端末で確かめる"];

/** 決まった形の外す申告。 */
const DROP1 = { id: "H1", resolution: "verified", reason: "確かめた" };
const DROP2 = { id: "H2", resolution: "verified", reason: "足したテストで確かめられた" };
const DROP3 = { id: "H3", resolution: "obsolete", reason: "要らなくなった" };

/** 決まった形でない申告：文字列（外さない意図の文・外す意図の文・番号の無い文）。 */
const STRINGS = [
  // 区切りの記号つきの、外さない意図の文
  "H1：外さない",
  "H1：まだ確かめられないので外さない",
  "H1 - 外さない",
  "H1 - まだ確かめていない",
  "H1－未確認",
  "[H1] — 未確認のまま",
  "- Ｈ１：外せない",
  "H1: keep",
  "H1: not verified yet",
  "H1 - cannot be verified in this workspace",
  "h1: still open",
  "H1 は、まだ確かめられないので外さない",
  "H1、H2：H1 は確かめられた。H2 はまだ",
  "H1、H2 は外さない",
  // 範囲・省略
  "H1〜H3 はまだ",
  "H1-3 はまだ",
  "H1,2 はまだ",
  // H の無い番号
  "1：外さない",
  "#1 は外さない",
  "1番目の項目は外さない",
  // 番号の無い、全体の否定。項目の文そのものを引いた文
  "どれも外さない",
  "すべて未確認",
  "none of them can be removed",
  `${CHECKS[0]} は外さない`,
  // 記号入り・長い空白
  "H-1 keep",
  "H#1",
  "H         1 keep",
  // 外す意図の文でも、文字列は、決まった形でない
  "H2：今回足した結合テストで確かめられた",
  "H2: verified",
  '{"id": "H2", "resolution": "verified", "reason": "文字列の中の JSON"}',
  // 番号と関係の無い文
  "verified with 2 tests",
  "h1 タグの表示は目視",
  "確かめられたので外す",
  // 空の文字列
  "",
  "  ",
];

/** 決まった形でない申告：オブジェクトと、ほかの値。 */
const OTHERS: unknown[] = [
  // 外す種類が無い・決まった値でない・文字列でない
  { id: "H1", reason: "確かめられた" },
  { id: "H1", resolution: "keep", reason: "まだ確かめられない" },
  { id: "H1", resolution: "not verified", reason: "まだ" },
  { id: "H1", resolution: "unverified", reason: "まだ" },
  { id: "H1", resolution: "verified?", reason: "たぶん" },
  { id: "H1", resolution: "verified か obsolete", reason: "どちらか" },
  { id: "H1", resolution: "確かめられた", reason: "決まった値でない" },
  { id: "H1", resolution: true, reason: "確かめられた" },
  { id: "H1", resolution: ["verified"], reason: "配列" },
  { id: "H1", resolution: `verified${" ".repeat(40)}`, reason: "長い値" },
  // 理由が無い・空・文字列でない
  { id: "H1", resolution: "verified" },
  { id: "H1", resolution: "verified", reason: "" },
  { id: "H1", resolution: "verified", reason: " \n" },
  { id: "H1", resolution: "verified", reason: ["確かめられた"] },
  // 番号が1つでない・番号でない・前の回に無い
  { id: "H1、H2", resolution: "verified", reason: "H1 は確かめられた。H2 はまだ" },
  { id: "H1,H2", resolution: "keep", reason: "どちらもまだ" },
  { id: "H1H2", resolution: "verified", reason: "続けて" },
  { id: ["H1"], resolution: "verified", reason: "配列の番号" },
  { ids: [1, 2], resolution: "keep", reason: "まだ" },
  { id: "H5", resolution: "verified", reason: "無い番号" },
  { id: "H0", resolution: "verified", reason: "無い番号" },
  { id: "H-1", resolution: "verified", reason: "無い番号" },
  { id: "H1.5", resolution: "verified", reason: "無い番号" },
  { id: "H1234567", resolution: "verified", reason: "桁の多い番号" },
  { id: "1", resolution: "keep", reason: "H の無い番号" },
  { id: 1, resolution: "keep", reason: "数の番号" },
  { id: 1, resolution: "verified", reason: "数の番号" },
  { id: "H1 は外さない", resolution: "keep", reason: "番号に文" },
  { id: `H1${" ".repeat(40)}`, resolution: "verified", reason: "長い番号" },
  { number: "H1", resolution: "keep", reason: "まだ" },
  { resolution: "verified", reason: "番号が無い" },
  {},
  // 指示の形の説明を書き写したもの
  { id: "<番号>", resolution: "<verified か obsolete>", reason: "<外す理由>" },
  // オブジェクトでない
  ["H1", "verified", "配列"],
  [DROP1],
  7,
  true,
  null,
];

describe("統合レビューの、人が確かめることを外す申告の読み取り（PBI-382）", () => {
  it("決まった形の申告だけなら外す。番号と外す種類の書き方の揺れは読む", () => {
    const review = read(CHECKS, [
      DROP1,
      { id: "H2", resolution: "obsolete", reason: "その機能を消した" },
      // 番号の全角・小文字・角括弧・空白と、外す種類の大文字・前後の空白は読む。理由の文は、書かれたまま残す
      { id: "［ｈ ３］", resolution: " Verified ", reason: "H4 と同じテスト（全角のまま）：Ａ" },
      // 同じ番号の2つ目の申告は、使わない
      { id: "H1", resolution: "obsolete", reason: "2つ目" },
    ]);
    expect(review.passed).toBe(true);
    expect(review.humanChecks).toEqual([CHECKS[3]]);
    expect(review.droppedHumanChecks).toEqual([
      { check: CHECKS[0], reason: "確かめた" },
      { check: CHECKS[1], reason: "その機能を消した" },
      { check: CHECKS[2], reason: "H4 と同じテスト（全角のまま）：Ａ" },
    ]);
    expect(review.unreadDroppedHumanChecks).toBeUndefined();
  });

  it("配列でない1つのオブジェクトも、外す申告として読む。外した項目は、同じ答えが挙げ直しても戻さない", () => {
    const review = read(CHECKS, { id: "H4", resolution: "obsolete", reason: "要らなくなった" }, [
      "新しく挙げた項目",
      CHECKS[3],
      CHECKS[0],
    ]);
    expect(review.humanChecks).toEqual([...CHECKS.slice(0, 3), "新しく挙げた項目"]);
    expect(review.droppedHumanChecks).toEqual([{ check: CHECKS[3], reason: "要らなくなった" }]);
    expect(review.unreadDroppedHumanChecks).toBeUndefined();
  });

  it("決まった形でない申告は、1件だけでも、配列でない値でも、何も外さずに記録する", () => {
    for (const claim of [...STRINGS, ...OTHERS]) {
      for (const answered of Array.isArray(claim) ? [[claim]] : [[claim], claim]) {
        const review = read(CHECKS, answered);
        const label = JSON.stringify(answered);
        expect(review.humanChecks, label).toEqual(CHECKS);
        expect(review.droppedHumanChecks, label).toBeUndefined();
        // 配列でない null は、申告が無いものとして扱う（何も記録しない）
        expect(review.unreadDroppedHumanChecks, label).toEqual(
          answered === null ? undefined : [recorded(claim)],
        );
      }
    }
  });

  it("決まった形でない申告が1つでも混ざると、同じ番号・関係の無い番号の、決まった形の申告も外さない", () => {
    for (const claim of [...STRINGS, ...OTHERS]) {
      for (const answered of [
        [claim, DROP1, DROP2, DROP3],
        [DROP1, DROP2, DROP3, claim],
        [DROP2, claim],
      ]) {
        const review = read(CHECKS, answered);
        const label = JSON.stringify(answered);
        expect(review.humanChecks, label).toEqual(CHECKS);
        expect(review.droppedHumanChecks, label).toBeUndefined();
        // 決まった形でない申告を先に、採らなかった決まった形の申告をその後に、すべて記録する
        expect(review.unreadDroppedHumanChecks, label).toEqual([
          recorded(claim),
          ...answered.filter((c) => c !== claim).map((c) => JSON.stringify(c)),
        ]);
      }
    }
  });

  it("前の回の項目が無ければ、外す申告は何も外さず、採らなかったものとして記録する", () => {
    const review = read([], [DROP1]);
    expect(review.humanChecks).toBeUndefined();
    expect(review.droppedHumanChecks).toBeUndefined();
    expect(review.unreadDroppedHumanChecks).toEqual([JSON.stringify(DROP1)]);
  });

  it("外す申告が無い・空・null なら、前の回の項目をそのまま引き継ぎ、何も記録しない", () => {
    for (const claims of [undefined, [], null]) {
      const review = read(CHECKS, claims);
      expect(review.humanChecks).toEqual(CHECKS);
      expect(review.droppedHumanChecks).toBeUndefined();
      expect(review.unreadDroppedHumanChecks).toBeUndefined();
    }
  });

  it("外す申告の項目が長くても、読み取りにかかる時間が、長さの2乗で増えない", () => {
    const LONG = 400_000;
    const claims = [
      `H1${" ".repeat(LONG)}x`,
      `H1：${" \n".repeat(LONG / 2)}x`,
      `${"H ".repeat(LONG / 2)}x`,
      "H1".repeat(LONG / 2),
      { id: `H1${" ".repeat(LONG)}`, resolution: "verified", reason: "長い番号" },
      { id: "H2", resolution: `verified${" ".repeat(LONG)}`, reason: "長い外す種類" },
    ];
    // 時間は比べない（環境で揺れる）。長さの2乗の時間がかかる読み方なら、この長さでは、テストの制限時間を超える
    const review = read(CHECKS, claims);
    expect(review.humanChecks).toEqual(CHECKS);
    expect(review.droppedHumanChecks).toBeUndefined();
    expect(review.unreadDroppedHumanChecks).toHaveLength(6);
    // 決まった形の申告の、長い理由
    const long = read(CHECKS, [{ ...DROP1, reason: ` ${"長".repeat(LONG)} ` }]);
    expect(long.droppedHumanChecks).toEqual([{ check: CHECKS[0], reason: "長".repeat(LONG) }]);
  });
});
