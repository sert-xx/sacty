import { CONTAINER_WORKSPACE } from "./agents/docker.js";

/** コードブロックの囲みの始まり・終わりの行（``` か ~~~）。 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** リンクの表示の文字として、`](` から前へ探す長さの上限（文字）。長い行で、探す時間が行の長さの二乗にならないようにする。 */
const LABEL_MAX = 1_000;
/** リンク先として、`](` から後ろへ読む長さの上限（文字）。 */
const TARGET_MAX = 2_000;

/**
 * 行の中のインラインコード（同じ数のバッククォートで囲んだ範囲）の位置。バッククォートの並びを1回で拾い、同じ長さの次の並びを
 * 閉じとして対にする（行の長さに比例する時間で済ませる）。
 */
function codeSpans(line: string): { start: number; end: number }[] {
  const runs: { at: number; length: number }[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "`") continue;
    let end = i;
    while (line[end] === "`") end++;
    runs.push({ at: i, length: end - i });
    i = end - 1;
  }
  // 長さごとの、並びの番号（昇順）と、次に見る位置
  const sameLength = new Map<number, { indexes: number[]; next: number }>();
  for (const [index, run] of runs.entries()) {
    const entry = sameLength.get(run.length) ?? { indexes: [], next: 0 };
    entry.indexes.push(index);
    sameLength.set(run.length, entry);
  }
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    const entry = open && sameLength.get(open.length);
    if (!open || !entry) continue;
    while (entry.next < entry.indexes.length && (entry.indexes[entry.next] ?? 0) <= i) entry.next++;
    const closeIndex = entry.indexes[entry.next];
    const close = closeIndex === undefined ? undefined : runs[closeIndex];
    if (closeIndex === undefined || !close) continue;
    spans.push({ start: open.at, end: close.at + close.length });
    i = closeIndex;
  }
  return spans;
}

/** `](` の後ろのリンク先が作業領域（とその下）なら、作業領域からの相対パスと、リンクの終わり（`)` の次）の位置。 */
function workspaceTarget(line: string, from: number): { path: string; end: number } | undefined {
  const close = line.indexOf(")", from);
  if (close < 0 || close - from > TARGET_MAX) return undefined;
  // リンク先（`<…>` で囲んだ形も）と、後ろの題（"…"）
  const inner = /^\s*<?([^\s>"]*)>?(?:\s+"[^"]*")?\s*$/.exec(line.slice(from, close))?.[1];
  if (inner === undefined) return undefined;
  if (inner === CONTAINER_WORKSPACE) return { path: "", end: close + 1 };
  if (!inner.startsWith(`${CONTAINER_WORKSPACE}/`)) return undefined;
  return { path: inner.slice(CONTAINER_WORKSPACE.length + 1), end: close + 1 };
}

/** `](` の前の、リンクの表示の文字の始まり（`[` の位置）。見つからなければ無い。入れ子の角括弧は読まない。 */
function labelStart(line: string, bracket: number, floor: number): number | undefined {
  for (let i = bracket - 1; i >= Math.max(floor, bracket - LABEL_MAX); i--) {
    if (line[i] === "]") return undefined;
    if (line[i] === "[" && line[i - 1] !== "\\") return i;
  }
  return undefined;
}

/** 1行の、作業領域へのリンクを外す。 */
function withoutLinksInLine(line: string): string {
  let spans: { start: number; end: number }[] | undefined;
  let out = "";
  let done = 0;
  for (let at = line.indexOf("]("); at >= 0; at = line.indexOf("](", at + 2)) {
    const target = workspaceTarget(line, at + 2);
    if (!target) continue;
    const open = labelStart(line, at, done);
    if (open === undefined) continue;
    // 画像（`![…](…)`）は、`!` ごと置き換える
    const start = open > done && line[open - 1] === "!" ? open - 1 : open;
    spans ??= codeSpans(line);
    if (spans.some((s) => s.start < start && start < s.end)) continue;
    const label = line.slice(open + 1, at);
    // 表示の文字にパス（行・節の指定を除く）が出ていれば、文字だけを残す
    const file = target.path.replace(/[#?].*$/, "").replace(/\/+$/, "");
    const text =
      file === "" || label.includes(file)
        ? label || `\`${target.path}\``
        : label.trim() === ""
          ? `\`${target.path}\``
          : `${label}（\`${target.path}\`）`;
    out += line.slice(done, start) + text;
    done = target.end;
    at = target.end - 2;
  }
  return out + line.slice(done);
}

/**
 * PR の本文から、コンテナの作業領域のパスへのリンクを外す（PBI-366）。エージェントの説明に、作業領域の絶対パスへのリンク
 * （`[README.md](/workspace/README.md)`）が入ることがあり、GitHub では開けない。リンクをやめて表示の文字を残し、表示の文字から
 * パスが分からなければ、リポジトリのルートからのパスをコードの書式で添える。コードブロックとインラインコードの中は変えない。
 * ほかのリンク（URL・相対パス・`/workspace` で始まる別の名前のパス）は変えない。参照形式のリンクの定義と HTML のリンクは読まない。
 */
export function withoutWorkspaceLinks(body: string): string {
  if (!body.includes(CONTAINER_WORKSPACE)) return body;
  let fence: string | undefined;
  return body
    .split("\n")
    .map((line) => {
      const mark = FENCE.exec(line)?.[1];
      if (fence) {
        // 囲みは、始まりと同じ文字で、同じ数以上のものだけが閉じる
        if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
        return line;
      }
      if (mark) {
        fence = mark;
        return line;
      }
      return line.includes(CONTAINER_WORKSPACE) ? withoutLinksInLine(line) : line;
    })
    .join("\n");
}
