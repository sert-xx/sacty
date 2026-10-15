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
  parseRepoUrl,
  StepKey,
} from "@sacty/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_HOST_ADDRESS, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./gateway.js";
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
 * OpenAI 互換（Responses API）の接続先（PBI-40）。組織の AI gateway など。Codex の model_providers の base_url・
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
  /** オーケストレーターとして、タスクの詳細での質問に答えたときの出力（PBI-54）。 */
  chat: z.string().default("スタブのため、質問には答えません。"),
  /** 承認した成果を書き出したときの出力（PBI-56）。 */
  export: z
    .string()
    .default('```json\n{"sacty-export": {"error": "スタブのため書き出しません"}}\n```'),
  /** マージの後に、デプロイ後のアプリを確かめたときの出力（PBI-89）。 */
  deployment: z
    .string()
    .default(
      '```json\n{"sacty-deployment": {"result": "unknown", "summary": "スタブのため確かめません", "evidence": []}}\n```',
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

/** git の URL（HTTPS か SSH）から、GitHub のリポジトリの URL（https://<ホスト>/<owner>/<name>）を求める。 */
export function githubRepoOf(url: string): string | undefined {
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  return parseRepoUrl(ssh ? `https://${ssh[1]}/${ssh[2]}` : url)?.url;
}

/** npm の設定のうち、認証の項目（イメージに残すと漏れるので、npm_config には書けない。PBI-40）。 */
const NPM_SECRET_KEY =
  /(?:^|:)(?:_auth|_authToken|_password|username|email|certfile|keyfile)$|^(?:cert|key)$/i;

/** 認証の値と思われる環境変数の名前（images の env には書けない。PBI-41）。 */
const IMAGE_ENV_SECRET_NAME = /TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTH|API_?KEY|PRIVATE_KEY/i;

/**
 * images の env に書けない名前（PBI-41）。docker のコマンド自体や、sacty がエージェントに渡す設定とぶつかるため。
 */
const IMAGE_ENV_RESERVED =
  /^(?:PATH|HOME|USER|SHELL|TMPDIR|NODE_OPTIONS|(?:DOCKER|SACTY|CODEX|CLAUDE|ANTHROPIC|OPENAI|NPM_CONFIG)_\w*)$/;

/** ユーザー名・パスワードを含む URL か（https://user:pass@host のような値）。 */
function hasUserInfo(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value);
}

const ConfigFile = z
  .object({
    image: z.string().default(DEFAULT_IMAGE),
    /** OpenAI 互換の接続先（組織の AI gateway など。PBI-40）。 */
    providers: z
      .record(z.string().regex(/^[A-Za-z0-9_-]+$/, code("input.providerName")), Provider)
      .default({}),
    default_agent: z.string(),
    /**
     * 工程とオーケストレーターごとに使う AI（PBI-40）。書かなければ default_agent（統合レビューは guardian_agent）。
     */
    step_agents: z
      .partialRecord(z.enum([...StepKey.options, "orchestrator", "deployment"]), z.string())
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
        /** 元のイメージ（FROM）。Node.js 18 以上で、node ユーザーがあること。 */
        base_image: z.string().trim().min(1).optional(),
        /** イメージに入れる npm の版（例 11。min-release-age などは npm 11 から。PBI-40）。書かなければ元のイメージの npm。 */
        npm_version: z
          .union([z.string(), z.number()])
          .transform(String)
          .pipe(z.string().regex(/^(?:latest|\d+(?:\.\d+){0,2})$/, code("config.npmVersion")))
          .optional(),
        /**
         * イメージの中の npm 全体の設定（global の npmrc。PBI-40）。コンテナの中のすべての npm に効く
         * （例 replace-registry-host: always、audit: false）。認証の項目はイメージに残るので書けない。
         */
        npm_config: z
          .record(
            z.string(),
            z
              .union([z.string(), z.number(), z.boolean()])
              .transform(String)
              .pipe(z.string().regex(/^[^\r\n]*$/, code("config.npmConfigKey"))),
          )
          // 認証の項目かを先に見る（レジストリに結びつけた //host/:_authToken なども拒否する）
          .superRefine((config, ctx) => {
            for (const key of Object.keys(config)) {
              if (NPM_SECRET_KEY.test(key)) {
                ctx.addIssue({
                  code: "custom",
                  path: [key],
                  message: code("config.npmConfigSecret"),
                });
              } else if (!/^(?:\/\/)?[@A-Za-z0-9][@A-Za-z0-9/:._-]*$/.test(key)) {
                ctx.addIssue({ code: "custom", path: [key], message: code("config.npmConfigKey") });
              }
            }
          })
          .optional(),
        /**
         * npm のレジストリ。Claude Code・Codex を入れるときに使い、コンテナの中の npm の registry にもする
         * （npm_config の registry があれば、そちらを優先。PBI-40）。
         */
        npm_registry: z.url({ protocol: /^https?$/ }).optional(),
        /** npm のレジストリの認証トークンの秘密情報名。イメージを作るときだけ使う（イメージには残さない）。 */
        npm_token: SecretName.optional(),
      })
      .optional(),
    /**
     * 言語ごとのイメージ（PBI-41）。名前ごとに、元のイメージ（言語のツールの入った CI のイメージなど）と、
     * オーケストレーターに見せる説明を書く。sacty が Node.js とエージェントの CLI を足して作る（npm の設定は
     * image_build のものを使う）。工程ごとに、オーケストレーターが説明を見て選ぶ（プロジェクトの対象で指定もできる）。
     */
    images: z
      .record(
        z.string(),
        z.object({
          /** オーケストレーターに見せる説明（例 Java 17・Maven・Gradle）。 */
          description: z.string().trim().min(1).max(200),
          /** 元のイメージ（FROM）。Debian・Ubuntu 系か RHEL 系（Rocky Linux など）。 */
          base_image: z.string().trim().min(1),
          /** 作るイメージの名前。書かなければ sacty-agent-<名前>:<版>。 */
          image: z.string().trim().min(1).optional(),
          /**
           * Node.js を写す元のイメージ（元のイメージに Node.js 18 以上と npm が無いとき）。書かなければ image_build.base_image、
           * それも無ければ node:22-bookworm-slim。
           */
          node_image: z.string().trim().min(1).optional(),
          /**
           * コンテナの中の環境変数（言語ごとのレジストリなど。例 PIP_INDEX_URL・GOPROXY・GONOSUMDB）。
           * エージェントの実行とテストの実行の両方に渡す。認証の値は書けない（コンテナの中のすべてのコマンドに見えるため）。
           */
          env: z
            .record(z.string(), z.string().regex(/^[^\r\n]*$/, code("config.imageEnvName")))
            // 名前の形も、record 全体で確かめる（名前の検査は、項目ごとの文言にならないため）
            .superRefine((env, ctx) => {
              for (const [key, value] of Object.entries(env)) {
                if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
                  ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: code("config.imageEnvName"),
                  });
                } else if (IMAGE_ENV_SECRET_NAME.test(key) || hasUserInfo(value)) {
                  ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: code("config.imageEnvSecret"),
                  });
                } else if (IMAGE_ENV_RESERVED.test(key)) {
                  ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: code("config.imageEnvReserved"),
                  });
                }
              }
            })
            .default({}),
          /**
           * Maven・Gradle の取得先にするリポジトリ（組織のミラー）。Maven は settings.xml の mirror、Gradle は
           * init スクリプトで、すべての Maven のリポジトリをこの URL に向ける。認証の情報は書けない。
           */
          /**
           * イメージを作るときに root で入れる OS のパッケージ（PBI-50）。dnf・microdnf・yum・apt-get のうち、元のイメージに
           * あるもので入れる（組織の rpm リポジトリなど、パッケージのリポジトリの設定は元のイメージか run で行う。無効にして
           * あるリポジトリは enable_repos で有効にする）。
           */
          packages: z
            .array(
              z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+:@~=-]*$/, code("config.imagePackage")),
            )
            .default([]),
          /**
           * packages を入れるときに有効にするパッケージのリポジトリの ID（PBI-59）。元のイメージに設定があるが無効にしてある
           * リポジトリ（組織の rpm リポジトリなど）を、dnf・microdnf・yum の --enablerepo で有効にする（apt-get では使えない）。
           * Dockerfile の RUN にそのまま展開するので、シェルの特別な文字を含まない形に限る。
           */
          enable_repos: z
            .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, code("config.imageRepo")))
            .default([]),
          /**
           * イメージを作るときに root で実行するシェルのコマンド（PBI-50。CLI の導入、Playwright の OS のライブラリなど）。
           * 上から順に実行し、失敗したら止める。イメージに残るので、秘密情報は書かない。
           */
          run: z
            .array(
              z
                .string()
                .min(1)
                .regex(/^[^\r\n]*$/, code("config.imageRun")),
            )
            .default([]),
          maven_mirror: z
            .url({ protocol: /^https?$/ })
            // XML（settings.xml）と Gradle の文字列に埋め込むので、引用符などの記号を含む URL は受け付けない
            .refine(
              (url) => !hasUserInfo(url) && /^[^\s'"<>&\\$`]+$/.test(url),
              code("config.mavenMirror"),
            )
            .optional(),
        }),
      )
      // 名前の形は record 全体で確かめる（名前の検査は、項目ごとの文言にならないため）
      .superRefine((images, ctx) => {
        for (const [name, image] of Object.entries(images)) {
          if (!/^(?!default$)[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
            ctx.addIssue({ code: "custom", path: [name], message: code("config.imageName") });
          }
          // enable_repos は packages を入れるときだけ効く（packages が無ければ、書いても何も起きないため。PBI-59）
          if (image.enable_repos.length > 0 && image.packages.length === 0) {
            ctx.addIssue({
              code: "custom",
              path: [name, "enable_repos"],
              message: code("config.imageRepoPackages"),
            });
          }
        }
      })
      .default({}),
    /** 1Password（PBI-34）。複数のアカウントにサインインしているときは、使うアカウントを書く。 */
    onepassword: z.object({ account: z.string().trim().min(1).optional() }).optional(),
    /** ホストのゲートウェイ（PBI-37）。 */
    gateway: z
      .object({
        /**
         * コンテナから見たホストのアドレス（PBI-40）。既定は host-gateway（Docker Desktop）。Rancher Desktop など、
         * 仮想マシンの中の Docker では、ホストに届くアドレス（Rancher Desktop は 192.168.5.2）を書く。
         */
        host_address: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9.:-]+$/, code("config.hostAddress"))
          .default(DEFAULT_HOST_ADDRESS),
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
         * 組織内 PF の API（PBI-35）。名前ごとに、転送先・認証・使える API を書く。エージェントは
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
export type AgentRoleKey = StepKey | "orchestrator" | "deployment";

/**
 * 役割に使う AI（PBI-40）。step_agents に書いてあればそれ、無ければ default_agent。統合レビューはゴールガーディアンが
 * 行うので、書いてなければ guardian_agent。
 */
export function agentFor(config: SactyConfig, role: AgentRoleKey): AgentConfig {
  return (
    config.stepAgents?.[role] ?? (role === "integrate" ? config.guardianAgent : config.defaultAgent)
  );
}
/**
 * 作業履歴に記録する、実行に使った AI の設定（接続先・モデル・リーズニングエフォート。PBI-46）。
 * 秘密の値（API キーや接続先の URL）は含めない。
 */
export function agentSetting(agent: AgentConfig) {
  return {
    authMode: agent.auth.mode,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.reasoning_effort ? { reasoningEffort: agent.reasoning_effort } : {}),
  };
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
  /** コンテナから見たホストのアドレス（host.docker.internal の向き先。PBI-40）。 */
  hostAddress: string;
  /** 組織内 PF の API（PBI-35）。 */
  platforms: Platform[];
  /** ホストで動かす MCP サーバー（PBI-36）。 */
  hostMcp: HostMcpSpec[];
  /** 1Password のアカウント（PBI-34）。 */
  onePasswordAccount?: string;
  /** `sacty image build` の元（PBI-33）。 */
  imageBuild: {
    baseImage?: string;
    npmRegistry?: string;
    npmToken?: string;
    /** イメージに入れる npm の版（PBI-40）。 */
    npmVersion?: string;
    /** イメージの中の npm 全体の設定（PBI-40）。 */
    npmConfig?: Record<string, string>;
  };
  /** 言語ごとのイメージ（PBI-41）。名前ごと。無ければ既定のイメージだけ。 */
  images?: Record<string, LanguageImage>;
};

/** 言語ごとのイメージ（PBI-41）。 */
export type LanguageImage = {
  name: string;
  /** 作るイメージの名前（タグ）。 */
  image: string;
  description: string;
  baseImage: string;
  nodeImage?: string;
  /** コンテナの中の環境変数（エージェントの実行とテストの実行の両方に渡す）。 */
  env: Record<string, string>;
  mavenMirror?: string;
  /** イメージを作るときに入れる OS のパッケージと、実行するコマンド（PBI-50）。 */
  packages?: string[];
  /** packages を入れるときに有効にするパッケージのリポジトリの ID（PBI-59）。 */
  enableRepos?: string[];
  run?: string[];
};

/** 既定のイメージの名前（オーケストレーター・プロジェクトの対象で、既定のイメージを指すときに使う。PBI-41）。 */
export const DEFAULT_IMAGE_NAME = "default";

/**
 * イメージの名前（images の名前か default。無ければ既定のイメージ）から、使うイメージと環境変数を決める（PBI-41）。
 * images に無い名前なら、理由を返す（設定から消した・書き間違えたなど）。
 */
export function resolveImage(
  config: SactyConfig,
  name: string | undefined,
): { ok: true; image: string; env: Record<string, string> } | { ok: false; message: DaemonText } {
  if (!name || name === DEFAULT_IMAGE_NAME) return { ok: true, image: config.image, env: {} };
  const image = config.images?.[name];
  if (!image) return { ok: false, message: message("image.unknown", { name }) };
  return { ok: true, image: image.image, env: image.env };
}

/** 言語ごとのイメージの、既定の名前（タグ）。既定のイメージと同じ版にする。 */
export function languageImageTag(name: string): string {
  return `sacty-agent-${name}:${DEFAULT_IMAGE.split(":")[1] ?? "latest"}`;
}

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
        ...(file.image_build?.npm_version ? { npmVersion: file.image_build.npm_version } : {}),
        ...(file.image_build?.npm_config ? { npmConfig: file.image_build.npm_config } : {}),
      },
      images: Object.fromEntries(
        Object.entries(file.images).map(([name, image]) => [
          name,
          {
            name,
            image: image.image ?? languageImageTag(name),
            description: image.description,
            baseImage: image.base_image,
            ...(image.node_image ? { nodeImage: image.node_image } : {}),
            env: image.env,
            ...(image.maven_mirror ? { mavenMirror: image.maven_mirror } : {}),
            packages: image.packages,
            ...(image.enable_repos.length > 0 ? { enableRepos: image.enable_repos } : {}),
            run: image.run,
          },
        ]),
      ),
      platforms: Object.entries(file.gateway.platforms).map(([name, p]) => toPlatform(name, p)),
      hostMcp: Object.entries(file.gateway.mcp_servers).map(([name, m]) => toHostMcp(name, m)),
      hostAddress: file.gateway.host_address,
      gatewayRetry: {
        maxAttempts: file.gateway.retry.max_attempts,
        maxWaitMs: file.gateway.retry.max_wait_sec * 1000,
      },
      defaultAgent: resolve(file.default_agent),
      guardianAgent: resolve(file.guardian_agent ?? file.default_agent),
      stepAgents: Object.fromEntries(
        Object.entries(file.step_agents).flatMap(([role, id]) => (id ? [[role, resolve(id)]] : [])),
      ),
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
# 元のイメージは Node.js 18 以上で、node ユーザーがあること。git が入っていれば、Debian のミラーに届かなくても作れる
# image_build:
#   base_image: registry.example.com/library/node:22-bookworm-slim
#   npm_registry: https://npm.example.com/repository/npm/
#   npm_token: npm-token   # 認証が要るとき。値は sacty secret set npm-token で保存する
#   npm_version: 11        # イメージに入れる npm の版（min-release-age は npm 11 から）
#   # コンテナの中の npm 全体の設定（認証の項目は書けない）
#   npm_config:
#     replace-registry-host: always   # package-lock.json の古い取得元の URL を、いまの registry に置き換える
#     audit: false
#     min-release-age: 7              # 公開から7日たっていない版は入れない
# 言語ごとのイメージ。工程ごとに、オーケストレーターが説明を見て選ぶ（プロジェクトの対象で指定もできる）。
# 元のイメージは、言語のツールが入った Debian・Ubuntu 系か RHEL 系（Rocky Linux など）のイメージ（CI のイメージなど）。
# sacty がエージェントの CLI を足して作る。元のイメージに Node.js 18 以上と npm が無ければ、node_image（無ければ image_build.base_image）から写す。
# env はエージェントとテストのコンテナに渡す（認証の値は書けない）。maven_mirror は Maven・Gradle の取得先を向ける
# images:
#   java17:
#     description: Java 17・Maven・Gradle
#     base_image: registry.example.com/ci/java:17
#     maven_mirror: https://maven.example.com/repository/maven-public/
#   python:
#     description: Python 3.12・pip・uv
#     base_image: registry.example.com/ci/python:3.12
#     env:
#       PIP_INDEX_URL: https://pypi.example.com/simple
#       UV_DEFAULT_INDEX: https://pypi.example.com/simple
#   go:
#     description: Go 1.23
#     base_image: registry.example.com/ci/go:1.23
#     env:
#       GOPROXY: https://goproxy.example.com
#       GONOSUMDB: git.example.com
default_agent: claude-subscription
# ゴールガーディアン（変更の申し出の判定）に使うAI。省略すると default_agent
# guardian_agent: claude-subscription
# 工程・オーケストレーターごとに使う AI（書かなければ default_agent。統合レビューは guardian_agent）
# step_agents:
#   orchestrator: luna-low
#   requirements: sol-high
#   design: sol-high
#   implement: sol-medium
#   deployment: luna-low   # マージの後のデプロイの確認（deployment-observer のスキル）

# OpenAI 互換（Responses API）の接続先。組織の AI gateway など（Codex の model_providers の base_url・env_key と同じ）。
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
#   # コンテナから見たホストのアドレス。既定は host-gateway（Docker Desktop）。
#   # Rancher Desktop では、host-gateway が仮想マシンを指してゲートウェイに届かないので 192.168.5.2 を書く
#   host_address: 192.168.5.2
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
#       tool_timeout_sec: 900    # エージェントがツールの呼び出しを待つ上限（任意。実行全体の上限の30分より短くする）
#   # 組織内 PF の API。エージェントは $SACTY_PF_URL/<名前>/… で呼び、ゲートウェイが認証を付けて転送する
#   # （認証情報はエージェントに渡さない）。allow に無い API は拒否する（* は1階層、** はそれ以下すべて）
#   platforms:
#     ticket:
#       upstream: https://ticket.internal.example.com
#       description: チケット管理
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
