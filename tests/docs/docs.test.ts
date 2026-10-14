// docs の構成の規則（docs/README.md と各ディレクトリの README.md）を確かめる。
// - ADR・作業履歴・仕様書・ユーザードキュメントのファイル名
// - ADR の置き換えの関係（superseded の置き換え先と、そのリンク先の置き換え元）
// - docs・README・スキルの中の相対リンクが切れていないこと、docs/pbi へリンクしないこと
// - Claude Code 用と Codex 用のスキルが同じ内容であること
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = join(ROOT, "docs");
const KINDS = ["spec", "user", "adr", "worklog"] as const;
const SKILL_NAME = "sacty-docs";
const SKILL_COPIES = [
  join(ROOT, ".claude", "skills", SKILL_NAME, "SKILL.md"),
  join(ROOT, ".agents", "skills", SKILL_NAME, "SKILL.md"),
];

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const STATUSES = ["superseded", "deprecated", "rejected"] as const;
const ADR_NAME = new RegExp(
  `^(\\d{8})-(\\d{4})(?:-(${STATUSES.join("|")}))?-((?!(?:${STATUSES.join("|")})(?:-|\\.md$))${SLUG})\\.md$`,
);
const WORKLOG_NAME = new RegExp(`^(\\d{8})-(${SLUG})\\.md$`);
const PLAIN_NAME = new RegExp(`^${SLUG}\\.md$`);

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

/** コードブロックとインラインコードを除いた本文（ひな形の中の例のリンクを検査しないため）。 */
function stripCode(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
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

function adrFiles(): string[] {
  const dir = join(DOCS, "adr");
  return readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md");
}

/** ADR の本文の「- <項目>: <値>」の値。 */
function field(markdown: string, key: string): string | undefined {
  return new RegExp(`^- ${key}: (.*)$`, "m").exec(markdown)?.[1]?.trim();
}

/** 値の中のリンクの行き先（ファイル名だけ）。 */
function linkedFiles(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...value.matchAll(/\]\(([^)]+)\)/g)].map((m) => (m[1] ?? "").split("#")[0] ?? "");
}

describe("docs の構成", () => {
  it("4種類のディレクトリと、それぞれの README がある", () => {
    expect(existsSync(join(DOCS, "README.md"))).toBe(true);
    for (const kind of KINDS) {
      expect(statSync(join(DOCS, kind)).isDirectory(), kind).toBe(true);
      expect(existsSync(join(DOCS, kind, "README.md")), kind).toBe(true);
    }
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

  it("ADR のファイル名は <YYYYMMDD-HHMM>[-<ステータス>]-<スラッグ>.md", () => {
    const names = adrFiles();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const m = ADR_NAME.exec(name);
      expect(m, name).not.toBeNull();
      expect(isValidDateTime(m?.[1] ?? "", m?.[2] ?? ""), name).toBe(true);
    }
    // ADR はディレクトリに分けない（一覧で決定の順に並ぶように）
    for (const entry of readdirSync(join(DOCS, "adr"), { withFileTypes: true })) {
      expect(entry.isDirectory(), entry.name).toBe(false);
    }
  });

  it("ADR の本文のステータスとファイル名のステータスが合い、置き換えの関係が双方に書いてある", () => {
    const words: Record<string, string> = {
      "": "採用",
      superseded: "superseded",
      deprecated: "deprecated",
      rejected: "rejected",
    };
    for (const name of adrFiles()) {
      const body = readFileSync(join(DOCS, "adr", name), "utf8");
      const status = ADR_NAME.exec(name)?.[3] ?? "";
      const declared = field(body, "ステータス") ?? "";
      expect(declared, `${name} のステータス`).toContain(words[status]);
      expect(field(body, "置き換え元"), `${name} の置き換え元`).toBeDefined();
      expect(field(body, "置き換え先"), `${name} の置き換え先`).toBeDefined();

      const successors = linkedFiles(field(body, "置き換え先"));
      if (status === "superseded") {
        expect(successors.length, `${name} の置き換え先`).toBeGreaterThan(0);
      }
      for (const next of successors) {
        expect(existsSync(join(DOCS, "adr", next)), `${name} → ${next}`).toBe(true);
        const nextBody = readFileSync(join(DOCS, "adr", next), "utf8");
        expect(linkedFiles(field(nextBody, "置き換え元")), `${next} の置き換え元`).toContain(name);
      }
      for (const prev of linkedFiles(field(body, "置き換え元"))) {
        expect(existsSync(join(DOCS, "adr", prev)), `${name} ← ${prev}`).toBe(true);
        const prevBody = readFileSync(join(DOCS, "adr", prev), "utf8");
        expect(ADR_NAME.exec(prev)?.[3], `${prev} は superseded になっている`).toBe("superseded");
        expect(linkedFiles(field(prevBody, "置き換え先")), `${prev} の置き換え先`).toContain(name);
      }
    }
  });

  it("作業履歴のファイル名は <YYYYMMDD>-<スラッグ>.md", () => {
    for (const name of readdirSync(join(DOCS, "worklog"))) {
      if (name === "README.md") continue;
      const m = WORKLOG_NAME.exec(name);
      expect(m, name).not.toBeNull();
      expect(isValidDateTime(m?.[1] ?? ""), name).toBe(true);
    }
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

describe("docs のスキル（Claude Code 用・Codex 用）", () => {
  it("2つの写しが同じ内容である", () => {
    const [claude, codex] = SKILL_COPIES.map((path) => readFileSync(path, "utf8"));
    expect(codex).toBe(claude);
  });

  it("front matter の name がディレクトリ名と同じで、description がある", () => {
    for (const path of SKILL_COPIES) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"))?.[1];
      expect(front, path).toBeDefined();
      expect(/^name: (.+)$/m.exec(front ?? "")?.[1], path).toBe(SKILL_NAME);
      expect(/^description: (.+)$/m.exec(front ?? "")?.[1]?.length ?? 0, path).toBeGreaterThan(0);
    }
  });
});

describe("検査の部品", () => {
  it("ADR のファイル名の規則", () => {
    expect(ADR_NAME.test("20261014-0816-docs-structure.md")).toBe(true);
    expect(ADR_NAME.test("20261014-0816-superseded-docs-structure.md")).toBe(true);
    expect(ADR_NAME.test("20261014-0816-deprecated-x.md")).toBe(true);
    expect(ADR_NAME.test("20261014-0816-rejected-x.md")).toBe(true);
    expect(ADR_NAME.test("20261014-docs-structure.md")).toBe(false);
    expect(ADR_NAME.test("2026-10-14-0816-docs.md")).toBe(false);
    expect(ADR_NAME.test("20261014-0816-Docs.md")).toBe(false);
    expect(ADR_NAME.test("20261014-0816-superseded.md")).toBe(false);
    expect(ADR_NAME.test("20261014-0816-docs-superseded.md")).toBe(true);
    expect(ADR_NAME.test("20261014-0816-superseded-superseded-x.md")).toBe(false);
    expect(ADR_NAME.test("20261014-0816-unknown-x.md")).toBe(true); // 未知の語はスラッグの一部
    expect(isValidDateTime("20261399", "0000")).toBe(false);
    expect(isValidDateTime("20261014", "2460")).toBe(false);
    expect(isValidDateTime("20240229", "2359")).toBe(true);
  });

  it("作業履歴のファイル名の規則", () => {
    expect(WORKLOG_NAME.test("20261014-pbi-80-docs-structure.md")).toBe(true);
    expect(WORKLOG_NAME.test("pbi-80.md")).toBe(false);
    expect(WORKLOG_NAME.test("20261014_pbi-80.md")).toBe(false);
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
});
