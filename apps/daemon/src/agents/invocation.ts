import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { StepKey } from "@sacty/core";
import type { AgentConfig } from "../config.js";
import { CLAUDE_MCP_CONFIG, GATEWAY_TOKEN_SECRET, type PlacedContext } from "../context.js";
import type { SecretStore } from "../secrets.js";
import { secretStringsInJson } from "./redact.js";

/**
 * 何として実行するか。工程か、ゴールガーディアン（変更の申し出の判定・最終レビュー）か、オーケストレーター
 * （工程の選択。chat はタスクの詳細での質問への答え。PBI-54）。export は、承認した成果の書き出し（PBI-56）。
 */
export type AgentRole =
  | StepKey
  | "guardian"
  | "final-review"
  | "rework"
  | "orchestrator"
  | "chat"
  | "export"
  | "deployment"
  | "audit"
  | "audit-dive";

/** コンテナの中での設定ディレクトリ。毎回空の場所を使い、ホストの設定やメモリーを読ませない。 */
export const CONTAINER_CLAUDE_CONFIG_DIR = "/tmp/sacty-claude-config";
/**
 * Codex は、CODEX_HOME が一時ディレクトリ（/tmp）の下にあると、サンドボックスの補助のプログラムを用意せず、
 * コマンドの実行で `--sandbox-policy-cwd` を認識できずに終了することがあるので、/tmp の外に置く（PBI-40）。
 */
export const CONTAINER_CODEX_HOME = "/.codex";

/** コンテナで実行するコマンドと、コンテナに渡す環境変数・ファイル。 */
export type Invocation = {
  command: string[];
  /**
   * コンテナの標準入力に書く内容（エージェントへの指示。PBI-149）。指示をコマンドの引数に入れると、Linux の1つの引数の上限
   * （128 KiB）を超えた大きな指示で `argument list too long` になるので、Claude Code（`-p`）・Codex（`exec -`）には標準入力で渡す。
   */
  stdin?: string;
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
    /**
     * この中身を、コンテキストの後に一時ディレクトリへ写す（保存したオーケストレーターのセッションのファイル。PBI-67）。
     * 設定の場所からの相対パスのまま置いてあるので、そのまま戻せば再開できる。
     */
    sessionDir?: string;
  };
  /**
   * 追加でマウントするディレクトリ（レビューの工程の PR の差分の全体など。PBI-65）。sacty が管理する場所だけを渡し、
   * 作業領域（PR 由来のファイルやリンクを含む）の中には置かない。
   */
  mounts?: { hostPath: string; containerPath: string; readOnly: boolean }[];
  parser: "claude-json" | "codex-jsonl";
  /**
   * 実行の後に、stage の場所（エージェントの設定の場所）から元のセッションのファイルを写す（PBI-66）。どのエージェントの
   * 形で選ぶか。無ければ写さない（スタブ）。
   */
  sessionFiles?: "claude-code" | "codex";
  /** コンテナから、ホストのゲートウェイ（host.docker.internal）に届くようにする（PBI-37）。 */
  hostGateway?: boolean;
  /**
   * コンテナから見たホストのアドレス（host.docker.internal の向き先。PBI-40）。無ければ host-gateway（Docker Desktop）。
   * Rancher Desktop などの仮想マシンの中の Docker では、host-gateway は仮想マシンを指すので、ホストのアドレスを書く。
   */
  hostAddress?: string;
};

/** 再開するセッション（PBI-67）。 */
export type OrchestratorSessionResume = { resume: string; fork?: boolean; filesDir: string };

/** providers の接続先を、Codex の自前のプロバイダーとして渡すときの名前と、API キーの環境変数（PBI-40）。 */
const PROVIDER_ID = "sacty-provider";
const PROVIDER_KEY_ENV = "SACTY_PROVIDER_API_KEY";

/** TOML の文字列（Codex の -c の値は TOML として読まれる）。 */
const tomlString = (value: string) => JSON.stringify(value);

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
  /**
   * 再開するセッション（オーケストレーター。PBI-67）。filesDir のファイルを実行ごとの設定の場所に戻し、resume の ID の
   * セッションを再開する。fork なら複製して（Claude Code の --fork-session）、元のセッションには書き足さない。
   */
  session?: OrchestratorSessionResume,
  /**
   * 作業領域の外で読ませるディレクトリ（コンテナの中のパス。質問への答えの各実行のセッションログ。PBI-91）。Claude Code は
   * --add-dir で読める場所に足す（Codex はサンドボックスを使わないので、そのまま読める）。
   */
  readDirs: readonly string[] = [],
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
        // MCP サーバーの起動の時間切れ（MCP_TIMEOUT。PBI-75）など、コンテキストから決めた環境変数
        ...context?.env,
        ...contextEnv,
        CLAUDE_CONFIG_DIR: CONTAINER_CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      };
      // 途中の出来事（考えたこと・ツールの呼び出しと結果）も出させ、セッションログに残す（PBI-62）。-p で stream-json を
      // 使うには --verbose が要る。最終結果は、最後の result の出来事から読む。指示は引数に入れず、標準入力で渡す（PBI-149）
      const command = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
      for (const dir of readDirs) command.push("--add-dir", dir);
      // 保存したセッションを再開する（PBI-67）。質問への答えは複製して、元のセッションに書き足さない
      if (session) {
        command.push("--resume", session.resume);
        if (session.fork) command.push("--fork-session");
      }
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
      // リーズニングエフォート（PBI-40）
      if (agent.reasoning_effort) command.push("--effort", agent.reasoning_effort);
      return {
        command,
        stdin: prompt,
        env,
        // 設定のディレクトリは実行ごとに空にし、コンテキストだけを置く（ホストの設定やメモリーは読ませない）。
        // コンテキストが無くても、実行ごとの場所をマウントする（元のセッションのファイルを、実行の後に写すため。PBI-66）
        stage: {
          containerDir: CONTAINER_CLAUDE_CONFIG_DIR,
          files: [],
          ...(context ? { seedDir: context.dir } : {}),
          ...(session ? { sessionDir: session.filesDir } : {}),
        },
        parser: "claude-json",
        sessionFiles: "claude-code",
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
      } else if (auth.mode === "provider") {
        // providers の OpenAI 互換の接続先（組織の AI gateway など。PBI-40）。API キーは env_key の環境変数で渡し、
        // Codex が Bearer で付ける。ゲートウェイ経由なら、API キーの代わりに実行ごとのトークンを渡す
        const endpoint = agent.endpoint;
        if (!endpoint) throw new Error(`the provider ${auth.provider} is not configured`);
        const key = gateway
          ? gateway.token
          : endpoint.secret
            ? await secrets.get(endpoint.secret)
            : undefined;
        if (key) env[PROVIDER_KEY_ENV] = key;
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
      // Codex の中のサンドボックス（Linux では bubblewrap）は、権限を落とした sacty のコンテナの中では作れず、
      // コマンドの実行が失敗する。隔離は sacty のコンテナが受け持つので、どの設定ファイル（コンテキストや
      // 対象リポジトリの .codex/config.toml）よりも優先される引数で、サンドボックスを使わないことにする（PBI-40）
      const command = [
        "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "danger-full-access",
      ];
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
      if (auth.mode === "provider" && agent.endpoint) {
        // Codex の自前のプロバイダー（Responses API の形）として、接続先（ゲートウェイ経由ならゲートウェイ）を渡す
        const baseUrl = gateway ? `${gateway.origin}/openai/v1` : agent.endpoint.baseUrl;
        const keyed = Boolean(gateway || agent.endpoint.secret);
        command.push(
          "-c",
          `model_provider="${PROVIDER_ID}"`,
          "-c",
          `model_providers.${PROVIDER_ID}={ name = ${tomlString(agent.endpoint.name)}, base_url = ${tomlString(baseUrl)}, wire_api = "responses"${keyed ? `, env_key = "${PROVIDER_KEY_ENV}"` : ""} }`,
        );
      }
      if (agent.model) command.push("--model", agent.model);
      // リーズニングエフォート（PBI-40）
      if (agent.reasoning_effort) {
        command.push("-c", `model_reasoning_effort=${tomlString(agent.reasoning_effort)}`);
      }
      // 保存したセッションを再開する（PBI-67。`codex exec [オプション] resume <ID> -- -`）。Codex には複製が無いので、
      // 質問への答えも再開する（実行ごとの使い捨ての場所で再開し、元のセッションには書き戻さない）
      if (session) command.push("resume", session.resume);
      // 指示は引数に入れず、標準入力で渡す（`-`。PBI-149）。`-` は `--` の後に置く（指示を引数で渡していたときと同じく、
      // オプションの解釈を終えてから読ませる）
      command.push("--", "-");
      return {
        command,
        stdin: prompt,
        env,
        stage: {
          containerDir: CONTAINER_CODEX_HOME,
          files,
          ...(context ? { seedDir: context.dir } : {}),
          ...(session ? { sessionDir: session.filesDir } : {}),
        },
        parser: "codex-jsonl",
        sessionFiles: "codex",
        ...(gateway ? { hostGateway: true } : {}),
      };
    }

    case "stub": {
      const stub: NonNullable<typeof agent.stub> = agent.stub ?? {
        output: "# 要求要件（スタブ）",
        outputs: {},
        audit: "",
        audit_dive: "",
        guardian: "",
        final_review: "",
        rework: "",
        orchestrator: "",
        chat: "",
        export: "",
        deployment: "",
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
              role === "audit"
                ? stub.audit
                : role === "audit-dive"
                  ? stub.audit_dive
                  : role === "guardian"
                    ? stub.guardian
                    : role === "final-review"
                      ? stub.final_review
                      : role === "rework"
                        ? stub.rework
                        : role === "orchestrator"
                          ? stub.orchestrator
                          : role === "chat"
                            ? stub.chat
                            : role === "export"
                              ? stub.export
                              : role === "deployment"
                                ? stub.deployment
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
