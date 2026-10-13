import type { Project } from "@sacty/core";
import type { AgentConfig, SactyConfig } from "./config.js";
import { GATEWAY_TOKEN_SECRET } from "./context.js";

/** 秘密情報の参照と、どこに書いたか（取り出せなかったときに示す。値は持たない。PBI-48）。 */
export type SecretUse = { ref: string; where: string };

/**
 * sacty の実行で使う秘密情報の参照を、設定とプロジェクトから集める（sacty up の起動時にまとめて取り出すため。
 * PBI-48）。使うエージェント（既定・ゴールガーディアン・工程ごと）の認証と接続先の API キー、組織内 PF の認証、
 * ホストで動かす MCP サーバーの環境変数、プロジェクトの通知先。イメージの作成だけで使う npm のトークンと、
 * gh から取る GitHub のトークン、コンテキストリポジトリの mcp.yaml（取得しないと分からない）は含めない。
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
  for (const project of projects) {
    const notification = project.notification;
    if (notification?.kind === "slack-api") {
      add(notification.token, `プロジェクト「${project.name}」の通知先（Slack のトークン）`);
    }
    if (notification?.kind === "slack-webhook") {
      add(notification.webhook, `プロジェクト「${project.name}」の通知先（Webhook の URL）`);
    }
  }
  // 同じ参照は1つにまとめる（書いた場所は最初のもの）
  const seen = new Set<string>();
  return uses.filter((use) => !seen.has(use.ref) && seen.add(use.ref));
}
