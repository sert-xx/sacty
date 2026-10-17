/**
 * エージェントの段階の名前（PBI-119）。設定（config.ts）とコンテキストの合成（context.ts）の両方から使うので、どちらにも依存しない
 * 小さなモジュールに置く。
 */

/** 段階（弱い順）。config.yaml の `claude_<段階>`・`codex_<段階>` の接尾辞で、サブエージェントの定義の名前にもなる。 */
export const AGENT_TIERS = ["lite", "entry", "standard", "advanced", "ultimate"] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];
/** 段階のエージェントを置ける runtime（stub には置かない）。 */
export type TierRuntime = "claude-code" | "codex";
/** 段階のエージェントの名前の接頭辞（runtime ごと）。 */
export const TIER_PREFIX: Record<TierRuntime, string> = {
  "claude-code": "claude_",
  codex: "codex_",
};

/** `agents` の名前が段階のエージェントなら、その runtime と段階。そうでなければ undefined。 */
export function parseTierId(id: string): { runtime: TierRuntime; tier: AgentTier } | undefined {
  for (const runtime of Object.keys(TIER_PREFIX) as TierRuntime[]) {
    const prefix = TIER_PREFIX[runtime];
    if (!id.startsWith(prefix)) continue;
    const tier = id.slice(prefix.length);
    if ((AGENT_TIERS as readonly string[]).includes(tier))
      return { runtime, tier: tier as AgentTier };
  }
  return undefined;
}

/**
 * 段階のサブエージェントの定義を置くパス（設定のディレクトリからの相対）。層にこのパスのファイルがあっても写さない
 * （段階を置くかどうかによらず。層の定義が残ると、スキルが段階の名前で起動したときにそれを使ってしまうため）。
 */
export function tierFilePath(runtime: TierRuntime, tier: AgentTier): string {
  return runtime === "codex" ? `agents/${tier}.toml` : `agents/${tier}.md`;
}
