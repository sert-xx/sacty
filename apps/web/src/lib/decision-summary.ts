/**
 * 差し戻しの判断の文（戻し先の判断が書いた、戻し先と理由。PBI-301。以前の版ではゴールガーディアン）を、画面で先に見せる要点にする。
 * 判断の文は 600〜1,000 文字になることがあり、そのまま出すと読みにくい。理由の先頭には、指摘がどの決定を変えるか（変えないか）
 * が短く書かれているので、先頭の 1〜2 文を要点にし、全文は開いて読めるようにする。作業履歴（イベント）と、実行に渡す判断文は
 * 全文のまま。
 */

/** 要点の文の数の上限。 */
const SUMMARY_SENTENCES_MAX = 2;
/** 要点の文字数の上限（超えたら、切って「…」を付ける）。 */
export const SUMMARY_CHARS_MAX = 160;

/** 開き括弧・閉じ括弧（括弧の中の句点では文を終えない）。 */
const OPENERS = "「『（(“";
const CLOSERS = "」』）)”";

/** 文の終わりの位置（その文の次の文字の位置）を、先頭から順に返す。句点・英語の終止符（空白か末尾が続くもの）・改行で終わる。 */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === "\n") {
      depth = 0;
      ends.push(i + 1);
      i += 1;
      continue;
    }
    const japanese = "。！？".includes(ch);
    const english =
      ".!?".includes(ch) && (i + 1 >= text.length || /\s/.test(text[i + 1] as string));
    if (depth === 0 && (japanese || english)) {
      let j = i + 1;
      while (j < text.length && "。！？".includes(text[j] as string)) j += 1;
      ends.push(j);
      i = j;
      continue;
    }
    i += 1;
  }
  if (ends.at(-1) !== text.length) ends.push(text.length);
  return ends;
}

/**
 * 判断の文の要点。短い（要点が全文と同じ）ときは full を持たない。長いときは、先頭の 1〜2 文（文字数の上限まで）を
 * summary にし、全文を full に持つ。
 */
export function summarizeDecision(text: string): { summary: string; full?: string } {
  const whole = text.trim();
  const ends = sentenceEnds(whole).filter((end) => whole.slice(0, end).trim() !== "");
  const upto = ends[Math.min(SUMMARY_SENTENCES_MAX, ends.length) - 1] ?? whole.length;
  let summary = whole
    .slice(0, upto)
    .replace(/\s*\n\s*/g, " ")
    .trim();
  const truncated = summary.length > SUMMARY_CHARS_MAX;
  if (truncated) summary = `${summary.slice(0, SUMMARY_CHARS_MAX)}…`;
  return whole.slice(upto).trim() === "" && !truncated ? { summary } : { summary, full: whole };
}
