import { parentPort, workerData } from "node:worker_threads";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

// このファイルは、PR の本文の解析を別スレッドで動かすときの入口でもある（`pr-body-links.ts` が起動する。PBI-372）。
// テストでは TypeScript のまま Node.js に読ませるので、ほかのソースファイルを import しない（型だけの import と、
// パッケージの import だけにする）。作業領域のパスは、引数（workspace）で受け取る。

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
export function cannotLinkToWorkspace(body: string, workspace: string): boolean {
  if (!body.includes("](")) return true;
  return !body.includes(workspace) && !body.includes("\\") && !CHARACTER_REFERENCE.test(body);
}

/** リンク先が作業領域（とその下）なら、作業領域からの相対パス（作業領域そのものなら空）。違えば無い。 */
function workspacePath(url: string, workspace: string): string | undefined {
  if (url === workspace) return "";
  return url.startsWith(`${workspace}/`) ? url.slice(workspace.length + 1) : undefined;
}

/** パスをインラインコードにする。パスにバッククォートがあれば、それより長いバッククォートで囲む。 */
function inlineCode(path: string): string {
  const longest = Math.max(0, ...[...path.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${path} ${fence}` : `${fence}${path}${fence}`;
}

/** 文字の範囲（始まりと、終わりの次の位置）。 */
type Span = { start: number; end: number };

/**
 * リンクの外に出ると、GitHub（GFM）で別の働きをしうる並びの種類。リンクの中では働かない。表示の文字の確かめ
 * （`activeOutsideLink`）と、外した後のつながりの確かめ（`activeRuns`）の両方が、この表だけを使う。
 * tail：並びの決め手になる部分。head：その前に続いて、同じ並びに入りうる文字。marks：決め手の部分に必ず入る記号。
 * - 自動リンク（`https://example.com/a`）：`://` から、空白の前まで。前は、スキームの文字
 * - 自動リンク（`www.example.com`）：`www.` から、空白の前まで
 * - メンション・メールアドレス（`@octocat`・`a@example.com`）：`@` と、名前・ドメインの文字。前は、名前の文字
 * - Issue・PR の参照（`#12`・`org/repo#12`・`GH-12`。`Closes #12` は、マージで Issue を閉じる）：`#` と数字。前は、
 *   リポジトリの名前の文字
 * - 打ち消し線の記号（`~`）：リンクの外の `~` と組になる。隣の文字がリンクの括弧か、ふつうの文字かでも、開き・閉じに
 *   なるかが変わる
 * どれも、決め手の部分は前へ戻らずに読め、前に続く文字は決め手の書き出しの文字を含まないので、本文の長さに比例する
 * 時間で拾える。
 */
const ACTIVE_RUNS: readonly { tail: RegExp; head?: RegExp; marks: string }[] = [
  { tail: /:\/\/\S*/g, head: /[A-Za-z0-9+.-]/, marks: ":" },
  { tail: /www\.\S*/gi, marks: "." },
  { tail: /@[A-Za-z0-9._/-]+/g, head: /[A-Za-z0-9._%+-]/, marks: "@" },
  { tail: /#\d+/g, head: /[A-Za-z0-9._/-]/, marks: "#" },
  { tail: /GH-\d+/gi, marks: "-" },
  { tail: /~+/g, marks: "~" },
];

/** 並びの決め手の部分に入る記号（打ち消して書かれると、書いた文字のままでは並びを読めなくなる記号）。 */
const DECISIVE: ReadonlySet<string> = new Set(ACTIVE_RUNS.flatMap(({ marks }) => [...marks]));

/**
 * 表示の文字に、リンクの外に出すと別の働きをしうる並び（`ACTIVE_RUNS`）か、表の列の区切り（`|`）があるか。こうした
 * 文字を含むリンクは、外さずに残す。
 */
function activeOutsideLink(label: string): boolean {
  return label.includes("|") || ACTIVE_RUNS.some(({ tail }) => label.search(tail) >= 0);
}

/** リンク・画像の表示の文字を、読まれる文字（打ち消し・文字参照を戻したもの）で返す。インラインコードの中は除く。 */
function readLabel(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "image") return node.alt ?? "";
  return "children" in node ? node.children.map(readLabel).join("") : "";
}

/**
 * 本文の中の、GitHub で別の働きをしうる並びの範囲（始まりの順）。打ち消し・文字参照は、書いた文字のままでは並びを
 * 読めない（`w\@example.com` は `w@example.com`、`&commat;octocat` は `@octocat` と読まれる）。読まれる文字に直して
 * 確かめるのではなく、それを含む ASCII の文字の連なり（空白と、ASCII でない文字で区切る）を、並びとして扱う（変えない
 * 側に倒す）。打ち消しは、連なりに決め手の記号があるときだけ数える（`foo\_bar` は、どの並びにもならない）。並びは
 * ASCII の文字だけでできているので、空白を置かない日本語の文でも、連なりは文の全体には広がらない。
 */
function activeRuns(text: string): Span[] {
  const runs: Span[] = [];
  for (const { tail, head } of ACTIVE_RUNS) {
    for (const match of text.matchAll(tail)) {
      let start = match.index;
      while (head && start > 0 && head.test(text.charAt(start - 1))) start--;
      runs.push({ start, end: match.index + match[0].length });
    }
  }
  for (const match of text.matchAll(/[!-~]+/g)) {
    const chunk = match[0];
    const escaped = chunk.includes("\\") && [...chunk].some((c) => DECISIVE.has(c));
    if (escaped || CHARACTER_REFERENCE.test(chunk)) {
      runs.push({ start: match.index, end: match.index + chunk.length });
    }
  }
  return runs.sort((a, b) => a.start - b.start);
}

/**
 * 置き換えた後の本文（text）で、置き換えた文字（spans。始まりの順で、重ならない）のうち、周りの文字とつながって、
 * GitHub で別の働きをしうる並びとつながったものの番号。並びが、置き換えた文字と重なるか隣り合い、かつ、その外へ続く
 * ものを数える。
 * - 重なる：`ping [@](/workspace)octocat` の `@` は、後ろの `octocat` とつながって、メンションになる
 * - 隣り合う：`[a](/workspace/a)www.example.com` の `www.example.com` は、リンクのすぐ後ろでは自動リンクになるが、
 *   `awww.example.com` では、ならない（もとからある並びが、働かなくなる・別の並びになる）
 * 置き換えた文字の中に収まる並びは、数えない（表示の文字は `activeOutsideLink` で確かめてあり、添えるパスはインライン
 * コードの中にある）。
 * text には、置き換えた文字を、読まれる文字（`Replacement.read`）にした本文を渡す。表示の文字の中の打ち消し・文字参照は、
 * 読まれる文字に戻っているので、それだけでは並びにならず（`see ([foo\_bar.md](/workspace/foo_bar.md))` は外す）、外の
 * 文字と合わせて並びになるもの（`[ww](/workspace)[w\.](/workspace)example.com` の `www.example.com`）は見つかる。
 * 打ち消し・文字参照を含む連なりとして数えるのは、置き換えた文字の外に書かれたものだけになる。
 */
function joinedSpans(text: string, spans: readonly Span[]): Set<number> {
  const joined = new Set<number>();
  let first = 0;
  for (const run of activeRuns(text)) {
    // 並びは始まりの順なので、この並びより前で終わる置き換えは、後の並びとも重ならない・隣り合わない
    while (first < spans.length && (spans[first]?.end ?? 0) < run.start) first++;
    for (let i = first; i < spans.length; i++) {
      const span = spans[i];
      if (!span || span.start > run.end) break;
      if (run.start < span.start || run.end > span.end) joined.add(i);
    }
  }
  return joined;
}

/**
 * 置き換える範囲（元の文字位置）と、置き換えた後の文字（text）。read は、置き換えた後の文字を、読まれる文字（表示の文字の
 * 打ち消し・文字参照を戻したもの）にしたもの。周りの文字とのつながりを確かめるのに使う。
 */
type Replacement = { start: number; end: number; text: string; read: string };

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

/**
 * 構文木をたどり、作業領域（workspace）へのリンク・画像の置き換えを集める。置き換えるリンク・画像は removed に入れる。
 * skip にある位置（元の文字位置）から始まるリンク・画像は、変えない。
 */
function collect(
  node: Nodes,
  source: string,
  workspace: string,
  out: Replacement[],
  removed: Map<Nodes, Removal>,
  skip: ReadonlySet<number>,
): void {
  if (node.type === "link" || node.type === "image") {
    const path = workspacePath(node.url, workspace);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (path !== undefined && start !== undefined && end !== undefined) {
      // 外すと周りの文字とつながると分かったリンク（skip）と、パスに縦棒があるリンクは、変えない。表の中では、添えるパスの
      // 縦棒（リンク先では `\|`・`&#124;` と書ける）が列の区切りになって、行のセルが割れる
      if (skip.has(start) || path.includes("|")) return;
      // 表示の文字は、元の書き方のまま残す（リンクは中身の範囲、画像は代わりの文字）。リンクの中にある作業領域への
      // リンク・画像（画像をリンクにした書き方）も外す
      let label = node.type === "image" ? (node.alt ?? "") : "";
      if (node.type === "link") {
        const first = node.children[0]?.position?.start.offset;
        const last = node.children.at(-1)?.position?.end.offset;
        if (first !== undefined && last !== undefined) {
          const inner: Replacement[] = [];
          for (const child of node.children) {
            collect(child, source, workspace, inner, removed, skip);
          }
          label = replaced(source, first, last, inner);
        }
      }
      // GitHub（GFM）では、リンクの外に出た文字が、メンション・Issue の参照・自動リンク・表の区切りとして働く。構文木の
      // 確かめ（CommonMark）では見つけられないので、そうなりうる文字を含むリンクは、変えない（通知が飛ぶ・別の Issue を
      // 閉じる、という外への作用を、置き換えで増やさない）。外した後に周りの文字とつながってできる並びは、置き換えた後の
      // 本文で確かめる（`joinedSpans`）
      // 表示の文字は、書いた文字と、読まれる文字（`&commat;octocat` は `@octocat`）の両方で確かめる
      const read = readLabel(node);
      if (activeOutsideLink(label) || activeOutsideLink(read)) return;
      const hasLabel = label.trim() !== "";
      // 表示の文字にパス（行・節の指定を除く）が出ていれば、文字だけを残す
      const file = path.replace(/[#?].*$/, "").replace(/\/+$/, "");
      const candidates: { text: string; read: string; removal: Removal }[] = [];
      if (!hasLabel) {
        // 表示の文字が空で、作業領域そのものへのリンクは、変えない。外すと何も残らず、前後の文字が、空白を挟んで
        // つながる（`Fixes [](/workspace) #12` が `Fixes  #12` になる）。見えないリンクなので、残しても表示は変わらない
        if (path === "") return;
        const code = inlineCode(path);
        candidates.push({ text: code, read: code, removal: { label: false, path } });
      } else {
        if (file !== "" && !label.includes(file)) {
          const added = `（${inlineCode(path)}）`;
          candidates.push({
            text: `${label}${added}`,
            read: `${read}${added}`,
            removal: { label: true, path },
          });
        }
        // パスを添えると元のリンクより長くなるとき（パスにバッククォートが続く）は、表示の文字だけにする
        candidates.push({ text: label, read, removal: { label: true } });
      }
      // 置き換えで本文を長くしない（長さの上限の後に置き換えるため）。どれも元のリンクより長ければ、リンクを変えない
      const chosen = candidates.find((c) => c.text.length <= end - start);
      if (chosen) {
        out.push({ start, end, text: chosen.text, read: chosen.read });
        removed.set(node, chosen.removal);
      }
      return;
    }
  }
  if ("children" in node) {
    for (const child of node.children) collect(child, source, workspace, out, removed, skip);
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
 * 構文木の確かめは CommonMark の解釈で行うので、GitHub（GFM）だけの解釈（メンション・Issue の参照・自動リンク・表）の
 * 変化は見つけられない。そこで、次のリンクは変えない（その本文では、作業領域へのリンクが残る）。並びの種類は、1つの表
 * （`ACTIVE_RUNS`）に書く：
 * - 表示の文字に、リンクの外に出すと GFM で別の働きをしうる文字（`activeOutsideLink`）を含むリンク
 * - 外した後の文字が、前後の文字とつながって、メンション・Issue の参照・自動リンク・打ち消し線の記号の一部になる・
 *   隣り合うリンク（`joinedSpans`。`ping [@](/workspace)octocat`・`see [http](/workspace)://example.com/x`）。置き換えた後の
 *   本文で確かめ、当たったリンクを除いて、もう一度置き換える。それでも当たるものがあれば、本文を変えずに返す
 * - パスに縦棒があるリンク（表の中で、添えたパスの縦棒が列の区切りになる）
 * - 表示の文字が空で、作業領域そのものへのリンク（外すと何も残らず、前後の文字が、空白を挟んでつながる）
 * 確かめるのは、この種類だけである。GitHub のほかの解釈が、外した後の文字のつながりで変わることは、確かめない
 * （空白を挟んでつながる並び。`[Fix](/workspace/Fix)es #12` は `Fixes #12` になる。コミットの SHA のリンク・絵文字の
 * `:名前:`・タスクリストのチェックボックス。表の中で、行が区切りの行の形になる・添えたパスのバッククォートが、同じ
 * セルの組になっていないバッククォートと組になる）。
 *
 * 本文は長さの上限（PR_BODY_MAX）の後のものを渡す。置き換えは、元のリンクより長い文字にしない（返す本文は、渡した本文より
 * 長くならない）。その長さで、ふつうの本文の解析は 0.1 秒ほど。解析に回る本文（作業領域のパス・バックスラッシュ・文字参照の
 * どれかと `](` を含む）で、かつ記号が上限いっぱいまで続くと、数秒〜数十秒かかる。この関数は同期で動き、途中で止められない
 * ので、デーモンは、別スレッドで動かして、時間を区切る（`pr-body-links.ts` の `unlinkedGeneratedBody`・`unlinkedMergedBody`。
 * PBI-372）。
 *
 * failed：解析・置き換えの途中で例外が出たので、本文を変えなかった（深い入れ子でスタックがあふれた、など）。
 */
export function convertWorkspaceLinks(body: string, workspace: string): Converted {
  if (cannotLinkToWorkspace(body, workspace)) return { body };
  try {
    const tree = fromMarkdown(body);
    // 外すと周りの文字とつながるリンクを1回目の置き換えで見つけ、それを除いて、もう一度置き換える。2回目でも
    // つながるリンクがあれば、本文を変えない
    const first = replaceOnce(tree, body, workspace, new Set());
    const done =
      first && first.joined.length > 0
        ? replaceOnce(tree, body, workspace, new Set(first.joined))
        : first;
    if (!done || done.joined.length > 0) return { body };
    const expected = JSON.stringify(shapeOf(tree, done.removed));
    const actual = JSON.stringify(shapeOf(fromMarkdown(done.out), new Map()));
    return { body: expected === actual ? done.out : body };
  } catch {
    return { body, failed: true };
  }
}

/** 変換の結果。body：外した後の本文（外さなかったら、渡した本文）。failed：例外で、外せなかった。 */
export type Converted = { body: string; failed?: true };

/**
 * 1回分の置き換え。skip にある位置のリンクを除いて、作業領域へのリンク・画像を置き換えた本文（out）と、置き換えた
 * リンク・画像（removed）、置き換えた文字が周りの文字とつながったリンクの、元の本文での位置（joined）を返す。置き換える
 * リンクが無ければ、何も返さない。
 */
function replaceOnce(
  tree: Nodes,
  body: string,
  workspace: string,
  skip: ReadonlySet<number>,
): { out: string; removed: Map<Nodes, Removal>; joined: number[] } | undefined {
  const found: Replacement[] = [];
  const removed = new Map<Nodes, Removal>();
  collect(tree, body, workspace, found, removed, skip);
  if (found.length === 0) return undefined;
  found.sort((a, b) => a.start - b.start);
  const out = replaced(body, 0, body.length, found);
  // つながりは、置き換えた文字を読まれる文字にした本文で確かめる。spans は、その本文での、置き換えた文字の範囲
  const reads = found.map((r) => ({ ...r, text: r.read }));
  let shift = 0;
  const spans = reads.map((r) => {
    const start = r.start + shift;
    shift += r.text.length - (r.end - r.start);
    return { start, end: start + r.text.length };
  });
  const joined = [...joinedSpans(replaced(body, 0, body.length, reads), spans)].flatMap(
    (i) => found[i]?.start ?? [],
  );
  return { out, removed, joined };
}

/** 別スレッドに渡す仕事（`pr-body-links.ts` が、`workerData` に入れる）。 */
export type ConvertJob = { sactyPrBodyLinks: true; body: string; workspace: string };

function isConvertJob(data: unknown): data is ConvertJob {
  if (typeof data !== "object" || data === null) return false;
  const job = data as Partial<ConvertJob>;
  return (
    job.sactyPrBodyLinks === true &&
    typeof job.body === "string" &&
    typeof job.workspace === "string"
  );
}

// 別スレッドの入口。このファイルを、仕事（ConvertJob）を付けて別スレッドで起動したときだけ動く（ふつうに import した
// ときと、テストの実行のためのスレッドでは、動かない）。結果を1回送って終わる。
if (parentPort && isConvertJob(workerData)) {
  parentPort.postMessage(convertWorkspaceLinks(workerData.body, workerData.workspace));
}
