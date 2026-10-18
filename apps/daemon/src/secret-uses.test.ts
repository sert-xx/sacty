import { describe, expect, it } from "vitest";
import type { AgentConfig, SactyConfig } from "./config.js";
import { GATEWAY_TOKEN_SECRET, type McpServer } from "./context.js";
import type { Platform } from "./platforms.js";
import { contextSecretUses, secretUses, settingsSecretUses } from "./secret-uses.js";

const agent = (id: string, auth: AgentConfig["auth"], extra: Partial<AgentConfig> = {}) =>
  ({ id, runtime: "codex", auth, ...extra }) as AgentConfig;

const config = (patch: Partial<SactyConfig> = {}): SactyConfig =>
  ({
    image: "x",
    defaultAgent: agent("main", { mode: "subscription", secret: "claude-token" }),
    guardianAgent: agent("main", { mode: "subscription", secret: "claude-token" }),
    budgetPerTaskUsd: 1,
    gatewayRetry: { maxAttempts: 1, maxWaitMs: 0 },
    hostAddress: "host-gateway",
    imageBuild: { npmToken: "npm-token" },
    platforms: [],
    hostMcp: [],
    ...patch,
  }) as SactyConfig;

describe("起動時に取り出す秘密情報の参照（PBI-48）", () => {
  it("使うエージェント・接続先・PF・ホストの MCP・sacty の設定の通知先の参照を、重ねずに集める（PBI-115）", () => {
    const uses = secretUses(
      config({
        guardianAgent: {
          ...agent("guard", { mode: "api-key", secret: "op://Work/Anthropic/key" }),
          runtime: "claude-code",
        },
        stepAgents: {
          implement: agent(
            "gw",
            { mode: "provider", provider: "corp" } as unknown as AgentConfig["auth"],
            {
              endpoint: {
                name: "corp",
                baseUrl: "https://gw",
                secret: "op://Work/GW/key",
                viaGateway: true,
              },
            },
          ),
          design: agent("main", { mode: "subscription", secret: "claude-token" }),
        },
        platforms: [
          {
            name: "ticket",
            upstream: "https://t",
            description: "",
            auth: {
              header: "Authorization",
              prefix: "",
              token: {
                url: "https://t/token",
                method: "POST",
                headers: {},
                secret: "op://Work/Ticket/client",
                tokenPath: "token",
                ttlSec: 60,
              },
            },
            allow: [],
          },
        ],
        hostMcp: [
          {
            name: "docs",
            command: "x",
            args: [],
            env: { PLAIN: "v", TOKEN: { secret: "op://Work/Docs/token", prefix: "" } },
            description: "",
            readyTimeoutSec: 5,
          },
        ],
      }),
      {
        notification: {
          kind: "slack-api",
          url: "https://slack",
          channel: "#c",
          token: "slack-token",
          language: "ja",
        },
      },
    );
    expect(uses).toEqual([
      // 認証・接続先は runtime ごとの providers に書く（PBI-134）
      { ref: "claude-token", where: "providers.codex.auth.secret" },
      { ref: "op://Work/Anthropic/key", where: "providers.claude.auth.secret" },
      { ref: "op://Work/GW/key", where: "providers.corp.auth.secret" },
      { ref: "op://Work/Ticket/client", where: "gateway.platforms.ticket.auth.token.secret" },
      { ref: "op://Work/Docs/token", where: "gateway.mcp_servers.docs.env.TOKEN" },
      { ref: "slack-token", where: "sacty の設定の通知先（Slack のトークン）", settings: true },
    ]);
    // イメージの作成だけで使う npm のトークンは含めない
    expect(uses.some((u) => u.ref === "npm-token")).toBe(false);
  });

  it("秘密情報を使わない設定（stub・ゲートウェイのトークン）では、何も集めない", () => {
    expect(
      secretUses(
        config({
          defaultAgent: agent("stub", { mode: "stub" }),
          guardianAgent: agent("stub", { mode: "stub" }),
          hostMcp: [
            {
              name: "x",
              command: "x",
              args: [],
              env: { T: { secret: GATEWAY_TOKEN_SECRET, prefix: "" } },
              description: "",
              readyTimeoutSec: 5,
            },
          ],
        }),
        {},
      ),
    ).toEqual([]);
  });
});

describe("プロジェクトのコンテキストの秘密情報の参照（PBI-107）", () => {
  const platform = (name: string, auth: Platform["auth"], from = "ctx@c0ffee0"): Platform =>
    ({ name, upstream: "https://pf", description: "", auth, allow: [], from }) as Platform;
  const server = (value: unknown) => value as McpServer;

  it("platforms.yaml の認証と、mcp.yaml の env・headers の参照を、書いた層とともに集める（ホストと同じ名前・ゲートウェイのトークンは除く）", () => {
    const uses = contextSecretUses(
      { id: "p", name: "決済" },
      {
        platforms: [
          platform(
            "docs",
            { header: "Authorization", prefix: "", secret: "op://Work/Docs/key" },
            "base@1111111",
          ),
          platform("sso", {
            header: "Authorization",
            prefix: "",
            token: {
              url: "https://t",
              method: "POST",
              headers: {},
              secret: "op://Work/SSO/client",
              tokenPath: "t",
              ttlSec: 60,
            },
          } as Platform["auth"]),
          platform("jira", { header: "Authorization", prefix: "", secret: "op://Work/Stolen/key" }),
        ],
        mcp: [
          {
            name: "wiki",
            from: "ctx@c0ffee0",
            server: server({
              command: "wiki-mcp",
              args: [],
              env: { TOKEN: { secret: "op://Work/Wiki/token", prefix: "" }, MODE: "ro" },
              via_gateway: true,
            }),
          },
          {
            name: "search",
            from: "base@1111111",
            server: server({
              url: "https://search",
              headers: {
                Authorization: { secret: "op://Work/Docs/key", prefix: "Bearer " },
                "X-Run": { secret: GATEWAY_TOKEN_SECRET, prefix: "" },
              },
              via_gateway: true,
            }),
          },
          {
            name: "private-cloud",
            from: "ctx@c0ffee0",
            server: server({
              url: "https://x",
              headers: { Authorization: { secret: "op://Work/Hidden/key", prefix: "" } },
              via_gateway: true,
            }),
          },
        ],
      },
      { platforms: ["jira"], mcp: ["private-cloud"] },
    );
    expect(uses).toEqual([
      {
        ref: "op://Work/Docs/key",
        where:
          "プロジェクト「決済」のコンテキスト（base@1111111）の platforms.yaml の docs.auth.secret",
        projectId: "p",
      },
      {
        ref: "op://Work/SSO/client",
        where:
          "プロジェクト「決済」のコンテキスト（ctx@c0ffee0）の platforms.yaml の sso.auth.token.secret",
        projectId: "p",
      },
      {
        ref: "op://Work/Wiki/token",
        where:
          "プロジェクト「決済」のコンテキスト（ctx@c0ffee0）の mcp.yaml の servers.wiki.env.TOKEN",
        projectId: "p",
      },
    ]);
  });
});

describe("sacty の設定の通知先の秘密情報（PBI-115）", () => {
  it("Webhook の URL・トークンを sacty の設定から取り、通知先が無い・トークンの無い Proxy なら取らない", () => {
    expect(
      settingsSecretUses({
        notification: { kind: "slack-webhook", webhook: "op://Work/Slack/webhook", language: "ja" },
      }),
    ).toEqual([
      {
        ref: "op://Work/Slack/webhook",
        where: "sacty の設定の通知先（Webhook の URL）",
        settings: true,
      },
    ]);
    expect(settingsSecretUses({})).toEqual([]);
    expect(
      settingsSecretUses({
        notification: {
          kind: "slack-api",
          url: "https://proxy.example.com/api/chat.postMessage",
          channel: "#a",
          language: "ja",
        },
      }),
    ).toEqual([]);
    // 設定ファイルと同じ参照なら、1つにまとめる
    const uses = secretUses(config(), {
      notification: { kind: "slack-webhook", webhook: "claude-token", language: "ja" },
    });
    expect(uses.filter((u) => u.ref === "claude-token")).toHaveLength(1);
  });
});
