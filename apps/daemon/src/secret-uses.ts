import type { Project } from "@sacty/core";
import type { AgentConfig, SactyConfig } from "./config.js";
import { GATEWAY_TOKEN_SECRET, type McpServer } from "./context.js";
import type { Platform } from "./platforms.js";

/**
 * 秘密情報の参照と、どこに書いたか（取り出せなかったときに示す。値は持たない。PBI-48）。projectId は、プロジェクトの
 * 設定（通知先・コンテキスト）に書いたもの（保存し直したときに、そのプロジェクトの警告だけを置き換える。PBI-107）。
 */
export type SecretUse = { ref: string; where: string; projectId?: string };

/**
 * sacty の実行で使う秘密情報の参照を、設定とプロジェクトから集める（sacty up の起動時にまとめて取り出すため。
 * PBI-48）。使うエージェント（既定・ゴールガーディアン・工程ごと）の認証と接続先の API キー、組織内 PF の認証、
 * ホストで動かす MCP サーバーの環境変数、プロジェクトの通知先。イメージの作成だけで使う npm のトークンと、
 * gh から取る GitHub のトークン、コンテキストリポジトリの mcp.yaml・platforms.yaml（取得しないと分からない）は含めない。
 */
export function secretUses(config: SactyConfig, projects: readonly Project[]): SecretUse[] {
  const uses: SecretUse[] = [];
  const add = (ref: string | undefined, where: string) => {
    if (ref && ref !== GATEWAY_TOKEN_SECRET) uses.push({ ref, where });
  };
  const agents = new Map<string, AgentConfig>();
  for (const agent of [
    config.defaultAgent,
    config.guardianAgent,
    ...Object.values(config.stepAgents ?? {}),
  ]) {
    if (agent) agents.set(agent.id, agent);
  }
  for (const agent of agents.values()) {
    if ("secret" in agent.auth) add(agent.auth.secret, `agents.${agent.id}.auth.secret`);
    if (agent.endpoint?.secret)
      add(agent.endpoint.secret, `providers.${agent.endpoint.name}.secret`);
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
  for (const project of projects) uses.push(...projectSecretUses(project));
  return uniqueUses(uses);
}

/** プロジェクトの設定（通知先）に書いた秘密情報の参照（PBI-48。保存のときにも使う。PBI-107）。 */
export function projectSecretUses(project: Project): SecretUse[] {
  const notification = project.notification;
  const where =
    notification?.kind === "slack-api"
      ? { ref: notification.token, label: "Slack のトークン" }
      : notification?.kind === "slack-webhook"
        ? { ref: notification.webhook, label: "Webhook の URL" }
        : undefined;
  return where?.ref
    ? [
        {
          ref: where.ref,
          where: `プロジェクト「${project.name}」の通知先（${where.label}）`,
          projectId: project.id,
        },
      ]
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
