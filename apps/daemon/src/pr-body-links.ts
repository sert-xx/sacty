import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { CONTAINER_WORKSPACE } from "./agents/docker.js";

/**
 * 作業領域へのリンクがありうる本文か。リンク先の始まり（`](`。空白・改行と `<` をはさんでよい）の後ろに、作業領域のパスが
 * 続く所があるかだけを見る（リンクかどうかは、パーサーが決める）。
 */
const CANDIDATE = new RegExp(
  `\\]\\([ \\t\\r\\n]*<?${CONTAINER_WORKSPACE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[/)>\\s]|$)`,
);

/** リンク先が作業領域（とその下）なら、作業領域からの相対パス（作業領域そのものなら空）。違えば無い。 */
function workspacePath(url: string): string | undefined {
  if (url === CONTAINER_WORKSPACE) return "";
  return url.startsWith(`${CONTAINER_WORKSPACE}/`)
    ? url.slice(CONTAINER_WORKSPACE.length + 1)
    : undefined;
}

/** パスをインラインコードにする。パスにバッククォートがあれば、それより長いバッククォートで囲む。 */
function inlineCode(path: string): string {
  const longest = Math.max(0, ...[...path.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${path} ${fence}` : `${fence}${path}${fence}`;
}

/** 置き換える範囲（元の文字位置）と、置き換えた後の文字。 */
type Replacement = { start: number; end: number; text: string };

/** source の start〜end を、置き換え（範囲の中のもの。重ならない）を当てて返す。 */
function replaced(source: string, start: number, end: number, found: Replacement[]): string {
  let out = "";
  let done = start;
  for (const r of [...found].sort((a, b) => a.start - b.start)) {
    if (r.start < done || r.end > end) continue;
    out += source.slice(done, r.start) + r.text;
    done = r.end;
  }
  return out + source.slice(done, end);
}

/** 構文木をたどり、作業領域へのリンク・画像の置き換えを集める。 */
function collect(node: Nodes, source: string, out: Replacement[]): void {
  if (node.type === "link" || node.type === "image") {
    const path = workspacePath(node.url);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (path !== undefined && start !== undefined && end !== undefined) {
      // 表示の文字は、元の書き方のまま残す（リンクは中身の範囲、画像は代わりの文字）。リンクの中にある作業領域への
      // リンク・画像（画像をリンクにした書き方）も外す
      let label = node.type === "image" ? (node.alt ?? "") : "";
      if (node.type === "link") {
        const first = node.children[0]?.position?.start.offset;
        const last = node.children.at(-1)?.position?.end.offset;
        if (first !== undefined && last !== undefined) {
          const inner: Replacement[] = [];
          for (const child of node.children) collect(child, source, inner);
          label = replaced(source, first, last, inner);
        }
      }
      // 表示の文字にパス（行・節の指定を除く）が出ていれば、文字だけを残す
      const file = path.replace(/[#?].*$/, "").replace(/\/+$/, "");
      const text =
        label.trim() === ""
          ? path === ""
            ? ""
            : inlineCode(path)
          : file === "" || label.includes(file)
            ? label
            : `${label}（${inlineCode(path)}）`;
      out.push({ start, end, text });
      return;
    }
  }
  if ("children" in node) for (const child of node.children) collect(child, source, out);
}

/**
 * PR の本文から、コンテナの作業領域のパスへのリンクを外す（PBI-366）。エージェントの説明に、作業領域の絶対パスへのリンク
 * （`[README.md](/workspace/README.md)`）が入ることがあり、GitHub では開けない。リンクをやめて表示の文字を残し、表示の文字から
 * パスが分からなければ、リポジトリのルートからのパスをコードの書式で添える。
 *
 * どこがリンク・画像かは、Markdown のパーサー（CommonMark）で決め、その範囲（元の文字位置）だけを置き換える。自前の行ごとの
 * 解析は、括弧を含むパス・複数行のインラインコード・引用の中のコードブロックで、Markdown の構文と食い違った。パーサーが
 * リンクと見なさないもの（コードブロック・インラインコードの中）と、ほかのリンク（URL・相対パス・`/workspace` で始まる別の
 * 名前のパス）は変えない。参照形式のリンク（`[a][b]` と、その定義）と HTML のリンクは変えない。解析できなければ、本文を
 * 変えずに返す（PR の作成を止めない）。
 *
 * 本文は長さの上限（PR_BODY_MAX）の後のものを渡す。その長さで、ふつうの本文の解析は 0.1 秒ほど。作業領域へのリンクを含み、
 * かつ記号が上限いっぱいまで続く本文では、数秒かかる（PR の作成・更新のたびに1回）。
 */
export function withoutWorkspaceLinks(body: string): string {
  // リンク先の始まりの形（`](` の後ろに作業領域のパス）が無い本文は、解析しない。パーサーは、記号が長く続く本文
  // （`>` や `*` の連続）で時間がかかるので、対象がありうる本文だけを解析する
  if (!CANDIDATE.test(body)) return body;
  const found: Replacement[] = [];
  try {
    collect(fromMarkdown(body), body, found);
  } catch {
    return body;
  }
  return found.length === 0 ? body : replaced(body, 0, body.length, found);
}
