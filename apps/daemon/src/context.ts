import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * コンテキストリポジトリ（PBI-6）。中立形式は次のとおり。
 * - `sacty-context.yaml`：extends（親のリポジトリ。`URL#ref` で ref を指定できる）、
 *   locked（下位で上書き・取り除きできない項目）、remove（上位から引き継いだ項目を取り除く）
 * - `rules.md` か `rules/*.md`：規約（上位から順に連結する）
 * - `skills/<名前>/SKILL.md`：スキル（名前ごとに、下位が上書きする）
 */
const ContextManifest = z
  .object({
    extends: z.string().trim().min(1).optional(),
    locked: z.object({ skills: z.array(z.string()).default([]) }).prefault({}),
    remove: z.object({ skills: z.array(z.string()).default([]) }).prefault({}),
  })
  .prefault({});

export type ContextRef = { repo: string; ref?: string };

/** 取得したコンテキストリポジトリの1層。 */
export type ContextLayer = ContextRef & {
  commit: string;
  dir: string;
  manifest: z.infer<typeof ContextManifest>;
};

/** コンテキストリポジトリを取得する口。テストでは偽物に差し替える。 */
export interface ContextFetcher {
  /** dir にリポジトリの中身を置き、そのコミットを返す。 */
  fetch(ref: ContextRef, dir: string): Promise<{ commit: string }>;
}

/** 継承をたどる深さの上限（循環や、誤った設定で延々とたどらないように）。 */
export const MAX_CONTEXT_DEPTH = 10;

export class ContextError extends Error {}

/** `URL#ref` の形の extends を分ける。 */
export function parseExtends(value: string): ContextRef {
  const hash = value.lastIndexOf("#");
  if (hash <= 0) return { repo: value };
  return { repo: value.slice(0, hash), ref: value.slice(hash + 1) || undefined };
}

/**
 * 継承をたどって、上位から順の層にする。各層は workDir の下に取得する。
 * 同じリポジトリと ref が2度出てきたら（循環）、深さが上限を超えたら、エラーにする。
 */
export async function resolveContext(
  fetcher: ContextFetcher,
  root: ContextRef,
  workDir: string,
): Promise<ContextLayer[]> {
  const chain: ContextLayer[] = [];
  const seen = new Set<string>();
  let next: ContextRef | undefined = root;
  while (next) {
    const key = `${next.repo}#${next.ref ?? ""}`;
    if (seen.has(key)) {
      throw new ContextError(`コンテキストの継承が循環しています（${key}）。`);
    }
    if (chain.length >= MAX_CONTEXT_DEPTH) {
      throw new ContextError(`コンテキストの継承が深すぎます（上限 ${MAX_CONTEXT_DEPTH} 段）。`);
    }
    seen.add(key);
    const dir = join(workDir, String(chain.length));
    let commit: string;
    try {
      ({ commit } = await fetcher.fetch(next, dir));
    } catch (error) {
      throw new ContextError(
        `コンテキストリポジトリ（${key}）を取得できません：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assertPlainEntries(dir, key);
    const manifest = readManifest(dir, key);
    chain.push({ ...next, commit, dir, manifest });
    next = manifest.extends ? parseExtends(manifest.extends) : undefined;
  }
  return chain.reverse();
}

/** sacty が読む・写す項目（設定・規約・スキル）。 */
const CONTEXT_ENTRIES = ["sacty-context.yaml", "rules.md", "rules", "skills"];

/**
 * sacty が読む・写す項目に、通常のファイルとディレクトリ以外（シンボリックリンクなど）が無いことを確かめる。
 * リンクを追うとホストの任意のファイルを取り込めてしまい、写した先ではコンテナから解決できないため、
 * リンクは扱わずに理由を示して止める。
 */
function assertPlainEntries(dir: string, key: string): void {
  const check = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) check(join(path, name));
      return;
    }
    if (!stat.isFile()) {
      const kind = stat.isSymbolicLink() ? "シンボリックリンク" : "通常のファイルでないもの";
      throw new ContextError(
        `${key} の ${relative(dir, path)} は${kind}です。コンテキストリポジトリでは、設定・規約・スキルに通常のファイルとディレクトリだけを使えます。`,
      );
    }
  };
  for (const entry of CONTEXT_ENTRIES) {
    const path = join(dir, entry);
    // リンク自体も見るため、existsSync（リンク先を見る）ではなく lstat で有無を確かめる
    try {
      lstatSync(path);
    } catch {
      continue;
    }
    check(path);
  }
}

function readManifest(dir: string, key: string) {
  const path = join(dir, "sacty-context.yaml");
  if (!existsSync(path)) return ContextManifest.parse(undefined);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ContextError(
      `${key} の sacty-context.yaml を読めません：${(error as Error).message}`,
    );
  }
  const parsed = ContextManifest.safeParse(raw ?? undefined);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ContextError(
      `${key} の sacty-context.yaml に誤りがあります（${issue?.path.join(".")}）：${issue?.message}`,
    );
  }
  return parsed.data;
}

/** 合成したコンテキスト。 */
export type ComposedContext = {
  /** 規約（上位から連結。どの層のものかの見出しつき）。 */
  rules: string;
  /** スキル（名前ごと。どの層のものか）。 */
  skills: { name: string; dir: string; from: string }[];
  /** 上書き禁止に当たったなど、合成で気づいたこと。 */
  warnings: string[];
};

const label = (layer: ContextLayer) =>
  `${layer.repo}${layer.ref ? `#${layer.ref}` : ""}@${layer.commit.slice(0, 7)}`;

/** 層の規約。`rules.md` があればそれ、無ければ `rules/*.md` を名前の順に。 */
function layerRules(layer: ContextLayer): string {
  const single = join(layer.dir, "rules.md");
  if (existsSync(single)) return readFileSync(single, "utf8").trim();
  const dir = join(layer.dir, "rules");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** 層のスキル（`skills/<名前>/SKILL.md` があるディレクトリ）。 */
function layerSkills(layer: ContextLayer): { name: string; dir: string }[] {
  const root = join(layer.dir, "skills");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^[\w.-]+$/.test(name) && statSync(join(root, name)).isDirectory())
    .filter((name) => existsSync(join(root, name, "SKILL.md")))
    .sort()
    .map((name) => ({ name, dir: join(root, name) }));
}

/**
 * 上位から順の層を合成する。規約は上位から連結し、スキルは名前ごとに下位が上書きする。
 * 上位で上書き禁止（locked）にしたスキルは、下位で上書きも取り除きもできない（警告を残して上位を使う）。
 */
export function composeContext(layers: ContextLayer[]): ComposedContext {
  const rules: string[] = [];
  const skills = new Map<string, { dir: string; from: string }>();
  const locked = new Map<string, string>();
  const warnings: string[] = [];
  for (const layer of layers) {
    const from = label(layer);
    const text = layerRules(layer);
    if (text) rules.push(`<!-- sacty context: ${from} -->\n${text}`);
    for (const name of layer.manifest.remove.skills) {
      if (locked.has(name)) {
        warnings.push(
          `${from} はスキル「${name}」を取り除こうとしましたが、${locked.get(name)} で上書き禁止のため残しました。`,
        );
      } else {
        skills.delete(name);
      }
    }
    for (const skill of layerSkills(layer)) {
      if (locked.has(skill.name)) {
        warnings.push(
          `${from} はスキル「${skill.name}」を上書きしようとしましたが、${locked.get(skill.name)} で上書き禁止のため上位のものを使いました。`,
        );
        continue;
      }
      skills.set(skill.name, { dir: skill.dir, from });
    }
    for (const name of layer.manifest.locked.skills) {
      if (!locked.has(name)) locked.set(name, from);
    }
  }
  return {
    rules: rules.join("\n\n"),
    skills: [...skills.entries()].map(([name, s]) => ({ name, ...s })),
    warnings,
  };
}

/**
 * 合成したコンテキストを、エージェントの形式で outDir に書く。outDir は実行ごとの空の設定の
 * ディレクトリ（Claude Code は CLAUDE_CONFIG_DIR、Codex は CODEX_HOME）として渡す。
 * - Claude Code：`CLAUDE.md`（規約）と `skills/<名前>/`（スキル）
 * - Codex：`AGENTS.md`（規約と、スキルの一覧）と `skills/<名前>/`（Codex にはスキルの仕組みが無いので、
 *   AGENTS.md から場所を示して読ませる）
 */
export function writeContext(
  composed: ComposedContext,
  runtime: "claude-code" | "codex",
  outDir: string,
  /** コンテナの中での outDir（Codex の AGENTS.md にスキルの場所を書くため）。 */
  containerDir: string,
): void {
  mkdirSync(outDir, { recursive: true });
  for (const skill of composed.skills) {
    cpSync(skill.dir, join(outDir, "skills", skill.name), { recursive: true });
  }
  if (runtime === "claude-code") {
    if (composed.rules) writeFileSync(join(outDir, "CLAUDE.md"), `${composed.rules}\n`);
    return;
  }
  const index = composed.skills.map((s) => {
    const description = readSkillDescription(join(outDir, "skills", s.name, "SKILL.md"));
    return `- ${s.name}${description ? `：${description}` : ""}（${containerDir}/skills/${s.name}/SKILL.md）`;
  });
  const parts = [
    composed.rules,
    index.length > 0
      ? `## スキル\n\n必要なときは、次のスキルの SKILL.md を読んで従ってください。\n\n${index.join("\n")}`
      : "",
  ].filter(Boolean);
  if (parts.length > 0) writeFileSync(join(outDir, "AGENTS.md"), `${parts.join("\n\n")}\n`);
}

/** SKILL.md の先頭の front matter から description を読む（無ければ空）。 */
function readSkillDescription(path: string): string {
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return "";
  try {
    const front = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
    return typeof front?.description === "string" ? front.description.trim() : "";
  } catch {
    return "";
  }
}

/** git で浅く clone してコンテキストリポジトリを取得する（ホストの認証を使う）。 */
export class GitContextFetcher implements ContextFetcher {
  async fetch(ref: ContextRef, dir: string) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const branch = ref.ref ? ["--branch", ref.ref] : [];
    await run(["clone", "--depth", "1", ...branch, "--", ref.repo, dir]);
    const commit = (await run(["rev-parse", "HEAD"], dir)).trim();
    return { commit };
  }
}

function run(args: string[], cwd?: string): Promise<string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => reject(new Error(`gitを実行できません（${error.message}）。`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `git ${args[0]} の終了コード ${code}`));
    });
  });
}

/**
 * プロジェクトのコンテキストを取得・合成し、エージェントの形式で書いた一時ディレクトリを返す。
 * 呼び出し側は、使い終わったら dispose で消す。
 */
export async function prepareContext(
  fetcher: ContextFetcher,
  root: ContextRef,
  runtime: "claude-code" | "codex",
  containerDir: string,
): Promise<{
  dir: string;
  layers: { repo: string; ref?: string; commit: string }[];
  warnings: string[];
  dispose: () => void;
}> {
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  const dispose = () => rmSync(work, { recursive: true, force: true });
  try {
    const layers = await resolveContext(fetcher, root, join(work, "repos"));
    const composed = composeContext(layers);
    const dir = join(work, "out");
    writeContext(composed, runtime, dir, containerDir);
    return {
      dir,
      layers: layers.map((l) => ({
        repo: l.repo,
        ...(l.ref ? { ref: l.ref } : {}),
        commit: l.commit,
      })),
      warnings: composed.warnings,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
