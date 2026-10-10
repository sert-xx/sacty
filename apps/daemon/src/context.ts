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
import { code, type DaemonText, issueMessage, message } from "@sacty/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errorText, MessageError } from "./errors.js";

/**
 * コンテキストリポジトリ（PBI-6）。中立形式は次のとおり。
 * - `sacty-context.yaml`：extends（親のリポジトリ。`URL#ref` で ref を指定できる）、
 *   locked（下位で上書き・取り除きできない項目）、remove（上位から引き継いだ項目を取り除く）
 * - `rules.md` か `rules/*.md`：規約（上位から順に連結する）
 * - `skills/<名前>/SKILL.md`：スキル（名前ごとに、下位が上書きする）
 * - `mcp.yaml`：MCP サーバー（名前ごとに、下位が上書きする）。秘密情報は値を書かず、名前で参照する
 */
const NamedItems = z
  .object({
    skills: z.array(z.string()).default([]),
    mcp: z.array(z.string()).default([]),
  })
  .prefault({});
const ContextManifest = z
  .object({
    extends: z.string().trim().min(1).optional(),
    locked: NamedItems,
    remove: NamedItems,
  })
  .prefault({});

/**
 * MCP の設定の値。文字列はそのまま、`{ secret: 名前 }` は実行時に秘密情報の値を入れる
 * （prefix は値の前につける。`Bearer ` など）。
 * Claude Code は設定の `${...}` を環境変数として展開するので、文字列に `${` は書けない。
 */
const McpLiteral = z.string().refine((v) => !v.includes("${"), code("input.dollarBrace"));
const McpValue = z.union([
  McpLiteral,
  z
    .object({
      secret: z.string().regex(/^[A-Za-z0-9._-]+$/, code("input.secretName")),
      prefix: McpLiteral.default(""),
    })
    .strict(),
]);
const McpServer = z.union([
  z
    .object({
      command: McpLiteral.pipe(z.string().min(1)),
      args: z.array(McpLiteral).default([]),
      env: z
        .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, code("input.envName")), McpValue)
        .default({}),
    })
    .strict(),
  z
    .object({
      url: McpLiteral.pipe(z.url({ protocol: /^https?$/ })),
      headers: z
        .record(
          z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, code("input.headerName")),
          McpValue,
        )
        .default({}),
    })
    .strict(),
]);
export type McpServer = z.infer<typeof McpServer>;
const McpFile = z
  .object({
    servers: z
      .record(z.string().regex(/^[A-Za-z0-9_-]+$/, code("input.mcpName")), McpServer)
      .default({}),
  })
  .strict()
  .prefault({});

export type ContextRef = { repo: string; ref?: string };

/** 取得したコンテキストリポジトリの1層。 */
export type ContextLayer = ContextRef & {
  commit: string;
  dir: string;
  manifest: z.infer<typeof ContextManifest>;
  /** この層の MCP サーバー（`mcp.yaml`）。 */
  mcp: Record<string, McpServer>;
};

/** コンテキストリポジトリを取得する口。テストでは偽物に差し替える。 */
export interface ContextFetcher {
  /** dir にリポジトリの中身を置き、そのコミットを返す。 */
  fetch(ref: ContextRef, dir: string): Promise<{ commit: string }>;
}

/** 継承をたどる深さの上限（循環や、誤った設定で延々とたどらないように）。 */
export const MAX_CONTEXT_DEPTH = 10;

export class ContextError extends MessageError {}

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
      throw new ContextError(message("context.cycle", { key }));
    }
    if (chain.length >= MAX_CONTEXT_DEPTH) {
      throw new ContextError(message("context.tooDeep", { max: MAX_CONTEXT_DEPTH }));
    }
    seen.add(key);
    const dir = join(workDir, String(chain.length));
    let commit: string;
    try {
      ({ commit } = await fetcher.fetch(next, dir));
    } catch (error) {
      throw new ContextError(message("context.fetchFailed", { key, detail: errorText(error) }));
    }
    assertPlainEntries(dir, key);
    const manifest = readManifest(dir, key);
    const mcp = readYaml(dir, "mcp.yaml", key, McpFile).servers;
    chain.push({ ...next, commit, dir, manifest, mcp });
    next = manifest.extends ? parseExtends(manifest.extends) : undefined;
  }
  return chain.reverse();
}

/** sacty が読む・写す項目（設定・規約・スキル）。 */
const CONTEXT_ENTRIES = ["sacty-context.yaml", "mcp.yaml", "rules.md", "rules", "skills"];

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
      throw new ContextError(
        message("context.notPlainFile", {
          key,
          path: relative(dir, path),
          symlink: stat.isSymbolicLink(),
        }),
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
  return readYaml(dir, "sacty-context.yaml", key, ContextManifest);
}

/**
 * 検査の誤りのうち、人に示すもの。名前（レコードのキー）の誤りは中の検査の文言を、
 * どの形にも合わない（union）ときは、誤りの最も少ない形の誤りを出す。
 */
function innermost(
  issue: z.core.$ZodIssue | undefined,
): { path: PropertyKey[]; issue: z.core.$ZodIssue } | undefined {
  if (!issue) return undefined;
  if (issue.code === "invalid_key") {
    const inner = issue.issues[0];
    return { path: issue.path, issue: inner ? { ...inner, path: [] } : issue };
  }
  if (issue.code === "invalid_union" && issue.errors.length > 0) {
    const closest = [...issue.errors].sort((a, b) => a.length - b.length)[0] ?? [];
    const inner = innermost(closest[0]);
    if (inner) return { path: [...issue.path, ...inner.path], issue: inner.issue };
  }
  return { path: issue.path, issue };
}

/** 層の YAML を読んで検査する（無ければ既定値）。 */
function readYaml<T extends z.ZodType>(
  dir: string,
  name: string,
  key: string,
  schema: T,
): z.output<T> {
  const path = join(dir, name);
  if (!existsSync(path)) return schema.parse(undefined);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ContextError(
      message("context.fileUnreadable", { key, file: name, detail: (error as Error).message }),
    );
  }
  const parsed = schema.safeParse(raw ?? undefined);
  if (!parsed.success) {
    const found = innermost(parsed.error.issues[0]);
    throw new ContextError(
      message("context.fileInvalid", {
        key,
        file: name,
        path: found?.path.join(".") ?? "",
        detail: found ? issueMessage(found.issue) : "",
      }),
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
  /** MCP サーバー（名前ごと。どの層のものか）。 */
  mcp: { name: string; server: McpServer; from: string }[];
  /** 上書き禁止に当たったなど、合成で気づいたこと。 */
  warnings: DaemonText[];
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
 * 名前のある項目（スキル・MCP サーバー）を、上位から順に合わせる。下位が上書きし、remove で取り除く。
 * 上位で上書き禁止（locked）にした項目は、下位で上書きも取り除きもできない（警告を残して上位を使う）。
 */
function mergeNamed<T>(
  layers: ContextLayer[],
  kind: "skills" | "mcp",
  itemsOf: (layer: ContextLayer) => { name: string; value: T }[],
  warnings: DaemonText[],
): { name: string; value: T; from: string }[] {
  const merged = new Map<string, { value: T; from: string }>();
  const locked = new Map<string, string>();
  for (const layer of layers) {
    const from = label(layer);
    for (const name of layer.manifest.remove[kind]) {
      if (locked.has(name)) {
        warnings.push(
          message("context.lockedRemove", { from, kind, name, lockedBy: locked.get(name) ?? "" }),
        );
      } else {
        merged.delete(name);
      }
    }
    for (const item of itemsOf(layer)) {
      if (locked.has(item.name)) {
        warnings.push(
          message("context.lockedOverride", {
            from,
            kind,
            name: item.name,
            lockedBy: locked.get(item.name) ?? "",
          }),
        );
        continue;
      }
      merged.set(item.name, { value: item.value, from });
    }
    for (const name of layer.manifest.locked[kind]) {
      if (!locked.has(name)) locked.set(name, from);
    }
  }
  return [...merged.entries()].map(([name, m]) => ({ name, ...m }));
}

/**
 * 上位から順の層を合成する。規約は上位から連結し、スキルと MCP サーバーは名前ごとに下位が上書きする。
 */
export function composeContext(layers: ContextLayer[]): ComposedContext {
  const rules: string[] = [];
  for (const layer of layers) {
    const text = layerRules(layer);
    if (text) rules.push(`<!-- sacty context: ${label(layer)} -->\n${text}`);
  }
  const warnings: DaemonText[] = [];
  const skills = mergeNamed(
    layers,
    "skills",
    (layer) => layerSkills(layer).map((s) => ({ name: s.name, value: s.dir })),
    warnings,
  );
  const mcp = mergeNamed(
    layers,
    "mcp",
    (layer) => Object.entries(layer.mcp).map(([name, value]) => ({ name, value })),
    warnings,
  );
  return {
    rules: rules.join("\n\n"),
    skills: skills.map((s) => ({ name: s.name, dir: s.value, from: s.from })),
    mcp: mcp.map((m) => ({ name: m.name, server: m.value, from: m.from })),
    warnings,
  };
}

/** 実行時に、秘密情報の値をこの環境変数でコンテナに渡す（値は prefix + 秘密情報）。 */
export type ContextSecret = { env: string; secret: string; prefix: string };

/** 配置したコンテキストのうち、エージェントの起動に必要なもの。 */
export type PlacedContext = {
  /** MCP サーバーの名前（Claude Code では、そのツールの使用を許可する）。 */
  mcpServers: string[];
  /** 実行時に入れる秘密情報。 */
  secrets: ContextSecret[];
};

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
): PlacedContext {
  mkdirSync(outDir, { recursive: true });
  const secrets: ContextSecret[] = [];
  // 秘密情報は設定のファイルに値を書かず、環境変数の名前で参照する（値は実行時に入れる）
  const resolve = (value: string | { secret: string; prefix: string }) => {
    if (typeof value === "string") return { literal: value };
    const env = `SACTY_MCP_SECRET_${secrets.length}`;
    secrets.push({ env, secret: value.secret, prefix: value.prefix });
    return { env };
  };
  const placed = () => ({ mcpServers: composed.mcp.map((m) => m.name), secrets });
  for (const skill of composed.skills) {
    cpSync(skill.dir, join(outDir, "skills", skill.name), { recursive: true });
  }
  if (runtime === "claude-code") {
    if (composed.rules) writeFileSync(join(outDir, "CLAUDE.md"), `${composed.rules}\n`);
    if (composed.mcp.length > 0) {
      const values = (record: Record<string, string | { secret: string; prefix: string }>) =>
        Object.fromEntries(
          Object.entries(record).map(([k, v]) => {
            const r = resolve(v);
            return [k, "env" in r ? `\${${r.env}}` : r.literal];
          }),
        );
      const servers = Object.fromEntries(
        composed.mcp.map(({ name, server }) => [
          name,
          "command" in server
            ? { command: server.command, args: server.args, env: values(server.env) }
            : { type: "http", url: server.url, headers: values(server.headers) },
        ]),
      );
      writeFileSync(
        join(outDir, CLAUDE_MCP_CONFIG),
        `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      );
    }
    return placed();
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
  if (composed.mcp.length > 0) {
    const toml = composed.mcp.map(({ name, server }) => codexServer(name, server, resolve));
    writeFileSync(join(outDir, "config.toml"), `${toml.join("\n")}`);
  }
  return placed();
}

/** Claude Code に渡す MCP の設定のファイル名（設定のディレクトリの中）。 */
export const CLAUDE_MCP_CONFIG = "mcp.json";

/**
 * TOML の文字列（JSON の文字列のエスケープは、TOML の基本文字列でもそのまま使える）。
 * DEL は JSON では素のままだが、TOML では使えないのでエスケープする。
 */
const tomlString = (value: string) => JSON.stringify(value).replaceAll("\u007f", "\\u007F");
const tomlArray = (values: string[]) => `[${values.map(tomlString).join(", ")}]`;
const tomlTable = (record: Record<string, string>) =>
  `{ ${Object.entries(record)
    .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
    .join(", ")} }`;

/**
 * Codex の config.toml の MCP サーバー。Codex は設定の値の中の環境変数を展開しないので、
 * 秘密情報は名前で受け渡す（stdio は env_vars で渡した変数を sh で目的の名前に移し、HTTP は env_http_headers）。
 */
function codexServer(
  name: string,
  server: McpServer,
  resolve: (
    value: string | { secret: string; prefix: string },
  ) => { literal: string } | { env: string },
): string {
  const lines = [`[mcp_servers.${tomlString(name)}]`];
  if ("command" in server) {
    const literal: Record<string, string> = {};
    const fromSecret: [string, string][] = [];
    for (const [key, value] of Object.entries(server.env)) {
      const r = resolve(value);
      if ("env" in r) fromSecret.push([key, r.env]);
      else literal[key] = r.literal;
    }
    if (fromSecret.length > 0) {
      const exports = fromSecret.map(([key, env]) => `export ${key}="$${env}"; `).join("");
      lines.push(
        `command = ${tomlString("/bin/sh")}`,
        `args = ${tomlArray(["-c", `${exports}exec "$0" "$@"`, server.command, ...server.args])}`,
        `env_vars = ${tomlArray(fromSecret.map(([, env]) => env))}`,
      );
    } else {
      lines.push(`command = ${tomlString(server.command)}`, `args = ${tomlArray(server.args)}`);
    }
    if (Object.keys(literal).length > 0) lines.push(`env = ${tomlTable(literal)}`);
  } else {
    const literal: Record<string, string> = {};
    const fromSecret: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers)) {
      const r = resolve(value);
      if ("env" in r) fromSecret[key] = r.env;
      else literal[key] = r.literal;
    }
    lines.push(`url = ${tomlString(server.url)}`);
    if (Object.keys(literal).length > 0) lines.push(`http_headers = ${tomlTable(literal)}`);
    if (Object.keys(fromSecret).length > 0) {
      lines.push(`env_http_headers = ${tomlTable(fromSecret)}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
    child.on("error", (error) =>
      reject(new MessageError(message("git.unavailable", { detail: error.message }))),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      // git のエラー文は外から来た文なので、そのまま渡す
      else if (err.trim()) reject(new Error(err.trim()));
      else reject(new MessageError(message("git.exitCode", { command: args[0] ?? "", code })));
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
  warnings: DaemonText[];
  placed: PlacedContext;
  dispose: () => void;
}> {
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  const dispose = () => rmSync(work, { recursive: true, force: true });
  try {
    const layers = await resolveContext(fetcher, root, join(work, "repos"));
    const composed = composeContext(layers);
    const dir = join(work, "out");
    const placed = writeContext(composed, runtime, dir, containerDir);
    return {
      dir,
      layers: layers.map((l) => ({
        repo: l.repo,
        ...(l.ref ? { ref: l.ref } : {}),
        commit: l.commit,
      })),
      warnings: composed.warnings,
      placed,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
