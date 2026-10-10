import { homedir } from "node:os";
import type { AgentConfig } from "../config.js";
import type { SecretStore } from "../secrets.js";

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
  };
  parser: "claude-json" | "codex-jsonl";
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
  secrets: SecretStore,
): Promise<Invocation> {
  switch (agent.runtime) {
    case "claude-code": {
      const env: Record<string, string> = {
        CLAUDE_CONFIG_DIR: CONTAINER_CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      };
      const command = ["claude", "-p", prompt, "--output-format", "json"];
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
      return { command, env, parser: "claude-json" };
    }

    case "codex": {
      const env: Record<string, string> = { CODEX_HOME: CONTAINER_CODEX_HOME };
      const files: { hostPath: string; name: string; syncBack: boolean }[] = [];
      const auth = agent.auth;
      if (auth.mode === "api-key") {
        const key = await secrets.get(auth.secret);
        env.CODEX_API_KEY = key;
        env.OPENAI_API_KEY = key;
      } else if (auth.mode === "subscription") {
        files.push({
          hostPath: expandHome(auth.auth_file ?? "~/.codex/auth.json"),
          name: "auth.json",
          syncBack: true,
        });
      } else {
        throw new Error(`codex does not support auth mode ${auth.mode}`);
      }
      const command = ["codex", "exec", "--json", "--skip-git-repo-check"];
      if (agent.model) command.push("--model", agent.model);
      command.push(prompt);
      return {
        command,
        env,
        stage: { containerDir: CONTAINER_CODEX_HOME, files },
        parser: "codex-jsonl",
      };
    }

    case "stub": {
      const stub = agent.stub ?? {
        output: "# 要求要件（スタブ）",
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
            result: stub.output,
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
