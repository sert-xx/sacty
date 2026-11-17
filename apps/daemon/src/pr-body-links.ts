import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { CONTAINER_WORKSPACE } from "./agents/docker.js";

/** Markdown の文字参照（`&#115;`・`&#x73;`・`&sol;`）の形。 */
const CHARACTER_REFERENCE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

/**
 * 解析しなくてよい本文か（作業領域へのリンク・画像が、ありえない本文）。リンク先を自前で読んで決めるのではなく、パーサーが
 * 作業領域へのリンクと解釈しうる本文を、すべて解析に回す（見落とさない側に倒す）：
 * - インラインのリンク・画像は、表示の文字の閉じ（`]`）の直後にリンク先の開き（`(`）が、そのままの文字で続く。`](` が
 *   無ければ、リンクも画像も無い。
 * - リンク先の文字は、バックスラッシュによる打ち消しと文字参照のほかは、書いたままに読まれる。本文に作業領域のパスが
 *   そのままの文字で無く、バックスラッシュも文字参照も無ければ、作業領域へのリンクは無い。
 * パーサーは、記号が長く続く本文で時間がかかるので、要らない解析を避ける。
 */
function cannotLinkToWorkspace(body: string): boolean {
  if (!body.includes("](")) return true;
  return (
    !body.includes(CONTAINER_WORKSPACE) && !body.includes("\\") && !CHARACTER_REFERENCE.test(body)
  );
}

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

/** 外したリンク・画像を、何に置き換えたか。label：表示の文字を残した、path：添えたパス（添えなければ無い）。 */
type Removal = { label: boolean; path?: string };

/** 構文木を比べるための形（位置を除いた、種類・値と子）。 */
type Shape = { type: string; [key: string]: unknown; children?: Shape[] };

/**
 * 構文木を、比べるための形にする。位置は除き、隣り合う文字はつなぐ。removed にあるリンク・画像は、置き換えた後に
 * そうなるはずの形（リンクは中身、画像は代わりの文字。パスを添えたなら、全角の括弧とインラインコード）にする。
 * 置き換えた後の本文の構文木が、この形と同じなら、置き換えで変わったのは、リンク・画像でなくなったことだけである。
 */
function shapeOf(node: Nodes, removed: ReadonlyMap<Nodes, Removal>): Shape[] {
  const removal = removed.get(node);
  if (removal && (node.type === "link" || node.type === "image")) {
    const kept: Shape[] = !removal.label
      ? []
      : node.type === "link"
        ? mergeText(node.children.flatMap((child) => shapeOf(child, removed)))
        : [{ type: "text", value: node.alt ?? "" }];
    if (removal.path === undefined) return kept;
    const code: Shape = { type: "inlineCode", value: removal.path };
    return removal.label
      ? [...kept, { type: "text", value: "（" }, code, { type: "text", value: "）" }]
      : [code];
  }
  const shape: Shape = { type: node.type };
  for (const [key, value] of Object.entries(node)) {
    if (key !== "type" && key !== "position" && key !== "children") shape[key] = value;
  }
  if ("children" in node) {
    shape.children = mergeText(node.children.flatMap((child) => shapeOf(child, removed)));
  }
  return [shape];
}

/** 隣り合う文字（text）を1つにつなぎ、空の文字は除く。 */
function mergeText(shapes: Shape[]): Shape[] {
  const out: Shape[] = [];
  for (const shape of shapes) {
    const last = out.at(-1);
    if (shape.type === "text" && shape.value === "") continue;
    if (shape.type === "text" && last?.type === "text") {
      last.value = `${String(last.value)}${String(shape.value)}`;
    } else out.push({ ...shape });
  }
  return out;
}

/** 構文木をたどり、作業領域へのリンク・画像の置き換えを集める。置き換えるリンク・画像は removed に入れる。 */
function collect(
  node: Nodes,
  source: string,
  out: Replacement[],
  removed: Map<Nodes, Removal>,
): void {
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
          for (const child of node.children) collect(child, source, inner, removed);
          label = replaced(source, first, last, inner);
        }
      }
      const hasLabel = label.trim() !== "";
      // 表示の文字にパス（行・節の指定を除く）が出ていれば、文字だけを残す
      const file = path.replace(/[#?].*$/, "").replace(/\/+$/, "");
      const candidates: { text: string; removal: Removal }[] = [];
      if (!hasLabel) {
        candidates.push(
          path === ""
            ? { text: "", removal: { label: false } }
            : { text: inlineCode(path), removal: { label: false, path } },
        );
      } else {
        if (file !== "" && !label.includes(file)) {
          candidates.push({
            text: `${label}（${inlineCode(path)}）`,
            removal: { label: true, path },
          });
        }
        // パスを添えると元のリンクより長くなるとき（パスにバッククォートが続く）は、表示の文字だけにする
        candidates.push({ text: label, removal: { label: true } });
      }
      // 置き換えで本文を長くしない（長さの上限の後に置き換えるため）。どれも元のリンクより長ければ、リンクを変えない
      const chosen = candidates.find((c) => c.text.length <= end - start);
      if (chosen) {
        out.push({ start, end, text: chosen.text });
        removed.set(node, chosen.removal);
      }
      return;
    }
  }
  if ("children" in node) {
    for (const child of node.children) collect(child, source, out, removed);
  }
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
 * 置き換えた後の本文も解析し、その構文木が、元の構文木から「外したリンク・画像を、中身（と添えたパス）にしたもの」と
 * 同じであることを確かめる（`shapeOf`）。表示の文字を周りの文字とつなぐと、別の構文になることがある
 * （`[[a]](/workspace/a)(/workspace/b)` は `[a](/workspace/b)` というリンクになる。画像の代わりの文字 `<!--` は、HTML の
 * コメントの始まりになって、後ろの文章を隠す。代わりの文字から参照の定義ができて、ほかのリンクの行き先が変わる）。
 * 同じにならないときは、本文を変えずに返す（置き換えで変わるのは、リンク・画像でなくなることだけ。その本文では、作業領域への
 * リンクは残る）。安全な文脈だけを選んで変えるのではなく、変えた結果を確かめて、違えば戻す。
 *
 * 本文は長さの上限（PR_BODY_MAX）の後のものを渡す。置き換えは、元のリンクより長い文字にしない（返す本文は、渡した本文より
 * 長くならない）。その長さで、ふつうの本文の解析は 0.1 秒ほど。解析に回る本文（作業領域のパス・バックスラッシュ・文字参照の
 * どれかと `](` を含む）で、かつ記号が上限いっぱいまで続くと、数秒〜数十秒かかる（PR の作成・更新のたびに1回。その間、
 * デーモンのほかの処理は待つ）。
 */
export function withoutWorkspaceLinks(body: string): string {
  if (cannotLinkToWorkspace(body)) return body;
  const found: Replacement[] = [];
  const removed = new Map<Nodes, Removal>();
  try {
    const tree = fromMarkdown(body);
    collect(tree, body, found, removed);
    if (found.length === 0) return body;
    const out = replaced(body, 0, body.length, found);
    const expected = JSON.stringify(shapeOf(tree, removed));
    const actual = JSON.stringify(shapeOf(fromMarkdown(out), new Map()));
    return expected === actual ? out : body;
  } catch {
    return body;
  }
}
