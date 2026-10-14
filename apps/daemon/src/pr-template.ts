import { type DaemonText, githubApiBase, message, parseRepoUrl } from "@sacty/core";
import { errorText } from "./errors.js";
import type { BodyParts, BodyText } from "./prompts.js";

/**
 * PR の本文を、対象のリポジトリ（無ければ Org の .github リポジトリ）の PR テンプレートに沿わせる（PBI-87）。
 * テンプレートを探す口（GitHub の contents API）と、テンプレートを sacty の内容で埋める処理、本文の長さの上限。
 */

/** 見つかった PR テンプレート。repo はテンプレートのあったリポジトリの URL、path はその中のパス。 */
export type PullRequestTemplate = { repo: string; path: string; text: string };

/**
 * テンプレートを探した結果。
 * - found：使うテンプレート
 * - none：無かった（message は補足。Org の .github が非公開で使わなかった、など）
 * - unusable：あるかもしれない・あったが使えなかった（取得の失敗・権限・大きすぎる・空・文字コード）
 */
export type TemplateLookup =
  | { kind: "found"; template: PullRequestTemplate }
  | { kind: "none"; message?: DaemonText }
  | { kind: "unusable"; repo: string; path?: string; message: DaemonText };

/** PR テンプレートを探す口。テストでは偽物に差し替える。 */
export interface PullRequestTemplates {
  /** repo（PR を作るリポジトリの URL）の PR テンプレートを探す。失敗しても例外にせず unusable を返す。 */
  find(input: { repo: string; token: string }): Promise<TemplateLookup>;
}

/** 読むテンプレートの大きさの上限（バイト）。これより大きいテンプレートは使わない。 */
export const TEMPLATE_MAX_BYTES = 32 * 1024;

/** テンプレートを探す処理全体の時間切れ（PR の作成を長く止めないため）。 */
const LOOKUP_TIMEOUT_MS = 30_000;

/** テンプレートの1つのファイル（大文字・小文字は区別しない）。 */
const TEMPLATE_FILE = "pull_request_template.md";
/** 複数のテンプレートを置くディレクトリ（大文字・小文字は区別しない）。 */
const TEMPLATE_DIR = "pull_request_template";

type Entry = { name: string; path: string; type: string; size: number };

class LookupFailure extends Error {
  constructor(
    readonly path: string,
    readonly text: DaemonText,
  ) {
    super(typeof text === "string" ? text : text.code);
  }
}

/**
 * GitHub の contents API で PR テンプレートを探す。探す順番は GitHub と同じ場所で、
 * 1つのファイル（`.github/`・ルート・`docs/` の pull_request_template.md）→ 複数のテンプレートのディレクトリ
 * （同じ順の PULL_REQUEST_TEMPLATE/ の中の .md のうち、名前の順で最初のもの）。対象のリポジトリに無ければ、
 * Org（またはユーザー）の .github リポジトリの同じ場所を探す（GitHub と同じく、公開のものだけ）。
 * どちらも既定のブランチのものを読む。
 */
export class GitHubPullRequestTemplates implements PullRequestTemplates {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = LOOKUP_TIMEOUT_MS,
  ) {}

  async find(input: { repo: string; token: string }): Promise<TemplateLookup> {
    const repo = parseRepoUrl(input.repo);
    if (!repo) return { kind: "none" };
    const signal = AbortSignal.timeout(this.timeoutMs);
    const get = (url: string) => this.get(url, input.token, signal);
    let current = repo.url;
    let path: string | undefined;
    try {
      const own = await this.findIn(repo.url, get, (p) => {
        path = p;
      });
      if (own) return own;
      // 対象のリポジトリが Org の .github そのものなら、ほかを探さない
      if (repo.name.toLowerCase() === ".github") return { kind: "none" };
      const org = `https://${repo.host}/${repo.owner}/.github`;
      current = org;
      path = undefined;
      const api = `${githubApiBase(repo.host)}/repos/${repo.owner}/.github`;
      const info = await get(api);
      if (info.status === 404) return { kind: "none" };
      if (!info.ok) throw new LookupFailure("", failed("", info));
      // GitHub は、公開の .github リポジトリのものだけを既定のテンプレートとして使う
      if (info.json.private !== false) {
        return { kind: "none", message: message("pr.templateOrgPrivate", { repo: org }) };
      }
      return (
        (await this.findIn(org, get, (p) => {
          path = p;
        })) ?? { kind: "none" }
      );
    } catch (error) {
      const at = error instanceof LookupFailure ? error.path || path : path;
      const text =
        error instanceof LookupFailure
          ? error.text
          : message("pr.templateFailed", { path: at ?? "", status: 0, detail: errorText(error) });
      return { kind: "unusable", repo: current, ...(at ? { path: at } : {}), message: text };
    }
  }

  /** 1つのリポジトリで探す。無ければ undefined。 */
  private async findIn(
    repoUrl: string,
    get: (url: string) => Promise<Got>,
    reading: (path: string) => void,
  ): Promise<TemplateLookup | undefined> {
    const repo = parseRepoUrl(repoUrl);
    if (!repo) return undefined;
    const base = `${githubApiBase(repo.host)}/repos/${repo.path}/contents`;
    const list = async (dir: string): Promise<Entry[] | undefined> => {
      reading(dir);
      const res = await get(dir ? `${base}/${encodePath(dir)}` : base);
      // 空のリポジトリ・見えないリポジトリ・消えたディレクトリは、無いものとして扱う
      if (res.status === 404) return undefined;
      if (!res.ok) throw new LookupFailure(dir || "/", failed(dir || "/", res));
      return Array.isArray(res.body) ? res.body.map(toEntry).filter(isEntry) : [];
    };
    const root = await list("");
    if (!root) return undefined;
    const dirOf = (entries: Entry[], name: string) =>
      sortByName(entries.filter((e) => e.type === "dir" && e.name.toLowerCase() === name))[0];
    const fileOf = (entries: Entry[]) =>
      sortByName(
        entries.filter((e) => e.type === "file" && e.name.toLowerCase() === TEMPLATE_FILE),
      )[0];
    // .github と docs の中身は、その順番になってから読む（前の順番で見つかったら、後の順番のディレクトリには触れない。
    // 後のディレクトリの一覧の失敗で、見つかったテンプレートを使えなくしないため。PR #99 レビュー指摘）
    const githubDir = dirOf(root, ".github");
    const docsDir = dirOf(root, "docs");
    let inGithub: Entry[] | undefined;
    let inDocs: Entry[] | undefined;
    const githubEntries = async () => {
      inGithub ??= githubDir ? ((await list(githubDir.path)) ?? []) : [];
      return inGithub;
    };
    const docsEntries = async () => {
      inDocs ??= docsDir ? ((await list(docsDir.path)) ?? []) : [];
      return inDocs;
    };
    // 1つのファイル：.github → ルート → docs（見つかった時点で読む）
    for (const entries of [githubEntries, async () => root, docsEntries]) {
      const single = fileOf(await entries());
      if (single) return this.read(repo.url, base, single, get, reading);
    }
    // 複数のテンプレートのディレクトリ：同じ順で、中の .md のうち名前の順で最初のもの
    for (const entries of [githubEntries, async () => root, docsEntries]) {
      const dir = dirOf(await entries(), TEMPLATE_DIR);
      if (!dir) continue;
      const files = sortByName(
        ((await list(dir.path)) ?? []).filter(
          (e) => e.type === "file" && e.name.toLowerCase().endsWith(".md"),
        ),
      );
      const first = files[0];
      if (first) return this.read(repo.url, base, first, get, reading);
    }
    return undefined;
  }

  private async read(
    repo: string,
    base: string,
    entry: Entry,
    get: (url: string) => Promise<Got>,
    reading: (path: string) => void,
  ): Promise<TemplateLookup> {
    reading(entry.path);
    const tooLarge = (size: number): TemplateLookup => ({
      kind: "unusable",
      repo,
      path: entry.path,
      message: message("pr.templateTooLarge", {
        path: entry.path,
        size,
        limit: TEMPLATE_MAX_BYTES,
      }),
    });
    if (entry.size > TEMPLATE_MAX_BYTES) return tooLarge(entry.size);
    const res = await get(`${base}/${encodePath(entry.path)}`);
    if (!res.ok) throw new LookupFailure(entry.path, failed(entry.path, res));
    const json = res.json;
    const content = typeof json.content === "string" ? json.content : undefined;
    if (json.encoding !== "base64" || content === undefined) {
      // 大きいファイルは、contents API が中身を返さない（encoding が none）
      return typeof json.size === "number" && json.size > TEMPLATE_MAX_BYTES
        ? tooLarge(json.size)
        : {
            kind: "unusable",
            repo,
            path: entry.path,
            message: message("pr.templateInvalid", { path: entry.path }),
          };
    }
    const bytes = Buffer.from(content.replace(/\s+/g, ""), "base64");
    if (bytes.length > TEMPLATE_MAX_BYTES) return tooLarge(bytes.length);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
      return {
        kind: "unusable",
        repo,
        path: entry.path,
        message: message("pr.templateInvalid", { path: entry.path }),
      };
    }
    if (text.trim() === "") {
      return {
        kind: "unusable",
        repo,
        path: entry.path,
        message: message("pr.templateEmpty", { path: entry.path }),
      };
    }
    return { kind: "found", template: { repo, path: entry.path, text } };
  }

  private async get(url: string, token: string, signal: AbortSignal): Promise<Got> {
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as unknown;
    const json =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    return { ok: res.ok, status: res.status, body, json };
  }
}

type Got = { ok: boolean; status: number; body: unknown; json: Record<string, unknown> };

function failed(path: string, res: Got): DaemonText {
  // GitHub の文（json.message）は外から来た文なので、翻訳せずに引数で渡す
  const detail = typeof res.json.message === "string" ? res.json.message : "";
  return message("pr.templateFailed", { path, status: res.status, detail });
}

function toEntry(item: unknown): Entry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const e = item as Record<string, unknown>;
  if (typeof e.name !== "string" || typeof e.path !== "string" || typeof e.type !== "string") {
    return undefined;
  }
  return {
    name: e.name,
    path: e.path,
    type: e.type,
    size: typeof e.size === "number" ? e.size : 0,
  };
}

function isEntry(e: Entry | undefined): e is Entry {
  return e !== undefined;
}

/** 名前の順（大文字・小文字を区別せず、同じなら元の名前の順）。 */
function sortByName(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------------------------
// テンプレートを埋める

type Category = "summary" | "changes" | "tests" | "issue";

/** 埋められない見出しに書く文。 */
export const NOT_APPLICABLE = "該当なし（sacty は記入していません）";

/** 見出しの文から、入れる内容の種類を決める（当てはまらなければ undefined。上から順に当てる）。 */
const CATEGORY_RULES: [Category | undefined, RegExp][] = [
  // sacty が書けない・書くべきでない見出し（チェックリスト・画面・破壊的変更など）
  [
    undefined,
    /breaking|破壊的|screenshot|スクリーンショット|スクショ|画面|checklist|チェックリスト|reviewer|レビュアー|レビュワー|備考|その他|\bother|types? of changes?|種類|種別|やらないこと|deploy|デプロイ|リリース|release/,
  ],
  [
    "issue",
    /issue|ticket|チケット|イシュー|課題|関連|related|\brefs?\b|reference|link|リンク|close|\bfix(es)?\b|resolve/,
  ],
  ["tests", /test|テスト|試験|動作確認|確認方法|検証|verif|\bqa\b/],
  ["changes", /変更|修正|実装|対応内容|やったこと|したこと|change|implement|modif|detail/],
  [
    "summary",
    /概要|目的|背景|説明|要約|理由|内容|狙い|やりたいこと|summary|description|overview|purpose|motivation|why|what|context|about|background|introduction/,
  ],
];

function categoryOf(heading: string): Category | undefined {
  const text = heading.toLowerCase();
  for (const [category, rule] of CATEGORY_RULES) {
    if (rule.test(text)) return category;
  }
  return undefined;
}

type Section = { heading?: string; title: string; lines: string[] };

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** 行全体が太字の項目（`**概要**`・`**Changes:**`）も見出しとして扱う。 */
const BOLD_HEADING = /^ {0,3}(\*\*|__)(.+?)\1[ \t]*[:：]?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/;

/** テンプレートを見出しで分ける（コードブロックと HTML のコメントの中の見出しは見出しにしない）。 */
function splitSections(template: string): Section[] {
  const sections: Section[] = [{ title: "", lines: [] }];
  let fence: string | undefined;
  let inComment = false;
  for (const line of template.replace(/\r\n?/g, "\n").split("\n")) {
    const current = sections[sections.length - 1] as Section;
    if (fence) {
      current.lines.push(line);
      if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    if (inComment) {
      current.lines.push(line);
      if (line.includes("-->")) inComment = opensComment(line.slice(line.lastIndexOf("-->") + 3));
      continue;
    }
    const heading = line.match(ATX_HEADING) ?? line.match(BOLD_HEADING);
    if (heading && !line.trimStart().startsWith("<!--")) {
      sections.push({ heading: line.trimEnd(), title: heading[2] ?? "", lines: [] });
      continue;
    }
    current.lines.push(line);
    const opened = line.match(FENCE);
    if (opened) fence = opened[1]?.[0]?.repeat(3);
    else inComment = opensComment(line);
  }
  return sections;
}

/** 行の中で、閉じられていない HTML のコメントが始まっているか。 */
function opensComment(line: string): boolean {
  const open = line.lastIndexOf("<!--");
  return open >= 0 && !line.slice(open + 4).includes("-->");
}

type Kept = { kind: "comment" | "checkbox"; text: string };

/**
 * 見出しの中身のうち、残すもの（HTML のコメント・チェックボックス）。チェックボックスは、sacty が確かめていないので
 * すべて外す。説明・例の文とコードブロックは、sacty の内容に置き換えるので残さない。
 */
function keptElements(lines: string[]): Kept[] {
  const kept: Kept[] = [];
  let fence: string | undefined;
  let comment: string[] | undefined;
  for (const line of lines) {
    if (comment) {
      comment.push(line);
      if (!opensComment(comment.join("\n"))) {
        kept.push({ kind: "comment", text: comment.join("\n") });
        comment = undefined;
      }
      continue;
    }
    if (fence) {
      if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    const opened = line.match(FENCE);
    if (opened) {
      fence = opened[1]?.[0]?.repeat(3);
      continue;
    }
    if (CHECKBOX.test(line)) {
      kept.push({ kind: "checkbox", text: line.replace(CHECKBOX, "$1[ ]").trimEnd() });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("<!--")) {
      if (opensComment(trimmed)) comment = [line];
      else if (trimmed.endsWith("-->")) kept.push({ kind: "comment", text: line.trimEnd() });
    }
  }
  // 閉じられていないコメントは、閉じて残す（後ろの本文を隠さないため）
  if (comment) kept.push({ kind: "comment", text: `${comment.join("\n")} -->` });
  return kept;
}

/** 折りたたんだ sacty の記録。 */
function details(body: string): string {
  return ["<details>", "<summary>sacty の記録</summary>", "", body.trim(), "", "</details>"].join(
    "\n",
  );
}

/**
 * テンプレートの見出し・項目の形に沿って、sacty の内容で本文を埋める。戻り値の main はテンプレートを埋めた本文と
 * sacty の記録、footer は必ず最後に置く部分（長さの上限で省かない）。
 * - 見出しの種類（目的・変更・テスト・関係する Issue）ごとに、最初に当たった見出しに内容を入れる
 * - 内容の無い見出し・当てはまらない見出しは「該当なし」にする（チェックボックスのある見出しは、外したチェックボックスだけ）
 * - テンプレートのコメント・チェックボックスは残し、チェックボックスはすべて外す
 */
export function fillTemplate(template: string, parts: BodyParts): BodyText {
  const used = new Set<Category>();
  const out: string[] = [];
  for (const section of splitSections(template)) {
    const kept = keptElements(section.lines);
    if (section.heading === undefined) {
      // 最初の見出しより前（説明の文は残さない）
      if (kept.length > 0) out.push(kept.map((k) => k.text).join("\n"), "");
      continue;
    }
    const category = categoryOf(section.title);
    const content =
      category && !used.has(category) && parts[category]?.trim()
        ? parts[category]?.trim()
        : undefined;
    if (content && category) used.add(category);
    const leading = kept.findIndex((k) => k.kind !== "comment");
    const head = leading < 0 ? kept : kept.slice(0, leading);
    const rest = leading < 0 ? [] : kept.slice(leading);
    const hasCheckbox = rest.some((k) => k.kind === "checkbox");
    out.push(section.heading, "");
    if (head.length > 0) out.push(head.map((k) => k.text).join("\n"), "");
    if (content) out.push(content, "");
    else if (!hasCheckbox) out.push(NOT_APPLICABLE, "");
    if (rest.length > 0) out.push(rest.map((k) => k.text).join("\n"), "");
  }
  // 見出しに入らなかった内容は、sacty の記録として折りたたむ（Issue は Closes を効かせるため、footer の前に出す）。
  // どの見出しにも入れられなかった（見出しの無いテンプレートなど）ときは、目的・変更・テストを折りたたまずに出す
  // （本文のほとんどが畳まれて、人が読み落とさないように）
  const leftover = (["summary", "changes", "tests"] as const)
    .filter((c) => !used.has(c) && parts[c]?.trim())
    .map((c) => parts[c]?.trim() ?? "");
  const plain = used.size === 0;
  if (plain && leftover.length > 0) out.push(leftover.join("\n\n"), "");
  const record = [
    ...(plain ? [] : leftover),
    ...(parts.record?.trim() ? [parts.record.trim()] : []),
  ];
  if (record.length > 0) out.push(details(record.join("\n\n")), "");
  const issue = !used.has("issue") && parts.issue?.trim() ? `${parts.issue.trim()}\n\n` : "";
  return {
    main: out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    footer: `${issue}${parts.footer.trim()}`,
    // 見出しに入れた関係する Issue（Closes）は、長さの上限で省いても残す（PR #99 レビュー指摘）
    keep: used.has("issue") && parts.issue?.trim() ? [parts.issue.trim()] : [],
  };
}

// ---------------------------------------------------------------------------------------------
// 本文の長さ

/**
 * PR の本文の長さの上限（文字。GitHub の上限は 65,536 文字。JavaScript の長さ（UTF-16 の単位）は文字の数以上に
 * なるので、この長さで測れば上限を超えない。少し余裕を持たせる）。
 */
export const PR_BODY_MAX = 65_000;

/** 長さの上限で省いたときに書く文。 */
export const TRUNCATED_NOTE =
  "…（本文が長いので、ここから先を省きました。続きは sacty のタスクの画面で確かめてください）";

/**
 * main と footer をつないだ本文を、上限に収める。超えるときは main の後ろを省く（footer は省かない）。
 * 省いたところで閉じられていない HTML のコメント・コードブロック・折りたたみは閉じる（後ろの footer を隠さないため）。
 * keep は main にあっても省けない部分（タスクの ID・Closes・承認の案内）。省いて main から消えたものは、footer の前に
 * 出し直す（PR #99 レビュー指摘）。
 */
export function limitBody(
  main: string,
  footer: string,
  max = PR_BODY_MAX,
  keep: readonly string[] = [],
): { body: string; truncated: boolean } {
  const joinWith = (head: string, tail: string) =>
    tail ? (head ? `${head}\n\n${tail}` : tail) : head;
  const whole = joinWith(main, footer);
  if (whole.length <= max) return { body: whole, truncated: false };
  const kept = keep.filter((k) => k.length > 0);
  // 閉じる記号・省いた文・出し直す部分の分を空けておく
  const reserve =
    footer.length + kept.reduce((sum, k) => sum + k.length + 2, 0) + TRUNCATED_NOTE.length + 64;
  let cut = Math.max(0, max - reserve);
  // サロゲートペアの途中で切らない
  const code = main.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  let head = main.slice(0, cut);
  if (opensComment(head)) head += " -->";
  const fences = head.split("\n").filter((line) => FENCE.test(line)).length;
  if (fences % 2 === 1) head += "\n```";
  const open = (head.match(/<details>/g) ?? []).length;
  const close = (head.match(/<\/details>/g) ?? []).length;
  head += `\n\n${TRUNCATED_NOTE}`;
  if (open > close) head += "\n\n</details>".repeat(open - close);
  // 省いて消えた、省けない部分は footer の前に出し直す
  const restored = kept.filter((k) => !head.includes(k));
  const body = joinWith(head, [...restored, footer].filter(Boolean).join("\n\n"));
  // footer そのものが上限を超えるときは、最後の手段として切る
  return { body: body.length <= max ? body : body.slice(0, max), truncated: true };
}
