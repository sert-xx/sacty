/*
 * 指摘の内部の ID（`<工程のキー>-<回>-<番号>`）を、人が読む文から除く（PBI-471）。エージェントが書いた文（実装の説明・
 * 最後の直し・対応の文・要点・後続に回したい理由）は、指示で ID を書かせないが、書かれたときは、組み立てで文を壊さずに除く。
 * 葉のモジュール（ほかの sacty のモジュールに依存しない）。
 */

const STEP_KEYS =
  "(?:investigate|review|requirements|design|split|integrate|reproduce|implement|deployment|document|operation)";
/** 指摘の ID 1つ。直後の「〜1-6」のような範囲の終わりも、ID の一部とみなす。 */
const ID = `${STEP_KEYS}-\\d+-\\d+(?:[〜~]\\d+-\\d+)?`;
/** 区切り（と・、・,）で並ぶ ID。 */
const ID_LIST = `${ID}(?:\\s*[、,・と]\\s*${ID})*`;
/** 置き換えたあと、日本語の語が続くときは、間の空白を詰める。 */
const SPACE_BEFORE_CJK = "[ \\u3000]*(?=[\\u3000-\\u9fff\\uff00-\\uffef]|$)";

const PARENTHESIZED = new RegExp(
  `(?<![ \\u3000])[ \\u3000]*[（(]\\s*${ID_LIST}\\s*(?:への対応|の対応|に対応)?\\s*[）)]`,
  "g",
);
const AFTER_REMARK_WORD = new RegExp(`指摘\\s*${ID_LIST}${SPACE_BEFORE_CJK}`, "g");
const BARE = new RegExp(`${ID_LIST}${SPACE_BEFORE_CJK}`, "g");

/**
 * 文の中の指摘の ID を、文を壊さずに除く。規則は上から順に当て、当たった所は次の規則に回さない。
 * 1. 括弧の中が ID・区切り・「への対応」だけなら、括弧ごと除く
 * 2. 「指摘」の後ろの ID は、除く（「指摘 implement-1-3 を」→「指摘を」）
 * 3. 区切りで並ぶ ID と、4. それ以外の文の中の ID は、「指摘」に置き換える
 */
export function withoutRemarkIds(text: string): string {
  return text.replace(PARENTHESIZED, "").replace(AFTER_REMARK_WORD, "指摘").replace(BARE, "指摘");
}

/** 要点（gist）の長さの上限（文字数。末尾の … を含む）。 */
export const GIST_MAX = 120;

/** 上限（末尾の … を含めて max 文字）で切る。文字の途中（サロゲートペアの間）では切らない。 */
export function cutWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uDC00-\uDFFF]/.test(text[max - 1] ?? "") ? max - 2 : max - 1;
  return `${text.slice(0, end)}…`;
}

/** 要点を、記録する形にする。改行・前後の空白を除いて1行にし、上限で切る。 */
export function normalizeGist(raw: string): string {
  return cutWithEllipsis(raw.replace(/\s+/g, " ").trim(), GIST_MAX);
}
