// docs の構成の規則（docs/README.md と各ディレクトリの README.md）を確かめる。
// - ADR・作業履歴・仕様書・ユーザードキュメントのファイル名
// - ADR の先頭の項目（日時・ステータス・置き換えの関係）と、ファイル名との一致
// - 作業履歴の先頭の項目（日付・タスク・PR）と、ファイル名との一致
// - docs・README・スキルの中の相対リンクが切れていないこと、docs/pbi へリンクしないこと
// - Claude Code 用と Codex 用のスキルが同じ内容であること
//
// ファイル名のステータスと本文の表記の対応は docs/adr/README.md の表を正本とし、ここではその表を読む。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = join(ROOT, "docs");
const ADR_DIR = join(DOCS, "adr");
const WORKLOG_DIR = join(DOCS, "worklog");
const KINDS = ["spec", "user", "adr", "worklog"] as const;
const SKILL_NAME = "sacty-docs";
const SKILL_COPIES = [
  join(ROOT, ".claude", "skills", SKILL_NAME, "SKILL.md"),
  join(ROOT, ".agents", "skills", SKILL_NAME, "SKILL.md"),
];

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PLAIN_NAME = new RegExp(`^${SLUG}\\.md$`);
const WORKLOG_NAME = new RegExp(`^(\\d{8})-(${SLUG})\\.md$`);

// ---- ステータスの対応表（docs/adr/README.md） ----

/** ファイル名のステータス（採用中は ""）→ 本文の表記。 */
type StatusTable = Map<string, string>;

const STATUS_TABLE_HEADER = "| ファイル名のステータス | 本文の表記 |";
const NO_STATUS = "（無し）";

/** README の表から、ファイル名のステータスと本文の表記の対応を読む。表の形が崩れていたら例外にする。 */
function parseStatusTable(readme: string): StatusTable {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => line.startsWith(STATUS_TABLE_HEADER));
  if (start < 0) throw new Error("ステータスの対応表が見つからない");
  const table: StatusTable = new Map();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [fileCell = "", labelCell = ""] = cells;
    const file = fileCell === NO_STATUS ? "" : /^`([a-z]+)`$/.exec(fileCell)?.[1];
    const label = /^`([^`]+)`$/.exec(labelCell)?.[1];
    if (file === undefined || label === undefined) throw new Error(`表の行の形が違う: ${line}`);
    if (table.has(file)) throw new Error(`同じステータスが2行ある: ${line}`);
    if ([...table.values()].includes(label)) throw new Error(`同じ表記が2行ある: ${line}`);
    table.set(file, label);
  }
  if (!table.has("")) throw new Error("採用中（無し）の行が無い");
  return table;
}

/** ファイル名のステータスの語（採用中を除く）。 */
function fileStatuses(table: StatusTable): string[] {
  return [...table.keys()].filter((status) => status !== "");
}

function adrNamePattern(table: StatusTable): RegExp {
  const words = fileStatuses(table).join("|");
  return new RegExp(
    `^(\\d{8})-(\\d{4})(?:-(${words}))?-((?!(?:${words})(?:-|\\.md$))${SLUG})\\.md$`,
  );
}

const STATUS_TABLE = parseStatusTable(readFileSync(join(ADR_DIR, "README.md"), "utf8"));

// ---- 共通の部品 ----

/** 年月日・時分として正しいか（20261399 などを弾く）。 */
function isValidDateTime(ymd: string, hm = "0000"): boolean {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const h = Number(hm.slice(0, 2));
  const min = Number(hm.slice(2, 4));
  const date = new Date(Date.UTC(y, m - 1, d, h, min));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d &&
    h < 24 &&
    min < 60
  );
}

/** ディレクトリの下の Markdown を再帰で集める（docs/pbi は git 管理しないので除く）。 */
function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === join(DOCS, "pbi")) continue;
      out.push(...markdownFiles(path));
    } else if (entry.name.endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

/** コードブロックを除いた本文（行の数は変えない）。 */
function stripFences(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) =>
    block.replace(/[^\n]/g, ""),
  );
}

/** コードブロックとインラインコードを除いた本文（ひな形の中の例のリンクを検査しないため）。 */
function stripCode(markdown: string): string {
  return stripFences(markdown).replace(/`[^`\n]*`/g, "");
}

/** Markdown のリンクの行き先を集める（画像を含む。外部の URL・アンカーだけのものは除く）。 */
function relativeLinks(markdown: string): string[] {
  const out: string[] = [];
  const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
  for (const m of stripCode(markdown).matchAll(pattern)) {
    const target = m[1] ?? m[2] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    out.push(target);
  }
  return out;
}

/** Markdown のリンクのうち、アンカー（#…）の付いたものの行き先を集める（同じファイルの #… を含む。外部の URL は除く）。 */
function anchorLinks(markdown: string): string[] {
  const out: string[] = [];
  const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
  for (const m of stripCode(markdown).matchAll(pattern)) {
    const target = m[1] ?? m[2] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || !target.includes("#")) continue;
    out.push(target);
  }
  return out;
}

/** 見出しの文から、GitHub と同じ規則でアンカーを作る（小文字にし、文字・数字・空白・-・_ 以外を除き、空白を - にする）。 */
function headingSlug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Markdown の見出しのアンカー（同じ見出しが重なれば -1・-2 を付ける。コードブロックの中は見ない）。 */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of stripFences(markdown).split("\n")) {
    const m = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!m) continue;
    const base = headingSlug(m[1] ?? "");
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 本文（コードブロックの外）の「- <項目>: <値>」の行を探し、ちょうど1行・決まった形であれば値を返す。
 * 字下げ・全角のコロン・前後の空白など、形の崩れた行も「その項目の行」として数える（見逃さないため）。
 * 問題があれば errors に足して undefined を返す。required が false なら、行が無いときは何も足さない。
 */
function fieldValue(
  body: string,
  key: string,
  label: string,
  errors: string[],
  required = true,
): string | undefined {
  const k = escapeRegExp(key);
  const loose = new RegExp(`^\\s*[-*+]\\s*${k}\\s*[:：]`);
  const strict = new RegExp(`^- ${k}: (\\S(?:.*\\S)?)$`);
  const lines = stripFences(body)
    .split("\n")
    .filter((line) => loose.test(line));
  if (lines.length === 0) {
    if (required) errors.push(`${label}: 「${key}」の行が無い`);
    return undefined;
  }
  if (lines.length > 1) {
    errors.push(`${label}: 「${key}」の行が${lines.length}行ある`);
    return undefined;
  }
  const value = strict.exec(lines[0] ?? "")?.[1];
  if (value === undefined) errors.push(`${label}: 「${key}」の行の書き方が違う: ${lines[0]}`);
  return value;
}

// ---- ADR ----

const REF_LINK = String.raw`\[[^\]]+\]\(([^()\s/#]+\.md)\)(?:（[^（）]*）)?`;
const REFS = new RegExp(`^${REF_LINK}(?:、${REF_LINK})*$`);

/** 置き換え元・置き換え先の値を、リンク先のファイル名の一覧にする（`なし` は空）。形が違えば undefined。 */
function parseRefs(value: string): string[] | undefined {
  if (value === "なし") return [];
  if (!REFS.test(value)) return undefined;
  return [...value.matchAll(new RegExp(REF_LINK, "g"))].map((m) => m[1] ?? "");
}

interface AdrInfo {
  status: string;
  prev: string[];
  next: string[];
}

/** ADR のファイル名と先頭の項目、置き換えの関係を確かめ、問題の一覧を返す。 */
function checkAdrs(files: Record<string, string>, table: StatusTable = STATUS_TABLE): string[] {
  const errors: string[] = [];
  const pattern = adrNamePattern(table);
  const infos = new Map<string, AdrInfo>();

  for (const [name, body] of Object.entries(files)) {
    const m = pattern.exec(name);
    if (m === null) {
      errors.push(`${name}: ファイル名が規則に合わない`);
      continue;
    }
    const [, ymd = "", hm = "", status = ""] = m;
    if (!isValidDateTime(ymd, hm)) errors.push(`${name}: ファイル名の日時が正しくない`);

    const date = fieldValue(body, "日時", name, errors);
    const expectedDate = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} ${hm.slice(0, 2)}:${hm.slice(2, 4)} UTC`;
    if (date !== undefined && date !== expectedDate) {
      errors.push(`${name}: 日時「${date}」がファイル名（${expectedDate}）と違う`);
    }

    const declared = fieldValue(body, "ステータス", name, errors);
    const expectedStatus = table.get(status);
    if (declared !== undefined && declared !== expectedStatus) {
      errors.push(
        `${name}: ステータス「${declared}」がファイル名に合う表記「${expectedStatus}」と違う`,
      );
    }

    fieldValue(body, "関係する PR・タスク", name, errors);

    const refs = (key: string): string[] => {
      const value = fieldValue(body, key, name, errors);
      if (value === undefined) return [];
      const parsed = parseRefs(value);
      if (parsed === undefined)
        errors.push(`${name}: 「${key}」は なし か ADR へのリンク: ${value}`);
      return parsed ?? [];
    };
    const prev = refs("置き換え元");
    const next = refs("置き換え先");

    const abolished = fieldValue(body, "廃止", name, errors, status === "deprecated");
    if (status === "deprecated") {
      if (abolished !== undefined && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \S/.test(abolished)) {
        errors.push(`${name}: 「廃止」は YYYY-MM-DD HH:MM UTC <理由> の形: ${abolished}`);
      }
    } else if (abolished !== undefined) {
      errors.push(`${name}: deprecated でないのに「廃止」の行がある`);
    }

    if (status === "superseded" && next.length === 0) {
      errors.push(`${name}: superseded なのに置き換え先が無い`);
    }
    if (status !== "superseded" && next.length > 0) {
      errors.push(`${name}: superseded でないのに置き換え先がある`);
    }
    infos.set(name, { status, prev, next });
  }

  for (const [name, info] of infos) {
    for (const next of info.next) {
      const target = infos.get(next);
      if (next === name) errors.push(`${name}: 置き換え先が自分自身`);
      else if (target === undefined) errors.push(`${name}: 置き換え先 ${next} が無い`);
      else if (!target.prev.includes(name)) {
        errors.push(`${next}: 置き換え元に ${name} へのリンクが無い（${name} の置き換え先）`);
      }
    }
    for (const prev of info.prev) {
      const source = infos.get(prev);
      if (prev === name) errors.push(`${name}: 置き換え元が自分自身`);
      else if (source === undefined) errors.push(`${name}: 置き換え元 ${prev} が無い`);
      else {
        if (source.status !== "superseded")
          errors.push(`${prev}: 置き換えられたのに superseded でない`);
        if (!source.next.includes(name)) {
          errors.push(`${prev}: 置き換え先に ${name} へのリンクが無い（${name} の置き換え元）`);
        }
      }
    }
  }
  return errors;
}

// ---- 作業履歴 ----

/** 作業履歴のファイル名と先頭の項目を確かめ、問題の一覧を返す。 */
function checkWorklogs(files: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    const m = WORKLOG_NAME.exec(name);
    if (m === null) {
      errors.push(`${name}: ファイル名が規則に合わない`);
      continue;
    }
    const [, ymd = "", slug = ""] = m;
    if (!isValidDateTime(ymd)) errors.push(`${name}: ファイル名の日付が正しくない`);
    const pbi = /^pbi-(\d+)-/.exec(slug)?.[1];
    const pr = /^pr-(\d+)-/.exec(slug)?.[1];
    if (/^pbi-/.test(slug) && pbi === undefined)
      errors.push(`${name}: pbi- の後は <番号>-<スラッグ>`);
    if (/^pr-/.test(slug) && pr === undefined) errors.push(`${name}: pr- の後は <番号>-<スラッグ>`);

    const date = fieldValue(body, "日付", name, errors);
    const expectedDate = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}（UTC）`;
    if (date !== undefined && date !== expectedDate) {
      errors.push(`${name}: 日付「${date}」がファイル名（${expectedDate}）と違う`);
    }

    const task = fieldValue(body, "タスク", name, errors);
    if (task !== undefined && !/^(?:PBI-\d+|なし)$/.test(task)) {
      errors.push(`${name}: タスクは PBI-<番号> か なし: ${task}`);
    }
    if (pbi !== undefined && task !== undefined && task !== `PBI-${pbi}`) {
      errors.push(`${name}: タスク「${task}」がファイル名（PBI-${pbi}）と違う`);
    }

    const prValue = fieldValue(body, "PR", name, errors);
    if (prValue !== undefined && !/^(?:#\d+|なし)$/.test(prValue)) {
      errors.push(`${name}: PR は #<番号> か なし: ${prValue}`);
    }
    if (pr !== undefined && prValue !== undefined && prValue !== `#${pr}`) {
      errors.push(`${name}: PR「${prValue}」がファイル名（#${pr}）と違う`);
    }

    // 本文 → ファイル名の向き：本文に PBI があれば pbi-<番号>-、PBI が無く PR があれば pr-<番号>- で始まる
    const bodyPbi = task === undefined ? undefined : /^PBI-(\d+)$/.exec(task)?.[1];
    const bodyPr = prValue === undefined ? undefined : /^#(\d+)$/.exec(prValue)?.[1];
    if (task !== undefined && prValue !== undefined) {
      const prefix =
        bodyPbi !== undefined
          ? `pbi-${bodyPbi}-`
          : bodyPr !== undefined
            ? `pr-${bodyPr}-`
            : undefined;
      if (prefix !== undefined && !slug.startsWith(prefix)) {
        errors.push(
          `${name}: 本文の${bodyPbi !== undefined ? "タスク" : "PR"}に合わせ、スラッグを ${prefix} で始める`,
        );
      }
      if (prefix === undefined && /^(?:pbi|pr)-/.test(slug)) {
        errors.push(`${name}: タスクも PR も なし なのに、スラッグが pbi- か pr- で始まる`);
      }
    }

    fieldValue(body, "ブランチ", name, errors);
    fieldValue(body, "関係する ADR", name, errors);
  }
  return errors;
}

// ---- 仕様書のコードの参照 ----

/** 「コード:」の行から、空行か見出しの前までをひとまとまりとして集める（コードブロックの中は除く）。 */
function codeRefBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of stripFences(markdown).split("\n")) {
    if (line.startsWith("コード:")) {
      if (current) blocks.push(current.join(" "));
      current = [line];
    } else if (current && line.trim() !== "" && !line.startsWith("#")) {
      current.push(line);
    } else if (current) {
      blocks.push(current.join(" "));
      current = undefined;
    }
  }
  if (current) blocks.push(current.join(" "));
  return blocks;
}

/**
 * 仕様書の「コード:」の参照を確かめ、問題の一覧を返す。`<パス>`（リポジトリのルートからの相対パス）が存在し、その後の
 * 括弧の中の `<名前>`（`A.b` は A と b の両方）が、そのファイルの中に語として現れること。read はファイルの中身
 * （無ければ undefined）。参照が1つも無ければ問題にする。
 */
function checkCodeRefs(
  name: string,
  markdown: string,
  read: (path: string) => string | undefined,
): string[] {
  const errors: string[] = [];
  const blocks = codeRefBlocks(markdown);
  if (blocks.length === 0) errors.push(`${name}: 「コード:」の参照が無い`);
  const ref = /`((?:apps|packages|tests)\/[^`\s]+)`(?:（([^）]*)）)?/g;
  for (const block of blocks) {
    const refs = [...block.matchAll(ref)];
    if (refs.length === 0) errors.push(`${name}: ファイルの無い参照: ${block}`);
    for (const [, path = "", names = ""] of refs) {
      const source = read(path);
      if (source === undefined) {
        errors.push(`${name}: ${path} が無い`);
        continue;
      }
      for (const [, symbol = ""] of names.matchAll(/`([^`]+)`/g)) {
        const missing = symbol
          .split(".")
          .filter((part) => !new RegExp(`(?<![\\w$])${escapeRegExp(part)}(?![\\w$])`).test(source));
        if (missing.length > 0) errors.push(`${name}: ${path} に ${symbol} が無い`);
      }
    }
  }
  return errors;
}

// ---- スキル ----

/** スキルの front matter（name がディレクトリ名と同じ・description がある）を確かめ、問題の一覧を返す。 */
function checkSkillFrontMatter(text: string, expectedName: string): string[] {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (front === undefined) return ["front matter が無い"];
  const errors: string[] = [];
  const lines = front.split("\n");
  const names = lines.filter((line) => /^name\s*:/.test(line));
  if (names.length !== 1) errors.push(`name の行が${names.length}行ある`);
  else if (names[0] !== `name: ${expectedName}`)
    errors.push(`name が ${expectedName} でない: ${names[0]}`);
  const descriptions = lines.filter((line) => /^description\s*:/.test(line));
  if (descriptions.length !== 1) errors.push(`description の行が${descriptions.length}行ある`);
  else if (!/^description: \S(?:.*\S)?$/.test(descriptions[0] ?? "")) {
    errors.push(`description が空か、形が違う: ${descriptions[0]}`);
  }
  return errors;
}

function readDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name === "README.md") continue;
    const path = join(dir, name);
    out[name] = statSync(path).isDirectory() ? "" : readFileSync(path, "utf8");
  }
  return out;
}

// ---- リポジトリの docs を確かめる ----

describe("docs の構成", () => {
  it("4種類のディレクトリと、それぞれの README がある", () => {
    expect(existsSync(join(DOCS, "README.md"))).toBe(true);
    for (const kind of KINDS) {
      expect(statSync(join(DOCS, kind)).isDirectory(), kind).toBe(true);
      expect(existsSync(join(DOCS, kind, "README.md")), kind).toBe(true);
    }
  });

  it("ADR の README のステータスの表と、ひな形のステータスの行が食い違わない", () => {
    expect([...STATUS_TABLE.keys()]).toEqual(["", "superseded", "deprecated", "rejected"]);
    const readme = readFileSync(join(ADR_DIR, "README.md"), "utf8");
    const template = /^- ステータス: (.+)$/m.exec(readme)?.[1];
    expect(template?.split(" | ")).toEqual([...STATUS_TABLE.values()]);
  });

  it("仕様書・ユーザードキュメントのファイル名は英小文字・数字・- だけ（日時を付けない）", () => {
    for (const kind of ["spec", "user"] as const) {
      for (const file of markdownFiles(join(DOCS, kind))) {
        const name = relative(join(DOCS, kind), file).split("/").pop() ?? "";
        if (name === "README.md") continue;
        expect(name, file).toMatch(PLAIN_NAME);
        expect(name, file).not.toMatch(/^\d{8}/);
      }
    }
  });

  it("ADR のファイル名・先頭の項目・置き換えの関係が規則どおり", () => {
    const files = readDir(ADR_DIR);
    expect(Object.keys(files).length).toBeGreaterThan(0);
    // ADR はディレクトリに分けない（一覧で決定の順に並ぶように）
    for (const entry of readdirSync(ADR_DIR, { withFileTypes: true })) {
      expect(entry.isDirectory(), entry.name).toBe(false);
    }
    expect(checkAdrs(files)).toEqual([]);
  });

  it("作業履歴のファイル名・先頭の項目が規則どおり", () => {
    for (const entry of readdirSync(WORKLOG_DIR, { withFileTypes: true })) {
      expect(entry.isDirectory(), entry.name).toBe(false);
    }
    expect(checkWorklogs(readDir(WORKLOG_DIR))).toEqual([]);
  });

  it("仕様書の「コード:」の参照のファイルと名前が、リポジトリにある", () => {
    const read = (path: string) => {
      const full = join(ROOT, path);
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : undefined;
    };
    const errors: string[] = [];
    for (const file of markdownFiles(join(DOCS, "spec"))) {
      if (file.endsWith("README.md")) continue;
      errors.push(...checkCodeRefs(relative(ROOT, file), readFileSync(file, "utf8"), read));
    }
    expect(errors).toEqual([]);
  });

  it("docs・README・スキルの相対リンクが切れておらず、docs/pbi へリンクしない", () => {
    const files = [...markdownFiles(DOCS), join(ROOT, "README.md"), ...SKILL_COPIES];
    const broken: string[] = [];
    for (const file of files) {
      for (const link of relativeLinks(readFileSync(file, "utf8"))) {
        const path = decodeURIComponent(link.split("#")[0] ?? "");
        if (path === "") continue;
        const target = resolve(dirname(file), path);
        const rel = relative(ROOT, file);
        if (relative(DOCS, target).split("/")[0] === "pbi")
          broken.push(`${rel}: ${link}（docs/pbi）`);
        else if (!existsSync(target)) broken.push(`${rel}: ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("ユーザードキュメントと README", () => {
  const USER_DIR = join(DOCS, "user");

  it("Markdown へのリンクのアンカー（#…）が、行き先の見出しにある", () => {
    const files = [...markdownFiles(DOCS), join(ROOT, "README.md"), ...SKILL_COPIES];
    const broken: string[] = [];
    for (const file of files) {
      for (const link of anchorLinks(readFileSync(file, "utf8"))) {
        const [pathPart = "", fragment = ""] = link.split("#");
        const target =
          pathPart === "" ? file : resolve(dirname(file), decodeURIComponent(pathPart));
        if (!target.endsWith(".md") || !existsSync(target)) continue;
        const anchor = decodeURIComponent(fragment);
        if (!headingAnchors(readFileSync(target, "utf8")).has(anchor)) {
          broken.push(`${relative(ROOT, file)}: ${link}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("すべてのユーザードキュメントが、目次にあり、先頭に対応するコードを書いている", () => {
    const readme = readFileSync(join(USER_DIR, "README.md"), "utf8");
    const toc = readme.slice(readme.indexOf("## 目次"));
    expect(toc.startsWith("## 目次")).toBe(true);
    const listed = relativeLinks(toc);
    for (const file of markdownFiles(USER_DIR)) {
      const name = relative(USER_DIR, file);
      if (name === "README.md") continue;
      expect(listed, `目次に ${name} が無い`).toContain(name);
      expect(readFileSync(file, "utf8"), name).toMatch(/^<!-- 対応するコード: \S[^\n]*-->\n/);
    }
  });

  it("ユーザードキュメントの書き方の規則は docs/README.md にあり、利用者向けの目次には置かない", () => {
    const policy = readFileSync(join(DOCS, "README.md"), "utf8");
    expect(headingAnchors(policy).has("ユーザードキュメントの書き方")).toBe(true);
    expect(policy).toContain("です・ます調");
    const headings = stripFences(readFileSync(join(USER_DIR, "README.md"), "utf8"))
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => line.replace(/^#+ /, ""));
    for (const rule of ["ファイルの分け方", "書き方の規則", "ひな形"]) {
      expect(headings, rule).not.toContain(rule);
    }
  });

  it("リポジトリの README から、ユーザードキュメントの目次へリンクしている", () => {
    expect(relativeLinks(readFileSync(join(ROOT, "README.md"), "utf8"))).toContain(
      "docs/user/README.md",
    );
  });
});

describe("docs のスキル（Claude Code 用・Codex 用）", () => {
  it("2つの写しが同じ内容である", () => {
    const [claude, codex] = SKILL_COPIES.map((path) => readFileSync(path, "utf8"));
    expect(codex).toBe(claude);
  });

  it("front matter の name がディレクトリ名と同じで、description がある", () => {
    for (const path of SKILL_COPIES) {
      expect(checkSkillFrontMatter(readFileSync(path, "utf8"), SKILL_NAME), path).toEqual([]);
    }
  });
});

// ---- 検査の部品（回帰テスト） ----

/** 規則どおりの ADR の本文。overrides で先頭の項目の行を差し替える（null は行を消す）。 */
function adrBody(overrides: Record<string, string | null> = {}, extra: string[] = []): string {
  const fields: Record<string, string | null> = {
    日時: "2026-10-14 08:16 UTC",
    ステータス: "採用",
    "関係する PR・タスク": "#1",
    置き換え元: "なし",
    置き換え先: "なし",
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `- ${key}: ${value}`);
  return ["# 決定", "", ...lines, ...extra, "", "## 背景", "", "本文"].join("\n");
}

const OK_ADR = "20261014-0816-a.md";

describe("検査の部品", () => {
  it("ステータスの表を読む", () => {
    const table = parseStatusTable(
      [
        `${STATUS_TABLE_HEADER} 意味 |`,
        "| --- | --- | --- |",
        "| （無し） | `採用` | x |",
        "| `superseded` | `置き換え済み（superseded）` | x |",
        "",
      ].join("\n"),
    );
    expect([...table]).toEqual([
      ["", "採用"],
      ["superseded", "置き換え済み（superseded）"],
    ]);
    expect(() => parseStatusTable("無し")).toThrow();
    expect(() =>
      parseStatusTable(
        [
          STATUS_TABLE_HEADER,
          "| --- | --- |",
          "| （無し） | `採用` |",
          "| `rejected` | `採用` |",
        ].join("\n"),
      ),
    ).toThrow();
    expect(() =>
      parseStatusTable([STATUS_TABLE_HEADER, "| --- | --- |", "| `x` | 採用 |"].join("\n")),
    ).toThrow();
  });

  it("ADR のファイル名の規則", () => {
    const pattern = adrNamePattern(STATUS_TABLE);
    expect(pattern.test("20261014-0816-docs-structure.md")).toBe(true);
    expect(pattern.test("20261014-0816-superseded-docs-structure.md")).toBe(true);
    expect(pattern.test("20261014-0816-deprecated-x.md")).toBe(true);
    expect(pattern.test("20261014-0816-rejected-x.md")).toBe(true);
    expect(pattern.test("20261014-docs-structure.md")).toBe(false);
    expect(pattern.test("2026-10-14-0816-docs.md")).toBe(false);
    expect(pattern.test("20261014-0816-Docs.md")).toBe(false);
    expect(pattern.test("20261014-0816-superseded.md")).toBe(false);
    expect(pattern.test("20261014-0816-docs-superseded.md")).toBe(true);
    expect(pattern.test("20261014-0816-superseded-superseded-x.md")).toBe(false);
    expect(pattern.test("20261014-0816-unknown-x.md")).toBe(true); // 未知の語はスラッグの一部
    expect(isValidDateTime("20261399", "0000")).toBe(false);
    expect(isValidDateTime("20261014", "2460")).toBe(false);
    expect(isValidDateTime("20240229", "2359")).toBe(true);
  });

  it("規則どおりの ADR は通る", () => {
    expect(checkAdrs({ [OK_ADR]: adrBody() })).toEqual([]);
    expect(
      checkAdrs({
        "20261014-0816-superseded-a.md": adrBody({
          ステータス: "置き換え済み（superseded）",
          置き換え先: "[b](20261015-0000-b.md)（一部）",
        }),
        "20261015-0000-b.md": adrBody({
          日時: "2026-10-15 00:00 UTC",
          置き換え元: "[a](20261014-0816-superseded-a.md)",
        }),
        "20261016-0000-deprecated-c.md": adrBody(
          { 日時: "2026-10-16 00:00 UTC", ステータス: "廃止（deprecated）" },
          ["- 廃止: 2026-10-17 00:00 UTC 使わなくなった（#2）"],
        ),
        "20261016-0100-rejected-d.md": adrBody({
          日時: "2026-10-16 01:00 UTC",
          ステータス: "却下（rejected）",
        }),
      }),
    ).toEqual([]);
  });

  it.each([
    ["表に無い語（「採用」を含む）", { ステータス: "不採用" }],
    ["表記に語を足す", { ステータス: "採用（2026-10-14）" }],
    ["別のステータスの表記", { ステータス: "却下（rejected）" }],
    ["置き換え済みの表記の一部だけ", { ステータス: "superseded" }],
    ["ステータスの行が無い", { ステータス: null }],
  ])("ADR のステータス：%s は失敗する", (_, overrides) => {
    expect(checkAdrs({ [OK_ADR]: adrBody(overrides) })).not.toEqual([]);
  });

  it.each([
    ["値の前に空白", "- ステータス:  採用"],
    ["値の後ろに空白", "- ステータス: 採用 "],
    ["全角のコロン", "- ステータス：採用"],
    ["字下げ", "  - ステータス: 採用"],
  ])("ADR のステータスの行の形：%s は失敗する", (_, line) => {
    const body = adrBody({ ステータス: null }).replace("- 関係する", `${line}\n- 関係する`);
    expect(checkAdrs({ [OK_ADR]: body })).not.toEqual([]);
  });

  it("ADR のステータス：別の行に「採用」があるだけでは失敗する", () => {
    const body = adrBody({ ステータス: null }, ["- メモ: 採用"]);
    expect(checkAdrs({ [OK_ADR]: body })).toContain(`${OK_ADR}: 「ステータス」の行が無い`);
  });

  it("ADR のステータス：行が2行あると失敗する（片方が正しくても）", () => {
    const body = adrBody({}, ["- ステータス: 採用"]);
    expect(checkAdrs({ [OK_ADR]: body })).toContain(`${OK_ADR}: 「ステータス」の行が2行ある`);
    const mixed = adrBody({}, ["- ステータス: 却下（rejected）"]);
    expect(checkAdrs({ [OK_ADR]: mixed })).not.toEqual([]);
  });

  it("ADR のステータス：ファイル名が superseded で本文が「採用」なら失敗する", () => {
    expect(
      checkAdrs({
        "20261014-0816-superseded-a.md": adrBody({ 置き換え先: "[b](20261015-0000-b.md)" }),
        "20261015-0000-b.md": adrBody({
          日時: "2026-10-15 00:00 UTC",
          置き換え元: "[a](20261014-0816-superseded-a.md)",
        }),
      }),
    ).toEqual([
      "20261014-0816-superseded-a.md: ステータス「採用」がファイル名に合う表記「置き換え済み（superseded）」と違う",
    ]);
  });

  it("ADR のステータス：コードブロックの中の行は数えない", () => {
    const body = adrBody({}, ["", "```markdown", "- ステータス: 却下（rejected）", "```"]);
    expect(checkAdrs({ [OK_ADR]: body })).toEqual([]);
  });

  it.each([
    ["日時がファイル名と違う", { 日時: "2026-10-14 08:17 UTC" }],
    ["日時の形が違う", { 日時: "2026-10-14T08:16Z" }],
    ["関係する PR・タスクの行が無い", { "関係する PR・タスク": null }],
    ["置き換え元の行が無い", { 置き換え元: null }],
    ["置き換え先が なし でもリンクでもない", { 置き換え先: "なしです" }],
    ["置き換え先のリンクの後ろに余計な語", { 置き換え先: "[b](20261015-0000-b.md) ほか" }],
    ["superseded でないのに置き換え先がある", { 置き換え先: "[b](20261015-0000-b.md)" }],
    ["置き換え元が自分自身", { 置き換え元: `[a](${OK_ADR})` }],
    ["置き換え元が無いファイル", { 置き換え元: "[x](20200101-0000-superseded-x.md)" }],
  ])("ADR の先頭の項目：%s は失敗する", (_, overrides) => {
    expect(checkAdrs({ [OK_ADR]: adrBody(overrides) })).not.toEqual([]);
  });

  it("ADR の置き換え：片方にしか書いていないと失敗する", () => {
    const old = "20261014-0816-superseded-a.md";
    const oldBody = adrBody({
      ステータス: "置き換え済み（superseded）",
      置き換え先: "[b](20261015-0000-b.md)",
    });
    const newer = "20261015-0000-b.md";
    const newerBody = adrBody({ 日時: "2026-10-15 00:00 UTC" });
    expect(checkAdrs({ [old]: oldBody, [newer]: newerBody })).toEqual([
      `${newer}: 置き換え元に ${old} へのリンクが無い（${old} の置き換え先）`,
    ]);
    // 置き換え元だけ書いて、古い ADR を superseded にしていない
    const plain = "20261014-0816-a.md";
    expect(
      checkAdrs({
        [plain]: adrBody(),
        [newer]: adrBody({ 日時: "2026-10-15 00:00 UTC", 置き換え元: `[a](${plain})` }),
      }),
    ).toEqual([
      `${plain}: 置き換えられたのに superseded でない`,
      `${plain}: 置き換え先に ${newer} へのリンクが無い（${newer} の置き換え元）`,
    ]);
  });

  it("ADR の廃止：deprecated に廃止の行が無い・deprecated でないのに廃止の行があると失敗する", () => {
    expect(
      checkAdrs({ "20261014-0816-deprecated-a.md": adrBody({ ステータス: "廃止（deprecated）" }) }),
    ).toEqual(["20261014-0816-deprecated-a.md: 「廃止」の行が無い"]);
    expect(
      checkAdrs({ [OK_ADR]: adrBody({}, ["- 廃止: 2026-10-17 00:00 UTC やめた（#2）"]) }),
    ).toEqual([`${OK_ADR}: deprecated でないのに「廃止」の行がある`]);
  });

  it("作業履歴のファイル名の規則", () => {
    expect(WORKLOG_NAME.test("20261014-pbi-80-docs-structure.md")).toBe(true);
    expect(WORKLOG_NAME.test("pbi-80.md")).toBe(false);
    expect(WORKLOG_NAME.test("20261014_pbi-80.md")).toBe(false);
  });

  const worklog = (overrides: Record<string, string | null> = {}): string => {
    const fields: Record<string, string | null> = {
      日付: "2026-10-14（UTC）",
      タスク: "PBI-80",
      PR: "#88",
      ブランチ: "feat/issue-80-docs-structure",
      "関係する ADR": "なし",
      ...overrides,
    };
    return [
      "# 作業",
      "",
      ...Object.entries(fields)
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([key, value]) => `- ${key}: ${value}`),
    ].join("\n");
  };
  const WL = "20261014-pbi-80-docs-structure.md";

  it("規則どおりの作業履歴は通る", () => {
    expect(checkWorklogs({ [WL]: worklog() })).toEqual([]);
    expect(checkWorklogs({ "20261014-pr-88-x.md": worklog({ タスク: "なし" }) })).toEqual([]);
    expect(checkWorklogs({ "20261014-x.md": worklog({ タスク: "なし", PR: "なし" }) })).toEqual([]);
  });

  it.each([
    ["タスクの番号がファイル名の番号の一部だけ", WL, { タスク: "PBI-8" }],
    ["タスクの番号がファイル名の番号を含むだけ", WL, { タスク: "PBI-800" }],
    ["PR の番号がファイル名と違う", "20261014-pr-88-x.md", { PR: "#8" }],
    ["PR の後ろに空白", WL, { PR: "#88 " }],
    ["PR の形が違う", WL, { PR: "88" }],
    ["日付がファイル名と違う", WL, { 日付: "2026-10-15（UTC）" }],
    ["日付の形が違う", WL, { 日付: "2026-10-14" }],
    ["タスクの行が無い", WL, { タスク: null }],
    ["pbi- の後に番号が無い", "20261014-pbi-x.md", { タスク: "なし" }],
    ["pbi-<番号> の後にスラッグが無い", "20261014-pbi-80.md", {}],
  ])("作業履歴：%s は失敗する", (_, name, overrides) => {
    expect(checkWorklogs({ [name]: worklog(overrides) })).not.toEqual([]);
  });

  it.each([
    ["PBI があるのに接頭辞を外した", "20261014-docs-structure.md", {}],
    ["PBI があるのに pr- で始まる", "20261014-pr-88-docs-structure.md", {}],
    ["PBI の番号がファイル名と違う（本文 → ファイル名）", "20261014-pbi-81-docs-structure.md", {}],
    ["PBI の番号の前方一致", "20261014-pbi-8-docs-structure.md", {}],
    ["PBI が無く PR があるのに接頭辞を外した", "20261014-docs-structure.md", { タスク: "なし" }],
    ["PBI が無く PR があるのに番号が違う", "20261014-pr-8-docs-structure.md", { タスク: "なし" }],
    ["PBI も PR も無いのに pbi- で始まる", "20261014-pbi-80-x.md", { タスク: "なし", PR: "なし" }],
    ["PBI も PR も無いのに pr- で始まる", "20261014-pr-88-x.md", { タスク: "なし", PR: "なし" }],
  ])("作業履歴の本文とファイル名：%s は失敗する", (_, name, overrides) => {
    expect(checkWorklogs({ [name]: worklog(overrides) })).not.toEqual([]);
  });

  it("作業履歴の本文とファイル名：PBI と PR の両方があれば pbi- で始め、どちらも無ければ接頭辞を付けない", () => {
    expect(checkWorklogs({ [WL]: worklog() })).toEqual([]);
    expect(checkWorklogs({ "20261014-x.md": worklog({ タスク: "なし", PR: "なし" }) })).toEqual([]);
    expect(checkWorklogs({ "20261014-pbi-80-x.md": worklog({ PR: "なし" }) })).toEqual([]);
  });

  it("作業履歴：日付の行が2行あると失敗する", () => {
    expect(checkWorklogs({ [WL]: `${worklog()}\n- 日付: 2026-10-14（UTC）` })).toContain(
      `${WL}: 「日付」の行が2行ある`,
    );
  });

  it("スキルの front matter", () => {
    const ok = "---\nname: sacty-docs\ndescription: 説明\n---\n\n本文\n";
    expect(checkSkillFrontMatter(ok, SKILL_NAME)).toEqual([]);
    for (const bad of [
      "name: sacty-docs\ndescription: 説明\n\n本文\n", // front matter が無い
      "---\nname: sacty-docs-old\ndescription: 説明\n---\n", // 名前の前方一致
      "---\nname: sacty-docs \ndescription: 説明\n---\n", // 後ろに空白
      "---\nname: sacty-docs\nname: other\ndescription: 説明\n---\n", // 2行
      "---\nname: sacty-docs\ndescription:   \n---\n", // description が空白だけ
      "---\nname: sacty-docs\n---\ndescription: 本文にあるだけ\n", // front matter の外
    ]) {
      expect(checkSkillFrontMatter(bad, SKILL_NAME), bad).not.toEqual([]);
    }
  });

  it("仕様書のコードの参照：ファイル・名前が無ければ失敗し、あれば通る", () => {
    const sources: Record<string, string> = {
      "apps/daemon/src/a.ts": "export class Foo { bar() {} }\nconst $baz = 1;\n",
    };
    const read = (path: string) => sources[path];
    const ok = [
      "# x",
      "",
      "本文",
      "",
      "コード: `apps/daemon/src/a.ts`（`Foo`・`Foo.bar`・`$baz`）、",
      "`apps/daemon/src/a.ts`",
      "",
    ].join("\n");
    expect(checkCodeRefs("ok.md", ok, read)).toEqual([]);
    for (const bad of [
      "本文だけ\n", // 参照が無い
      "コード: `apps/daemon/src/b.ts`\n", // ファイルが無い
      "コード: `apps/daemon/src/a.ts`（`Qux`）\n", // 名前が無い
      "コード: `apps/daemon/src/a.ts`（`Foo.qux`）\n", // 2つ目の部分が無い
      "コード: `apps/daemon/src/a.ts`（`Fo`）\n", // 語の一部だけ
      "コード: `apps/daemon/src/a.ts`（`Foo`）\n`apps/daemon/src/a.ts`（`Nope`）\n", // 続きの行
      "コード: なし\n", // ファイルの無い参照
    ]) {
      expect(checkCodeRefs("bad.md", bad, read), bad).not.toEqual([]);
    }
    // コードブロックの中の「コード:」は数えない
    expect(checkCodeRefs("fence.md", "```markdown\nコード: `apps/x.ts`\n```\n", read)).toEqual([
      "fence.md: 「コード:」の参照が無い",
    ]);
  });

  it("コードの中のリンクと外部のリンクは検査しない", () => {
    const md = [
      "[a](a.md) [b](https://example.com) [c](#top) ![d](img/d.png)",
      "`[e](e.md)`",
      "```markdown",
      "[f](f.md)",
      "```",
      "[g](<g h.md>) [i](i.md#x)",
    ].join("\n");
    expect(relativeLinks(md)).toEqual(["a.md", "img/d.png", "g h.md", "i.md#x"]);
  });

  it("アンカーの付いたリンクを集める（同じファイルの #… を含み、外部とコードの中は除く）", () => {
    const md = [
      "[a](a.md) [b](https://example.com/#x) [c](#top) [d](d.md#sec)",
      "`[e](e.md#y)`",
      "```markdown",
      "[f](f.md#z)",
      "```",
    ].join("\n");
    expect(anchorLinks(md)).toEqual(["#top", "d.md#sec"]);
  });

  it("見出しのアンカーは GitHub と同じ規則で作る", () => {
    expect(headingSlug("GitHub アカウント")).toBe("github-アカウント");
    expect(headingSlug("OpenAI 互換の接続先（providers）")).toBe("openai-互換の接続先providers");
    expect(headingSlug("`sacty up`")).toBe("sacty-up");
    expect(headingSlug("mcp.yaml")).toBe("mcpyaml");
    expect(headingSlug("PR での承認（要求要件・設計・成果物チェック）")).toBe(
      "pr-での承認要求要件設計成果物チェック",
    );
    expect(headingSlug("step_agents と [リンク](x.md)")).toBe("step_agents-と-リンク");
    const anchors = headingAnchors(
      ["# 題", "## 手順", "### 手順", "```", "## コードの中", "```", "## 末尾 ##"].join("\n"),
    );
    expect([...anchors]).toEqual(["題", "手順", "手順-1", "末尾"]);
  });
});
