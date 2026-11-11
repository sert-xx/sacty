import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { CLAUDE_MCP_CONFIG, DEFAULT_CONTEXT_REPO } from "./context.js";

/**
 * ローカルのセッション（`sacty launch`）で、デーモンが合成したコンテキストのファイルを、ホストの Claude Code・Codex に
 * 設定の場所（CLAUDE_CONFIG_DIR・CODEX_HOME）を変えずに渡すための組み立て。利用者のログイン・設定はそのまま使う。
 * ファイルは CLI が作った一時ディレクトリ（dir）に置き、その場所を引数で示す。
 */

/** デーモンが返す、置くファイル1つ（設定のディレクトリからの相対パス・どの層のものか・base64 の中身）。 */
export type LaunchFile = { path: string; from?: string; content: string };

export type LaunchPlan = {
  command: string;
  args: string[];
  /** dir に書くファイル（dir からの相対パスと中身）。 */
  files: { path: string; content: Buffer }[];
  /** 手元の起動では渡せないため、渡さなかったファイル（既定のコンテキストのものは含めない）。 */
  notApplied: { path: string; from?: string }[];
  /**
   * 利用者の設定と名前がぶつかったため、別の名前で渡したコンテキストの MCP サーバー（Codex）。Codex の `-c` は表を置き換えずに
   * 重ねるので、同じ名前のままだと利用者の設定と混ざる（コマンド型と URL 型が混ざると Codex が起動しない）。
   */
  renamed?: { from: string; to: string }[];
};

/** Codex の規則（developer_instructions）として 1 つの引数で渡せる大きさの上限（バイト。Linux の 1 つの引数の上限）。 */
export const CODEX_INSTRUCTIONS_MAX_BYTES = 128 * 1024 - 1024;

export class LaunchError extends Error {}

const decode = (file: LaunchFile) => Buffer.from(file.content, "base64");

/** 段階・層のサブエージェントの定義（agents/<名前>.md・.toml。サブディレクトリは含めない）か。 */
const agentFile = (path: string, ext: ".md" | ".toml") =>
  path.startsWith("agents/") && !path.slice("agents/".length).includes("/") && path.endsWith(ext);

const notAppliedOf = (files: readonly LaunchFile[]) =>
  files
    .filter(
      (f) => f.from !== DEFAULT_CONTEXT_REPO && !f.from?.startsWith(`${DEFAULT_CONTEXT_REPO}@`),
    )
    .map((f) => ({ path: f.path, ...(f.from ? { from: f.from } : {}) }));

/**
 * Claude Code の起動。規則は --append-system-prompt-file、設定は --settings、MCP は --mcp-config と --strict-mcp-config
 * （利用者の MCP サーバーは使わない）、サブエージェントは --agents（JSON）、スキルは dir の .claude/skills/ に置いて --add-dir
 * で渡す。権限の確認を求めるモード（default）を明示する。extraArgs（`--` の後の引数）は最後に足す。
 */
export function claudeLaunch(
  dir: string,
  files: readonly LaunchFile[],
  extraArgs: readonly string[] = [],
): LaunchPlan {
  const out: LaunchPlan["files"] = [];
  const skipped: LaunchFile[] = [];
  const args: string[] = [];
  const agents: Record<string, { description: string; prompt: string; model?: string }> = {};
  let skills = false;
  let mcp = false;
  for (const file of files) {
    if (file.path.startsWith("skills/")) {
      out.push({ path: `.claude/${file.path}`, content: decode(file) });
      skills = true;
    } else if (file.path === "CLAUDE.md") {
      out.push({ path: file.path, content: decode(file) });
      args.push("--append-system-prompt-file", join(dir, file.path));
    } else if (file.path === "settings.json") {
      out.push({ path: file.path, content: decode(file) });
      args.push("--settings", join(dir, file.path));
    } else if (file.path === CLAUDE_MCP_CONFIG) {
      out.push({ path: file.path, content: decode(file) });
      mcp = true;
    } else if (agentFile(file.path, ".md")) {
      const agent = claudeAgent(file.path, decode(file).toString("utf8"));
      if (agent) agents[agent.name] = agent.definition;
      else skipped.push(file);
    } else {
      skipped.push(file);
    }
  }
  // コンテキストに MCP サーバーが無くても、利用者の MCP サーバーを使わないように、空の設定を渡す
  if (!mcp) {
    out.push({ path: CLAUDE_MCP_CONFIG, content: Buffer.from('{ "mcpServers": {} }\n') });
  }
  args.push("--mcp-config", join(dir, CLAUDE_MCP_CONFIG), "--strict-mcp-config");
  if (Object.keys(agents).length > 0) args.push("--agents", JSON.stringify(agents));
  if (skills) args.push("--add-dir", dir);
  args.push("--permission-mode", "default", ...extraArgs);
  return { command: "claude", args, files: out, notApplied: notAppliedOf(skipped) };
}

/** Claude Code のサブエージェントの定義（frontmatter の name・description・model と本文）を、--agents の形にする。 */
function claudeAgent(
  path: string,
  text: string,
):
  | { name: string; definition: { description: string; prompt: string; model?: string } }
  | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  let front: unknown;
  try {
    front = parseYaml(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (!front || typeof front !== "object") return undefined;
  const meta = front as Record<string, unknown>;
  const fallback = path.slice("agents/".length, -".md".length);
  const name = typeof meta.name === "string" && meta.name ? meta.name : fallback;
  const description = typeof meta.description === "string" ? meta.description : "";
  return {
    name,
    definition: {
      description,
      prompt: (match[2] ?? "").trim(),
      ...(typeof meta.model === "string" && meta.model ? { model: meta.model } : {}),
    },
  };
}

/**
 * Codex の起動。規則（AGENTS.md。スキルの一覧の場所は dir の絶対パス）は -c developer_instructions、層の設定と MCP サーバーは
 * 葉のキーごとの -c、サブエージェントは -c agents.<名前>.config_file・description で渡す。利用者の MCP サーバー（userMcp）は
 * -c mcp_servers.<名前>.enabled=false で止める。利用者のものと同じ名前のコンテキストの MCP サーバーは、別の名前（<名前>-sacty）で
 * 渡す（renamed）。層の approvals_reviewer は渡さない。サンドボックスと承認の方針を明示する。extraArgs（`--` の後の引数）は
 * 最後に足す。
 */
export function codexLaunch(
  dir: string,
  files: readonly LaunchFile[],
  userMcp: readonly string[] = [],
  extraArgs: readonly string[] = [],
): LaunchPlan {
  const out: LaunchPlan["files"] = [];
  const skipped: LaunchFile[] = [];
  const overrides: string[] = [];
  const user = new Set(userMcp);
  const renamed: { from: string; to: string }[] = [];
  const agents: { name: string; path: string; description: string }[] = [];
  for (const file of files) {
    const content = decode(file);
    if (file.path.startsWith("skills/")) {
      out.push({ path: file.path, content });
    } else if (file.path === "AGENTS.md") {
      if (content.byteLength > CODEX_INSTRUCTIONS_MAX_BYTES) {
        throw new LaunchError(
          `規則とスキルの一覧（${content.byteLength} バイト）が、Codex に引数で渡せる大きさ（${CODEX_INSTRUCTIONS_MAX_BYTES} バイト）を超えています。`,
        );
      }
      overrides.push(`developer_instructions=${tomlValue(content.toString("utf8"))}`);
    } else if (file.path === "config.toml") {
      const config = parseToml(content.toString("utf8")) as Record<string, unknown>;
      delete config.approvals_reviewer;
      const servers = config.mcp_servers;
      delete config.mcp_servers;
      if (isTable(servers)) {
        const taken = new Set([...user, ...Object.keys(servers)]);
        for (const [name, server] of Object.entries(servers)) {
          let key = name;
          if (user.has(name)) {
            key = `${name}-sacty`;
            for (let i = 2; taken.has(key); i++) key = `${name}-sacty-${i}`;
            taken.add(key);
            renamed.push({ from: name, to: key });
          }
          overrides.push(`${keyPath(["mcp_servers", key])}=${tomlValue(server)}`);
        }
      }
      // 層が宣言したサブエージェントの config_file は、設定の場所からの相対パスなので、dir の絶対パスにする
      if (isTable(config.agents)) {
        for (const agent of Object.values(config.agents)) {
          if (isTable(agent) && typeof agent.config_file === "string") {
            agent.config_file = resolve(dir, agent.config_file);
          }
        }
      }
      for (const [path, value] of leaves(config))
        overrides.push(`${keyPath(path)}=${tomlValue(value)}`);
    } else if (agentFile(file.path, ".toml")) {
      out.push({ path: file.path, content });
      const agent = codexAgent(file.path, content.toString("utf8"));
      if (agent) agents.push({ ...agent, path: join(dir, file.path) });
    } else {
      skipped.push(file);
    }
  }
  for (const agent of agents) {
    overrides.push(
      `${keyPath(["agents", agent.name, "config_file"])}=${tomlValue(agent.path)}`,
      `${keyPath(["agents", agent.name, "description"])}=${tomlValue(agent.description)}`,
    );
  }
  for (const name of userMcp) overrides.push(`${keyPath(["mcp_servers", name, "enabled"])}=false`);
  // Codex は --sandbox・--ask-for-approval を 2 回渡すと起動しない（0.167.0 で確かめた）。利用者が `--` の後で渡したら、
  // sacty の分は渡さず、利用者の指定を効かせる
  const given = (long: string, short: string) =>
    extraArgs.some((a) => a === long || a === short || a.startsWith(`${long}=`));
  const args = [
    ...overrides.flatMap((o) => ["-c", o]),
    ...(given("--sandbox", "-s") ? [] : ["--sandbox", "workspace-write"]),
    ...(given("--ask-for-approval", "-a") ? [] : ["--ask-for-approval", "on-request"]),
    ...extraArgs,
  ];
  return {
    command: "codex",
    args,
    files: out,
    notApplied: notAppliedOf(skipped),
    ...(renamed.length > 0 ? { renamed } : {}),
  };
}

/** Codex のサブエージェントの定義（name・description）。name が無ければファイルの名前。 */
function codexAgent(path: string, text: string): { name: string; description: string } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const fallback = path.slice("agents/".length, -".toml".length);
  return {
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : fallback,
    description: typeof parsed.description === "string" ? parsed.description : "",
  };
}

/**
 * 利用者の Codex の MCP サーバーの名前。利用者の設定（CODEX_HOME、無ければ ~/.codex の config.toml）と、cwd から対象リポジトリの
 * 根（.git のあるディレクトリ）までの .codex/config.toml を読む。読めないファイルは飛ばす。
 */
export function codexUserMcpServers(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const paths = [join(env.CODEX_HOME || join(home, ".codex"), "config.toml")];
  let current = resolve(cwd);
  for (;;) {
    paths.push(join(current, ".codex", "config.toml"));
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const names = new Set<string>();
  for (const path of paths) {
    try {
      const parsed = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (isTable(parsed.mcp_servers)) {
        for (const name of Object.keys(parsed.mcp_servers)) names.add(name);
      }
    } catch {
      // 無い・読めないファイルは飛ばす
    }
  }
  return [...names];
}

function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** 表の葉（表でない値）を、キーの並びとあわせて返す（-c で表ごと置き換えず、利用者の同じ表のほかのキーを残すため）。 */
function leaves(table: Record<string, unknown>, prefix: string[] = []): [string[], unknown][] {
  return Object.entries(table).flatMap(([key, value]): [string[], unknown][] =>
    isTable(value) ? leaves(value, [...prefix, key]) : [[[...prefix, key], value]],
  );
}

/** -c のキー。Codex は `.` で区切るので、`.` を含むキーは渡せない。 */
function keyPath(path: readonly string[]): string {
  const bad = path.find((key) => key === "" || key.includes("."));
  if (bad !== undefined) {
    throw new LaunchError(
      `Codex の設定のキー「${path.join(".")}」は、引数で渡せません（「.」を含むキーや空のキー）。`,
    );
  }
  return path.join(".");
}

/** TOML の値（-c の値。表はインラインの表にする）。 */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isTable(value)) {
    const entries = Object.entries(value).map(
      ([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${tomlValue(v)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  throw new LaunchError(`Codex の設定に渡せない値があります（${String(value)}）。`);
}
