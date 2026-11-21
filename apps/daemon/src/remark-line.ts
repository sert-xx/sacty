import { publicText } from "./human-ask-notice.js";
import { cutWithEllipsis, GIST_MAX, withoutRemarkIds } from "./remark-ids.js";

/*
 * 指摘を示す1行（PBI-471）。PR の説明の要点・各コメント・Issue の題と本文・後続のタスクの題に、共通に使う。
 * 元は、指摘の要点（gist）。無ければ、指摘の全文から、行の内容の写しと目印・見出し・引用の行を除いた最初の行。
 */

/** 指摘の全文の末尾に添える、コメントが付いた行の内容（lineContextText）の目印。 */
const LINE_CONTEXT = "（コメントが付いた行の内容：";

/** URL（`http(s)://`・大文字小文字を問わない）と、リンクになりうる `www.`・`//host`。 */
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:)?\/\/\S+|\bwww\.\S+/gi;

/** 指摘の全文から、要点の元になる最初の行を取る。目印の HTML コメントと、空・`#`・`>` で始まる行は飛ばす。 */
export function firstMeaningfulLine(text: string): string {
  const at = text.lastIndexOf(`\n${LINE_CONTEXT}`);
  const body = (at >= 0 && text.endsWith("）") ? text.slice(0, at) : text).replace(
    /<!--[\s\S]*?-->/g,
    " ",
  );
  return (
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("#") && !line.startsWith(">")) ?? ""
  );
}

/**
 * 指摘を示す1行。秘密の値・内部のパスを伏せ、`@` を無効にし、改行を空白にし、URL・UUID・指摘の ID を除いて、上限で切る
 * （末尾の … を含めて max 文字）。示せるものが無ければ空文字列。
 */
export function remarkLine(
  remark: { gist?: string; text: string },
  secrets: readonly string[],
  max: number = GIST_MAX,
): string {
  const source = remark.gist?.trim() ? remark.gist : firstMeaningfulLine(remark.text);
  // 伏せてから整える（複数行の秘密の値を、行で切ってから伏せると見つけられない）
  const hidden = publicText(source, secrets, Number.MAX_SAFE_INTEGER);
  const flat = withoutRemarkIds(
    hidden
      .replace(/\s+/g, " ")
      .replace(URL_LIKE, "")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  return cutWithEllipsis(flat, max);
}

/**
 * 本文に載せるとき、記法として効かせずに文字として出す。行の頭の `#`・`>`・`-`・`+`・`*` と、バッククォート、
 * リンク・HTML コメント・タグ・課題の参照（`owner/repo#12`）になる `<`・`>`・`[`・`]`・`#` を、行のどこにあっても逃がす。
 */
export function markdownText(line: string): string {
  return line.replace(/^([-+*])/, "\\$1").replace(/[`<>[\]#]/g, (c) => `\\${c}`);
}
