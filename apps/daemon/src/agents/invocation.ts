import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { StepKey } from "@sacty/core";
import type { AgentConfig } from "../config.js";
import { CLAUDE_MCP_CONFIG, GATEWAY_TOKEN_SECRET, type PlacedContext } from "../context.js";
import type { SecretStore } from "../secrets.js";
import { secretStringsInJson } from "./redact.js";

/** 何として実行するか。工程か、ゴールガーディアン（変更の申し出の判定・最終レビュー）。 */
export type AgentRole = StepKey | "guardian" | "final-review" | "rework" | "orchestrator";

/** コンテナの中での設定ディレクトリ。毎回空の場所を使い、ホストの設定やメモリーを読ませない。 */
export const CONTAINER_CLAUDE_CONFIG_DIR = "/tmp/sacty-claude-config";
export const CONTAINER_CODEX_HOME = "/tmp/sacty-codex-home";

/** コンテナで実行するコマンドと、コンテナに渡す環境変数・ファイル。 */
export type Invocation = {
  command: string[];
  /** コンテナに渡す環境変数。ここに無いホストの変数は渡さない。 */
  env: Record<string, string>;
  /**
   * 実行ごとの一時ディレクトリにホストのファイルをコピーし、そのディレクトリごとマウントする
   * （Codexの認証ファイルなど）。元のファイルはコンテナから書き換えられない。
   */
  stage?: {
    containerDir: string;
    /** syncBack：コンテナで更新されたら、実行後にホストへ書き戻す（トークンの更新を失わないため）。 */
    files: { hostPath: string; name: string; syncBack: boolean }[];
    /** この中身を、先に一時ディレクトリへ写す（合成したコンテキストなど。PBI-6）。 */
    seedDir?: string;
  };
  parser: "claude-json" | "codex-jsonl";
  /** コンテナから、ホストのゲートウェイ（host.docker.internal）に届くようにする（PBI-37）。 */
  hostGateway?: boolean;
};

function expandHome(path: string): string {
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/**
 * AIの定義と認証方式から、コンテナで実行するコマンドと環境変数を組み立てる。
 * 選んだ認証方式の変数だけを入れる（例：ANTHROPIC_API_KEY が残っていると、
 * Claude Code はサブスクリプションより優先して使い、意図せず従量課金になるため）。
 */
export async function buildInvocation(
  agent: AgentConfig,
  prompt: string,
  store: SecretStore,
  /** 取り出した秘密情報を、その都度知らせる（途中で失敗しても、出力から取り除けるように）。 */
  onSecret: (value: string) => void = () => {},
  /** 実行する工程か、ゴールガーディアン（スタブが出力を選ぶのに使う）。 */
  role?: AgentRole,
  /**
   * エージェントの形式に変換したコンテキスト（PBI-6）。dir は実行ごとの空の設定のディレクトリ
   * （Claude Code は CLAUDE_CONFIG_DIR、Codex は CODEX_HOME）に写して渡す。
   */
  context?: { dir: string } & PlacedContext,
  /**
   * ホストのゲートウェイ（PBI-37）。あれば、AI の呼び出しの向き先をゲートウェイにし、API キーの代わりに
   * 実行ごとのトークンを渡す（API キーはゲートウェイだけが持つ）。
   */
  gateway?: { origin: string; token: string },
): Promise<Invocation> {
  const secrets = {
    get: async (name: string) => {
      const value = await store.get(name);
      onSecret(value);
      return value;
    },
  };
  // MCP サーバーが参照する秘密情報は、値を環境変数でだけ渡す（設定のファイルには名前だけを書いている）
  const contextEnv: Record<string, string> = {};
  if (agent.runtime !== "stub") {
    for (const s of context?.secrets ?? []) {
      // ホストの MCP サーバーの認証は、実行ごとのゲートウェイのトークン（実行するときに sacty が入れる。PBI-36）
      if (s.secret === GATEWAY_TOKEN_SECRET) continue;
      contextEnv[s.env] = `${s.prefix}${await secrets.get(s.secret)}`;
    }
  }
  switch (agent.runtime) {
    case "claude-code": {
      const env: Record<string, string> = {
        ...contextEnv,
        CLAUDE_CONFIG_DIR: CONTAINER_CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      };
      const command = ["claude", "-p", prompt, "--output-format", "json"];
      if (context && context.mcpServers.length > 0) {
        // コンテキストの MCP サーバーだけを使い、そのツールの使用を許可する
        command.push(
          "--mcp-config",
          `${CONTAINER_CLAUDE_CONFIG_DIR}/${CLAUDE_MCP_CONFIG}`,
          "--strict-mcp-config",
          "--allowedTools",
          context.mcpServers.map((name) => `mcp__${name}`).join(","),
        );
      }
      const auth = agent.auth;
      if (auth.mode === "subscription") {
        if (!auth.secret) throw new Error("subscription requires a secret name");
        env.CLAUDE_CODE_OAUTH_TOKEN = await secrets.get(auth.secret);
      } else if (auth.mode === "api-key") {
        env.ANTHROPIC_API_KEY = await secrets.get(auth.secret);
      } else if (auth.mode === "bedrock") {
        env.CLAUDE_CODE_USE_BEDROCK = "1";
        env.AWS_BEARER_TOKEN_BEDROCK = await secrets.get(auth.secret);
        env.AWS_REGION = auth.region;
      } else {
        throw new Error(`claude-code does not support auth mode ${auth.mode}`);
      }
      if (agent.model) {
        if (auth.mode === "bedrock") env.ANTHROPIC_MODEL = agent.model;
        else command.push("--model", agent.model);
      }
      return {
        command,
        env,
        // 設定のディレクトリは実行ごとに空にし、コンテキストだけを置く（ホストの設定やメモリーは読ませない）
        ...(context
          ? {
              stage: { containerDir: CONTAINER_CLAUDE_CONFIG_DIR, files: [], seedDir: context.dir },
            }
          : {}),
        parser: "claude-json",
      };
    }

    case "codex": {
      const env: Record<string, string> = { ...contextEnv, CODEX_HOME: CONTAINER_CODEX_HOME };
      const files: { hostPath: string; name: string; syncBack: boolean }[] = [];
      const auth = agent.auth;
      if (auth.mode === "api-key") {
        const key = await secrets.get(auth.secret);
        env.CODEX_API_KEY = key;
        env.OPENAI_API_KEY = key;
      } else if (auth.mode === "bedrock") {
        // Codex の組み込みの Bedrock のプロバイダー（PBI-32）。API キーとリージョンは環境変数で渡す。
        // ゲートウェイ経由なら、API キーの代わりに実行ごとのトークンを渡す（Codex はこれを Bearer で送る。PBI-37）
        env.AWS_BEARER_TOKEN_BEDROCK = gateway ? gateway.token : await secrets.get(auth.secret);
        env.AWS_REGION = auth.region;
      } else if (auth.mode === "subscription") {
        const hostPath = expandHome(auth.auth_file ?? "~/.codex/auth.json");
        // 認証ファイルのトークン類も、出力から取り除く対象にする
        try {
          for (const value of secretStringsInJson(readFileSync(hostPath, "utf8"))) onSecret(value);
        } catch {
          // 読めない場合は実行時に「認証ファイルを読めません」として止まる
        }
        files.push({ hostPath, name: "auth.json", syncBack: true });
      } else {
        throw new Error(`codex does not support auth mode ${auth.mode}`);
      }
      const command = ["codex", "exec", "--json", "--skip-git-repo-check"];
      if (auth.mode === "bedrock") {
        // Bedrock Runtime ではホストされた Web 検索を使えないので、無効にする
        const runtime = (auth.endpoint ?? "runtime") === "runtime";
        const provider = runtime ? "amazon-bedrock-runtime" : "amazon-bedrock";
        command.push(
          "-c",
          `model_provider="${provider}"`,
          ...(runtime ? ["-c", 'web_search="disabled"'] : []),
          // 組み込みのプロバイダーのまま、向き先だけをゲートウェイにする（base_url は上書きできる）
          ...(gateway
            ? ["-c", `model_providers.${provider}.base_url="${gateway.origin}/openai/v1"`]
            : []),
        );
      }
      if (agent.model) command.push("--model", agent.model);
      command.push(prompt);
      return {
        command,
        env,
        stage: {
          containerDir: CONTAINER_CODEX_HOME,
          files,
          ...(context ? { seedDir: context.dir } : {}),
        },
        parser: "codex-jsonl",
        ...(gateway ? { hostGateway: true } : {}),
      };
    }

    case "stub": {
      const stub = agent.stub ?? {
        output: "# 要求要件（スタブ）",
        outputs: {},
        guardian: "",
        final_review: "",
        rework: "",
        orchestrator: "",
        usage: { input: 1000, cache_read: 0, cache_write: 0, output: 500 },
      };
      const result = stub.fail
        ? {
            type: "result",
            is_error: true,
            result:
              stub.fail === "usage_limit"
                ? "You've hit your session limit · resets 3:45pm"
                : "API Error: 401 Invalid authentication credentials",
          }
        : {
            type: "result",
            is_error: false,
            result:
              role === "guardian"
                ? stub.guardian
                : role === "final-review"
                  ? stub.final_review
                  : role === "rework"
                    ? stub.rework
                    : role === "orchestrator"
                      ? stub.orchestrator
                      : ((role && stub.outputs[role]) ?? stub.output),
            usage: {
              input_tokens: stub.usage.input,
              cache_read_input_tokens: stub.usage.cache_read,
              cache_creation_input_tokens: stub.usage.cache_write,
              output_tokens: stub.usage.output,
            },
          };
      return {
        command: ["sh", "-c", 'printf "%s" "$SACTY_STUB_RESULT"'],
        env: { SACTY_STUB_RESULT: JSON.stringify(result) },
        parser: "claude-json",
      };
    }
  }
}
