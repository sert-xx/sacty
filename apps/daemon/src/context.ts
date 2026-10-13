import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { code, type DaemonText, issueMessage, message } from "@sacty/core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errorText, MessageError } from "./errors.js";
import { SecretRef } from "./secrets.js";

/**
 * コンテキストリポジトリ（PBI-6）。中立形式は次のとおり。
 * - `sacty-context.yaml`：extends（親のリポジトリ。`URL#ref` で ref を指定できる）、
 *   locked（下位で上書き・取り除きできない項目）、remove（上位から引き継いだ項目を取り除く）
 * - `rules.md` か `rules/*.md`：規約（上位から順に連結する）
 * - `skills/<名前>/SKILL.md`：スキル（名前ごとに、下位が上書きする）
 * - `mcp.yaml`：MCP サーバー（名前ごとに、下位が上書きする）。秘密情報は値を書かず、名前で参照する
 * - `agents/codex/config.toml`・`agents/claude/settings.json`：エージェントの設定（キーごとに、下位が上書きする。PBI-24）
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
      // キーチェーンの名前か、1Password の参照（PBI-34）
      secret: SecretRef,
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
      /**
       * sacty のゲートウェイ経由で使うか（PBI-49。既定は経由）。経由なら、エージェントにはゲートウェイの URL と
       * 実行ごとのトークンだけを渡し、認証のヘッダー（秘密情報）はホストで付ける。false なら、コンテナから直接つなぐ。
       */
      via_gateway: z.boolean().default(true),
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
  /** この層のエージェントの設定（`agents/` の下。無ければ空）。 */
  agents: AgentSettings;
};

/** エージェントの設定（Codex は config.toml、Claude Code は settings.json の中身）。 */
export type AgentSettings = { codex: Record<string, unknown>; claude: Record<string, unknown> };

/** Claude Code に渡す MCP の設定のファイル名（設定のディレクトリの中）。 */
export const CLAUDE_MCP_CONFIG = "mcp.json";

/** 層の中の、エージェントの設定のファイル。 */
export const AGENT_SETTINGS_FILES = {
  codex: "agents/codex/config.toml",
  claude: "agents/claude/settings.json",
} as const;

/** コンテキストリポジトリを取得する口。テストでは偽物に差し替える。 */
export interface ContextFetcher {
  /**
   * dir にリポジトリの中身を置き、そのコミットを返す。authEnv は HTTPS の GitHub に認証する環境変数
   * （プロジェクトの gh のアカウントのトークン。PBI-13）。無ければホストの認証を使う。
   */
  fetch(
    ref: ContextRef,
    dir: string,
    authEnv?: Record<string, string>,
  ): Promise<{ commit: string }>;
}

/** リポジトリ（URL）ごとに、git の認証の環境変数を返す（HTTPS の GitHub 以外は undefined）。 */
export type ContextAuth = (repo: string) => Promise<Record<string, string> | undefined>;

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
  auth?: ContextAuth,
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
    // 認証を用意できない（GitHub のアカウントを選んでいないなど）ときは、その理由のまま止める
    const authEnv = await auth?.(next.repo);
    let commit: string;
    try {
      ({ commit } = await fetcher.fetch(next, dir, authEnv));
    } catch (error) {
      throw new ContextError(message("context.fetchFailed", { key, detail: errorText(error) }));
    }
    const layer = readLayer(dir, key);
    chain.push({ ...next, commit, dir, ...layer });
    next = layer.manifest.extends ? parseExtends(layer.manifest.extends) : undefined;
  }
  return chain.reverse();
}

/** 層のディレクトリから、設定（sacty-context.yaml・mcp.yaml・エージェントの設定）を読む。 */
function readLayer(dir: string, key: string): Pick<ContextLayer, "manifest" | "mcp" | "agents"> {
  assertPlainEntries(dir, key);
  return {
    manifest: readManifest(dir, key),
    mcp: readYaml(dir, "mcp.yaml", key, McpFile).servers,
    agents: {
      codex: readAgentSettings(dir, key, AGENT_SETTINGS_FILES.codex, parseToml),
      claude: readAgentSettings(dir, key, AGENT_SETTINGS_FILES.claude, JSON.parse),
    },
  };
}

/** sacty に同梱する既定のコンテキストの名前（作業履歴で、層のリポジトリとして記録する）。 */
export const DEFAULT_CONTEXT_REPO = "sacty-default";

/**
 * sacty に同梱する既定のコンテキスト（PBI-24）。コンテキストリポジトリと同じ形式で、
 * ここに置いた規約・スキル・MCP・エージェントの設定は、どのプロジェクトでも一番上位の層になる。
 * （src からも dist からも、1つ上の default-context を指す）
 */
export const DEFAULT_CONTEXT_DIR = fileURLToPath(new URL("../default-context", import.meta.url));

/**
 * 既定のコンテキストの層。取得はせず、同梱のディレクトリをそのまま読む。
 * コミットの代わりに中身のハッシュを記録する（どの版の既定を使ったかが分かるように）。
 * 既定は一番上位なので、extends は読まない。
 */
export function loadDefaultContext(dir: string): ContextLayer {
  const key = DEFAULT_CONTEXT_REPO;
  return { repo: key, commit: hashEntries(dir), dir, ...readLayer(dir, key) };
}

/** sacty が読む項目の中身のハッシュ（パスの順に、パスと中身から作る）。 */
function hashEntries(dir: string): string {
  const hash = createHash("sha256");
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    hash.update(`${relative(dir, path)}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  for (const entry of [...CONTEXT_ENTRIES].sort()) visit(join(dir, entry));
  return hash.digest("hex");
}

/** sacty が読む・写す項目（設定・規約・スキル・エージェントの設定）。 */
const CONTEXT_ENTRIES = ["sacty-context.yaml", "mcp.yaml", "rules.md", "rules", "skills", "agents"];

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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** 層のエージェントの設定のファイルを読む（無ければ空）。中身は表（オブジェクト）でなければならない。 */
function readAgentSettings(
  dir: string,
  key: string,
  file: string,
  parse: (text: string) => unknown,
): Record<string, unknown> {
  const path = join(dir, file);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ContextError(
      message("context.fileUnreadable", { key, file, detail: (error as Error).message }),
    );
  }
  if (!isPlainObject(raw)) {
    throw new ContextError(
      message("context.fileInvalid", { key, file, path: "", detail: message("input.invalidType") }),
    );
  }
  return raw;
}

/**
 * エージェントの設定のうち、sacty が決める項目。層に書かれていても使わない（警告を残す）。
 * - MCP は mcp.yaml から sacty が作る（秘密情報を名前で渡すため）
 * - 認証・接続先は、AI の定義と秘密情報で sacty が決める（トークンを別の宛先に送らせないため）
 * - Codex の承認の方針とプロファイルは、人のいない実行が承認待ちで止まらないように使わない
 * - Codex のサンドボックスは、コンテナの中では作れないので使わない（隔離はコンテナが受け持つ）
 * モデルは、AI の定義に model があればコマンドの引数で渡すので、設定より優先する。
 */
const RESERVED_SETTINGS: Record<keyof AgentSettings, { keys: string[]; env?: string[] }> = {
  codex: {
    keys: [
      "mcp_servers",
      "model_provider",
      "model_providers",
      "forced_login_method",
      "forced_chatgpt_workspace_id",
      "chatgpt_base_url",
      "approval_policy",
      // サンドボックスは、コマンドの引数で sacty が決める（コンテナの中では Codex のサンドボックスを作れない。PBI-40）
      "sandbox_mode",
      "sandbox_workspace_write",
      "profile",
      "profiles",
    ],
  },
  claude: {
    keys: [
      "apiKeyHelper",
      "awsAuthRefresh",
      "awsCredentialExport",
      "forceLoginMethod",
      "forceLoginOrgUUID",
    ],
    // settings.json の env は実行時の環境変数になるので、sacty が入れる変数と認証・接続先の変数は使わない
    env: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_REGION",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    ],
  },
};

/** 層の設定から、sacty が決める項目を取り除く（取り除いたものは警告に残す）。 */
function withoutReserved(
  kind: keyof AgentSettings,
  settings: Record<string, unknown>,
  from: string,
  warnings: DaemonText[],
): Record<string, unknown> {
  const file = AGENT_SETTINGS_FILES[kind];
  const reserved = RESERVED_SETTINGS[kind];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (reserved.keys.includes(key)) {
      warnings.push(message("context.reservedSetting", { from, file, key }));
      continue;
    }
    if (key === "env" && reserved.env && isPlainObject(value)) {
      const env: Record<string, unknown> = {};
      for (const [name, v] of Object.entries(value)) {
        if (reserved.env.includes(name) || name.startsWith("SACTY_")) {
          warnings.push(message("context.reservedSetting", { from, file, key: `env.${name}` }));
        } else {
          env[name] = v;
        }
      }
      result[key] = env;
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * 設定を重ねる。表（オブジェクト）はキーごとに合わせ、それ以外（配列も）は下位の値で置き換える。
 * union に当たる配列だけは、上位と下位を合わせる（重複は除く）。
 */
function mergeSettings(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  union: (path: string[]) => boolean = () => false,
  path: string[] = [],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = result[key];
    const at = [...path, key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeSettings(current, value, union, at);
    } else if (Array.isArray(current) && Array.isArray(value) && union(at)) {
      result[key] = [...new Set([...current, ...value])];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 層を重ねても合わせる配列。Claude Code の許可・禁止のルールは、既定で決めたものに
 * プロジェクトが足していけるように、置き換えずに合わせる。
 */
const UNION_SETTINGS: Record<keyof AgentSettings, (path: string[]) => boolean> = {
  codex: () => false,
  claude: (path) =>
    path.length === 2 &&
    path[0] === "permissions" &&
    ["allow", "deny", "ask"].includes(path[1] ?? ""),
};

/** 層の、エージェントの設定のディレクトリ（`agents/codex`・`agents/claude`）。 */
const AGENT_DIRS = { codex: "agents/codex", claude: "agents/claude" } as const;

/**
 * エージェントの設定のディレクトリのうち、sacty が作る・管理するもの。層に置いても写さない（警告を残す）。
 * 認証のファイル、sacty が作る規約・MCP の設定、スキル（skills/ で管理する）。
 */
const RESERVED_FILES: Record<keyof AgentSettings, string[]> = {
  codex: ["auth.json", "AGENTS.md", "skills"],
  claude: [".credentials.json", ".claude.json", "CLAUDE.md", CLAUDE_MCP_CONFIG, "skills"],
};

/** 層の、エージェントの設定のディレクトリにあるファイル（ディレクトリからの相対パス）。 */
function layerAgentFiles(layer: ContextLayer, kind: keyof AgentSettings): string[] {
  const root = join(layer.dir, AGENT_DIRS[kind]);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (rel: string) => {
    const path = join(root, rel);
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(rel ? `${rel}/${name}` : name);
    } else {
      files.push(rel);
    }
  };
  visit("");
  return files;
}

/** 合成したコンテキスト。 */
export type ComposedContext = {
  /** 規約（上位から連結。どの層のものかの見出しつき）。 */
  rules: string;
  /** スキル（名前ごと。どの層のものか）。 */
  skills: { name: string; dir: string; from: string }[];
  /** MCP サーバー（名前ごと。どの層のものか）。 */
  mcp: { name: string; server: McpServer; from: string }[];
  /** エージェントの設定（上位から重ねたもの。sacty が決める項目は除いてある）。 */
  agents: AgentSettings;
  /**
   * エージェントの設定のディレクトリに写すファイル（同じパスは下位が上書き）。
   * 設定ファイル・sacty が管理するファイルは含まない。Codex のルール（`rules/*.rules`）も同じく
   * ファイルごとに扱う（既定のルールは `rules/sacty.rules` にして、層のファイルと名前がぶつかりにくくしている）。
   */
  agentFiles: Record<keyof AgentSettings, { path: string; src: string; from: string }[]>;
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
export function composeContext(
  layers: ContextLayer[],
  /** 渡すエージェント。指定すれば、そのエージェントの設定だけを重ねる（ほかの設定の警告を出さないため）。 */
  runtime?: "claude-code" | "codex",
): ComposedContext {
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
  const agents: AgentSettings = { codex: {}, claude: {} };
  const files = { codex: new Map(), claude: new Map() } as Record<
    keyof AgentSettings,
    Map<string, { src: string; from: string }>
  >;
  const kinds: (keyof AgentSettings)[] = runtime
    ? [runtime === "codex" ? "codex" : "claude"]
    : ["codex", "claude"];
  for (const layer of layers) {
    const from = label(layer);
    for (const kind of kinds) {
      const own = withoutReserved(kind, layer.agents[kind], from, warnings);
      agents[kind] = mergeSettings(agents[kind], own, UNION_SETTINGS[kind]);
      const settingsFile = AGENT_SETTINGS_FILES[kind].slice(AGENT_DIRS[kind].length + 1);
      for (const path of layerAgentFiles(layer, kind)) {
        if (path === settingsFile) continue;
        const src = join(layer.dir, AGENT_DIRS[kind], path);
        if (RESERVED_FILES[kind].some((r) => path === r || path.startsWith(`${r}/`))) {
          warnings.push(
            message("context.reservedSetting", { from, file: `${AGENT_DIRS[kind]}/`, key: path }),
          );
        } else {
          files[kind].set(path, { src, from });
        }
      }
    }
  }
  return {
    rules: rules.join("\n\n"),
    skills: skills.map((s) => ({ name: s.name, dir: s.value, from: s.from })),
    mcp: mcp.map((m) => ({ name: m.name, server: m.value, from: m.from })),
    agents,
    agentFiles: {
      codex: [...files.codex.entries()].map(([path, f]) => ({ path, ...f })),
      claude: [...files.claude.entries()].map(([path, f]) => ({ path, ...f })),
    },
    warnings,
  };
}

/**
 * ホストの MCP サーバー（PBI-36）の認証のヘッダーに入れる、実行ごとのゲートウェイのトークン。秘密情報の取り出し口
 * からは取り出さず、実行するときに sacty が入れる（秘密情報の参照としては書けない名前にしてある）。
 */
export const GATEWAY_TOKEN_SECRET = "sacty:gateway-token";

/** ゲートウェイ経由にした、コンテキストの HTTP の MCP サーバー（PBI-49）。ヘッダーの秘密情報は参照のまま。 */
export type GatewayMcpServer = {
  name: string;
  url: string;
  headers: Record<string, string | { secret: string; prefix: string }>;
};

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
  // 層のエージェントの設定のディレクトリのファイルを先に写す（sacty が作るファイルは除いてある）
  for (const file of composed.agentFiles[runtime === "codex" ? "codex" : "claude"]) {
    const to = join(outDir, file.path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(file.src, to);
  }
  for (const skill of composed.skills) {
    cpSync(skill.dir, join(outDir, "skills", skill.name), { recursive: true });
  }
  if (runtime === "claude-code") {
    if (composed.rules) writeFileSync(join(outDir, "CLAUDE.md"), `${composed.rules}\n`);
    if (Object.keys(composed.agents.claude).length > 0) {
      writeFileSync(
        join(outDir, "settings.json"),
        `${JSON.stringify(composed.agents.claude, null, 2)}\n`,
      );
    }
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
  // 層の設定を先に書き、mcp.yaml から作る MCP サーバーの表を後ろに続ける（設定の mcp_servers は除いてある）
  const toml = [
    ...(Object.keys(composed.agents.codex).length > 0
      ? [stringifyToml(composed.agents.codex)]
      : []),
    ...composed.mcp.map(({ name, server }) => codexServer(name, server, resolve)),
  ];
  if (toml.length > 0) writeFileSync(join(outDir, "config.toml"), `${toml.join("\n")}`);
  return placed();
}

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
  async fetch(ref: ContextRef, dir: string, authEnv?: Record<string, string>) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const branch = ref.ref ? ["--branch", ref.ref] : [];
    await run(["clone", "--depth", "1", ...branch, "--", ref.repo, dir], undefined, authEnv);
    const commit = (await run(["rev-parse", "HEAD"], dir)).trim();
    return { commit };
  }
}

function run(args: string[], cwd?: string, authEnv: Record<string, string> = {}): Promise<string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  // HTTPS の GitHub は、プロジェクトの gh のアカウントのトークンで認証する（環境変数でだけ渡す）
  Object.assign(env, authEnv);
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
  /** プロジェクトのコンテキストリポジトリ（無ければ既定のコンテキストだけ）。 */
  root: ContextRef | undefined,
  runtime: "claude-code" | "codex",
  containerDir: string,
  /** 継承の各リポジトリの git の認証（HTTPS の GitHub はプロジェクトの gh のアカウント）。 */
  auth?: ContextAuth,
  /** 既定のコンテキストのディレクトリ（PBI-24）。一番上位の層として重ねる。 */
  defaultDir?: string,
  /**
   * ホストの MCP サーバー（PBI-36）。ゲートウェイの HTTP の MCP として、層の MCP サーバーに加える（同じ名前なら、
   * こちらを使う）。認証のヘッダーには、実行ごとのゲートウェイのトークンを入れる。
   */
  hostMcp: readonly { name: string; url: string }[] = [],
  /**
   * コンテナから見たゲートウェイの起点（PBI-49）。あれば、層の HTTP の MCP サーバー（via_gateway）を、ゲートウェイの
   * URL（/ctx-mcp/<名前>）に置き換え、元の URL と認証のヘッダーは gatewayMcp として返す（ゲートウェイに持たせる）。
   */
  gatewayOrigin?: string,
): Promise<{
  dir: string;
  layers: { repo: string; ref?: string; commit: string }[];
  warnings: DaemonText[];
  placed: PlacedContext;
  /** ゲートウェイ経由にした、層の HTTP の MCP サーバーの中継先（PBI-49）。ヘッダーの秘密情報は参照のまま。 */
  gatewayMcp: GatewayMcpServer[];
  dispose: () => void;
}> {
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  const dispose = () => rmSync(work, { recursive: true, force: true });
  try {
    const layers = [
      ...(defaultDir ? [loadDefaultContext(defaultDir)] : []),
      ...(root ? await resolveContext(fetcher, root, join(work, "repos"), auth) : []),
    ];
    const composed = composeContext(layers, runtime);
    // 層の HTTP の MCP サーバーは、ゲートウェイ経由にする（PBI-49）。ホストの MCP サーバーと同じく、認証のヘッダーには
    // 実行ごとのゲートウェイのトークンだけを入れる
    const gatewayMcp: GatewayMcpServer[] = [];
    if (gatewayOrigin) {
      composed.mcp = composed.mcp.map((m) => {
        if ("command" in m.server || !m.server.via_gateway) return m;
        gatewayMcp.push({ name: m.name, url: m.server.url, headers: m.server.headers });
        return {
          ...m,
          server: {
            url: `${gatewayOrigin}/ctx-mcp/${m.name}`,
            headers: { Authorization: { secret: GATEWAY_TOKEN_SECRET, prefix: "Bearer " } },
            via_gateway: true,
          },
        };
      });
    }
    if (hostMcp.length > 0) {
      const names = new Set(hostMcp.map((m) => m.name));
      composed.mcp = [
        ...composed.mcp.filter((m) => !names.has(m.name)),
        ...hostMcp.map((m) => ({
          name: m.name,
          from: "sacty-gateway",
          server: {
            url: m.url,
            headers: { Authorization: { secret: GATEWAY_TOKEN_SECRET, prefix: "Bearer " } },
            via_gateway: true,
          },
        })),
      ];
    }
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
      // ホストの MCP サーバーと同じ名前で置き換えられたものは、中継しない
      gatewayMcp: gatewayMcp.filter((m) =>
        composed.mcp.some((c) => c.name === m.name && c.from !== "sacty-gateway"),
      ),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/**
 * 書き出し先を決めるための、プロジェクトのコンテキストの MCP サーバーの名前と規約（PBI-56）。オーケストレーターに、
 * 使える接続先と、どこに何を書くかの規約を渡すために読む（取得したリポジトリは、読んだら消す）。
 */
export async function contextExportInfo(
  fetcher: ContextFetcher,
  root: ContextRef | undefined,
  auth?: ContextAuth,
  defaultDir?: string,
): Promise<{ mcp: string[]; rules: string }> {
  if (!root && !defaultDir) return { mcp: [], rules: "" };
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  try {
    const own = root ? await resolveContext(fetcher, root, join(work, "repos"), auth) : [];
    const layers = [...(defaultDir ? [loadDefaultContext(defaultDir)] : []), ...own];
    // 規約は、プロジェクトのコンテキストのものだけ（sacty の既定の規約は、書き出し先の手がかりではないため）
    return {
      mcp: composeContext(layers).mcp.map((m) => m.name),
      rules: own.length > 0 ? composeContext(own).rules : "",
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
