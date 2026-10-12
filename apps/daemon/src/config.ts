import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  code,
  type DaemonText,
  DEFAULT_BUDGET_USD,
  issueMessage,
  message,
  PricePerMTok,
  StepKey,
} from "@sacty/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./gateway.js";
import { HostMcpFile, type HostMcpSpec, toHostMcp } from "./host-mcp.js";
import { type Platform, PlatformFile, toPlatform } from "./platforms.js";
import { SecretRef } from "./secrets.js";

export const DEFAULT_IMAGE = "sacty-agent:0.1.0";

/** 秘密情報：キーチェーンの名前か、1Password の参照（op://…。PBI-34）。 */
const SecretName = SecretRef;

const Auth = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("subscription"),
    /** Claude Code：`claude setup-token` で作ったトークンの秘密情報名。 */
    secret: SecretName.optional(),
    /** Codex：ChatGPTでログインした認証ファイルのパス（既定 ~/.codex/auth.json）。 */
    auth_file: z.string().optional(),
  }),
  z.object({ mode: z.literal("api-key"), secret: SecretName }),
  z.object({
    mode: z.literal("bedrock"),
    /** BedrockのAPIキー（AWS_BEARER_TOKEN_BEDROCK）の秘密情報名。 */
    secret: SecretName,
    region: z.string().min(1),
    /**
     * Codex の接続先（PBI-32）。runtime：Bedrock Runtime（リージョンをまたぐ推論。モデルは推論プロファイル ID、
     * 例 global.openai.gpt-6-sol）、mantle：Bedrock Mantle（リージョン内の推論。モデルは例 openai.gpt-6-sol）。
     * 省略すると runtime。Claude Code では使わない。
     */
    endpoint: z.enum(["runtime", "mantle"]).optional(),
  }),
  z.object({ mode: z.literal("stub") }),
  /**
   * config.yaml の providers の接続先（PBI-40）。エージェントには provider: <名前> と書けばよい（この形に直す）。
   */
  z.object({ mode: z.literal("provider"), provider: z.string().min(1) }),
]);

/**
 * OpenAI 互換（Responses API）の接続先（PBI-40）。社内の AI gateway など。Codex の model_providers の base_url・
 * env_key と同じく、base_url に API キーを Bearer で付けて送る。
 */
const Provider = z.object({
  base_url: z.url({ protocol: /^https?$/, message: code("input.invalidUrl") }),
  /** API キー（秘密情報の名前か 1Password の参照）。認証が要らなければ書かない。 */
  secret: SecretName.optional(),
  /** sacty のゲートウェイ経由にする（429 のリトライ。API キーをコンテナに渡さない。PBI-37）。 */
  via_gateway: z.boolean().default(false),
});

/** リーズニングエフォート（Codex の model_reasoning_effort・Claude Code の --effort。PBI-40）。 */
const ReasoningEffort = z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/, code("input.reasoningEffort"));

const StubBehavior = z.object({
  output: z.string().default("# 要求要件（スタブ）\n\n- これはスタブのエージェントの出力です。"),
  /** 工程ごとの出力。無い工程は output を使う。 */
  outputs: z.partialRecord(StepKey, z.string()).default({}),
  /** ゴールガーディアンとして最終レビューをしたときの出力。 */
  final_review: z
    .string()
    .default(
      '```json\n{"sacty-final-review": {"viewpoints": [], "remarks": [], "summary": "スタブのため判定しません"}}\n```',
    ),
  /** オーケストレーターとして、工程を選んだときの出力（PBI-17）。 */
  orchestrator: z
    .string()
    .default(
      '```json\n{"sacty-steps": {"plan": "standard", "reason": "スタブのため標準の工程"}}\n```',
    ),
  /** ゴールガーディアンとして、PR の指摘の戻し先を判断したときの出力（PBI-14b）。 */
  rework: z
    .string()
    .default(
      '```json\n{"sacty-rework": {"target": "undecidable", "reason": "スタブのため判断しません"}}\n```',
    ),
  /** ゴールガーディアンとして呼ばれたときの出力。 */
  guardian: z
    .string()
    .default(
      '```json\n{"sacty-verdict": {"verdict": "undecidable", "reason": "スタブのため判定しません"}}\n```',
    ),
  usage: z
    .object({
      input: z.number().int().nonnegative().default(1000),
      cache_read: z.number().int().nonnegative().default(0),
      cache_write: z.number().int().nonnegative().default(0),
      output: z.number().int().nonnegative().default(500),
    })
    .prefault({}),
  /** 失敗を再現したいときに指定する。 */
  fail: z.enum(["usage_limit", "auth"]).optional(),
});

const Agent = z
  .preprocess(
    // provider: <名前> だけを書いたエージェントは、その接続先を使う
    (v) =>
      v && typeof v === "object" && "provider" in v && !("auth" in v)
        ? { ...v, auth: { mode: "provider", provider: (v as { provider: unknown }).provider } }
        : v,
    z.object({
      runtime: z.enum(["claude-code", "codex", "stub"]),
      model: z.string().min(1).optional(),
      /** リーズニングエフォート（PBI-40）。書かなければ、エージェントの既定。 */
      reasoning_effort: ReasoningEffort.optional(),
      auth: Auth,
      /** auth の代わりに書く、providers の接続先の名前（PBI-40）。 */
      provider: z.string().optional(),
      price_per_mtok_usd: z.object({
        input: z.number().nonnegative(),
        cached_input: z.number().nonnegative(),
        cache_write: z.number().nonnegative().default(0),
        output: z.number().nonnegative(),
      }),
      stub: StubBehavior.optional(),
      /**
       * AI の呼び出しを、ホストのゲートウェイ経由にする（PBI-37）。ゲートウェイが API キーを持ち、レート制限（429）や
       * 一時的な失敗をリトライする。API キーはコンテナに渡さない。いまは Codex × Bedrock だけ。
       */
      via_gateway: z.boolean().default(false),
    }),
  )
  .superRefine((agent, ctx) => {
    if (agent.via_gateway && !(agent.runtime === "codex" && agent.auth.mode === "bedrock")) {
      ctx.addIssue({
        code: "custom",
        path: ["via_gateway"],
        message: code("config.gatewayCodexBedrockOnly"),
      });
    }
    const ok: Record<typeof agent.runtime, string[]> = {
      "claude-code": ["subscription", "api-key", "bedrock"],
      codex: ["subscription", "api-key", "bedrock", "provider"],
      stub: ["stub"],
    };
    if (!ok[agent.runtime].includes(agent.auth.mode)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "mode"],
        message: code("config.authUnsupported"),
        params: {
          runtime: agent.runtime,
          mode: agent.auth.mode,
          supported: ok[agent.runtime].join(", "),
        },
      });
    }
    if (
      agent.runtime === "claude-code" &&
      agent.auth.mode === "bedrock" &&
      agent.auth.endpoint !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "endpoint"],
        message: code("config.bedrockEndpointCodexOnly"),
      });
    }
    if (
      agent.runtime === "claude-code" &&
      agent.auth.mode === "subscription" &&
      !agent.auth.secret
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "secret"],
        message: code("config.subscriptionSecret"),
      });
    }
  });

/** GitHub のリポジトリの URL から owner/name を求める。 */
export function githubRepoOf(url: string): string | undefined {
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

const ConfigFile = z
  .object({
    image: z.string().default(DEFAULT_IMAGE),
    /** OpenAI 互換の接続先（社内の AI gateway など。PBI-40）。 */
    providers: z
      .record(z.string().regex(/^[A-Za-z0-9_-]+$/, code("input.providerName")), Provider)
      .default({}),
    default_agent: z.string(),
    /**
     * 工程とオーケストレーターごとに使う AI（PBI-40）。書かなければ default_agent（統合レビューは guardian_agent）。
     */
    step_agents: z
      .partialRecord(z.enum([...StepKey.options, "orchestrator"]), z.string())
      .default({}),
    /** ゴールガーディアンに使うAI。省略すると default_agent。 */
    guardian_agent: z.string().optional(),
    budget: z
      .object({ default_per_task_usd: z.number().positive().default(DEFAULT_BUDGET_USD) })
      .prefault({}),
    agents: z.record(z.string(), Agent),
    /**
     * `sacty image build` でイメージを作るときの元（PBI-33）。プライベートのレジストリしか使えない環境向け。
     * 書かなければ、Docker Hub の node のイメージと、npm の公開レジストリから作る。
     */
    image_build: z
      .object({
        /** 元のイメージ（FROM）。Node.js 22 で、node ユーザーがあること。 */
        base_image: z.string().trim().min(1).optional(),
        /** Claude Code・Codex を入れる npm のレジストリ。 */
        npm_registry: z.url({ protocol: /^https?$/ }).optional(),
        /** npm のレジストリの認証トークンの秘密情報名（イメージには残さない）。 */
        npm_token: SecretName.optional(),
      })
      .optional(),
    /** 1Password（PBI-34）。複数のアカウントにサインインしているときは、使うアカウントを書く。 */
    onepassword: z.object({ account: z.string().trim().min(1).optional() }).optional(),
    /** ホストのゲートウェイ（PBI-37）。 */
    gateway: z
      .object({
        /** AI の呼び出しのリトライの上限。 */
        retry: z
          .object({
            /** 1件のリクエストで、上流に送る回数の上限（最初の1回を含む）。 */
            max_attempts: z.number().int().min(1).max(50).default(DEFAULT_RETRY_POLICY.maxAttempts),
            /** 一続きの失敗で待つ合計の上限（秒）。 */
            max_wait_sec: z
              .number()
              .int()
              .min(0)
              .max(86_400)
              .default(DEFAULT_RETRY_POLICY.maxWaitMs / 1000),
          })
          .prefault({}),
        /**
         * 社内 PF の API（PBI-35）。名前ごとに、転送先・認証・使える API を書く。エージェントは
         * $SACTY_PF_URL/<名前>/… で呼び、ゲートウェイが認証を付けて転送する。
         */
        platforms: z
          .record(
            z.string().regex(/^[a-z0-9][a-z0-9-]*$/, code("input.platformName")),
            PlatformFile,
          )
          .default({}),
        /**
         * ホストで動かす MCP サーバー（PBI-36）。起動時にブラウザで認証する手元のコマンドの MCP サーバーを、
         * ゲートウェイが起動して持ち続け、工程エージェントには HTTP の MCP として渡す。
         */
        mcp_servers: z
          .record(z.string().regex(/^[A-Za-z0-9_-]+$/, code("input.mcpName")), HostMcpFile)
          .default({}),
      })
      .prefault({}),
    /** GitHub Issue の取り込み（個人の設定。プロジェクトの定義には含めない）。 */
    github: z
      .object({
        /** 取り込みの間隔（秒）。 */
        poll_interval_sec: z.number().int().min(60).default(300),
      })
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.agents[config.default_agent]) {
      ctx.addIssue({
        code: "custom",
        path: ["default_agent"],
        message: code("config.agentMissing"),
        params: { key: "default_agent", id: config.default_agent },
      });
    }
    if (config.guardian_agent && !config.agents[config.guardian_agent]) {
      ctx.addIssue({
        code: "custom",
        path: ["guardian_agent"],
        message: code("config.agentMissing"),
        params: { key: "guardian_agent", id: config.guardian_agent },
      });
    }
    for (const [role, id] of Object.entries(config.step_agents)) {
      if (id && !config.agents[id]) {
        ctx.addIssue({
          code: "custom",
          path: ["step_agents", role],
          message: code("config.agentMissing"),
          params: { key: `step_agents.${role}`, id },
        });
      }
    }
    for (const [id, agent] of Object.entries(config.agents)) {
      if (agent.auth.mode === "provider" && !config.providers[agent.auth.provider]) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", id, "provider"],
          message: code("config.providerMissing"),
          params: { id: agent.auth.provider },
        });
      }
    }
  });

export type AgentConfig = z.infer<typeof Agent> & {
  id: string;
  price: PricePerMTok;
  /** providers の接続先（auth.mode が provider のとき。PBI-40）。 */
  endpoint?: { name: string; baseUrl: string; secret?: string; viaGateway: boolean };
};

/** 工程・オーケストレーターの役割（step_agents のキー。PBI-40）。 */
export type AgentRoleKey = StepKey | "orchestrator";

/**
 * 役割に使う AI（PBI-40）。step_agents に書いてあればそれ、無ければ default_agent。統合レビューはゴールガーディアンが
 * 行うので、書いてなければ guardian_agent。
 */
export function agentFor(config: SactyConfig, role: AgentRoleKey): AgentConfig {
  return (
    config.stepAgents?.[role] ?? (role === "integrate" ? config.guardianAgent : config.defaultAgent)
  );
}
export type SactyConfig = {
  image: string;
  defaultAgent: AgentConfig;
  /** ゴールガーディアンに使うAI。 */
  guardianAgent: AgentConfig;
  /** 工程・オーケストレーターごとに使う AI（書いてある役割だけ。PBI-40）。 */
  stepAgents?: Partial<Record<AgentRoleKey, AgentConfig>>;
  budgetPerTaskUsd: number;
  /** ゲートウェイの AI の呼び出しのリトライの上限（PBI-37）。 */
  gatewayRetry: RetryPolicy;
  /** 社内 PF の API（PBI-35）。 */
  platforms: Platform[];
  /** ホストで動かす MCP サーバー（PBI-36）。 */
  hostMcp: HostMcpSpec[];
  /** 1Password のアカウント（PBI-34）。 */
  onePasswordAccount?: string;
  /** `sacty image build` の元（PBI-33）。 */
  imageBuild: { baseImage?: string; npmRegistry?: string; npmToken?: string };
  /** GitHub Issue の取り込み。認証はプロジェクトの gh のアカウント（PBI-13）。 */
  github?: { pollIntervalSec: number };
};

/** 設定。読めなければ、その理由（文言のコードと引数。PBI-11）。 */
export type ConfigResult = { ok: true; config: SactyConfig } | { ok: false; problem: DaemonText };

/** sactyのデータ（作業履歴・設定・作業領域）を置く場所。環境変数 SACTY_HOME で変えられる。 */
export function resolveHome(): string {
  return process.env.SACTY_HOME ?? join(homedir(), ".sacty");
}

export function configPath(home: string): string {
  return join(home, "config.yaml");
}

/** sactyの設定を読む。読めない場合は、画面に出せる理由を返す。 */
export function loadConfig(home: string): ConfigResult {
  const path = configPath(home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      ok: false,
      problem: message("config.missing", { path }),
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      problem: message("config.unreadable", { detail: (error as Error).message }),
    };
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      problem: message("config.invalid", {
        path: first?.path.join(".") ?? "",
        detail: first ? issueMessage(first) : "",
      }),
    };
  }
  const file = parsed.data;
  const resolve = (id: string): AgentConfig => {
    const agent = file.agents[id];
    if (!agent) throw new Error("unreachable: agent ids are validated");
    const provider =
      agent.auth.mode === "provider" ? file.providers[agent.auth.provider] : undefined;
    return {
      ...agent,
      id,
      ...(agent.auth.mode === "provider" && provider
        ? {
            endpoint: {
              name: agent.auth.provider,
              baseUrl: provider.base_url.replace(/\/+$/, ""),
              ...(provider.secret ? { secret: provider.secret } : {}),
              viaGateway: provider.via_gateway,
            },
          }
        : {}),
      price: PricePerMTok.parse({
        input: agent.price_per_mtok_usd.input,
        cachedInput: agent.price_per_mtok_usd.cached_input,
        cacheWrite: agent.price_per_mtok_usd.cache_write,
        output: agent.price_per_mtok_usd.output,
      }),
    };
  };
  return {
    ok: true,
    config: {
      image: file.image,
      budgetPerTaskUsd: file.budget.default_per_task_usd,
      ...(file.onepassword?.account ? { onePasswordAccount: file.onepassword.account } : {}),
      imageBuild: {
        ...(file.image_build?.base_image ? { baseImage: file.image_build.base_image } : {}),
        ...(file.image_build?.npm_registry ? { npmRegistry: file.image_build.npm_registry } : {}),
        ...(file.image_build?.npm_token ? { npmToken: file.image_build.npm_token } : {}),
      },
      platforms: Object.entries(file.gateway.platforms).map(([name, p]) => toPlatform(name, p)),
      hostMcp: Object.entries(file.gateway.mcp_servers).map(([name, m]) => toHostMcp(name, m)),
      gatewayRetry: {
        maxAttempts: file.gateway.retry.max_attempts,
        maxWaitMs: file.gateway.retry.max_wait_sec * 1000,
      },
      defaultAgent: resolve(file.default_agent),
      guardianAgent: resolve(file.guardian_agent ?? file.default_agent),
      stepAgents: Object.fromEntries(
        Object.entries(file.step_agents).flatMap(([role, id]) => (id ? [[role, resolve(id)]] : [])),
      ),
      ...(file.github
        ? {
            github: { pollIntervalSec: file.github.poll_interval_sec },
          }
        : {}),
    },
  };
}

/** `sacty config init` が書き出す雛形。 */
export const CONFIG_TEMPLATE = `# sacty の設定
# 単価（price_per_mtok_usd）は100万トークンあたりの米ドル。利用するモデルの最新の単価に合わせてください。
# 秘密情報（secret）には名前だけを書き、値は \`sacty secret set <名前>\` でキーチェーンに保存します。
# 1Password に保存した秘密情報は、名前の代わりに参照（op://保管庫/アイテム/フィールド）を書きます（op CLI で取り出す）。
# 複数の 1Password のアカウントにサインインしているときは、使うアカウントを書きます
# onepassword:
#   account: my-company.1password.com

image: ${DEFAULT_IMAGE}
# \`sacty image build\` でイメージを作るときの元。プライベートのレジストリしか使えない環境では、元のイメージと
# npm のレジストリを書く（書かなければ、Docker Hub の node のイメージと npm の公開レジストリ）。
# 元のイメージは Node.js 22 で、node ユーザーがあること。git が入っていれば、Debian のミラーに届かなくても作れる
# image_build:
#   base_image: registry.example.com/library/node:22-bookworm-slim
#   npm_registry: https://npm.example.com/repository/npm/
#   npm_token: npm-token   # 認証が要るとき。値は sacty secret set npm-token で保存する
default_agent: claude-subscription
# ゴールガーディアン（変更の申し出の判定）に使うAI。省略すると default_agent
# guardian_agent: claude-subscription
# 工程・オーケストレーターごとに使う AI（書かなければ default_agent。統合レビューは guardian_agent）
# step_agents:
#   orchestrator: luna-low
#   requirements: sol-high
#   design: sol-high
#   implement: sol-medium

# OpenAI 互換（Responses API）の接続先。社内の AI gateway など（Codex の model_providers の base_url・env_key と同じ）。
# Codex のエージェントは provider: <名前> で使う。via_gateway: true なら、sacty のゲートウェイが API キーを付けて中継し、
# レート制限（429）をリトライする（API キーはコンテナに渡さない）
# providers:
#   corp-gw:
#     base_url: https://ai-gateway.example.com/v1
#     secret: op://Work/AI-Gateway/api-key
#     via_gateway: true

budget:
  default_per_task_usd: ${DEFAULT_BUDGET_USD}

# タスクの対象リポジトリ（URL・ベースブランチ・テストのコマンド・PR を作るか）は、
# 画面のプロジェクトの設定で登録する

# ホストのゲートウェイ（via_gateway: true のエージェントの AI の呼び出しを中継する）。
# レート制限（429）や一時的な失敗（5xx）は、Retry-After（無ければ1秒から倍にしていく間隔）で待ってリトライする
# gateway:
#   retry:
#     max_attempts: 8     # 1件のリクエストで上流に送る回数の上限
#     max_wait_sec: 600   # 成功するまでの一続きの失敗で待つ合計の上限
#   # ホストで動かす MCP サーバー。起動時にブラウザで認証（Okta など）する手元のコマンドの MCP サーバーを、
#   # ゲートウェイが起動して持ち続け、工程エージェントには HTTP の MCP として渡す（認証情報は渡さない）。
#   # 認証には期限があるので、restart_every_min ごとに起動し直して再認証する（期限より短くする）。
#   # プロセスが終わった・ツールが認証エラーを返したときも、起動し直す
#   mcp_servers:
#     private-cloud:
#       command: npx
#       args: ["-y", "@example/private-cloud-mcp"]
#       env: { CLOUD_REGION: ap-northeast-1 }
#       restart_every_min: 240
#       ready_timeout_sec: 300   # 起動してから認証が済むまで待つ上限
#   # 社内 PF の API。エージェントは $SACTY_PF_URL/<名前>/… で呼び、ゲートウェイが認証を付けて転送する
#   # （認証情報はエージェントに渡さない）。allow に無い API は拒否する（* は1階層、** はそれ以下すべて）
#   platforms:
#     ticket:
#       upstream: https://ticket.internal.example.com
#       description: 社内のチケット管理
#       auth:                         # 固定のキーをヘッダーに付ける（独自のヘッダーも書ける）
#         header: X-Internal-Token
#         secret: op://Work/Ticket/token
#       allow:
#         - GET /api/v1/tickets/**
#         - POST /api/v1/tickets/*/comments
#     deploy:
#       upstream: https://deploy.internal.example.com
#       auth:                         # API キーで JWT を取得して付ける（期限の前に取り直す）
#         header: Authorization
#         prefix: "Bearer "
#         token:
#           url: https://auth.internal.example.com/api/token
#           json: { apiKey: "{{secret}}" }
#           secret: op://Work/Deploy/api-key
#           token_path: data.accessToken
#           expires_in_path: data.expiresIn
#       allow:
#         - GET /api/v1/deployments/**

# GitHub Issue の取り込み（取り込み元と、使う gh のアカウントはプロジェクトの設定で登録する）。
# Issue から作ったタスクは、その Issue のリポジトリに実装する（設定はプロジェクトのリポジトリの設定）
# github:
#   poll_interval_sec: 300

agents:
  # サブスクリプション：\`claude setup-token\` で作ったトークンを
  # \`sacty secret set claude-oauth-token\` で保存する
  claude-subscription:
    runtime: claude-code
    auth:
      mode: subscription
      secret: claude-oauth-token
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }

  # Amazon Bedrock（APIキー）。モデルは推論プロファイルIDで指定する
  # claude-bedrock:
  #   runtime: claude-code
  #   model: us.anthropic.claude-sonnet-4-6
  #   auth:
  #     mode: bedrock
  #     secret: bedrock-api-key
  #     region: us-east-1
  #   price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }

  # providers の接続先を使う Codex のエージェント。モデル・リーズニングエフォート・単価の組ごとに書く
  # sol-high:
  #   runtime: codex
  #   provider: corp-gw
  #   model: gpt-6-sol
  #   reasoning_effort: high     # Codex は model_reasoning_effort、Claude Code は --effort
  #   price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }

  # Codex × Amazon Bedrock の OpenAI のモデル（APIキー）。endpoint は runtime（リージョンをまたぐ推論。
  # モデルは推論プロファイルID）か mantle（リージョン内の推論。モデルIDは openai. で始まる）。
  # 単価は契約の単価に合わせてください（費用は、この単価とトークン数から計算します）
  # codex-bedrock:
  #   runtime: codex
  #   model: global.openai.gpt-6-sol
  #   auth:
  #     mode: bedrock
  #     secret: bedrock-api-key
  #     region: us-east-2
  #     endpoint: runtime
  #   # ホストのゲートウェイ経由にすると、API キーをコンテナに渡さず、レート制限（429）をリトライする
  #   via_gateway: true
  #   price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }

  # 動作確認用のスタブ（実際のAIは呼ばない）
  stub:
    runtime: stub
    auth:
      mode: stub
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }
`;
