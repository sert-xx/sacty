import { describe, expect, it } from "vitest";
import { extractIntegrationReview } from "./prompts.js";

/**
 * 統合レビューの、前の回の「人が確かめること」を外す申告の読み取り（PBI-382）。外すのは、番号・外す種類・理由がそろった
 * オブジェクトだけ。文の中身や区切りの記号では、外すかどうかを決めない。
 */

/** 前の回が checks を挙げ、今回の統合レビューが claims を外す申告（droppedHumanChecks）として答えたときの、読み取った結果。 */
function read(checks: readonly string[], claims: unknown) {
  const output = [
    "# 統合できている",
    "",
    "```json",
    JSON.stringify({
      "sacty-integration-review": {
        viewpoints: [{ id: "TV-1", verified: true, reason: "満たす" }],
        remarks: [],
        findings: [],
        droppedHumanChecks: claims,
        summary: "満たす",
      },
    }),
    "```",
  ].join("\n");
  return extractIntegrationReview(output, ["TV-1"], [], undefined, checks);
}

/** 記録に残る、読み取れなかった申告の文字（文字列は前後の空白を除いたもの。ほかは JSON の文字）。 */
const recorded = (claim: unknown) =>
  typeof claim === "string" ? claim.trim() : JSON.stringify(claim);

/** 1件ずつ答えたとき・配列でない値で答えたとき・まとめて答えたときの、答えの組。 */
const eachAndAll = (claims: readonly unknown[]): unknown[] => [
  ...claims.map((claim) => [claim]),
  ...claims.filter((claim) => !Array.isArray(claim)),
  claims,
];

const CHECKS = ["実機で確かめる", "本番で確かめる", "目視で確かめる", "端末で確かめる"];

describe("統合レビューの、人が確かめることを外す申告の読み取り（PBI-382）", () => {
  it("番号・外す種類・理由がそろったオブジェクトで外す。番号と外す種類の書き方の揺れは読む", () => {
    const review = read(CHECKS, [
      { id: "H1", resolution: "verified", reason: "足したテストで確かめられた" },
      { id: "H2", resolution: "obsolete", reason: "その機能を消した" },
      // 番号の全角・小文字・角括弧・空白と、外す種類の大文字・前後の空白は読む。理由の文は、書かれたまま残す
      { id: "［ｈ ３］", resolution: " Verified ", reason: "全角の理由（そのまま）：Ａ" },
      // 同じ番号の2つ目の申告は、採らない
      { id: "H1", resolution: "obsolete", reason: "2つ目" },
    ]);
    expect(review.passed).toBe(true);
    expect(review.humanChecks).toEqual([CHECKS[3]]);
    expect(review.droppedHumanChecks).toEqual([
      { check: CHECKS[0], reason: "足したテストで確かめられた" },
      { check: CHECKS[1], reason: "その機能を消した" },
      { check: CHECKS[2], reason: "全角の理由（そのまま）：Ａ" },
    ]);
    expect(review.unreadDroppedHumanChecks).toBeUndefined();
  });

  it("配列でない1つのオブジェクトも、外す申告として読む", () => {
    const review = read(CHECKS, { id: "H4", resolution: "obsolete", reason: "要らなくなった" });
    expect(review.humanChecks).toEqual(CHECKS.slice(0, 3));
    expect(review.droppedHumanChecks).toEqual([{ check: CHECKS[3], reason: "要らなくなった" }]);
  });

  it("外さない意図の文は、区切りの記号があっても、外す申告として読まない。文字列の申告は、外さずに記録する", () => {
    const claims = [
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
      // 文字列は、外す意図の文でも、外す申告として読まない（文の中身で判定しない）
      "H2：今回足した結合テストで確かめられた",
      "H2: verified",
      '{"id": "H2", "resolution": "verified", "reason": "文字列の中の JSON"}',
    ];
    for (const answered of eachAndAll(claims)) {
      const review = read(CHECKS, answered);
      const label = JSON.stringify(answered);
      expect(review.humanChecks, label).toEqual(CHECKS);
      expect(review.droppedHumanChecks, label).toBeUndefined();
      expect(review.unreadDroppedHumanChecks, label).toEqual(
        (Array.isArray(answered) ? answered : [answered]).map(recorded),
      );
    }
  });

  it("外す種類が決まった値でない・理由が無い・番号が1つでない・形が違うオブジェクトは、外さずに記録する", () => {
    const claims = [
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
      // 番号が1つでない（理由が一部の番号だけに当たっていても、どれも外さない）・番号でない・前の回に無い
      { id: "H1、H2", resolution: "verified", reason: "H1 は確かめられた。H2 はまだ" },
      { id: "H1,H2", resolution: "verified", reason: "まとめて" },
      { id: "H1H2", resolution: "verified", reason: "続けて" },
      { id: ["H1"], resolution: "verified", reason: "配列の番号" },
      { id: "H5", resolution: "verified", reason: "無い番号" },
      { id: "H0", resolution: "verified", reason: "無い番号" },
      { id: "H-1", resolution: "verified", reason: "無い番号" },
      { id: "H1.5", resolution: "verified", reason: "無い番号" },
      { id: "H1234567", resolution: "verified", reason: "桁の多い番号" },
      { id: "1", resolution: "verified", reason: "H の無い番号" },
      { id: 1, resolution: "verified", reason: "数の番号" },
      { id: "H1 は外さない", resolution: "verified", reason: "番号に文" },
      { id: `H1${" ".repeat(40)}`, resolution: "verified", reason: "長い番号" },
      { resolution: "verified", reason: "番号が無い" },
      // 指示の形の説明を書き写したもの
      { id: "<番号>", resolution: "<verified か obsolete>", reason: "<外す理由>" },
      // オブジェクトでない
      ["H1", "verified", "配列"],
      7,
      true,
    ];
    for (const answered of eachAndAll(claims)) {
      const review = read(CHECKS, answered);
      const label = JSON.stringify(answered);
      expect(review.humanChecks, label).toEqual(CHECKS);
      expect(review.droppedHumanChecks, label).toBeUndefined();
      expect(review.unreadDroppedHumanChecks, label).toEqual(
        (Array.isArray(answered) ? answered : [answered]).map(recorded),
      );
    }
  });

  it("同じ番号に、外す申告と、外す申告として読めない申告の両方があるときは、外さない", () => {
    const DROP1 = { id: "H1", resolution: "verified", reason: "確かめられた" };
    const KEEP1 = { id: "h1", resolution: "keep", reason: "やはり確かめられない" };
    const DROP2 = { id: "H2", resolution: "obsolete", reason: "要らなくなった" };
    for (const answered of [
      [DROP1, KEEP1, DROP2],
      [KEEP1, DROP2, DROP1],
    ]) {
      const review = read(CHECKS, answered);
      expect(review.humanChecks).toEqual([CHECKS[0], CHECKS[2], CHECKS[3]]);
      expect(review.droppedHumanChecks).toEqual([{ check: CHECKS[1], reason: "要らなくなった" }]);
      expect(review.unreadDroppedHumanChecks).toEqual([
        JSON.stringify(KEEP1),
        JSON.stringify(DROP1),
      ]);
    }
  });

  it("前の回の項目が無ければ、外す申告は何も外さず、読み取れなかったものとして記録する", () => {
    const claim = { id: "H1", resolution: "verified", reason: "確かめられた" };
    const review = read([], [claim]);
    expect(review.humanChecks).toBeUndefined();
    expect(review.droppedHumanChecks).toBeUndefined();
    expect(review.unreadDroppedHumanChecks).toEqual([JSON.stringify(claim)]);
  });

  it("外す申告が無い・空・null なら、前の回の項目をそのまま引き継ぎ、何も記録しない", () => {
    for (const claims of [undefined, [], null, [""], ["  "]]) {
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
      { id: `H1${" ".repeat(LONG)}`, resolution: "verified", reason: "長い番号" },
      { id: "H2", resolution: `verified${" ".repeat(LONG)}`, reason: "長い外す種類" },
    ];
    // 時間は比べない（環境で揺れる）。長さの2乗の時間がかかる読み方なら、この長さでは、テストの制限時間を超える
    const review = read(CHECKS, claims);
    expect(review.humanChecks).toEqual(CHECKS);
    expect(review.droppedHumanChecks).toBeUndefined();
    expect(review.unreadDroppedHumanChecks).toHaveLength(4);
  });
});
