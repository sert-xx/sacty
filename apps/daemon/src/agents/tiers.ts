import { type DaemonText, message } from "@sacty/core";
import type { AgentConfig } from "../config.js";
import type { PlannedFile } from "../context.js";
import { AGENT_TIERS, type AgentTier, type TierRuntime, tierFilePath } from "./tier-names.js";

export { tierFilePath };

/**
 * エージェントの段階（PBI-119）。config.yaml の `claude_<段階>`・`codex_<段階>` を、工程を動かすツールのサブエージェントの
 * 定義として、接頭辞を外した名前で設定のディレクトリに置く。スキル（review など）は段階の名前で担当を起動するので、
 * 同じスキルの定義で、どちらのツールでも同じ段階の担当が動く。
 */

/** 置いた段階（作業履歴の ContextResolved に残す形）。 */
export type PlacedTier = {
  tier: AgentTier;
  agentId: string;
  model?: string;
  reasoningEffort?: string;
};

/**
 * 認証・接続先が同じか。サブエージェントは親（工程のエージェント）と同じプロセスで動き、認証・接続先は親のものを使うので、
 * 違う段階は置かない（別の接続先のモデル名を黙って使わない）。
 */
export function sameConnection(a: AgentConfig, b: AgentConfig): boolean {
  const key = (x: AgentConfig) =>
    JSON.stringify({
      runtime: x.runtime,
      auth: x.auth,
      endpoint: x.endpoint ?? null,
      viaGateway: x.via_gateway,
    });
  return key(a) === key(b);
}

/**
 * 親（工程のエージェント）に置く段階を選ぶ。認証・接続先が親と違う段階は置かず、警告にする。
 * stub の親には何も置かない（AI を呼ばない）。
 */
export function selectTiers(
  parent: AgentConfig,
  tiers: Partial<Record<AgentTier, AgentConfig>>,
): { entries: PlacedTier[]; warnings: DaemonText[] } {
  const entries: PlacedTier[] = [];
  const warnings: DaemonText[] = [];
  if (parent.runtime === "stub") return { entries, warnings };
  for (const tier of AGENT_TIERS) {
    const agent = tiers[tier];
    if (!agent) continue;
    if (!sameConnection(parent, agent)) {
      warnings.push(
        message("agents.tierConnectionDiffers", { tier, id: agent.id, parent: parent.id }),
      );
      continue;
    }
    entries.push({
      tier,
      agentId: agent.id,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoning_effort ? { reasoningEffort: agent.reasoning_effort } : {}),
    });
  }
  return { entries, warnings };
}

/** TOML の文字列（引用符・バックスラッシュ・改行を逃がす）。 */
const tomlString = (value: string) => JSON.stringify(value);

/** YAML の frontmatter の文字列（JSON の文字列は YAML の文字列として読める）。 */
const yamlString = (value: string) => JSON.stringify(value);

/**
 * 段階のサブエージェントの定義のファイル。
 * - Claude Code：`agents/<段階>.md`（frontmatter の `name`・`description`・`model`・`effort`。model を書かなければ親を引き継ぐ）
 * - Codex：`agents/<段階>.toml`（`name`・`description`・`developer_instructions`・`model`・`model_reasoning_effort`）
 */
export function tierFiles(runtime: TierRuntime, entries: readonly PlacedTier[]): PlannedFile[] {
  return entries.map((entry) => ({
    path: tierFilePath(runtime, entry.tier),
    content: runtime === "codex" ? codexAgent(entry) : claudeAgent(entry),
  }));
}

function describe(entry: PlacedTier): string {
  const setting = [entry.model, entry.reasoningEffort].filter(Boolean).join(", ");
  return `sacty の段階「${entry.tier}」のサブエージェント${setting ? `（${setting}）` : ""}。親の依頼文に従って、渡された作業だけを行う。`;
}

const INSTRUCTIONS =
  "あなたは sacty の段階のサブエージェントです。親から渡された依頼文だけに従い、依頼文に無いことはしないでください。";

function claudeAgent(entry: PlacedTier): string {
  const lines = [
    "---",
    `name: ${entry.tier}`,
    `description: ${yamlString(describe(entry))}`,
    ...(entry.model ? [`model: ${yamlString(entry.model)}`] : []),
    ...(entry.reasoningEffort ? [`effort: ${yamlString(entry.reasoningEffort)}`] : []),
    "---",
    "",
    INSTRUCTIONS,
    "",
  ];
  return lines.join("\n");
}

function codexAgent(entry: PlacedTier): string {
  const lines = [
    `name = ${tomlString(entry.tier)}`,
    `description = ${tomlString(describe(entry))}`,
    `developer_instructions = ${tomlString(INSTRUCTIONS)}`,
    ...(entry.model ? [`model = ${tomlString(entry.model)}`] : []),
    ...(entry.reasoningEffort
      ? [`model_reasoning_effort = ${tomlString(entry.reasoningEffort)}`]
      : []),
    "",
  ];
  return lines.join("\n");
}
