/*
 * Markdown の文に埋め込む文字列の整え方（PR の本文・コメントのリンクとコード）。
 */

/** URL のパスの1区切り。Markdown のリンク先を閉じる括弧も符号にする。 */
export function urlPathSegment(text: string): string {
  return encodeURIComponent(text).replace(
    /[()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** インラインのコード。中にバッククォートがあれば、それより長いバッククォートで囲む。 */
export function markdownCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
