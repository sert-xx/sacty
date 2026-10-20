import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  code,
  type DaemonText,
  DEFAULT_AUDIT_BUDGET_USD,
  DEFAULT_BUDGET_USD,
  issueMessage,
  message,
  PricePerMTok,
  parseRepoUrl,
  StepKey,
} from "@sacty/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type AgentTier, parseTierId, type TierRuntime } from "./agents/tier-names.js";
import { DEFAULT_HOST_ADDRESS, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./gateway.js";
import { HostMcpFile, type HostMcpSpec, toHostMcp } from "./host-mcp.js";
import { type Platform, PlatformFile, toPlatform } from "./platforms.js";
import {
  DEFAULT_AGENT_TIMEOUT_MINUTES,
  DEFAULT_TEST_TIMEOUT_MINUTES,
  RUN_TIMEOUT_MAX_MINUTES,
  RUN_TIMEOUT_MIN_MINUTES,
  RUN_TIMEOUT_ROLES,
  type RunTimeouts,
} from "./run-timeouts.js";
import { SecretRef } from "./secrets.js";

export const DEFAULT_IMAGE = "sacty-agent:1.3.0";

/** 秘密情報：キーチェーンの名前か、1Password の参照（op://…。PBI-34）。 */
const SecretName = SecretRef;

/**
 * 中身をすべてコメントにした項目（YAML では null）は、書いていないのと同じにする（PBI-134。providers・agents の下を
 * コメントにしただけで誤りにならないように）。
 */
function nullAsMissing<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema);
}

/** Claude Code・Codex に共通の認証（providers の auth に書く。PBI-134 で agents から移した）。 */
const SubscriptionAuth = z.object({
  mode: z.literal("subscription"),
  /** Claude Code：`claude setup-token` で作ったトークンの秘密情報名。 */
  secret: SecretName.optional(),
  /** Codex：ChatGPTでログインした認証ファイルのパス（既定 ~/.codex/auth.json）。 */
  auth_file: z.string().optional(),
});
const ApiKeyAuth = z.object({ mode: z.literal("api-key"), secret: SecretName });
const BedrockAuth = z.object({
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
});

const ProviderAuth = z.discriminatedUnion("mode", [
  SubscriptionAuth,
  ApiKeyAuth,
  BedrockAuth,
  /**
   * OpenAI 互換（Responses API）の接続先（PBI-40）。組織の AI gateway など。Codex の model_providers の base_url・
   * env_key と同じく、base_url に API キーを Bearer で付けて送る。Codex だけ。
   */
  z.object({
    mode: z.literal("openai-compatible"),
    base_url: z.url({ protocol: /^https?$/, message: code("input.invalidUrl") }),
    /** API キー（秘密情報の名前か 1Password の参照）。認証が要らなければ書かない。 */
    secret: SecretName.optional(),
  }),
]);

/** 100万トークンあたりの米ドル。 */
const PriceFile = z.object({
  input: z.number().nonnegative(),
  cached_input: z.number().nonnegative(),
  cache_write: z.number().nonnegative().default(0),
  output: z.number().nonnegative(),
});

/** runtime ごとの接続先（providers.codex・providers.claude。PBI-134）。 */
const ProviderFile = z.object({
  auth: ProviderAuth,
  /**
   * AI の呼び出しを、ホストのゲートウェイ経由にする（PBI-37）。ゲートウェイが API キーを持ち、レート制限（429）や
   * 一時的な失敗をリトライする。API キーはコンテナに渡さない。Codex の bedrock・openai-compatible だけ。
   */
  via_gateway: z.boolean().default(false),
  /** 使えるモデルと、その単価。ここに無いモデルのエージェントは使えない（単価が分からないため）。 */
  available_models: nullAsMissing(z.record(z.string().min(1), PriceFile).default({})),
});

/** providers の名前（runtime ごとに1つ。PBI-134）。 */
export type ProviderKey = "codex" | "claude";
const PROVIDER_KEYS: readonly ProviderKey[] = ["codex", "claude"];

/** runtime の接続先の名前（stub は接続先を使わない）。 */
export function providerKeyOf(runtime: AgentConfig["runtime"]): ProviderKey | undefined {
  return runtime === "codex" ? "codex" : runtime === "claude-code" ? "claude" : undefined;
}

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
      '```json\n{"sacty-deployment": {"ci": {"result": "unknown", "reason": "スタブのため確かめません"}, "deployment": {"result": "unknown", "reason": "スタブのため確かめません"}, "summary": "スタブのため確かめません", "evidence": []}}\n```',
    ),
  /** ゴールガーディアンとして、PR の指摘の戻し先を判断したときの出力（PBI-14b）。 */
  rework: z
    .string()
    .default(
      '```json\n{"sacty-rework": {"target": "undecidable", "reason": "スタブのため判断しません"}}\n```',
    ),
  /** 完了したタスクの大まかな監査の出力（PBI-125）。既定は、懸念のある工程が無い。 */
  audit: z
    .string()
    .default(
      '```json\n{"sacty-audit-survey": {"summary": "スタブのため監査しません", "concerns": []}}\n```',
    ),
  /** 完了したタスクの、懸念のある工程の深掘りの出力（PBI-125）。既定は、原因が無い。 */
  audit_dive: z
    .string()
    .default(
      '```json\n{"sacty-audit-findings": {"summary": "スタブのため深掘りしません", "findings": []}}\n```',
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

/**
 * エージェントの定義（config/agents.yaml の既定と、config.yaml の agents の上書き。PBI-134）。認証・接続先・単価は
 * providers に書くので、ここには書けない（今までの書き方は誤りにして、直し方を示す）。
 */
const AgentFile = z
  .looseObject({
    /** 既定にある名前を上書きするときは省ける。 */
    runtime: z.enum(["claude-code", "codex", "stub"]).optional(),
    model: z.string().min(1).optional(),
    /** リーズニングエフォート（PBI-40）。書かなければ、エージェントの既定。 */
    reasoning_effort: ReasoningEffort.optional(),
    stub: StubBehavior.optional(),
    /** runtime: stub だけ（接続先が無いので、単価をここに書く。書かなければ 0）。 */
    price_per_mtok_usd: PriceFile.optional(),
  })
  .superRefine((agent, ctx) => {
    for (const key of LEGACY_AGENT_KEYS) {
      if (Object.hasOwn(agent, key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: code("config.agentLegacyKey"),
          params: { key },
        });
      }
    }
  });

/** 今までエージェントに書いていた、認証・接続先の項目（PBI-134 で providers に移した）。 */
const LEGACY_AGENT_KEYS = ["auth", "provider", "via_gateway"] as const;

type AgentFileT = z.output<typeof AgentFile>;

/** リポジトリの config/agents.yaml（sacty が推奨するエージェントの既定。PBI-134）。 */
const DefaultsFile = z.object({
  /** 工程を動かす AI の既定。上から順に、使えるものを選ぶ。 */
  default_agent: z.array(z.string().min(1)).min(1),
  agents: z.record(
    z.string().min(1),
    AgentFile.refine((agent) => agent.runtime !== undefined, { path: ["runtime"] }),
  ),
});

/** リポジトリの config/agents.yaml の場所（src・dist のどちらからも、リポジトリの直下の config）。 */
export const DEFAULT_AGENTS_PATH = fileURLToPath(
  new URL("../../../config/agents.yaml", import.meta.url),
);

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

const ConfigFile = z.object({
  image: z.string().default(DEFAULT_IMAGE),
  /**
   * runtime ごとの接続先（認証・ゲートウェイ・使えるモデルと単価。PBI-134）。名前は codex・claude だけ（今までの、
   * 名前を付けた接続先は誤りにして、直し方を示す）。
   */
  providers: nullAsMissing(
    z
      .looseObject({ codex: ProviderFile.optional(), claude: ProviderFile.optional() })
      .superRefine((providers, ctx) => {
        for (const name of Object.keys(providers)) {
          if (!(PROVIDER_KEYS as readonly string[]).includes(name)) {
            ctx.addIssue({
              code: "custom",
              path: [name],
              message: code("config.providerLegacyName"),
              params: { name },
            });
          }
        }
        for (const key of PROVIDER_KEYS) {
          const provider = providers[key];
          if (provider) refineProvider(key, provider, ctx);
        }
      })
      .prefault({}),
  ),
  /** 書かなければ、config/agents.yaml の default_agent（上から順に、使えるもの）。 */
  default_agent: z.string().optional(),
  /**
   * 工程とオーケストレーターごとに使う AI（PBI-40）。書かなければ default_agent（統合レビューは guardian_agent）。
   */
  step_agents: z
    .partialRecord(z.enum([...StepKey.options, "orchestrator"]), z.string())
    .default({}),
  /** ゴールガーディアンに使うAI。省略すると default_agent。 */
  guardian_agent: z.string().optional(),
  /** 完了したタスクの監査に使うAI（PBI-125）。省略すると guardian_agent（それも無ければ default_agent）。 */
  audit_agent: z.string().optional(),
  budget: z
    .object({
      default_per_task_usd: z.number().positive().default(DEFAULT_BUDGET_USD),
      /** 1回の監査の予算の既定の上限（PBI-124）。タスクの予算とは別に持つ。 */
      default_per_audit_usd: z.number().positive().default(DEFAULT_AUDIT_BUDGET_USD),
    })
    .prefault({}),
  /**
   * 名前は空にできない（タスクの詳細で選んだ名前を作業履歴に残すため。PR #131 再レビュー指摘）。default_agent などは、
   * agents の名前で書くので、空の名前は agents に無い名前として誤りになる。
   */
  agents: nullAsMissing(
    z
      .record(z.string(), AgentFile)
      .superRefine((agents, ctx) => {
        if (Object.hasOwn(agents, "")) {
          ctx.addIssue({ code: "custom", path: [""], message: code("config.agentNameEmpty") });
        }
      })
      .default({}),
  ),
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
          .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+:@~=-]*$/, code("config.imagePackage")))
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
        .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, code("input.platformName")), PlatformFile)
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
  /**
   * sacty の最新版を確かめる（PBI-135）。false なら GitHub に問い合わせない（インターネットに出られない環境など）。
   */
  update_check: z.boolean().default(true),
  /**
   * エージェントの実行とテストの実行の上限（分。PBI-150）。roles で役割（工程・guardian・orchestrator など）ごとに上書きする。
   * 範囲は 1〜720 分の整数。
   */
  run_timeout: z
    .object({
      agent_minutes: z
        .number()
        .int()
        .min(RUN_TIMEOUT_MIN_MINUTES)
        .max(RUN_TIMEOUT_MAX_MINUTES)
        .default(DEFAULT_AGENT_TIMEOUT_MINUTES),
      test_minutes: z
        .number()
        .int()
        .min(RUN_TIMEOUT_MIN_MINUTES)
        .max(RUN_TIMEOUT_MAX_MINUTES)
        .default(DEFAULT_TEST_TIMEOUT_MINUTES),
      roles: z
        .partialRecord(
          z.enum(RUN_TIMEOUT_ROLES),
          z.number().int().min(RUN_TIMEOUT_MIN_MINUTES).max(RUN_TIMEOUT_MAX_MINUTES),
        )
        .default({}),
    })
    .prefault({}),
  /** 画面（PBI-133）。 */
  web: z
    .object({
      /**
       * 画面の認証（PBI-129）。false にすると、`sacty up` が表示する入り口の URL を開かなくても使える。工程のコンテナから
       * 画面を通して承認・設定の変更をできてしまうので、既定は true。
       */
      auth: z.boolean().default(true),
    })
    .prefault({}),
});

/** 接続先の認証・ゲートウェイを、runtime に合うか確かめる（PBI-134 で、エージェントから接続先に移した）。 */
function refineProvider(
  key: ProviderKey,
  provider: z.output<typeof ProviderFile>,
  ctx: z.RefinementCtx,
): void {
  const runtime = key === "codex" ? "codex" : "claude-code";
  const supported =
    key === "codex"
      ? ["subscription", "api-key", "bedrock", "openai-compatible"]
      : ["subscription", "api-key", "bedrock"];
  const auth = provider.auth;
  if (!supported.includes(auth.mode)) {
    ctx.addIssue({
      code: "custom",
      path: [key, "auth", "mode"],
      message: code("config.authUnsupported"),
      params: { runtime, mode: auth.mode, supported: supported.join(", ") },
    });
  }
  if (key === "claude" && auth.mode === "bedrock" && auth.endpoint !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: [key, "auth", "endpoint"],
      message: code("config.bedrockEndpointCodexOnly"),
    });
  }
  if (key === "claude" && auth.mode === "subscription" && !auth.secret) {
    ctx.addIssue({
      code: "custom",
      path: [key, "auth", "secret"],
      message: code("config.subscriptionSecret"),
    });
  }
  if (
    provider.via_gateway &&
    !(key === "codex" && (auth.mode === "bedrock" || auth.mode === "openai-compatible"))
  ) {
    ctx.addIssue({
      code: "custom",
      path: [key, "via_gateway"],
      message: code("config.gatewayUnsupported"),
    });
  }
}

export {
  AGENT_TIERS,
  type AgentTier,
  parseTierId,
  TIER_PREFIX,
  type TierRuntime,
  tierFilePath,
} from "./agents/tier-names.js";

/**
 * エージェントの認証（実行のときの形）。providers の auth から作る（openai-compatible は provider にして、接続先を endpoint に
 * 置く。PBI-134）。stub は接続先を使わない。
 */
export type AgentAuth =
  | z.output<typeof SubscriptionAuth>
  | z.output<typeof ApiKeyAuth>
  | z.output<typeof BedrockAuth>
  | { mode: "stub" }
  | { mode: "provider"; provider: string };

export type AgentConfig = {
  id: string;
  runtime: "claude-code" | "codex" | "stub";
  model?: string;
  reasoning_effort?: string;
  auth: AgentAuth;
  stub?: z.output<typeof StubBehavior>;
  /** ゲートウェイ経由（Codex × Bedrock のとき。openai-compatible は endpoint.viaGateway。PBI-37）。 */
  via_gateway: boolean;
  price: PricePerMTok;
  /** OpenAI 互換の接続先（auth.mode が provider のとき。PBI-40）。 */
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
/**
 * 工程に使う AI（PBI-121）。人がタスクの詳細で選んだエージェントがあればそれ（config.yaml の step_agents より優先）、無ければ
 * agentFor。選んだ名前が agents から消えていれば missing（黙って既定に戻さない）。
 */
export function stepAgentFor(
  config: SactyConfig,
  step: AgentRoleKey,
  chosen: string | undefined,
): { ok: true; agent: AgentConfig } | { ok: false; missing: string } {
  if (chosen === undefined) return { ok: true, agent: agentFor(config, step) };
  const agent = definedAgent(config, chosen);
  return agent ? { ok: true, agent } : { ok: false, missing: chosen };
}

/**
 * config.yaml の agents に、その名前そのもので書いたエージェント（PBI-121）。継承したプロパティの名前（constructor・
 * __proto__・toString など）はエージェントとしない（PR #131 レビュー指摘）。
 */
export function definedAgent(config: SactyConfig, name: string): AgentConfig | undefined {
  const agents = config.agents;
  return agents && Object.hasOwn(agents, name) ? agents[name] : undefined;
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
  /** 完了したタスクの監査に使うAI（PBI-125。audit_agent・guardian_agent・default_agent の順）。 */
  auditAgent: AgentConfig;
  /** 工程・オーケストレーターごとに使う AI（書いてある役割だけ。PBI-40）。 */
  stepAgents?: Partial<Record<AgentRoleKey, AgentConfig>>;
  /** agents のすべて（名前ごと。タスクの詳細で工程のエージェントを選ぶのに使う。PBI-121）。 */
  agents?: Record<string, AgentConfig>;
  /**
   * 使えないエージェントの警告（接続先・単価が無い。PBI-134）。使えないエージェントは agents・tierAgents に入れない。
   */
  agentWarnings?: DaemonText[];
  /** 段階のエージェント（runtime ごと・段階ごと。使える段階だけ。PBI-119）。 */
  tierAgents?: Partial<Record<TierRuntime, Partial<Record<AgentTier, AgentConfig>>>>;
  budgetPerTaskUsd: number;
  /** 1回の監査の予算の既定の上限（PBI-124）。 */
  budgetPerAuditUsd: number;
  /** ゲートウェイの AI の呼び出しのリトライの上限（PBI-37）。 */
  gatewayRetry: RetryPolicy;
  /** コンテナから見たホストのアドレス（host.docker.internal の向き先。PBI-40）。 */
  hostAddress: string;
  /** 画面の認証（PBI-129）。false なら OFF（PBI-133）。 */
  webAuth: boolean;
  /** sacty の最新版を確かめるか（PBI-135）。 */
  updateCheck: boolean;
  /** エージェントの実行とテストの実行の上限（分。PBI-150）。 */
  runTimeouts: RunTimeouts;
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

type ConfigProblem = { ok: false; problem: DaemonText };

function invalid(path: string, detail: DaemonText): ConfigProblem {
  return { ok: false, problem: message("config.invalid", { path, detail }) };
}

type DefaultsFileT = z.output<typeof DefaultsFile>;

/** リポジトリの config/agents.yaml を読む（PBI-134）。読めなければ、画面に出せる理由。 */
function loadDefaults(path: string): { ok: true; defaults: DefaultsFileT } | ConfigProblem {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      problem: message("config.defaultsUnreadable", { path, detail: (error as Error).message }),
    };
  }
  const parsed = DefaultsFile.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      problem: message("config.defaultsUnreadable", {
        path,
        detail: first ? `${first.path.join(".")}: ${first.message}` : "",
      }),
    };
  }
  return { ok: true, defaults: parsed.data };
}

function toPrice(price: z.output<typeof PriceFile> | undefined): PricePerMTok {
  return PricePerMTok.parse({
    input: price?.input ?? 0,
    cachedInput: price?.cached_input ?? 0,
    cacheWrite: price?.cache_write ?? 0,
    output: price?.output ?? 0,
  });
}

/** 接続先から、エージェントの認証・ゲートウェイ・OpenAI 互換の接続先を作る（PBI-134）。 */
function connectionOf(
  key: ProviderKey,
  provider: z.output<typeof ProviderFile>,
): Pick<AgentConfig, "auth" | "via_gateway" | "endpoint"> {
  const auth = provider.auth;
  if (auth.mode === "openai-compatible") {
    return {
      auth: { mode: "provider", provider: key },
      via_gateway: false,
      endpoint: {
        name: key,
        baseUrl: auth.base_url.replace(/\/+$/, ""),
        ...(auth.secret ? { secret: auth.secret } : {}),
        viaGateway: provider.via_gateway,
      },
    };
  }
  return { auth, via_gateway: provider.via_gateway };
}

/**
 * 既定（config/agents.yaml）に config.yaml の agents を項目ごとに重ね、接続先と単価を付ける（PBI-134）。接続先が無い、
 * または単価（available_models）が無いエージェントは使えない扱い（unusable）にして、警告にする。誤りにはしない
 * （sacty の更新で既定のモデルが変わっても、設定が読めなくならないように）。接続先が無い runtime の既定のエージェントは、
 * その runtime を使っていないだけなので警告しない。
 */
function buildAgents(
  file: z.output<typeof ConfigFile>,
  defaults: DefaultsFileT,
):
  | {
      ok: true;
      agents: Record<string, AgentConfig>;
      /** 使えないエージェントと、その理由（工程の AI などに指定したときの誤りに載せる。PR #146 レビュー提案）。 */
      unusable: Map<string, DaemonText>;
      warnings: DaemonText[];
    }
  | ConfigProblem {
  type Merged = AgentFileT & { runtime: AgentConfig["runtime"] };
  const merged = new Map<string, { agent: Merged; written: boolean }>();
  for (const [id, agent] of Object.entries(defaults.agents)) {
    merged.set(id, { agent: agent as Merged, written: false });
  }
  for (const [id, agent] of Object.entries(file.agents)) {
    const base = Object.hasOwn(defaults.agents, id) ? defaults.agents[id] : undefined;
    const runtime = agent.runtime ?? base?.runtime;
    if (!runtime) return invalid(`agents.${id}.runtime`, message("config.agentRuntimeRequired"));
    const written = Object.fromEntries(Object.entries(agent).filter(([, v]) => v !== undefined));
    merged.set(id, { agent: { ...base, ...written, runtime } as Merged, written: true });
  }
  const agents: Record<string, AgentConfig> = {};
  const unusable = new Map<string, DaemonText>();
  const warnings: DaemonText[] = [];
  const unpriced = new Map<string, { provider: ProviderKey; model: string; ids: string[] }>();
  for (const [id, { agent, written }] of merged) {
    // 段階のエージェント（PBI-119）は、名前の接頭辞と runtime を合わせる
    const tier = parseTierId(id);
    if (tier && agent.runtime !== tier.runtime) {
      return invalid(
        `agents.${id}.runtime`,
        message("config.tierRuntime", { id, runtime: agent.runtime, expected: tier.runtime }),
      );
    }
    const common = {
      id,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoning_effort ? { reasoning_effort: agent.reasoning_effort } : {}),
    };
    if (agent.runtime === "stub") {
      agents[id] = {
        ...common,
        runtime: "stub",
        auth: { mode: "stub" },
        ...(agent.stub ? { stub: agent.stub } : {}),
        via_gateway: false,
        price: toPrice(agent.price_per_mtok_usd),
      };
      continue;
    }
    if (agent.price_per_mtok_usd) {
      return invalid(
        `agents.${id}.price_per_mtok_usd`,
        message("config.agentLegacyKey", { key: "price_per_mtok_usd" }),
      );
    }
    if (!agent.model) return invalid(`agents.${id}.model`, message("config.agentModelRequired"));
    const key = providerKeyOf(agent.runtime) as ProviderKey;
    const provider = file.providers[key];
    if (!provider) {
      const reason = message("config.agentProviderMissing", { id, provider: key });
      unusable.set(id, reason);
      if (written) warnings.push(reason);
      continue;
    }
    const price = Object.hasOwn(provider.available_models, agent.model)
      ? provider.available_models[agent.model]
      : undefined;
    if (!price) {
      unusable.set(
        id,
        message("config.modelPriceMissing", { provider: key, model: agent.model, agents: id }),
      );
      const group = `${key}\n${agent.model}`;
      const entry = unpriced.get(group) ?? { provider: key, model: agent.model, ids: [] };
      entry.ids.push(id);
      unpriced.set(group, entry);
      continue;
    }
    agents[id] = {
      ...common,
      runtime: agent.runtime,
      ...connectionOf(key, provider),
      price: toPrice(price),
    };
  }
  for (const { provider, model, ids } of unpriced.values()) {
    warnings.push(message("config.modelPriceMissing", { provider, model, agents: ids.join(", ") }));
  }
  return { ok: true, agents, unusable, warnings };
}

/**
 * sactyの設定を読む。読めない場合は、画面に出せる理由を返す。エージェントは、リポジトリの config/agents.yaml の既定に
 * config.yaml の agents を重ねる（PBI-134）。
 */
export function loadConfig(home: string, defaultsPath: string = DEFAULT_AGENTS_PATH): ConfigResult {
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
  // 「PR作成」の工程（pr）は無くした（PBI-110）。知らない工程の誤りではなく、消すよう案内する
  const stepAgents = (raw as { step_agents?: unknown } | null)?.step_agents;
  if (stepAgents && typeof stepAgents === "object" && Object.hasOwn(stepAgents, "pr")) {
    return { ok: false, problem: message("config.stepAgentsPrRemoved") };
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
  const defaults = loadDefaults(defaultsPath);
  if (!defaults.ok) return defaults;
  const built = buildAgents(file, defaults.defaults);
  if (!built.ok) return built;
  const { agents, unusable } = built;
  const pick = (key: string, id: string): AgentConfig | ConfigProblem => {
    if (Object.hasOwn(agents, id)) return agents[id] as AgentConfig;
    // 使えない理由（足すべき単価・接続先）も載せる。設定が誤りのときは画面の警告を出さないため（PR #146 レビュー提案）
    const reason = unusable.get(id);
    return invalid(
      key,
      reason
        ? message("config.agentUnavailable", { key, id, reason })
        : message("config.agentMissing", { key, id }),
    );
  };
  const isProblem = (x: AgentConfig | ConfigProblem): x is ConfigProblem => "problem" in x;
  let defaultAgent: AgentConfig | ConfigProblem;
  if (file.default_agent !== undefined) {
    defaultAgent = pick("default_agent", file.default_agent);
  } else {
    // 書いていなければ、既定の候補のうち使える最初のもの（providers.claude だけのときは claude_standard など）
    const first = defaults.defaults.default_agent.find((id) => Object.hasOwn(agents, id));
    defaultAgent = first
      ? (agents[first] as AgentConfig)
      : { ok: false, problem: message("config.noDefaultAgent") };
  }
  if (isProblem(defaultAgent)) return defaultAgent;
  const guardianAgent =
    file.guardian_agent !== undefined ? pick("guardian_agent", file.guardian_agent) : defaultAgent;
  if (isProblem(guardianAgent)) return guardianAgent;
  const auditAgent =
    file.audit_agent !== undefined ? pick("audit_agent", file.audit_agent) : guardianAgent;
  if (isProblem(auditAgent)) return auditAgent;
  const roleAgents: Partial<Record<AgentRoleKey, AgentConfig>> = {};
  for (const [role, id] of Object.entries(file.step_agents)) {
    if (!id) continue;
    const agent = pick(`step_agents.${role}`, id);
    if (isProblem(agent)) return agent;
    roleAgents[role as AgentRoleKey] = agent;
  }
  return {
    ok: true,
    config: {
      image: file.image,
      budgetPerTaskUsd: file.budget.default_per_task_usd,
      budgetPerAuditUsd: file.budget.default_per_audit_usd,
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
      webAuth: file.web.auth,
      updateCheck: file.update_check,
      runTimeouts: {
        agentMinutes: file.run_timeout.agent_minutes,
        testMinutes: file.run_timeout.test_minutes,
        roles: file.run_timeout.roles,
      },
      gatewayRetry: {
        maxAttempts: file.gateway.retry.max_attempts,
        maxWaitMs: file.gateway.retry.max_wait_sec * 1000,
      },
      defaultAgent,
      guardianAgent,
      auditAgent,
      stepAgents: roleAgents,
      agents,
      agentWarnings: built.warnings,
      tierAgents: tierAgentsOf(agents),
    },
  };
}

/** 使えるエージェントから、段階のエージェントを runtime ごと・段階ごとに集める（PBI-119）。 */
function tierAgentsOf(agents: Record<string, AgentConfig>): SactyConfig["tierAgents"] {
  const tiers: NonNullable<SactyConfig["tierAgents"]> = {};
  for (const [id, agent] of Object.entries(agents)) {
    const parsed = parseTierId(id);
    if (!parsed) continue;
    const ofRuntime = tiers[parsed.runtime] ?? {};
    ofRuntime[parsed.tier] = agent;
    tiers[parsed.runtime] = ofRuntime;
  }
  return tiers;
}

/** runtime の段階のエージェント（書いてある段階だけ。PBI-119）。 */
export function tierAgentsFor(
  config: SactyConfig,
  runtime: TierRuntime,
): Partial<Record<AgentTier, AgentConfig>> {
  return config.tierAgents?.[runtime] ?? {};
}

/** `sacty config init` が書き出す雛形。 */
export const CONFIG_TEMPLATE = `# sacty の設定
# 単価（available_models）は100万トークンあたりの米ドル。利用するモデルの最新の単価に合わせてください。
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

# 工程を動かす AI のモデルは、sacty が推奨する既定（sacty のリポジトリの config/agents.yaml）を使う。
# ここには、runtime ごとの接続先（認証）と、使えるモデルの単価（available_models）だけを書けばよい。
# 既定のエージェントのモデルが available_models に無いと、そのエージェントは使えない（画面に警告が出る）。
# sacty を更新して既定のモデルが変わったら、警告に出たモデルの単価を足す
providers:
  # Codex（OpenAI）。auth の mode は subscription（ChatGPT でログイン）・api-key・bedrock・openai-compatible
  codex:
    auth:
      mode: api-key
      secret: openai-api-key   # 値は sacty secret set openai-api-key で保存する
    available_models:   # 単価は例。契約の単価に合わせる
      gpt-6-luna: { input: 0.25, cached_input: 0.025, output: 2 }
      gpt-6.1-sol: { input: 1.25, cached_input: 0.125, output: 10 }
    # ChatGPT のサブスクリプション（~/.codex/auth.json を使う）
    # auth: { mode: subscription }
    # 組織の AI gateway など、OpenAI 互換（Responses API）の接続先
    # auth:
    #   mode: openai-compatible
    #   base_url: https://ai-gateway.example.com/v1
    #   secret: op://Work/AI-Gateway/api-key
    # Amazon Bedrock の OpenAI のモデル（APIキー）。endpoint は runtime（リージョンをまたぐ推論。モデルは推論プロファイルID）か
    # mantle（リージョン内の推論。モデルIDは openai. で始まる）。モデル名が変わるので、agents で model を上書きする
    # auth: { mode: bedrock, secret: bedrock-api-key, region: us-east-2, endpoint: runtime }
    # bedrock・openai-compatible では、ホストのゲートウェイ経由にすると、API キーをコンテナに渡さず、レート制限（429）をリトライする
    # via_gateway: true

  # Claude Code。auth の mode は subscription・api-key・bedrock
  # サブスクリプション：\`claude setup-token\` で作ったトークンを \`sacty secret set claude-oauth-token\` で保存する
  # claude:
  #   auth:
  #     mode: subscription
  #     secret: claude-oauth-token
  #   available_models:
  #     claude-haiku-5-5: { input: 1, cached_input: 0.1, cache_write: 1.25, output: 5 }
  #     claude-sonnet-5-5: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }
  #     claude-opus-5-5: { input: 15, cached_input: 1.5, cache_write: 18.75, output: 75 }
  #   # Amazon Bedrock（APIキー）
  #   # auth: { mode: bedrock, secret: bedrock-api-key, region: us-east-1 }

# 工程を動かす AI（書かなければ codex_standard。providers.codex が無ければ claude_standard）
# default_agent: codex_standard
# ゴールガーディアン（変更の申し出の判定）に使うAI。省略すると default_agent
# guardian_agent: codex_advanced
# 完了したタスクの監査に使う AI（書かなければ guardian_agent。無ければ default_agent）
# audit_agent: codex_advanced
# 工程・オーケストレーターごとに使う AI（書かなければ default_agent。統合レビューは guardian_agent）
# step_agents:
#   orchestrator: codex_lite
#   requirements: codex_advanced
#   design: codex_advanced
#   implement: codex_standard
#   deployment: codex_lite   # マージの後の監視の工程の確認（deployment-observer のスキル）

# エージェントの上書き（任意）。sacty の既定（codex_lite〜codex_ultimate・claude_lite〜claude_ultimate）を、
# 同じ名前で項目ごとに上書きする。新しい名前で足すこともできる（runtime・model を書く）。
# 認証・接続先・単価は書けない（providers に書く）。段階（lite など）は、工程の実行でサブエージェントとして置く
# agents:
#   codex_ultimate:
#     reasoning_effort: xhigh
#   claude_lite:
#     model: claude-haiku-5-5
#   # 動作確認用のスタブ（実際のAIは呼ばない。接続先が無いので単価をここに書ける）
#   stub:
#     runtime: stub
#     price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }

budget:
  default_per_task_usd: ${DEFAULT_BUDGET_USD}
  # 完了したタスクの監査の、1回あたりの上限（タスクの予算とは別）
  default_per_audit_usd: ${DEFAULT_AUDIT_BUDGET_USD}

# タスクの対象リポジトリ（URL・ベースブランチ・テストのコマンド・PR を作るか）は、
# 画面のプロジェクトの設定で登録する

# 画面。auth: false にすると、\`sacty up\` が表示する入り口の URL を開かなくても画面を使える（既定は true）。
# ただし、工程のコンテナで動くコード（対象リポジトリのテスト・プロンプトインジェクション）が、画面を通して承認や
# 設定の変更をできるようになる。信頼できるリポジトリだけを扱う環境で使う
# web:
#   auth: false

# sacty の最新版（GitHub の sacty のリポジトリの main）を1日ごとに確かめ、新しい版があれば画面に出す（既定は true）。
# インターネットに出られない環境では false にする（GitHub に問い合わせない）
# update_check: false

# エージェントの1回の実行とテストのコマンドの上限（分。1〜720）。過ぎるとコンテナを止め、タスクを一時停止する。
# roles で役割ごとに上書きする（工程の名前のほか guardian・final-review・rework・orchestrator・chat・export・audit・audit-dive）
# run_timeout:
#   agent_minutes: 30   # 既定 30
#   test_minutes: 20    # 既定 20
#   roles:
#     implement: 90
#     guardian: 45

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
#       tool_timeout_sec: 900    # エージェントがツールの呼び出しを待つ上限（任意。実行全体の上限（run_timeout。既定 30 分）より短くする）
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
`;
