import { type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { code, type DaemonText, issueMessage, message } from "@sacty/core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AGENT_TIERS, tierFilePath } from "./agents/tier-names.js";
import { errorText, MessageError } from "./errors.js";
import { spawnStoppable } from "./fetch-processes.js";
import { type Platform, PlatformFile, toPlatform } from "./platforms.js";
import { SecretRef } from "./secrets.js";

/**
 * コンテキストリポジトリ（PBI-6）。中立形式は次のとおり。
 * - `sacty-context.yaml`：extends（親のリポジトリ。`URL#ref` で ref を指定できる）、
 *   locked（下位で上書き・取り除きできない項目）、remove（上位から引き継いだ項目を取り除く）
 * - `rules.md` か `rules/*.md`：規約（上位から順に連結する）
 * - `skills/<名前>/SKILL.md`：スキル（名前ごとに、下位が上書きする）。SKILL.md の無いディレクトリはグループで、
 *   `skills/<グループ>/<名前>/SKILL.md` も名前 `<名前>` のスキルになる（PBI-65）
 * - `mcp.yaml`：MCP サーバー（名前ごとに、下位が上書きする）。秘密情報は値を書かず、名前で参照する
 * - `platforms.yaml`：ゲートウェイの外部 PF（名前ごとに、下位が上書きする。書き方は config.yaml の gateway.platforms と
 *   同じ。PBI-74）。認証は秘密情報の名前で参照し、値はホストのゲートウェイだけが取り出して付ける
 * - `agents/codex/config.toml`・`agents/claude/settings.json`：エージェントの設定（キーごとに、下位が上書きする。PBI-24）
 */
const NamedItems = z
  .object({
    skills: z.array(z.string()).default([]),
    mcp: z.array(z.string()).default([]),
    platforms: z.array(z.string()).default([]),
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
/**
 * MCP サーバーの時間切れ（秒。PBI-75）。書かなければエージェントの既定のまま。
 * - startup_timeout_sec：起動（初期化とツールの一覧）を待つ上限
 * - tool_timeout_sec：ツールの呼び出しを待つ上限
 * Codex はそれぞれ同じ名前で、Claude Code はツールの呼び出しだけサーバーごとの timeout（ミリ秒）で受け取る。
 * Claude Code は 1000 ミリ秒より短い値を使わないので、1秒から。
 */
const MCP_STARTUP_TIMEOUT_MAX_SEC = 3_600;
const MCP_TOOL_TIMEOUT_MAX_SEC = 86_400;
export const McpTimeouts = {
  startup_timeout_sec: z.number().int().min(1).max(MCP_STARTUP_TIMEOUT_MAX_SEC).optional(),
  tool_timeout_sec: z.number().int().min(1).max(MCP_TOOL_TIMEOUT_MAX_SEC).optional(),
};
const McpServer = z.union([
  z
    .object({
      command: McpLiteral.pipe(z.string().min(1)),
      args: z.array(McpLiteral).default([]),
      env: z
        .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, code("input.envName")), McpValue)
        .default({}),
      /**
       * ホストで起動してゲートウェイ経由で使うか（PBI-84。既定はホスト）。ホストなら、コマンドはホストで起動し（作業
       * ディレクトリは、このサーバーを書いた層のリポジトリの写し）、エージェントにはゲートウェイの URL と実行ごとの
       * トークンだけを渡す。env の秘密情報はホストで取り出す（コンテナには渡さない）。false なら、これまでどおり
       * コンテナの中で起動する（秘密情報の値は環境変数でコンテナに渡す）。
       */
      via_gateway: z.boolean().default(true),
      ...McpTimeouts,
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
      ...McpTimeouts,
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

/**
 * 層の外部 PF（`platforms.yaml`。PBI-74）。名前と項目は config.yaml の gateway.platforms と同じ
 * （名前は $SACTY_PF_URL/<名前> の URL の一部になる）。
 */
const PlatformsFile = z
  .object({
    platforms: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, code("input.platformName")), PlatformFile)
      .default({}),
  })
  .strict()
  .prefault({});

/** 層の外部 PF のファイル名（PBI-74）。 */
export const PLATFORMS_FILE = "platforms.yaml";

export type ContextRef = { repo: string; ref?: string };

/** 取得したコンテキストリポジトリの1層。 */
export type ContextLayer = ContextRef & {
  commit: string;
  dir: string;
  manifest: z.infer<typeof ContextManifest>;
  /** この層の MCP サーバー（`mcp.yaml`）。 */
  mcp: Record<string, McpServer>;
  /** この層の外部 PF（`platforms.yaml`。PBI-74）。無ければ空。 */
  platforms: Record<string, z.output<typeof PlatformFile>>;
  /** この層のエージェントの設定（`agents/` の下。無ければ空）。 */
  agents: AgentSettings;
};

/** MCP サーバーを書いた層（PBI-84）。dir は取得した層のディレクトリ（実行の後に消える）。 */
export type McpLayer = { repo: string; ref?: string; commit: string; dir: string };

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
    /** 中止されたら、取得を止めて失敗にする（取得の子プロセスも止める。PBI-107）。 */
    signal?: AbortSignal,
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
  signal?: AbortSignal,
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
      signal?.throwIfAborted();
      ({ commit } = await fetcher.fetch(next, dir, authEnv, signal));
    } catch (error) {
      throw new ContextError(message("context.fetchFailed", { key, detail: errorText(error) }));
    }
    const layer = readLayer(dir, key);
    chain.push({ ...next, commit, dir, ...layer });
    next = layer.manifest.extends ? parseExtends(layer.manifest.extends) : undefined;
  }
  return chain.reverse();
}

/** 層のディレクトリから、設定（sacty-context.yaml・mcp.yaml・platforms.yaml・エージェントの設定）を読む。 */
function readLayer(
  dir: string,
  key: string,
): Pick<ContextLayer, "manifest" | "mcp" | "platforms" | "agents"> {
  assertPlainEntries(dir, key);
  return {
    manifest: readManifest(dir, key),
    mcp: readYaml(dir, "mcp.yaml", key, McpFile).servers,
    platforms: readYaml(dir, PLATFORMS_FILE, key, PlatformsFile).platforms,
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
const CONTEXT_ENTRIES = [
  "sacty-context.yaml",
  "mcp.yaml",
  PLATFORMS_FILE,
  "rules.md",
  "rules",
  "skills",
  "agents",
];

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
    // Codex の [agents.<段階>]（カスタムエージェントの宣言）は sacty が段階の定義として作る。層に同じ名前の宣言があると、
    // 自動で探す agents/<段階>.toml より先に登録されて sacty の定義が使われないので、使わずに警告する（PBI-119）
    if (kind === "codex" && key === "agents" && isPlainObject(value)) {
      const agents: Record<string, unknown> = {};
      for (const [name, v] of Object.entries(value)) {
        if ((AGENT_TIERS as readonly string[]).includes(name)) {
          warnings.push(message("context.reservedSetting", { from, file, key: `agents.${name}` }));
        } else {
          agents[name] = v;
        }
      }
      result[key] = agents;
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

/** Codex のカスタムエージェントの定義（TOML）の name。読めない・無ければ undefined。 */
/** Codex のカスタムエージェントの定義として読む大きさの上限（バイト。PR #129 再レビュー指摘）。 */
const CODEX_ROLE_FILE_MAX_BYTES = 256 * 1024;

/**
 * Codex のカスタムエージェントの定義（TOML）の name（前後の空白を除く。Codex 0.160.0 と同じく trim して比べる）。
 * root（層のエージェントの設定のディレクトリ）の中の、シンボリックリンクでない通常のファイルだけを読む。root の外・
 * リンク・通常でないファイル（デバイス・FIFO など）・大きすぎるもの・読めないもの・空の名前は undefined
 * （PR #129 再レビュー指摘）。
 */
function codexRoleName(root: string, rel: string): string | undefined {
  if (isAbsolute(rel)) return undefined;
  const path = resolve(root, rel);
  const inside = relative(resolve(root), path);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  try {
    // 途中のディレクトリも含めて、リンクを通らないことを確かめる
    let at = resolve(root);
    for (const part of inside.split(/[\\/]/)) {
      at = join(at, part);
      if (lstatSync(at).isSymbolicLink()) return undefined;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > CODEX_ROLE_FILE_MAX_BYTES) return undefined;
    const parsed = parseToml(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed) || typeof parsed.name !== "string") return undefined;
    const name = parsed.name.trim();
    return name === "" ? undefined : name;
  } catch {
    return undefined;
  }
}

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

/** 名前のある項目の種類（スキル・MCP サーバー・外部 PF）。 */
export type ContextItemKind = "skills" | "mcp" | "platforms";

/**
 * locked・remove の効果（PBI-76）。removed は by の層が取り除いた（of は取り除かれた項目の層）、locked は by の層で上書き
 * 禁止にした（of はそのときの項目の層。まだ無ければ無い）。
 */
export type ContextEffect = {
  kind: ContextItemKind;
  name: string;
  effect: "removed" | "locked";
  by: string;
  of?: string;
};

/** 合成したコンテキスト。 */
export type ComposedContext = {
  /** 規約（上位から連結。どの層のものかの見出しつき）。 */
  rules: string;
  /** スキル（名前ごと。どの層のものか）。 */
  skills: { name: string; dir: string; from: string }[];
  /**
   * MCP サーバー（名前ごと。どの層のものか）。layer は、そのサーバーを書いた層（ホストで起動する command のサーバーの
   * 作業ディレクトリと、使い回しの判断に使う。PBI-84）。ホストの MCP サーバー（config.yaml）には無い。
   */
  mcp: { name: string; server: McpServer; from: string; layer?: McpLayer }[];
  /**
   * ゲートウェイの外部 PF（名前ごと。PBI-74）。from に、どの層のものかを持つ。認証は秘密情報の名前のまま
   * （値はホストのゲートウェイだけが取り出す）。
   */
  platforms: Platform[];
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
  /** locked・remove の効果（PBI-76。プレビューに出す）。 */
  effects: ContextEffect[];
  /** 規約を持つ層（上位から。PBI-76）。 */
  rulesFrom: string[];
  /** エージェントの設定（settings.json・config.toml）を持つ層（上位から。PBI-76）。 */
  agentsFrom: Record<keyof AgentSettings, string[]>;
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

/**
 * 層のスキル。`skills/` の下で SKILL.md のあるディレクトリがスキルで、名前はそのディレクトリの名前。
 * SKILL.md の無いディレクトリはグループで、その下を再帰的に探す（`skills/<グループ>/<名前>/SKILL.md`。PBI-65）。
 * 同じ層に同じ名前のスキルが重なれば、パスの順で先のものを使い、警告を残す。
 */
function layerSkills(
  layer: ContextLayer,
  warnings?: DaemonText[],
): { name: string; dir: string }[] {
  const root = join(layer.dir, "skills");
  if (!existsSync(root)) return [];
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (!/^[\w.-]+$/.test(name) || !statSync(path).isDirectory()) continue;
      if (!existsSync(join(path, "SKILL.md"))) {
        walk(path);
        continue;
      }
      const used = found.get(name);
      if (used) {
        warnings?.push(
          message("context.duplicateSkill", {
            from: label(layer),
            name,
            path: path.slice(root.length + 1),
            usedPath: used.slice(root.length + 1),
          }),
        );
        continue;
      }
      found.set(name, path);
    }
  };
  walk(root);
  return [...found.entries()]
    .map(([name, dir]) => ({ name, dir }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 名前のある項目（スキル・MCP サーバー）を、上位から順に合わせる。下位が上書きし、remove で取り除く。
 * 上位で上書き禁止（locked）にした項目は、下位で上書きも取り除きもできない（警告を残して上位を使う）。
 */
function mergeNamed<T>(
  layers: ContextLayer[],
  kind: ContextItemKind,
  itemsOf: (layer: ContextLayer) => { name: string; value: T }[],
  warnings: DaemonText[],
  effects: ContextEffect[] = [],
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
        // 取り除いた項目（上位に無ければ、何も取り除いていない）
        const removed = merged.get(name);
        if (removed) effects.push({ kind, name, effect: "removed", by: from, of: removed.from });
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
      if (!locked.has(name)) {
        locked.set(name, from);
        // 上位の層の項目を上書き禁止にしたときだけ、どの層のものかを添える
        const item = merged.get(name);
        effects.push({
          kind,
          name,
          effect: "locked",
          by: from,
          ...(item && item.from !== from ? { of: item.from } : {}),
        });
      }
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
  const rulesFrom: string[] = [];
  for (const layer of layers) {
    const text = layerRules(layer);
    if (text) {
      rules.push(`<!-- sacty context: ${label(layer)} -->\n${text}`);
      rulesFrom.push(label(layer));
    }
  }
  const warnings: DaemonText[] = [];
  const effects: ContextEffect[] = [];
  const skills = mergeNamed(
    layers,
    "skills",
    (layer) => layerSkills(layer, warnings).map((s) => ({ name: s.name, value: s.dir })),
    warnings,
    effects,
  );
  const mcp = mergeNamed(
    layers,
    "mcp",
    (layer) =>
      Object.entries(layer.mcp).map(([name, server]) => ({
        name,
        value: {
          server,
          layer: {
            repo: layer.repo,
            ...(layer.ref ? { ref: layer.ref } : {}),
            commit: layer.commit,
            dir: layer.dir,
          },
        },
      })),
    warnings,
    effects,
  );
  // 外部 PF も、MCP サーバーと同じ規則で合わせる（PBI-74）
  const platforms = mergeNamed(
    layers,
    "platforms",
    (layer) => Object.entries(layer.platforms).map(([name, value]) => ({ name, value })),
    warnings,
    effects,
  );
  const agentsFrom: Record<keyof AgentSettings, string[]> = { codex: [], claude: [] };
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
      const agentDir = join(layer.dir, AGENT_DIRS[kind]);
      // Codex の [agents.<名前>] が config_file で指す定義の中の name が段階なら、その宣言も使わない（PBI-119）
      if (kind === "codex" && isPlainObject(own.agents)) {
        for (const [key, value] of Object.entries(own.agents)) {
          const configFile = isPlainObject(value) ? value.config_file : undefined;
          if (typeof configFile !== "string") continue;
          const role = codexRoleName(agentDir, configFile);
          if (role !== undefined && (AGENT_TIERS as readonly string[]).includes(role)) {
            warnings.push(
              message("context.reservedSetting", {
                from,
                file: AGENT_SETTINGS_FILES[kind],
                key: `agents.${key}`,
              }),
            );
            delete own.agents[key];
          }
        }
      }
      if (Object.keys(own).length > 0) agentsFrom[kind].push(from);
      agents[kind] = mergeSettings(agents[kind], own, UNION_SETTINGS[kind]);
      const settingsFile = AGENT_SETTINGS_FILES[kind].slice(AGENT_DIRS[kind].length + 1);
      for (const path of layerAgentFiles(layer, kind)) {
        if (path === settingsFile) continue;
        const src = join(agentDir, path);
        if (RESERVED_FILES[kind].some((r) => path === r || path.startsWith(`${r}/`))) {
          warnings.push(
            message("context.reservedSetting", { from, file: `${AGENT_DIRS[kind]}/`, key: path }),
          );
          continue;
        }
        // Codex は agents/*.toml の中の name をロールの名前にする（ファイル名ではない）。name が段階なら、ファイル名が
        // 違っても sacty の段階の定義と衝突するので写さない（PBI-119。PR #129 再レビュー指摘）
        if (kind === "codex" && path.startsWith("agents/") && path.endsWith(".toml")) {
          const role = codexRoleName(agentDir, path);
          if (role !== undefined && (AGENT_TIERS as readonly string[]).includes(role)) {
            warnings.push(
              message("context.reservedTierFile", { from, path: `${AGENT_DIRS[kind]}/${path}` }),
            );
            continue;
          }
        }
        files[kind].set(path, { src, from });
      }
    }
  }
  return {
    rules: rules.join("\n\n"),
    skills: skills.map((s) => ({ name: s.name, dir: s.value, from: s.from })),
    mcp: mcp.map((m) => ({
      name: m.name,
      server: m.value.server,
      from: m.from,
      layer: m.value.layer,
    })),
    platforms: platforms.map((p) => ({ ...toPlatform(p.name, p.value), from: p.from })),
    agents,
    agentFiles: {
      codex: [...files.codex.entries()].map(([path, f]) => ({ path, ...f })),
      claude: [...files.claude.entries()].map(([path, f]) => ({ path, ...f })),
    },
    warnings,
    effects,
    rulesFrom,
    agentsFrom,
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
  /** mcp.yaml に書いた時間切れ（秒。PBI-75）。ゲートウェイの中継が、これより先に切れないようにする。 */
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
};

/**
 * ホストで起動してゲートウェイ経由にした、コンテキストの command の MCP サーバー（PBI-84）。env の秘密情報は参照のまま
 * （値はホストで起動するときにだけ取り出す）。layer の dir は取得した層（実行の後に消える）なので、起動する側で写す。
 */
export type HostedContextMcp = {
  name: string;
  from: string;
  command: string;
  args: string[];
  env: Record<string, string | { secret: string; prefix: string }>;
  layer: McpLayer;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
};

/** ゲートウェイがホストで起動したコンテキストの MCP サーバーへ中継する（PBI-84）。host はゲートウェイの中の名前。 */
export type HostedMcpRelay = { name: string; host: string };

/** 実行時に、秘密情報の値をこの環境変数でコンテナに渡す（値は prefix + 秘密情報）。 */
export type ContextSecret = { env: string; secret: string; prefix: string };

/** 配置したコンテキストのうち、エージェントの起動に必要なもの。 */
export type PlacedContext = {
  /** MCP サーバーの名前（Claude Code では、そのツールの使用を許可する）。 */
  mcpServers: string[];
  /** 実行時に入れる秘密情報。 */
  secrets: ContextSecret[];
  /** エージェントに渡す環境変数（秘密情報ではないもの。Claude Code の MCP_TIMEOUT など。PBI-75）。 */
  env?: Record<string, string>;
};

/**
 * エージェントの実行全体の上限（ミリ秒）。コンテナは、開始からこの時間で止める（DockerExecutor の既定）。MCP の
 * 時間切れをこれ以上にしても意味が無いので、コンテキストの用意で警告する（PBI-75）。
 */
export const AGENT_RUN_TIMEOUT_MS = 30 * 60_000;

/**
 * Claude Code が MCP サーバーの起動を待つ既定の上限（秒）。Claude Code にはサーバーごとの起動の時間切れが無く、
 * 全体の環境変数 MCP_TIMEOUT（ミリ秒。書かなければ 30000）だけがある（2.1.299 の本体で確かめた。PBI-75）。
 */
const CLAUDE_MCP_STARTUP_DEFAULT_SEC = 30;

/**
 * エージェントの設定のディレクトリに置く1つのファイル（PBI-76）。content は sacty が作った中身、src は写す元のファイル
 * （層のエージェントの設定のディレクトリのファイル・スキルのファイル）。from は、どの層のものか（sacty が作ったものは無い）。
 */
export type PlannedFile = { path: string; from?: string } & ({ content: string } | { src: string });

/** ディレクトリの下のファイル（相対パス。名前の順）。 */
function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (rel: string) => {
    const path = rel ? join(root, rel) : root;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(rel ? `${rel}/${name}` : name);
    } else {
      files.push(rel);
    }
  };
  visit("");
  return files;
}

/**
 * 合成したコンテキストから、エージェントの設定のディレクトリに置くファイルの一覧を作る（書かない。PBI-76）。実行
 * （writeContext）もプレビューも、これで作る。同じパスは後のものが上書きする（書く順のまま並べ、重なりは除く）。
 * - Claude Code：`CLAUDE.md`（規約）・`settings.json`・`mcp.json`・`skills/<名前>/`（スキル）
 * - Codex：`AGENTS.md`（規約と、スキルの一覧）・`config.toml`・`skills/<名前>/`（Codex にはスキルの仕組みが無いので、
 *   AGENTS.md から場所を示して読ませる）
 */
export function planContext(
  composed: ComposedContext,
  runtime: "claude-code" | "codex",
  /** コンテナの中での設定のディレクトリ（Codex の AGENTS.md にスキルの場所を書くため）。 */
  containerDir: string,
  /**
   * sacty が足して置くファイル（段階のサブエージェントの定義。PBI-119）。層の同じパスのファイルより優先し、層のものは
   * 写さずに警告する（`context.reservedTierFile`）。
   */
  extraFiles: readonly PlannedFile[] = [],
): { files: PlannedFile[]; placed: PlacedContext; warnings: DaemonText[] } {
  const files = new Map<string, PlannedFile>();
  const warnings: DaemonText[] = [];
  const put = (file: PlannedFile) => {
    // 上書きしたものは、書いた順の位置に置き直す
    files.delete(file.path);
    files.set(file.path, file);
  };
  const secrets: ContextSecret[] = [];
  // 秘密情報は設定のファイルに値を書かず、環境変数の名前で参照する（値は実行時に入れる）
  const resolve = (value: string | { secret: string; prefix: string }) => {
    if (typeof value === "string") return { literal: value };
    const env = `SACTY_MCP_SECRET_${secrets.length}`;
    secrets.push({ env, secret: value.secret, prefix: value.prefix });
    return { env };
  };
  const done = (env?: Record<string, string>) => ({
    files: [...files.values()],
    placed: {
      mcpServers: composed.mcp.map((m) => m.name),
      secrets,
      ...(env ? { env } : {}),
    },
    warnings,
  });
  // 層のエージェントの設定のディレクトリのファイルを先に写す（sacty が作るファイルは除いてある）
  for (const file of composed.agentFiles[runtime === "codex" ? "codex" : "claude"]) {
    put({ path: file.path, src: file.src, from: file.from });
  }
  // 段階のサブエージェントの定義のパス（agents/<段階>.md・.toml）は sacty が作る。層にあれば、段階を置くかどうかによらず
  // 写さずに警告する（残すと、スキルが段階の名前で起動したときに層の定義を使ってしまう。PBI-119）
  for (const tier of AGENT_TIERS) {
    const path = tierFilePath(runtime, tier);
    const existing = files.get(path);
    if (existing?.from) {
      warnings.push(
        message("context.reservedTierFile", {
          from: existing.from,
          path: `${AGENT_DIRS[runtime === "codex" ? "codex" : "claude"]}/${path}`,
        }),
      );
      files.delete(path);
    }
  }
  // sacty が足すファイル（段階のサブエージェントの定義。PBI-119）
  for (const extra of extraFiles) put(extra);
  for (const skill of composed.skills) {
    for (const rel of filesUnder(skill.dir)) {
      put({ path: `skills/${skill.name}/${rel}`, src: join(skill.dir, rel), from: skill.from });
    }
  }
  if (runtime === "claude-code") {
    if (composed.rules) put({ path: "CLAUDE.md", content: `${composed.rules}\n` });
    if (Object.keys(composed.agents.claude).length > 0) {
      put({
        path: "settings.json",
        content: `${JSON.stringify(composed.agents.claude, null, 2)}\n`,
      });
    }
    if (composed.mcp.length > 0) {
      const values = (record: Record<string, string | { secret: string; prefix: string }>) =>
        Object.fromEntries(
          Object.entries(record).map(([k, v]) => {
            const r = resolve(v);
            return [k, "env" in r ? `\${${r.env}}` : r.literal];
          }),
        );
      // ツールの呼び出しの時間切れは、サーバーごとの timeout（ミリ秒。MCP_TOOL_TIMEOUT より優先される）で渡す
      const timeout = (server: McpServer) =>
        server.tool_timeout_sec !== undefined ? { timeout: server.tool_timeout_sec * 1000 } : {};
      const servers = Object.fromEntries(
        composed.mcp.map(({ name, server }) => [
          name,
          "command" in server
            ? {
                command: server.command,
                args: server.args,
                env: values(server.env),
                ...timeout(server),
              }
            : {
                type: "http",
                url: server.url,
                headers: values(server.headers),
                ...timeout(server),
              },
        ]),
      );
      put({
        path: CLAUDE_MCP_CONFIG,
        content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      });
      // 起動の時間切れはサーバーごとに渡せないので、全体の MCP_TIMEOUT にする。書いたサーバーの値と、書いていない
      // サーバーの既定（30秒）の大きい方（書いていないサーバーの待ち時間を、既定より短くしない）
      if (composed.mcp.some((m) => m.server.startup_timeout_sec !== undefined)) {
        const sec = Math.max(
          ...composed.mcp.map(
            (m) => m.server.startup_timeout_sec ?? CLAUDE_MCP_STARTUP_DEFAULT_SEC,
          ),
        );
        return done({ MCP_TIMEOUT: String(sec * 1000) });
      }
    }
    return done();
  }
  // スキルの一覧の説明は、写す SKILL.md（スキルのディレクトリのもの）から読む
  const index = composed.skills.map((s) => {
    const description = readSkillDescription(join(s.dir, "SKILL.md"));
    return `- ${s.name}${description ? `：${description}` : ""}（${containerDir}/skills/${s.name}/SKILL.md）`;
  });
  const parts = [
    composed.rules,
    index.length > 0
      ? `## スキル\n\n必要なときは、次のスキルの SKILL.md を読んで従ってください。\n\n${index.join("\n")}`
      : "",
  ].filter(Boolean);
  if (parts.length > 0) put({ path: "AGENTS.md", content: `${parts.join("\n\n")}\n` });
  // 層の設定を先に書き、mcp.yaml から作る MCP サーバーの表を後ろに続ける（設定の mcp_servers は除いてある）
  const toml = [
    ...(Object.keys(composed.agents.codex).length > 0
      ? [stringifyToml(composed.agents.codex)]
      : []),
    ...composed.mcp.map(({ name, server }) => codexServer(name, server, resolve)),
  ];
  if (toml.length > 0) put({ path: "config.toml", content: `${toml.join("\n")}` });
  return done();
}

/** 置くファイルの一覧を outDir に書く（content は書き、src は写す）。 */
export function writePlanned(files: readonly PlannedFile[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const to = join(outDir, file.path);
    mkdirSync(dirname(to), { recursive: true });
    if ("content" in file) writeFileSync(to, file.content);
    else cpSync(file.src, to);
  }
}

/**
 * 合成したコンテキストを、エージェントの形式で outDir に書く。outDir は実行ごとの空の設定の
 * ディレクトリ（Claude Code は CLAUDE_CONFIG_DIR、Codex は CODEX_HOME）として渡す。置くファイルは planContext で作る。
 */
export function writeContext(
  composed: ComposedContext,
  runtime: "claude-code" | "codex",
  outDir: string,
  /** コンテナの中での outDir（Codex の AGENTS.md にスキルの場所を書くため）。 */
  containerDir: string,
): PlacedContext {
  const { files, placed } = planContext(composed, runtime, containerDir);
  writePlanned(files, outDir);
  return placed;
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
  // 時間切れ（秒。PBI-75）。書かなければ Codex の既定のまま
  if (server.startup_timeout_sec !== undefined) {
    lines.push(`startup_timeout_sec = ${server.startup_timeout_sec}`);
  }
  if (server.tool_timeout_sec !== undefined) {
    lines.push(`tool_timeout_sec = ${server.tool_timeout_sec}`);
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
  async fetch(
    ref: ContextRef,
    dir: string,
    authEnv?: Record<string, string>,
    signal?: AbortSignal,
  ) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const branch = ref.ref ? ["--branch", ref.ref] : [];
    await run(
      ["clone", "--depth", "1", ...branch, "--", ref.repo, dir],
      undefined,
      authEnv,
      signal,
    );
    const commit = (await run(["rev-parse", "HEAD"], dir, {}, signal)).trim();
    return { commit };
  }
}

function run(
  args: string[],
  cwd?: string,
  authEnv: Record<string, string> = {},
  /** 中止されたら、git を止めて（SIGKILL）、止まってから失敗にする（PBI-107）。 */
  signal?: AbortSignal,
): Promise<string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  // HTTPS の GitHub は、プロジェクトの gh のアカウントのトークンで認証する（環境変数でだけ渡す）
  Object.assign(env, authEnv);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MessageError(message("git.aborted")));
    // 止められる取得は、自分のプロセスグループで起動し、グループごと止める（git clone が起動する git-remote-https などの
    // 子プロセスも残さない）。デーモンが終わるときにも止める（fetch-processes.ts）
    const options = { cwd, env, stdio: ["ignore", "pipe", "pipe"] } satisfies SpawnOptions;
    const stoppable = signal ? spawnStoppable("git", args, options) : undefined;
    const child = stoppable?.child ?? spawn("git", args, options);
    // 止めたら、終わるのを待ってから失敗にする（呼ぶ側が、取得したディレクトリを消せるように）
    let aborted = false;
    const abort = () => {
      aborted = true;
      stoppable?.stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) =>
      reject(new MessageError(message("git.unavailable", { detail: error.message }))),
    );
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (aborted) reject(new MessageError(message("git.aborted")));
      else if (code === 0) resolve(out);
      // git のエラー文は外から来た文なので、そのまま渡す
      else if (err.trim()) reject(new Error(err.trim()));
      else reject(new MessageError(message("git.exitCode", { command: args[0] ?? "", code })));
    });
  });
}

/** ホストの MCP サーバー（PBI-36）を、ゲートウェイの HTTP の MCP として渡すときの接続先と時間切れ（PBI-75）。 */
export type HostMcpEntry = {
  name: string;
  url: string;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
};

/**
 * 実行全体の上限（AGENT_RUN_TIMEOUT_MS）以上の時間切れの警告（PBI-75）。実行全体が先に止まるので効かない。
 * ホストの MCP サーバーも含め、エージェントに渡すサーバーだけを見る。
 */
function timeoutWarnings(mcp: { name: string; server: McpServer }[]): DaemonText[] {
  const limitSec = AGENT_RUN_TIMEOUT_MS / 1000;
  return mcp.flatMap(({ name, server }) =>
    (["startup_timeout_sec", "tool_timeout_sec"] as const).flatMap((key) => {
      const seconds = server[key];
      return seconds !== undefined && seconds >= limitSec
        ? [message("context.mcpTimeoutOverRun", { name, key, seconds, minutes: limitSec / 60 })]
        : [];
    }),
  );
}

/** 書いてある時間切れだけを取り出す（書いていない項目は足さない）。 */
function pickTimeouts(from: { startup_timeout_sec?: number; tool_timeout_sec?: number }) {
  return {
    ...(from.startup_timeout_sec !== undefined
      ? { startup_timeout_sec: from.startup_timeout_sec }
      : {}),
    ...(from.tool_timeout_sec !== undefined ? { tool_timeout_sec: from.tool_timeout_sec } : {}),
  };
}

/** 実行のときの、MCP サーバーの渡し方（PBI-36・49・56）。 */
export type McpRouting = {
  /**
   * ホストの MCP サーバー（PBI-36）。ゲートウェイの HTTP の MCP として、層の MCP サーバーに加える（同じ名前なら、
   * こちらを使い、警告を残す）。認証のヘッダーには、実行ごとのゲートウェイのトークンを入れる。
   */
  hostMcp?: readonly HostMcpEntry[];
  /**
   * コンテナから見たゲートウェイの起点（PBI-49）。あれば、層の HTTP の MCP サーバー（via_gateway）を、ゲートウェイの
   * URL（/ctx-mcp/<名前>）に置き換え、元の URL と認証のヘッダーは gatewayMcp として返す（ゲートウェイに持たせる）。
   */
  gatewayOrigin?: string;
  /**
   * 層の command の MCP サーバー（via_gateway）をホストで起動するか（PBI-84。gatewayOrigin と一緒に使う）。true なら、
   * ゲートウェイの URL（/ctx-mcp/<名前>）に置き換え、起動するコマンドは hostedMcp として返す（ゲートウェイがホストで
   * 起動する）。
   */
  hostCommands?: boolean;
  /**
   * 渡す MCP サーバーを、この名前の1つに絞る（成果の書き出し。PBI-56）。決めた接続先のほかは渡さない（使わせない。
   * ほかの MCP サーバーの認証も取り出さない）。
   */
  onlyMcp?: string;
};

/** ホストの MCP サーバー（PBI-36）を加えたものの from。 */
export const HOST_MCP_FROM = "sacty-gateway";

/**
 * 合成した MCP サーバーを、実行のときの形にする（PBI-76 で prepareContext から分けた。プレビューも同じものを使う）。
 * 層の HTTP の MCP サーバーのゲートウェイへの置き換え、ホストの MCP サーバーの追加、書き出しの絞り込み、時間切れの
 * 警告。元の composed は変えない。
 */
export function routeMcp(
  composed: ComposedContext,
  routing: McpRouting = {},
): {
  composed: ComposedContext;
  gatewayMcp: GatewayMcpServer[];
  /** ホストで起動する、層の command の MCP サーバー（PBI-84）。 */
  hostedMcp: HostedContextMcp[];
} {
  const { hostMcp = [], gatewayOrigin, hostCommands = false, onlyMcp } = routing;
  const warnings = [...composed.warnings];
  let mcp = composed.mcp;
  // 層の HTTP の MCP サーバーは、ゲートウェイ経由にする（PBI-49）。ホストの MCP サーバーと同じく、認証のヘッダーには
  // 実行ごとのゲートウェイのトークンだけを入れる
  const gatewayMcp: GatewayMcpServer[] = [];
  const hostedMcp: HostedContextMcp[] = [];
  const viaGateway = (timeouts: ReturnType<typeof pickTimeouts>, name: string) => ({
    url: `${gatewayOrigin}/ctx-mcp/${name}`,
    headers: { Authorization: { secret: GATEWAY_TOKEN_SECRET, prefix: "Bearer " } },
    via_gateway: true,
    ...timeouts,
  });
  if (gatewayOrigin) {
    mcp = mcp.map((m) => {
      if (!m.server.via_gateway) return m;
      const timeouts = pickTimeouts(m.server);
      if ("command" in m.server) {
        // 層の command の MCP サーバーは、ホストで起動してゲートウェイ経由にする（PBI-84）。層の分からないもの（作業
        // ディレクトリを決められない）は、これまでどおりコンテナの中で起動する
        if (!hostCommands || !m.layer) return m;
        hostedMcp.push({
          name: m.name,
          from: m.from,
          command: m.server.command,
          args: m.server.args,
          env: m.server.env,
          layer: m.layer,
          ...timeouts,
        });
        return { ...m, server: viaGateway(timeouts, m.name) };
      }
      gatewayMcp.push({
        name: m.name,
        url: m.server.url,
        headers: m.server.headers,
        ...timeouts,
      });
      return { ...m, server: viaGateway(timeouts, m.name) };
    });
  }
  if (hostMcp.length > 0) {
    const names = new Set(hostMcp.map((m) => m.name));
    // 層の MCP サーバーがホストのものと同じ名前なら、ホストのものを使う（層のものは渡さない。PBI-76 で警告にした）
    for (const m of mcp) {
      if (names.has(m.name)) {
        warnings.push(message("context.hostMcpOverride", { from: m.from, name: m.name }));
      }
    }
    mcp = [
      ...mcp.filter((m) => !names.has(m.name)),
      ...hostMcp.map((m) => ({
        name: m.name,
        from: HOST_MCP_FROM,
        server: {
          url: m.url,
          headers: { Authorization: { secret: GATEWAY_TOKEN_SECRET, prefix: "Bearer " } },
          via_gateway: true,
          ...pickTimeouts(m),
        },
      })),
    ];
  }
  if (onlyMcp !== undefined) mcp = mcp.filter((m) => m.name === onlyMcp);
  warnings.push(...timeoutWarnings(mcp));
  // ホストの MCP サーバーと同じ名前で置き換えられたもの・絞り込みで外したものは、中継しない（ホストで起動もしない）
  const kept = (g: { name: string }) =>
    mcp.some((c) => c.name === g.name && c.from !== HOST_MCP_FROM);
  return {
    composed: { ...composed, mcp, warnings },
    gatewayMcp: gatewayMcp.filter(kept),
    hostedMcp: hostedMcp.filter(kept),
  };
}

/** 既定のコンテキストと、プロジェクトのコンテキストの層（上位から）。プロジェクトのものは work の下に取得する。 */
async function loadLayers(
  fetcher: ContextFetcher,
  root: ContextRef | undefined,
  work: string,
  auth?: ContextAuth,
  defaultDir?: string,
  signal?: AbortSignal,
): Promise<ContextLayer[]> {
  return [
    ...(defaultDir ? [loadDefaultContext(defaultDir)] : []),
    ...(root ? await resolveContext(fetcher, root, join(work, "repos"), auth, signal) : []),
  ];
}

/** 層の、作業履歴に記録する形（repo・ref・commit）。 */
const layerRecord = (l: ContextLayer) => ({
  repo: l.repo,
  ...(l.ref ? { ref: l.ref } : {}),
  commit: l.commit,
});

/**
 * 実行のときに置くコンテキストを、書く前の形で作る（PBI-76）。prepareContext（実行）とプレビューは、どちらもこれで作る
 * （プレビューのために別の作り方をしない）。層は work の下に取得する（呼び出し側で消す）。
 */
async function buildContext(
  fetcher: ContextFetcher,
  root: ContextRef | undefined,
  runtime: "claude-code" | "codex",
  containerDir: string,
  work: string,
  auth: ContextAuth | undefined,
  defaultDir: string | undefined,
  routing: McpRouting,
  /** sacty が足して置くファイル（段階のサブエージェントの定義。PBI-119）。 */
  extraFiles: readonly PlannedFile[] = [],
) {
  const layers = await loadLayers(fetcher, root, work, auth, defaultDir);
  const { composed, gatewayMcp, hostedMcp } = routeMcp(composeContext(layers, runtime), routing);
  const { files, placed, warnings } = planContext(composed, runtime, containerDir, extraFiles);
  composed.warnings.push(...warnings);
  return { layers, composed, gatewayMcp, hostedMcp, files, placed };
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
  /** ホストの MCP サーバー（PBI-36。McpRouting の hostMcp）。 */
  hostMcp: readonly HostMcpEntry[] = [],
  /** コンテナから見たゲートウェイの起点（PBI-49。McpRouting の gatewayOrigin）。 */
  gatewayOrigin?: string,
  /** 渡す MCP サーバーを、この名前の1つに絞る（成果の書き出し。PBI-56。McpRouting の onlyMcp）。 */
  onlyMcp?: string,
  /** 層の command の MCP サーバーをホストで起動するか（PBI-84。McpRouting の hostCommands）。 */
  hostCommands?: boolean,
  /** sacty が足して置くファイル（段階のサブエージェントの定義。PBI-119）。 */
  extraFiles: readonly PlannedFile[] = [],
): Promise<{
  dir: string;
  layers: { repo: string; ref?: string; commit: string }[];
  warnings: DaemonText[];
  placed: PlacedContext;
  /**
   * ゲートウェイ経由にした、層の HTTP の MCP サーバーの中継先（PBI-49）。ヘッダーの秘密情報は参照のまま。ホストで
   * 起動した command の MCP サーバーの中継（PBI-84）は、呼び出し側が起動してから加える。
   */
  gatewayMcp: (GatewayMcpServer | HostedMcpRelay)[];
  /** ホストで起動する、層の command の MCP サーバー（PBI-84）。層のディレクトリは dispose で消えるので、その前に写す。 */
  hostedMcp: HostedContextMcp[];
  /** 層で定義した外部 PF（PBI-74。from にどの層のものか）。認証は秘密情報の名前のまま。 */
  platforms: Platform[];
  dispose: () => void;
}> {
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  const dispose = () => rmSync(work, { recursive: true, force: true });
  try {
    const built = await buildContext(
      fetcher,
      root,
      runtime,
      containerDir,
      work,
      auth,
      defaultDir,
      { hostMcp, gatewayOrigin, onlyMcp, hostCommands },
      extraFiles,
    );
    const dir = join(work, "out");
    writePlanned(built.files, dir);
    return {
      dir,
      layers: built.layers.map(layerRecord),
      warnings: built.composed.warnings,
      placed: built.placed,
      gatewayMcp: built.gatewayMcp,
      hostedMcp: built.hostedMcp,
      platforms: built.composed.platforms,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** プレビューに出すファイルの中身の上限（バイト。PBI-76）。超えた分は省く。 */
export const PREVIEW_FILE_MAX_BYTES = 256 * 1024;
/**
 * プレビューに出す中身の合計の上限（バイト。PBI-76）。超えたら、それより後のファイルは中身を出さない（omitted）。
 * sacty が作るファイル（規約・設定・MCP の設定）を先に数える。
 */
export const PREVIEW_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

/** プレビューの、置くファイル1つ（PBI-76）。 */
export type ContextPreviewFile = {
  /** 設定のディレクトリからの相対パス。 */
  path: string;
  /** どの層のものか（sacty が作ったファイルには無い）。 */
  from?: string;
  /** sacty が作ったファイルか（規約・設定・MCP の設定）。false なら層のファイルの写し。 */
  generated: boolean;
  /** 大きさ（バイト）。 */
  size: number;
  /** 中身（UTF-8 でないファイルには無い。上限を超えた分は省く）。 */
  content?: string;
  binary?: true;
  /** ファイルの上限（PREVIEW_FILE_MAX_BYTES）を超えたので、途中までにした。 */
  truncated?: true;
  /** 合計の上限（PREVIEW_TOTAL_MAX_BYTES）を超えたので、中身を出さなかった。 */
  omitted?: true;
};

/** プレビューの MCP サーバー1つ（PBI-76）。エージェントから見える形と、元の接続先。 */
export type ContextPreviewMcp = {
  name: string;
  /** どの層のものか（ホストの MCP サーバーは HOST_MCP_FROM）。 */
  from: string;
  /** エージェントから見える形（stdio はコンテナの中で起動するコマンド、HTTP は URL）。 */
  agent: { command: string; args: string[] } | { url: string };
  /**
   * 元の接続先。direct は agent のまま（コンテナから直接）、gateway はゲートウェイが中継する先（ヘッダーの秘密情報は
   * 参照の名前のまま）、host はホストで動かす MCP サーバー（config.yaml の gateway.mcp_servers）、hostCommand は
   * ゲートウェイがホストで起動する層の command の MCP サーバー（PBI-84。env の秘密情報は参照の名前のまま。作業
   * ディレクトリは cwd の層のリポジトリの写し）。
   */
  origin:
    | { kind: "direct" }
    | {
        kind: "gateway";
        url: string;
        headers: Record<string, string | { secret: string; prefix: string }>;
      }
    | { kind: "host" }
    | {
        kind: "hostCommand";
        command: string;
        args: string[];
        env: Record<string, string | { secret: string; prefix: string }>;
        cwd: string;
      };
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
};

/** コンテキストの合成の結果のプレビュー（PBI-76）。秘密情報は参照の名前だけで、値は含まない。 */
export type ContextPreview = {
  runtime: "claude-code" | "codex";
  /** 層（上位から）と、それぞれの locked・remove。 */
  layers: {
    repo: string;
    ref?: string;
    commit: string;
    locked: z.infer<typeof NamedItems>;
    remove: z.infer<typeof NamedItems>;
  }[];
  /** 実行のときに設定のディレクトリに置くファイル（置く順）。 */
  files: ContextPreviewFile[];
  mcp: ContextPreviewMcp[];
  skills: { name: string; from: string }[];
  /** 規約を持つ層（上位から連結する）。 */
  rules: string[];
  /** エージェントの設定（settings.json・config.toml）を持つ層（上位から重ねる）。 */
  agentSettings: string[];
  effects: ContextEffect[];
  /**
   * 実行のときに環境変数で入れる秘密情報（参照の名前だけ）。gatewayToken は、実行ごとのゲートウェイのトークン
   * （秘密情報の取り出し口からは取り出さず、実行するときに sacty が入れる）。
   */
  secrets: { env: string; secret: string; prefix: string; gatewayToken: boolean }[];
  /** エージェントに渡す、秘密情報ではない環境変数（MCP_TIMEOUT など）。 */
  env: Record<string, string>;
  /** 層で定義した外部 PF（認証は秘密情報の名前のまま。画面に出すときは要約にする）。 */
  platforms: Platform[];
  warnings: DaemonText[];
};

/** ファイルの大きさと、先頭の max バイト（大きいファイルを全部は読まない）。 */
function readHead(path: string, max: number): { size: number; head: Buffer } {
  const size = statSync(path).size;
  const head = Buffer.alloc(Math.min(size, max));
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < head.length) {
      const n = readSync(fd, head, read, head.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { size, head: head.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}

/** プレビューに出す中身（UTF-8 として読めなければ binary。上限を超えた分は省く）。 */
function previewContent(
  size: number,
  head: Buffer,
): Pick<ContextPreviewFile, "size" | "content" | "binary" | "truncated"> {
  const truncated = size > head.length;
  if (head.includes(0)) return { size, binary: true };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // 途中までにしたときは、末尾で切れた文字（最大3バイト）だけを落とす。ほかの不正なバイトは binary にする
  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= head.length; cut++) {
    try {
      const content = decoder.decode(head.subarray(0, head.length - cut));
      return { size, content, ...(truncated ? { truncated: true as const } : {}) };
    } catch {
      // 次の切り方を試す
    }
  }
  return { size, binary: true };
}

/**
 * 置くファイルの一覧を、プレビューの形にする。中身はファイルごとの上限と合計の上限までにする（合計の上限に届いたファイルは
 * 途中まで、それより後のファイルは中身を出さない）。
 */
function previewFiles(files: readonly PlannedFile[]): ContextPreviewFile[] {
  let budget = PREVIEW_TOTAL_MAX_BYTES;
  const shown = new Map<PlannedFile, ContextPreviewFile>();
  // sacty が作るファイルを先に数える（規約・設定・MCP の設定は必ず見せたい）
  const ordered = [
    ...files.filter((f) => "content" in f),
    ...files.filter((f) => !("content" in f)),
  ];
  for (const f of ordered) {
    const base = { path: f.path, ...(f.from ? { from: f.from } : {}), generated: "content" in f };
    const max = Math.min(PREVIEW_FILE_MAX_BYTES, budget);
    let size: number;
    let head: Buffer;
    if ("content" in f) {
      const bytes = Buffer.from(f.content);
      size = bytes.length;
      head = bytes.subarray(0, max);
    } else {
      ({ size, head } = readHead(f.src, max));
    }
    if (size > 0 && head.length === 0) {
      shown.set(f, { ...base, size, omitted: true });
      continue;
    }
    budget -= head.length;
    shown.set(f, { ...base, ...previewContent(size, head) });
  }
  return files.map((f) => shown.get(f) as ContextPreviewFile);
}

/**
 * プロジェクトのコンテキストの合成の結果を、実行のときと同じ処理（buildContext）で作り、書かずに返す（PBI-76）。取得した
 * リポジトリは読んだら消す（実行の状態・作業履歴には触れない）。取得・設定の誤りは、prepareContext と同じく例外にする。
 */
export async function previewContext(
  fetcher: ContextFetcher,
  root: ContextRef | undefined,
  runtime: "claude-code" | "codex",
  containerDir: string,
  auth?: ContextAuth,
  defaultDir?: string,
  routing: McpRouting = {},
  /** sacty が足して置くファイル（段階のサブエージェントの定義。PBI-119）。 */
  extraFiles: readonly PlannedFile[] = [],
): Promise<ContextPreview> {
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  try {
    const { layers, composed, gatewayMcp, hostedMcp, files, placed } = await buildContext(
      fetcher,
      root,
      runtime,
      containerDir,
      work,
      auth,
      defaultDir,
      routing,
      extraFiles,
    );
    return {
      runtime,
      layers: layers.map((l) => ({
        ...layerRecord(l),
        locked: l.manifest.locked,
        remove: l.manifest.remove,
      })),
      files: previewFiles(files),
      mcp: composed.mcp.map(({ name, from, server }): ContextPreviewMcp => {
        const relayed = gatewayMcp.find((g) => g.name === name);
        const hosted = hostedMcp.find((h) => h.name === name);
        return {
          name,
          from,
          agent:
            "command" in server
              ? { command: server.command, args: server.args }
              : { url: server.url },
          origin:
            from === HOST_MCP_FROM
              ? { kind: "host" }
              : hosted
                ? {
                    kind: "hostCommand",
                    command: hosted.command,
                    args: hosted.args,
                    env: hosted.env,
                    cwd: hosted.from,
                  }
                : relayed
                  ? { kind: "gateway", url: relayed.url, headers: relayed.headers }
                  : { kind: "direct" },
          ...pickTimeouts(server),
        };
      }),
      skills: composed.skills.map((s) => ({ name: s.name, from: s.from })),
      rules: composed.rulesFrom,
      agentSettings: composed.agentsFrom[runtime === "codex" ? "codex" : "claude"],
      effects: composed.effects,
      secrets: placed.secrets.map((s) => ({
        ...s,
        gatewayToken: s.secret === GATEWAY_TOKEN_SECRET,
      })),
      env: placed.env ?? {},
      platforms: composed.platforms,
      warnings: composed.warnings,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
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
): Promise<{ mcp: string[]; rules: string; platforms: Platform[] }> {
  if (!root && !defaultDir) return { mcp: [], rules: "", platforms: [] };
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  try {
    const own = root ? await resolveContext(fetcher, root, join(work, "repos"), auth) : [];
    const layers = [...(defaultDir ? [loadDefaultContext(defaultDir)] : []), ...own];
    // 規約は、プロジェクトのコンテキストのものだけ（sacty の既定の規約は、書き出し先の手がかりではないため）
    const composed = composeContext(layers);
    return {
      mcp: composed.mcp.map((m) => m.name),
      rules: own.length > 0 ? composeContext(own).rules : "",
      platforms: composed.platforms,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * プロジェクトのコンテキストで合成した MCP サーバーと外部 PF（PBI-107）。使う秘密情報の参照を、起動時と保存時に
 * まとめて取り出すために読む（継承の鎖の上の層も含めて合成したもの。取得したリポジトリは、読んだら消す）。
 */
export async function contextSecretSources(
  fetcher: ContextFetcher,
  root: ContextRef,
  auth?: ContextAuth,
  defaultDir?: string,
  /** 中止されたら、取得を止めて失敗にする（取得したリポジトリは消す）。 */
  signal?: AbortSignal,
): Promise<{ mcp: { name: string; server: McpServer; from: string }[]; platforms: Platform[] }> {
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  try {
    const composed = composeContext(
      await loadLayers(fetcher, root, work, auth, defaultDir, signal),
    );
    return {
      mcp: composed.mcp.map(({ name, server, from }) => ({ name, server, from })),
      platforms: composed.platforms,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * プロジェクトのコンテキストで合成した外部 PF と、合成の警告（PBI-74）。チケットの取り込み・プロジェクトの設定の画面
 * など、工程の実行の外で PF の名前を引くために読む（取得したリポジトリは、読んだら消す）。
 */
export async function contextPlatforms(
  fetcher: ContextFetcher,
  root: ContextRef | undefined,
  auth?: ContextAuth,
  defaultDir?: string,
): Promise<{ platforms: Platform[]; warnings: DaemonText[] }> {
  if (!root && !defaultDir) return { platforms: [], warnings: [] };
  const work = mkdtempSync(join(tmpdir(), "sacty-context-"));
  try {
    const layers = await loadLayers(fetcher, root, work, auth, defaultDir);
    const composed = composeContext(layers);
    // PF に関わる警告だけを返す（スキル・エージェントの設定の警告は、工程の実行で出す）
    const warnings = composed.warnings.filter(
      (w) =>
        typeof w !== "string" &&
        (w.code === "context.lockedOverride" || w.code === "context.lockedRemove") &&
        w.params?.kind === "platforms",
    );
    return { platforms: composed.platforms, warnings };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
