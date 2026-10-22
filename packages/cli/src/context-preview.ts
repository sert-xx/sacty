import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextLabel, renderMessage } from "@sacty/core";

/**
 * 起動中のデーモンの接続先とトークンを置くファイル（SACTY_HOME の下。PBI-76）。`sacty up` が、デーモンが起動できた
 * （応答した）ときに書き（claimDaemonFile）、終わるときに自分の書いたものだけを消す。CLI のコマンド
 * （`sacty context preview`）が、画面と同じ API を呼ぶために読む。トークンを含むので、本人だけが読める権限で置く。
 */
export const DAEMON_FILE = "daemon.json";

export type DaemonEndpoint = { url: string; token: string };

export function writeDaemonFile(home: string, endpoint: DaemonEndpoint): void {
  const path = join(home, DAEMON_FILE);
  // 既にあるファイルは権限が変わらないので、消してから作る
  rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
}

/** 書いたのが自分（接続先とトークンが同じ）のときだけ消す（ほかの sacty のものは消さない）。 */
export function removeDaemonFile(home: string, endpoint: DaemonEndpoint): void {
  const path = join(home, DAEMON_FILE);
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonEndpoint>;
    if (current.token === endpoint.token && current.url === endpoint.url) {
      rmSync(path, { force: true });
    }
  } catch {
    // 無い・読めないなら何もしない
  }
}

/** 接続先のデーモンが、そのトークンで応答するか。 */
export async function isDaemonAlive(
  endpoint: DaemonEndpoint,
  fetcher: Fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetcher(`${endpoint.url}/api/health`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 起動できたデーモンの接続先を書く。既に書かれたほかの sacty が応答するなら、上書きしない（false を返す。その sacty の
 * プレビューを使えなくしないため）。応答しない（止まった後に残ったもの）なら、上書きする。
 */
export async function claimDaemonFile(
  home: string,
  endpoint: DaemonEndpoint,
  alive: (endpoint: DaemonEndpoint) => Promise<boolean> = isDaemonAlive,
): Promise<boolean> {
  const current = readDaemonFile(home);
  if (
    current &&
    !(current.token === endpoint.token && current.url === endpoint.url) &&
    (await alive(current))
  ) {
    return false;
  }
  writeDaemonFile(home, endpoint);
  return true;
}

export function readDaemonFile(home: string): DaemonEndpoint | undefined {
  const path = join(home, DAEMON_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonEndpoint>;
    return typeof json.url === "string" && typeof json.token === "string"
      ? { url: json.url, token: json.token }
      : undefined;
  } catch {
    return undefined;
  }
}

/** デーモンが返すプレビュー（apps/daemon の ContextPreviewView のうち、CLI が出すもの）。 */
export type PreviewView = {
  runtime: string;
  layers: {
    repo: string;
    ref?: string;
    path?: string;
    commit: string;
    locked: Record<string, string[]>;
    remove: Record<string, string[]>;
  }[];
  files: {
    path: string;
    from?: string;
    generated: boolean;
    size: number;
    content?: string;
    binary?: boolean;
    truncated?: boolean;
    omitted?: boolean;
  }[];
  mcp: {
    name: string;
    from: string;
    agent: { command: string; args: string[] } | { url: string };
    origin:
      | { kind: "direct" }
      | { kind: "gateway"; url: string; headers: Record<string, unknown> }
      | { kind: "host" };
    startup_timeout_sec?: number;
    tool_timeout_sec?: number;
  }[];
  skills: { name: string; from: string }[];
  rules: string[];
  agentSettings: string[];
  effects: { kind: string; name: string; effect: "removed" | "locked"; by: string; of?: string }[];
  secrets: { env: string; secret: string; prefix: string; gatewayToken: boolean }[];
  env: Record<string, string>;
  platforms: { name: string; from?: string; description: string; allow: string[] }[];
  warnings: unknown[];
};

export type PreviewResult = { preview: PreviewView } | { error: unknown };

/** ファイルの中身を除いた結果（--no-content。JSON でも人が読む形でも、中身を出さない）。 */
export function withoutContent(result: PreviewResult): PreviewResult {
  if (!("preview" in result)) return result;
  return {
    preview: {
      ...result.preview,
      files: result.preview.files.map(({ content: _, ...file }) => file),
    },
  };
}

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/**
 * プロジェクト（ID か名前）のコンテキストのプレビューを、デーモンの API（GET /api/projects/:id/context-preview）から
 * 取る。プロジェクトが無ければ、その理由で例外にする。
 */
export async function fetchContextPreview(
  endpoint: DaemonEndpoint,
  project: string,
  runtime: "claude-code" | "codex",
  fetcher: Fetch = fetch,
): Promise<PreviewResult> {
  const headers = { authorization: `Bearer ${endpoint.token}` };
  const get = async (path: string) => {
    let res: Response;
    try {
      res = await fetcher(`${endpoint.url}${path}`, { headers });
    } catch {
      throw new Error(
        "デーモンにつながりません。`sacty up` で起動しているか確かめてください（止めたままなら、起動し直してください）。",
      );
    }
    if (res.status === 401) {
      throw new Error("デーモンに認証できません。`sacty up` で起動し直してください。");
    }
    return res;
  };
  const list = await get("/api/projects");
  if (!list.ok) throw new Error(`デーモンが ${list.status} を返しました。`);
  const { projects } = (await list.json()) as { projects: { id: string; name: string }[] };
  // ID が合えばそれ、無ければ名前で探す
  const byId = projects.filter((p) => p.id === project);
  const found = byId.length > 0 ? byId : projects.filter((p) => p.name === project);
  if (found.length === 0) {
    throw new Error(
      `プロジェクト「${project}」がありません（あるもの：${projects.map((p) => p.name).join("・") || "なし"}）。`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `同じ名前のプロジェクトが複数あります。ID で指定してください（${found.map((p) => p.id).join("・")}）。`,
    );
  }
  const id = found[0]?.id ?? "";
  const res = await get(
    `/api/projects/${encodeURIComponent(id)}/context-preview?runtime=${encodeURIComponent(runtime)}`,
  );
  if (!res.ok) throw new Error(`デーモンが ${res.status} を返しました。`);
  return (await res.json()) as PreviewResult;
}

/**
 * `sacty context preview` の出力。--json は API の結果の形、そうでなければ人が読む形。--no-content（content: false）は、
 * どちらの形でもファイルの中身を出さない。
 */
export function previewOutput(
  result: PreviewResult,
  options: { json: boolean; content: boolean },
): string {
  const shown = options.content ? result : withoutContent(result);
  return options.json
    ? JSON.stringify(shown, null, 2)
    : formatContextPreview(shown, options.content);
}

/** プレビューを、人が読む文にする（ファイルの中身も出す。秘密情報は参照の名前だけ）。 */
export function formatContextPreview(result: PreviewResult, showContent = true): string {
  const text = (m: unknown) => renderMessage(m, "ja");
  if ("error" in result) return `コンテキストに誤りがあります：${text(result.error)}`;
  const p = result.preview;
  const out: string[] = [];
  const section = (title: string) => out.push("", `## ${title}`);
  out.push(`# コンテキストのプレビュー（${p.runtime === "codex" ? "Codex" : "Claude Code"}）`);
  out.push(
    "※ 層の設定の中身・mcp.yaml の literal の値は、書かれたまま出ます。秘密情報は参照の名前だけで、値は出しません。",
  );
  section("層（上位から）");
  for (const l of p.layers) {
    const named = (r: Record<string, string[]>) =>
      Object.entries(r)
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => `${k}: ${v.join(", ")}`)
        .join(" / ");
    const locked = named(l.locked);
    const remove = named(l.remove);
    out.push(
      `- ${contextLabel(l)} @ ${l.commit}${locked ? `\n    locked: ${locked}` : ""}${remove ? `\n    remove: ${remove}` : ""}`,
    );
  }
  if (p.warnings.length > 0) {
    section("警告");
    for (const w of p.warnings) out.push(`- ${text(w)}`);
  }
  if (p.effects.length > 0) {
    section("locked・remove の効果");
    for (const e of p.effects) {
      out.push(
        e.effect === "removed"
          ? `- ${e.kind}「${e.name}」：${e.by} が取り除いた（${e.of ?? ""} のもの）`
          : `- ${e.kind}「${e.name}」：${e.by} で上書き禁止${e.of ? `（${e.of} のもの）` : ""}`,
      );
    }
  }
  section("規約・エージェントの設定");
  out.push(`- 規約：${p.rules.join(" → ") || "なし"}`);
  out.push(`- エージェントの設定：${p.agentSettings.join(" → ") || "なし"}`);
  section("スキル");
  for (const s of p.skills) out.push(`- ${s.name}（${s.from}）`);
  if (p.skills.length === 0) out.push("なし");
  section("MCP サーバー");
  for (const m of p.mcp) {
    const agent = "url" in m.agent ? m.agent.url : [m.agent.command, ...m.agent.args].join(" ");
    const origin =
      m.origin.kind === "host"
        ? "ホストの MCP サーバー（config.yaml の gateway.mcp_servers）"
        : m.origin.kind === "gateway"
          ? `ゲートウェイが中継する先：${m.origin.url}`
          : "コンテナから直接";
    out.push(`- ${m.name}（${m.from}）\n    エージェントから：${agent}\n    元の接続先：${origin}`);
  }
  if (p.mcp.length === 0) out.push("なし");
  section("使える外部 PF");
  for (const pf of p.platforms) out.push(`- ${pf.name}（${pf.from ?? "config.yaml"}）`);
  if (p.platforms.length === 0) out.push("なし");
  section("実行のときに入れる環境変数");
  for (const s of p.secrets) {
    out.push(
      `- ${s.env} = ${s.prefix}${s.gatewayToken ? "<実行ごとのゲートウェイのトークン>" : `<秘密情報「${s.secret}」>`}`,
    );
  }
  for (const [k, v] of Object.entries(p.env)) out.push(`- ${k} = ${v}`);
  if (p.secrets.length === 0 && Object.keys(p.env).length === 0) out.push("なし");
  section("置くファイル");
  for (const f of p.files) {
    out.push(`- ${f.path}（${f.from ?? "sacty が作成"}・${f.size} バイト）`);
  }
  if (showContent) {
    for (const f of p.files) {
      out.push("", `===== ${f.path} =====`);
      if (f.binary) out.push("（テキストでないファイル）");
      else if (f.omitted) out.push("（中身の合計が上限を超えたため、中身を省きました）");
      else out.push(`${f.content ?? ""}${f.truncated ? "\n…（以降は省きました）" : ""}`);
    }
  }
  return out.join("\n");
}
