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

export const DEFAULT_IMAGE = "sacty-agent:0.1.0";

const SecretName = z.string().regex(/^[A-Za-z0-9._-]+$/, code("input.secretName"));

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
]);

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
  .object({
    runtime: z.enum(["claude-code", "codex", "stub"]),
    model: z.string().min(1).optional(),
    auth: Auth,
    price_per_mtok_usd: z.object({
      input: z.number().nonnegative(),
      cached_input: z.number().nonnegative(),
      cache_write: z.number().nonnegative().default(0),
      output: z.number().nonnegative(),
    }),
    stub: StubBehavior.optional(),
  })
  .superRefine((agent, ctx) => {
    const ok: Record<typeof agent.runtime, string[]> = {
      "claude-code": ["subscription", "api-key", "bedrock"],
      codex: ["subscription", "api-key", "bedrock"],
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
    default_agent: z.string(),
    /** ゴールガーディアンに使うAI。省略すると default_agent。 */
    guardian_agent: z.string().optional(),
    budget: z
      .object({ default_per_task_usd: z.number().positive().default(DEFAULT_BUDGET_USD) })
      .prefault({}),
    agents: z.record(z.string(), Agent),
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
  });

export type AgentConfig = z.infer<typeof Agent> & { id: string; price: PricePerMTok };
export type SactyConfig = {
  image: string;
  defaultAgent: AgentConfig;
  /** ゴールガーディアンに使うAI。 */
  guardianAgent: AgentConfig;
  budgetPerTaskUsd: number;
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
    return {
      ...agent,
      id,
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
      defaultAgent: resolve(file.default_agent),
      guardianAgent: resolve(file.guardian_agent ?? file.default_agent),
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

image: ${DEFAULT_IMAGE}
default_agent: claude-subscription
# ゴールガーディアン（変更の申し出の判定）に使うAI。省略すると default_agent
# guardian_agent: claude-subscription

budget:
  default_per_task_usd: ${DEFAULT_BUDGET_USD}

# タスクの対象リポジトリ（URL・ベースブランチ・テストのコマンド・PR を作るか）は、
# 画面のプロジェクトの設定で登録する

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
  #   price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }

  # 動作確認用のスタブ（実際のAIは呼ばない）
  stub:
    runtime: stub
    auth:
      mode: stub
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }
`;
