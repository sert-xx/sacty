import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET_USD, PricePerMTok, StepKey } from "@sacty/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_IMAGE = "sacty-agent:0.1.0";

const SecretName = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, "秘密情報の名前は英数字と . _ - だけで書いてください");

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
  }),
  z.object({ mode: z.literal("stub") }),
]);

const StubBehavior = z.object({
  output: z.string().default("# 要求要件（スタブ）\n\n- これはスタブのエージェントの出力です。"),
  /** 工程ごとの出力。無い工程は output を使う。 */
  outputs: z.partialRecord(StepKey, z.string()).default({}),
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
      codex: ["subscription", "api-key"],
      stub: ["stub"],
    };
    if (!ok[agent.runtime].includes(agent.auth.mode)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "mode"],
        message: `${agent.runtime} では ${agent.auth.mode} を使えません（使えるもの：${ok[agent.runtime].join(", ")}）`,
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
        message: "Claude Code のサブスクリプションには、トークンの秘密情報名（secret）が必要です",
      });
    }
  });

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
  })
  .superRefine((config, ctx) => {
    if (!config.agents[config.default_agent]) {
      ctx.addIssue({
        code: "custom",
        path: ["default_agent"],
        message: `default_agent の "${config.default_agent}" が agents にありません`,
      });
    }
    if (config.guardian_agent && !config.agents[config.guardian_agent]) {
      ctx.addIssue({
        code: "custom",
        path: ["guardian_agent"],
        message: `guardian_agent の "${config.guardian_agent}" が agents にありません`,
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
};

export type ConfigResult = { ok: true; config: SactyConfig } | { ok: false; problem: string };

/** sactyのデータ（台帳・設定・作業領域）を置く場所。環境変数 SACTY_HOME で変えられる。 */
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
      problem: `設定ファイルがありません（${path}）。\`sacty config init\` で作成してください。`,
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { ok: false, problem: `設定ファイルのYAMLを読めません：${(error as Error).message}` };
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      problem: `設定ファイルに誤りがあります（${first?.path.join(".")}）：${first?.message}`,
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

  # 動作確認用のスタブ（実際のAIは呼ばない）
  stub:
    runtime: stub
    auth:
      mode: stub
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }
`;
