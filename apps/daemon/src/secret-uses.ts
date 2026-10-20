import type { Project, SactySettings } from "@sacty/core";
import { type AgentConfig, definedAgent, providerKeyOf, type SactyConfig } from "./config.js";
import { GATEWAY_TOKEN_SECRET, type McpServer } from "./context.js";
import type { Platform } from "./platforms.js";

/**
 * 秘密情報の参照と、どこに書いたか（取り出せなかったときに示す。値は持たない。PBI-48）。projectId は、プロジェクトの
 * コンテキストに書いたもの（保存し直したときに、そのプロジェクトの警告だけを置き換える。PBI-107）。settings は、
 * sacty の設定（通知先）に書いたもの（設定を保存し直したときに、その警告だけを置き換える。PBI-115）。
 */
export type SecretUse = { ref: string; where: string; projectId?: string; settings?: true };

/**
 * sacty の実行で使う秘密情報の参照を、設定ファイルと sacty の設定から集める（sacty up の起動時にまとめて取り出すため。
 * PBI-48）。使うエージェント（既定・ゴールガーディアン・工程ごと）の認証と接続先の API キー、組織内 PF の認証、
 * ホストで動かす MCP サーバーの環境変数、sacty の設定の通知先（PBI-115）。イメージの作成だけで使う npm のトークンと、
 * gh から取る GitHub のトークン、コンテキストリポジトリの mcp.yaml・platforms.yaml（取得しないと分からない。
 * contextSecretUses で集める）は含めない。
 */
export function secretUses(config: SactyConfig, settings: SactySettings): SecretUse[] {
  const uses: SecretUse[] = [];
  const add = (ref: string | undefined, where: string) => {
    if (ref && ref !== GATEWAY_TOKEN_SECRET) uses.push({ ref, where });
  };
  const agents = new Map<string, AgentConfig>();
  for (const agent of [
    config.defaultAgent,
    config.guardianAgent,
    // 完了したタスクの監査の AI（PBI-125。監査の材料を伏せるときにも使う。PR #135 再レビュー指摘）
    config.auditAgent,
    ...Object.values(config.stepAgents ?? {}),
  ]) {
    if (agent) agents.set(agent.id, agent);
  }
  // 利用制限のときの代わりのエージェント（agents の fallback）も、その代わりも使う
  for (const agent of agents.values()) {
    for (const name of agent.fallback ?? []) {
      const fallback = definedAgent(config, name);
      if (fallback && !agents.has(fallback.id)) agents.set(fallback.id, fallback);
    }
  }
  for (const agent of agents.values()) {
    // 認証・接続先は runtime ごとの providers に書く（PBI-134）
    const provider = providerKeyOf(agent.runtime);
    if ("secret" in agent.auth) add(agent.auth.secret, `providers.${provider}.auth.secret`);
    if (agent.endpoint?.secret)
      add(agent.endpoint.secret, `providers.${agent.endpoint.name}.auth.secret`);
  }
  for (const platform of config.platforms) {
    add(platform.auth.secret, `gateway.platforms.${platform.name}.auth.secret`);
    add(platform.auth.token?.secret, `gateway.platforms.${platform.name}.auth.token.secret`);
  }
  for (const server of config.hostMcp) {
    for (const [env, value] of Object.entries(server.env)) {
      if (typeof value !== "string")
        add(value.secret, `gateway.mcp_servers.${server.name}.env.${env}`);
    }
  }
  uses.push(...settingsSecretUses(settings));
  return uniqueUses(uses);
}

/** sacty の設定の通知先に書いた秘密情報の参照（PBI-115。設定を保存したときにも使う）。 */
export function settingsSecretUses(settings: SactySettings): SecretUse[] {
  const notification = settings.notification;
  const where =
    notification?.kind === "slack-api"
      ? { ref: notification.token, label: "Slack のトークン" }
      : notification?.kind === "slack-webhook"
        ? { ref: notification.webhook, label: "Webhook の URL" }
        : undefined;
  return where?.ref
    ? [{ ref: where.ref, where: `Sacty の設定の通知先（${where.label}）`, settings: true }]
    : [];
}

/** 同じ参照は1つにまとめる（書いた場所は最初のもの）。 */
export function uniqueUses(uses: readonly SecretUse[]): SecretUse[] {
  const seen = new Set<string>();
  return uses.filter((use) => !seen.has(use.ref) && seen.add(use.ref));
}

/**
 * プロジェクトのコンテキスト（継承の鎖の上の層も含めて合成したもの）で使う秘密情報の参照（PBI-107）。platforms.yaml の
 * 認証と、mcp.yaml の env・headers。ホストの PF・MCP サーバーと同じ名前のもの（ホストのものを使い、層のものは使わない）は
 * 含めない。
 */
export function contextSecretUses(
  project: Pick<Project, "id" | "name">,
  sources: {
    mcp: readonly { name: string; server: McpServer; from: string }[];
    platforms: readonly Platform[];
  },
  host: { platforms: readonly string[]; mcp: readonly string[] },
): SecretUse[] {
  const uses: SecretUse[] = [];
  const add = (ref: string | undefined, from: string, where: string) => {
    if (ref && ref !== GATEWAY_TOKEN_SECRET) {
      uses.push({
        ref,
        where: `プロジェクト「${project.name}」のコンテキスト（${from}）の ${where}`,
        projectId: project.id,
      });
    }
  };
  for (const platform of sources.platforms) {
    if (host.platforms.includes(platform.name)) continue;
    const from = platform.from ?? "";
    add(platform.auth.secret, from, `platforms.yaml の ${platform.name}.auth.secret`);
    add(platform.auth.token?.secret, from, `platforms.yaml の ${platform.name}.auth.token.secret`);
  }
  for (const { name, server, from } of sources.mcp) {
    if (host.mcp.includes(name)) continue;
    const [key, values] = "command" in server ? ["env", server.env] : ["headers", server.headers];
    for (const [field, value] of Object.entries(values)) {
      if (typeof value !== "string")
        add(value.secret, from, `mcp.yaml の servers.${name}.${key}.${field}`);
    }
  }
  return uniqueUses(uses);
}
