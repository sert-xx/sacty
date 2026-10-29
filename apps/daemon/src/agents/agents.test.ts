import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentConfig, agentFor, CONFIG_TEMPLATE, loadConfig } from "../config.js";
import { MemorySecretStore } from "../secrets.js";
import { waitFor } from "../testing/wait.js";
import { dockerRunArgs, syncBackIfChanged } from "./docker.js";
import { buildInvocation, type Invocation } from "./invocation.js";
import {
  ClaudeOutcomeReader,
  classifyFailure,
  parseClaudeResult,
  parseCodexEvents,
} from "./parse.js";

/** 記録した文言（コードと引数）を、日本語の文にする（PBI-11）。 */
const ja = (text: unknown) => renderMessage(text, "ja");

const price = { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 };
const base = {
  price_per_mtok_usd: price,
  price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
};
const secrets = new MemorySecretStore({
  "claude-oauth-token": "oauth-value",
  "anthropic-key": "api-value",
  "bedrock-key": "bedrock-value",
  "openai-key": "openai-value",
});

describe("認証方式ごとの環境変数", () => {
  const hostKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (hostKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = hostKey;
  });

  it("コンテキストは、実行ごとの空の設定のディレクトリに写して渡す（PBI-6）", async () => {
    const claude: AgentConfig = {
      ...base,
      id: "c",
      runtime: "claude-code",
      auth: { mode: "subscription", secret: "claude-oauth-token" },
    };
    // コンテキストが無くても、実行ごとの空の場所をマウントする（元のセッションのファイルを写すため。PBI-66）
    const plain = await buildInvocation(claude, "prompt", secrets);
    expect(plain.stage).toEqual({ containerDir: "/tmp/sacty-claude-config", files: [] });
    expect(plain.sessionFiles).toBe("claude-code");
    const withContext = await buildInvocation(claude, "prompt", secrets, () => {}, "design", {
      dir: "/host/ctx",
      mcpServers: [],
      secrets: [],
    });
    expect(withContext.stage).toEqual({
      containerDir: "/tmp/sacty-claude-config",
      files: [],
      seedDir: "/host/ctx",
    });
    // 組み込みのメモリーは使わない
    expect(withContext.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(withContext.env.CLAUDE_CONFIG_DIR).toBe("/tmp/sacty-claude-config");

    const codex: AgentConfig = {
      ...base,
      id: "x",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    };
    const codexInv = await buildInvocation(
      codex,
      "prompt",
      new MemorySecretStore({ "openai-key": "sk-x" }),
      () => {},
      "design",
      { dir: "/host/ctx", mcpServers: [], secrets: [] },
    );
    expect(codexInv.stage).toMatchObject({
      containerDir: "/.codex",
      seedDir: "/host/ctx",
    });
    expect(codexInv.env.CODEX_HOME).toBe("/.codex");
    expect(codexInv.sessionFiles).toBe("codex");
  });

  it("作業領域の外で読ませる場所は、Claude Code には --add-dir で渡し、Codex には足さない（PBI-91）", async () => {
    const claude: AgentConfig = {
      ...base,
      id: "c",
      runtime: "claude-code",
      auth: { mode: "subscription", secret: "claude-oauth-token" },
    };
    const inv = await buildInvocation(
      claude,
      "prompt",
      secrets,
      () => {},
      "chat",
      undefined,
      undefined,
      undefined,
      ["/sacty-logs"],
    );
    // 指示は引数に入れず、標準入力で渡す（PBI-149）
    expect(inv.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--disallowedTools",
      "ScheduleWakeup,CronCreate,CronDelete,CronList,RemoteTrigger",
      "--add-dir",
      "/sacty-logs",
    ]);
    expect(inv.stdin).toBe("prompt");
    expect((await buildInvocation(claude, "prompt", secrets)).command).not.toContain("--add-dir");
    const codex: AgentConfig = {
      ...base,
      id: "x",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    };
    const codexInv = await buildInvocation(
      codex,
      "prompt",
      new MemorySecretStore({ "openai-key": "sk-x" }),
      () => {},
      "chat",
      undefined,
      undefined,
      undefined,
      ["/sacty-logs"],
    );
    expect(codexInv.command).not.toContain("--add-dir");
    expect(codexInv.command.slice(-2)).toEqual(["--", "-"]);
    expect(codexInv.stdin).toBe("prompt");
  });

  it("コンテキストの MCP サーバーの秘密情報は、実行時に環境変数で渡し、Claude Code にはそのサーバーだけを使わせる（PBI-6）", async () => {
    const store = new MemorySecretStore({
      "claude-oauth-token": "oauth-value",
      "openai-key": "openai-value",
      "gh-token": "ghp-value",
    });
    const context = {
      dir: "/host/ctx",
      mcpServers: ["github", "docs"],
      secrets: [{ env: "SACTY_MCP_SECRET_0", secret: "gh-token", prefix: "Bearer " }],
    };
    const used: string[] = [];
    const claude = await buildInvocation(
      {
        ...base,
        id: "c",
        runtime: "claude-code",
        auth: { mode: "subscription", secret: "claude-oauth-token" },
      },
      "prompt",
      store,
      (v) => used.push(v),
      "design",
      context,
    );
    expect(claude.env.SACTY_MCP_SECRET_0).toBe("Bearer ghp-value");
    // 出力から取り除けるように、取り出した値を知らせる
    expect(used).toContain("ghp-value");
    expect(claude.command.slice(7)).toEqual([
      "--mcp-config",
      "/tmp/sacty-claude-config/mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__github,mcp__docs",
    ]);

    const codex = await buildInvocation(
      { ...base, id: "x", runtime: "codex", auth: { mode: "api-key", secret: "openai-key" } },
      "prompt",
      store,
      () => {},
      "design",
      context,
    );
    expect(codex.env.SACTY_MCP_SECRET_0).toBe("Bearer ghp-value");

    // MCP サーバーが無ければ、フラグはつけない
    const plain = await buildInvocation(
      {
        ...base,
        id: "c",
        runtime: "claude-code",
        auth: { mode: "subscription", secret: "claude-oauth-token" },
      },
      "prompt",
      store,
      () => {},
      "design",
      { dir: "/host/ctx", mcpServers: [], secrets: [] },
    );
    expect(plain.command).not.toContain("--mcp-config");
    expect(plain.env).not.toHaveProperty("MCP_TIMEOUT");

    // MCP サーバーの起動の時間切れ（PBI-75）は、Claude Code に環境変数で渡す（sacty が決める変数は上書きさせない）
    const timed = await buildInvocation(
      {
        ...base,
        id: "c",
        runtime: "claude-code",
        auth: { mode: "subscription", secret: "claude-oauth-token" },
      },
      "prompt",
      store,
      () => {},
      "design",
      {
        dir: "/host/ctx",
        mcpServers: ["docs"],
        secrets: [],
        env: { MCP_TIMEOUT: "45000", CLAUDE_CONFIG_DIR: "/elsewhere" },
      },
    );
    expect(timed.env.MCP_TIMEOUT).toBe("45000");
    expect(timed.env.CLAUDE_CONFIG_DIR).toBe("/tmp/sacty-claude-config");

    // 秘密情報が無ければ、名前を示して止める
    await expect(
      buildInvocation(
        { ...base, id: "x", runtime: "codex", auth: { mode: "api-key", secret: "openai-key" } },
        "prompt",
        store,
        () => {},
        "design",
        { ...context, secrets: [{ env: "SACTY_MCP_SECRET_0", secret: "missing", prefix: "" }] },
      ),
    ).rejects.toThrow("秘密情報「missing」が見つかりません");
  });

  it("サブスクリプションでは、ホストにAPIキーがあってもトークンだけを渡す", async () => {
    process.env.ANTHROPIC_API_KEY = "host-key-must-not-leak";
    const agent: AgentConfig = {
      ...base,
      id: "c",
      runtime: "claude-code",
      auth: { mode: "subscription", secret: "claude-oauth-token" },
    };
    const inv = await buildInvocation(agent, "prompt", secrets);
    expect(inv.env).toEqual({
      CLAUDE_CONFIG_DIR: "/tmp/sacty-claude-config",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-value",
    });
    expect(inv.command.slice(0, 2)).toEqual(["claude", "-p"]);
    // 途中の出来事も出させる（セッションログ。PBI-62）。-p で stream-json を使うには --verbose が要る
    expect(inv.command.slice(2, 5)).toEqual(["--output-format", "stream-json", "--verbose"]);
    // 一度きりの実行なので、後で起こす予約・定期の実行は使わせない（PBI-154）
    expect(inv.command.slice(5, 7)).toEqual([
      "--disallowedTools",
      "ScheduleWakeup,CronCreate,CronDelete,CronList,RemoteTrigger",
    ]);
  });

  it("APIキーではANTHROPIC_API_KEYだけを渡し、モデルは引数で指定する", async () => {
    const inv = await buildInvocation(
      {
        ...base,
        id: "c",
        runtime: "claude-code",
        model: "claude-sonnet",
        auth: { mode: "api-key", secret: "anthropic-key" },
      },
      "prompt",
      secrets,
    );
    expect(inv.env.ANTHROPIC_API_KEY).toBe("api-value");
    expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(inv.command.slice(-2)).toEqual(["--model", "claude-sonnet"]);
  });

  it("BedrockではBedrockの変数を渡し、モデルは推論プロファイルIDを環境変数で指定する", async () => {
    const inv = await buildInvocation(
      {
        ...base,
        id: "b",
        runtime: "claude-code",
        model: "us.anthropic.claude-sonnet-4-6",
        auth: { mode: "bedrock", secret: "bedrock-key", region: "us-east-1" },
      },
      "prompt",
      secrets,
    );
    expect(inv.env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-value",
      AWS_REGION: "us-east-1",
      ANTHROPIC_MODEL: "us.anthropic.claude-sonnet-4-6",
    });
    expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(inv.command).not.toContain("--model");
  });

  it("Codex は providers の接続先を自前のプロバイダーとして使い、リーズニングエフォートを渡す（PBI-40）", async () => {
    const provider = (secret?: string): AgentConfig => ({
      ...base,
      id: "sol-high",
      runtime: "codex",
      model: "gpt-6-sol",
      reasoning_effort: "high",
      auth: { mode: "provider", provider: "corp-gw" },
      via_gateway: false,
      endpoint: {
        name: "corp-gw",
        baseUrl: "https://ai-gw.example.com/llm/v1",
        ...(secret ? { secret } : {}),
        viaGateway: false,
      },
    });
    const direct = await buildInvocation(provider("openai-key"), "prompt", secrets);
    expect(direct.env.SACTY_PROVIDER_API_KEY).toBe("openai-value");
    expect(direct.command).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "danger-full-access",
      "-c",
      'model_provider="sacty-provider"',
      "-c",
      'model_providers.sacty-provider={ name = "corp-gw", base_url = "https://ai-gw.example.com/llm/v1", wire_api = "responses", env_key = "SACTY_PROVIDER_API_KEY" }',
      "--model",
      "gpt-6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "--",
      "-",
    ]);
    expect(direct.stdin).toBe("prompt");
    expect(direct.hostGateway).toBeUndefined();
    // 認証が要らない接続先には、API キーを渡さない
    const open = await buildInvocation(provider(), "prompt", secrets);
    expect(open.env.SACTY_PROVIDER_API_KEY).toBeUndefined();
    expect(open.command.join(" ")).not.toContain("env_key");
    // ゲートウェイ経由なら、向き先はゲートウェイ、API キーの代わりに実行ごとのトークン
    const via = await buildInvocation(
      provider("openai-key"),
      "prompt",
      secrets,
      () => {},
      "design",
      undefined,
      {
        origin: "http://host.docker.internal:5001",
        token: "sacty-gw-run",
      },
    );
    expect(via.env.SACTY_PROVIDER_API_KEY).toBe("sacty-gw-run");
    expect(via.command.join(" ")).toContain(
      'base_url = "http://host.docker.internal:5001/openai/v1"',
    );
    expect(via.hostGateway).toBe(true);
    // Claude Code には --effort で渡す
    const claude = await buildInvocation(
      {
        ...base,
        id: "c",
        runtime: "claude-code",
        reasoning_effort: "xhigh",
        auth: { mode: "api-key", secret: "anthropic-key" },
      },
      "prompt",
      secrets,
    );
    expect(claude.command.slice(-2)).toEqual(["--effort", "xhigh"]);
  });

  it("CodexのAPIキーと、サブスクリプション（認証ファイルをコピーして渡す）", async () => {
    const api = await buildInvocation(
      { ...base, id: "x", runtime: "codex", auth: { mode: "api-key", secret: "openai-key" } },
      "prompt",
      secrets,
    );
    expect(api.env).toMatchObject({
      CODEX_API_KEY: "openai-value",
      OPENAI_API_KEY: "openai-value",
    });
    expect(api.parser).toBe("codex-jsonl");

    const sub = await buildInvocation(
      {
        ...base,
        id: "x",
        runtime: "codex",
        auth: { mode: "subscription", auth_file: "/path/auth.json" },
      },
      "prompt",
      secrets,
    );
    expect(sub.env).toEqual({ CODEX_HOME: "/.codex" });
    expect(sub.stage).toEqual({
      containerDir: "/.codex",
      files: [{ hostPath: "/path/auth.json", name: "auth.json", syncBack: true }],
    });
  });

  it("Codex × Bedrock は、組み込みの Bedrock のプロバイダーに API キーとリージョンを渡す（PBI-32）", async () => {
    const bedrock = (endpoint?: "runtime" | "mantle") =>
      buildInvocation(
        {
          ...base,
          id: "b",
          runtime: "codex",
          model: endpoint === "mantle" ? "openai.gpt-6-sol" : "global.openai.gpt-6-sol",
          auth: {
            mode: "bedrock",
            secret: "bedrock-key",
            region: "us-east-2",
            ...(endpoint ? { endpoint } : {}),
          },
        },
        "prompt",
        secrets,
      );
    const runtime = await bedrock();
    // OpenAI の API キーやサブスクリプションの認証ファイルは渡さない
    expect(runtime.env).toEqual({
      CODEX_HOME: "/.codex",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-value",
      AWS_REGION: "us-east-2",
    });
    expect(runtime.stage?.files).toEqual([]);
    // 既定は Bedrock Runtime。ホストされた Web 検索は使えないので無効にする
    expect(runtime.command).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "danger-full-access",
      "-c",
      'model_provider="amazon-bedrock-runtime"',
      "-c",
      'web_search="disabled"',
      "--model",
      "global.openai.gpt-6-sol",
      "--",
      "-",
    ]);
    expect(runtime.parser).toBe("codex-jsonl");
    // ゲートウェイ経由（PBI-37）：API キーの代わりに実行ごとのトークンを渡し、向き先だけをゲートウェイにする
    const viaGateway = await buildInvocation(
      {
        ...base,
        id: "b",
        runtime: "codex",
        auth: { mode: "bedrock", secret: "missing-secret", region: "us-east-2" },
        via_gateway: true,
      },
      "prompt",
      secrets,
      () => {},
      "requirements",
      undefined,
      { origin: "http://host.docker.internal:5001", token: "sacty-gw-token" },
    );
    expect(viaGateway.env.AWS_BEARER_TOKEN_BEDROCK).toBe("sacty-gw-token");
    expect(viaGateway.command).toContain(
      'model_providers.amazon-bedrock-runtime.base_url="http://host.docker.internal:5001/openai/v1"',
    );
    expect(viaGateway.hostGateway).toBe(true);
    expect(runtime.hostGateway).toBeUndefined();
    const mantle = await bedrock("mantle");
    expect(mantle.command).toContain('model_provider="amazon-bedrock"');
    expect(mantle.command).not.toContain('web_search="disabled"');
    expect(mantle.command.slice(-4)).toEqual(["--model", "openai.gpt-6-sol", "--", "-"]);
  });
});

describe("dockerの引数", () => {
  it("環境変数は名前だけを渡し、秘密情報の値をコマンドラインに出さない", () => {
    const args = dockerRunArgs({
      runId: "r1",
      image: "sacty-agent:test",
      workspaceDir: "/ws/t1",
      envNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
      mounts: [],
      command: ["claude", "-p", "prompt"],
    });
    expect(args).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(args.join(" ")).not.toContain("oauth-value");
    expect(args).toEqual(
      expect.arrayContaining(["--rm", "--cap-drop", "ALL", "/ws/t1:/workspace"]),
    );
    // PID 1 を init にして、ゾンビのプロセスを回収させる（PBI-155）。イメージより前（docker の引数）に置く
    expect(args.indexOf("--init")).toBeGreaterThan(-1);
    expect(args.indexOf("--init")).toBeLessThan(args.indexOf("sacty-agent:test"));
    // 作業領域は書き込める形でマウントする。要求要件・設計などの工程には使い捨ての写しを渡すので、
    // リポジトリの手順のセットアップなども実行でき、変更は残らない（PBI-40）
    expect(args.join(" ")).not.toContain(":/workspace:ro");
    // イメージの後ろにコマンドが続く
    expect(args.slice(args.indexOf("sacty-agent:test") + 1)).toEqual(["claude", "-p", "prompt"]);
    // ゲートウェイ経由の実行だけ、host.docker.internal をホストに向ける（PBI-37）
    expect(args).not.toContain("--add-host");
    const viaGateway = dockerRunArgs({
      runId: "r3",
      image: "sacty-agent:test",
      workspaceDir: "/ws/t1",
      envNames: [],
      mounts: [],
      command: ["codex"],
      hostGateway: "host-gateway",
    });
    expect(
      viaGateway.slice(viaGateway.indexOf("--add-host"), viaGateway.indexOf("--add-host") + 2),
    ).toEqual(["--add-host", "host.docker.internal:host-gateway"]);
    // Rancher Desktop など、仮想マシンの中の Docker では、ホストのアドレスに向ける（PBI-40）
    const rancher = dockerRunArgs({
      runId: "r4",
      image: "sacty-agent:test",
      workspaceDir: "/ws/t1",
      envNames: [],
      mounts: [],
      command: ["codex"],
      hostGateway: "192.168.5.2",
    });
    expect(rancher.slice(rancher.indexOf("--add-host"), rancher.indexOf("--add-host") + 2)).toEqual(
      ["--add-host", "host.docker.internal:192.168.5.2"],
    );
  });
});

describe("出力の読み取り", () => {
  it("Claudeの成功結果から出力と使用量を読む（前に警告行があっても読める）", () => {
    const stdout = `warning: something\n${JSON.stringify({
      type: "result",
      is_error: false,
      result: "# 要求要件",
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 400,
        output_tokens: 50,
      },
    })}`;
    expect(parseClaudeResult(stdout, 0)).toEqual({
      kind: "completed",
      output: "# 要求要件",
      usage: { input: 120, cacheRead: 3000, cacheWrite: 400, output: 50 },
    });
  });

  it("result が何回も出たら、使用量は実行の全体から読み、本文は目印を含む最後の result から読む（PBI-154）", () => {
    const turn = (result: string, usage: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: "result",
        is_error: false,
        result,
        usage: {
          input_tokens: usage,
          cache_read_input_tokens: usage * 10,
          cache_creation_input_tokens: usage * 2,
          output_tokens: usage * 3,
        },
        ...extra,
      });
    const modelUsage = {
      "claude-opus-5-5": {
        inputTokens: 300,
        cacheReadInputTokens: 9000,
        cacheCreationInputTokens: 700,
        outputTokens: 800,
      },
      "claude-sonnet-5-5": {
        inputTokens: 30,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 70,
        outputTokens: 80,
      },
    };
    const verdict = '```json\n{"sacty-review-verdict": {"verdict": "suggestions"}}\n```';
    const lines = [
      turn("待っています。", 1),
      turn(`**総評**\n\n本文\n\n${verdict}`, 2),
      // 最終の答えの後の通知への返答（判定の塊の名前に触れるだけの文は、目印に当たらない）
      turn(
        "レビューは終わっています。判定の sacty-review-verdict は前のメッセージにあります。",
        4,
        {
          modelUsage,
        },
      ),
    ].join("\n");
    const total = { input: 330, cacheRead: 9900, cacheWrite: 770, output: 880 };
    // 目印が無ければ、これまでどおり最後の result。使用量は modelUsage の合計
    expect(parseClaudeResult(lines, 0)).toEqual({
      kind: "completed",
      output: "レビューは終わっています。判定の sacty-review-verdict は前のメッセージにあります。",
      usage: total,
    });
    const reader = new ClaudeOutcomeReader(undefined, { prefer: '"sacty-review-verdict"' });
    reader.push(lines);
    expect(reader.finish(0)).toEqual({
      kind: "completed",
      output: `**総評**\n\n本文\n\n${verdict}`,
      usage: total,
    });
    // セッションを再開・複製した実行は、modelUsage に前の実行の分も入るので、各 result の usage を合計する
    const resumed = new ClaudeOutcomeReader(undefined, { resumed: true });
    resumed.push(lines);
    expect(resumed.finish(0)).toMatchObject({
      kind: "completed",
      usage: { input: 7, cacheRead: 70, cacheWrite: 14, output: 21 },
    });
    // 目印を含む result が無ければ、最後の result
    const none = new ClaudeOutcomeReader(undefined, { prefer: '"sacty-review-verdict"' });
    none.push([turn("待っています。", 1), turn("終わりました。", 2)].join("\n"));
    // modelUsage が無ければ、各 result の usage（その番の分）を合計する
    expect(none.finish(0)).toEqual({
      kind: "completed",
      output: "終わりました。",
      usage: { input: 3, cacheRead: 30, cacheWrite: 6, output: 9 },
    });
    // 目印に当たらず最後の result に戻ったことを知らせる（PR #213 レビュー指摘）。当たったとき・目印が無いときは知らせない
    expect(none.notice).toBe(
      'result が 2 回出ましたが、"sacty-review-verdict" を含むものが無いので、最後の result を答えにしました（使用量：各 result の usage の合計）',
    );
    expect(reader.notice).toBeUndefined();
    // result が1つなら、後の番の返答はありえないので知らせない
    const single = new ClaudeOutcomeReader(undefined, { prefer: '"sacty-review-verdict"' });
    single.push(turn("答え", 1));
    single.finish(0);
    expect(single.notice).toBeUndefined();
    const plain = new ClaudeOutcomeReader();
    plain.push(lines);
    plain.finish(0);
    expect(plain.notice).toBeUndefined();
  });

  it("modelUsage が読めない・各番の合計より小さいときは、各 result の usage の合計を下回らない（PR #213 レビュー指摘）", () => {
    const turn = (usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: "result", is_error: false, result: "答え", usage, ...extra });
    const read = (modelUsage: unknown) =>
      parseClaudeResult(
        [
          turn({ input_tokens: 100, output_tokens: 50 }),
          turn({ input_tokens: 10, output_tokens: 5 }, { modelUsage }),
        ].join("\n"),
        0,
      );
    const summed = { input: 110, cacheRead: 0, cacheWrite: 0, output: 55 };
    // キーの名前の形が違う（読める項目を持つモデルが無い）なら、各 result の usage の合計
    expect(read({ m: { input_tokens: 999 } })).toMatchObject({ usage: summed });
    expect(read({ m: null, n: "x" })).toMatchObject({ usage: summed });
    // 読めない modelUsage は、使用量の出どころとして扱わない（知らせには各 result の usage の合計と書く）
    const malformed = new ClaudeOutcomeReader(undefined, { prefer: '"none"' });
    malformed.push(
      [
        turn({ input_tokens: 100 }),
        turn({ input_tokens: 10 }, { modelUsage: { m: { input_tokens: 999 } } }),
      ].join("\n"),
    );
    malformed.finish(0);
    expect(malformed.notice).toContain("使用量：各 result の usage の合計");
    // 読める項目の一部だけが小さいときは、項目ごとに大きいほう
    expect(read({ m: { inputTokens: 50, outputTokens: 500 } })).toMatchObject({
      usage: { input: 110, cacheRead: 0, cacheWrite: 0, output: 500 },
    });
  });

  it("result が何回も出て最後が失敗なら、失敗にし、使用量は実行の全体から読む（PR #213 レビュー指摘）", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "途中",
        usage: { output_tokens: 7 },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: '```json\n{"sacty-review-verdict": {"verdict": "suggestions"}}\n```',
        usage: { output_tokens: 8 },
      }),
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "API Error: 500",
        usage: { output_tokens: 9 },
        modelUsage: { m: { outputTokens: 100 } },
      }),
    ].join("\n");
    const reader = new ClaudeOutcomeReader(undefined, { prefer: '"sacty-review-verdict"' });
    reader.push(lines);
    expect(reader.finish(1)).toEqual({
      kind: "failed",
      reason: "error",
      message: "API Error: 500",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    });
    // modelUsage が無ければ、各 result の usage の合計
    expect(parseClaudeResult(lines.replace(/,"modelUsage":\{[^}]*\}\}/, ""), 1)).toMatchObject({
      kind: "failed",
      usage: { output: 24 },
    });
  });

  it("Claudeの失敗を、利用上限・認証・その他に分類する", () => {
    const fail = (result: string, code = 1) =>
      parseClaudeResult(JSON.stringify({ type: "result", is_error: true, result }), code);
    expect(fail("You've hit your weekly limit · resets Mon")).toMatchObject({
      kind: "failed",
      reason: "usage_limit",
    });
    expect(fail("OAuth token has expired")).toMatchObject({ reason: "auth" });
    expect(fail("something broke")).toMatchObject({ reason: "error" });
    expect(parseClaudeResult("", 127, "claude: not found")).toMatchObject({
      kind: "failed",
      reason: "error",
      message: "claude: not found",
    });
  });

  it("Codexの使用量を合計し、キャッシュは入力の内数として二重に数えない", () => {
    const lines = [
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { type: "agent_message", text: "途中" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
      },
      { type: "item.completed", item: { type: "agent_message", text: "最終の出力" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 20 },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseCodexEvents(lines, 0)).toEqual({
      kind: "completed",
      output: "最終の出力",
      usage: { input: 700, cacheRead: 800, cacheWrite: 0, output: 70 },
    });
  });

  it("Codexの失敗を読む", () => {
    const lines = JSON.stringify({
      type: "turn.failed",
      error: { message: "429 Too Many Requests" },
    });
    expect(parseCodexEvents(lines, 1)).toMatchObject({ kind: "failed", reason: "usage_limit" });
  });

  it("分類の境界", () => {
    expect(classifyFailure("API Error: Request rejected (429)")).toBe("usage_limit");
    expect(classifyFailure("API Error: 401 Invalid authentication credentials")).toBe("auth");
    expect(classifyFailure("ENOSPC")).toBe("error");
    // Bedrock のエラー（PBI-32）
    expect(classifyFailure("ThrottlingException: Too many tokens, please wait")).toBe(
      "usage_limit",
    );
    expect(classifyFailure("unexpected status Too Many Requests")).toBe("usage_limit");
    expect(classifyFailure("AccessDeniedException: You don't have access to the model")).toBe(
      "auth",
    );
  });
});

describe("設定ファイル", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("config.yaml の repository は読まず、雛形にも書かない（PBI-21）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    expect(CONFIG_TEMPLATE).not.toMatch(/^#?\s*repository:/m);
    writeFileSync(
      join(dir, "config.yaml"),
      `${CONFIG_TEMPLATE}\nrepository:\n  url: git@github.com:acme/app.git\n  test_command: npm test\n`,
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    expect(result.ok && "repository" in result.config).toBe(false);
  });

  it("config.yaml の github（poll_interval_sec）は読まず、雛形にも書かない。書いてあっても読める（PBI-100）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    expect(CONFIG_TEMPLATE).not.toMatch(/^#?\s*github:/m);
    expect(CONFIG_TEMPLATE).not.toContain("poll_interval_sec");
    writeFileSync(
      join(dir, "config.yaml"),
      `${CONFIG_TEMPLATE}\ngithub:\n  poll_interval_sec: 10\n`,
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    expect(result.ok && "github" in result.config).toBe(false);
  });

  /** 雛形の、有効な providers.codex の認証（例のコメントを外す前に消す）。 */
  const ACTIVE_CODEX_AUTH = /^ {4}auth:\n {6}mode: api-key\n {6}secret: openai-api-key.*\n/m;
  /** 雛形を書き換える（書き換える箇所が無ければ、雛形が変わったのでテストを止める）。 */
  const sub = (text: string, pattern: RegExp, to: string) => {
    expect(text).toMatch(pattern);
    return text.replace(pattern, to);
  };
  const ALL_TIERS = ["lite", "entry", "standard", "advanced", "ultimate"];

  it("`sacty config init` の雛形はそのまま読める", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    writeFileSync(join(dir, "config.yaml"), CONFIG_TEMPLATE);
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    // 工程の AI は sacty の既定（config/agents.yaml）の codex_standard。単価は available_models から引く（PBI-134）
    expect(result.config.defaultAgent).toMatchObject({
      id: "codex_standard",
      model: "gpt-6.1-sol",
      reasoning_effort: "low",
      auth: { mode: "api-key", secret: "openai-api-key" },
    });
    expect(result.config.defaultAgent.price).toEqual({
      input: 1.25,
      cachedInput: 0.125,
      cacheWrite: 0,
      output: 10,
    });
    expect(result.config.budgetPerTaskUsd).toBe(1);
    expect(Object.keys(result.config.tierAgents?.codex ?? {})).toEqual(ALL_TIERS);
    // providers.claude は例だけなので、claude の段階は使えない（警告もしない）
    expect(result.config.tierAgents?.["claude-code"]).toBeUndefined();
    expect(result.config.agentWarnings).toEqual([]);
    // agents は書かない（上書きの例はコメントだけ）
    expect(CONFIG_TEMPLATE).not.toMatch(/^agents:/m);
  });

  it("秘密情報には 1Password の参照も書け、使うアカウントを読む（PBI-34）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (secret: string, extra = "") =>
      writeFileSync(
        join(dir, "config.yaml"),
        `providers:
  codex:
    auth: { mode: bedrock, secret: "${secret}", region: us-east-2 }
    available_models:
      gpt-6.1-sol: { input: 1, cached_input: 0.1, output: 2 }
${extra}`,
      );
    write("op://Work/Bedrock/credential", "onepassword:\n  account: my-company.1password.com\n");
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        defaultAgent: { auth: { secret: "op://Work/Bedrock/credential" } },
        onePasswordAccount: "my-company.1password.com",
      },
    });
    write("op://Work/Bedrock");
    const result = loadConfig(dir);
    expect(result.ok ? "" : ja(result.problem)).toContain(
      "1Password の参照（op://保管庫/アイテム/フィールド）",
    );
  });

  it("providers.codex の OpenAI 互換の接続先・工程ごとのエージェントを読む（PBI-40・PBI-134）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    const base = `providers:
  codex:
    auth:
      mode: openai-compatible
      base_url: https://ai-gw.example.com/llm/v1/
      secret: op://Work/AI-GW/api-key
    via_gateway: true
    available_models:
      gpt-6-luna: { input: 0.3, cached_input: 0.03, output: 1.5 }
      gpt-6.1-sol: { input: 2, cached_input: 0.2, output: 12 }
`;
    write(`${base}default_agent: codex_lite
guardian_agent: codex_advanced
step_agents:
  orchestrator: codex_lite
  design: codex_advanced
`);
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    expect(result.config.stepAgents?.design).toMatchObject({
      id: "codex_advanced",
      model: "gpt-6.1-sol",
      reasoning_effort: "medium",
      auth: { mode: "provider", provider: "codex" },
      endpoint: {
        name: "codex",
        baseUrl: "https://ai-gw.example.com/llm/v1",
        secret: "op://Work/AI-GW/api-key",
        viaGateway: true,
      },
      via_gateway: false,
      price: { input: 2, cachedInput: 0.2, output: 12 },
    });
    // 工程ごとに書いたものはそれ、書いていなければ default_agent（統合レビューは guardian_agent）
    expect(agentFor(result.config, "design").id).toBe("codex_advanced");
    expect(agentFor(result.config, "orchestrator").id).toBe("codex_lite");
    expect(agentFor(result.config, "implement").id).toBe("codex_lite");
    expect(agentFor(result.config, "integrate").id).toBe("codex_advanced");

    const problem = (yaml: string) => {
      write(yaml);
      const r = loadConfig(dir);
      return r.ok ? "" : ja(r.problem);
    };
    expect(problem(`${base}step_agents:\n  design: nope\n`)).toContain(
      'step_agents.design の "nope" が agents にありません',
    );
    expect(problem(`${base}agents:\n  codex_lite:\n    reasoning_effort: HIGH!\n`)).toContain(
      "リーズニングエフォート",
    );
    // OpenAI 互換の接続先は Codex だけ
    expect(
      problem(
        "providers:\n  claude:\n    auth: { mode: openai-compatible, base_url: https://gw.example.com/v1 }\n",
      ),
    ).toContain("claude-code では openai-compatible を使えません");
  });

  it("イメージの作成の元（元のイメージ・npm のレジストリ・トークンの名前）を読む（PBI-33）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (extra: string) =>
      writeFileSync(
        join(dir, "config.yaml"),
        `default_agent: x
agents:
  x:
    runtime: stub
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
${extra}`,
      );
    write("");
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { imageBuild: {} } });
    write(`image_build:
  base_image: registry.example.com/library/node:26-bookworm-slim
  npm_registry: https://npm.example.com/repository/npm/
  npm_token: npm-token
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        imageBuild: {
          baseImage: "registry.example.com/library/node:26-bookworm-slim",
          npmRegistry: "https://npm.example.com/repository/npm/",
          npmToken: "npm-token",
        },
      },
    });
    write("image_build:\n  npm_registry: ftp://npm.example.com/\n");
    const result = loadConfig(dir);
    expect(result.ok ? "" : ja(result.problem)).toContain("image_build.npm_registry");
    // npm の版と、コンテナの中の npm 全体の設定（PBI-40）。値は文字列にそろえる
    write(`image_build:
  npm_version: 11
  npm_config:
    replace-registry-host: always
    audit: false
    min-release-age: 7
    "@acme:registry": https://npm.example.com/acme/
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        imageBuild: {
          npmVersion: "11",
          npmConfig: {
            "replace-registry-host": "always",
            audit: "false",
            "min-release-age": "7",
            "@acme:registry": "https://npm.example.com/acme/",
          },
        },
      },
    });
    // 認証の項目はイメージに残るので書けない。値の改行（別の項目を足せる）・誤った版も拒否する
    for (const bad of [
      '"//npm.example.com/:_authToken": abc',
      "_auth: abc",
      "_password: abc",
      "keyfile: /k",
    ]) {
      write(`image_build:\n  npm_config:\n    ${bad}\n`);
      const rejected = loadConfig(dir);
      expect(rejected.ok ? "" : ja(rejected.problem)).toContain("認証の項目");
    }
    write('image_build:\n  npm_config:\n    audit: "false\\n_authToken=x"\n');
    expect(loadConfig(dir).ok).toBe(false);
    write("image_build:\n  npm_version: '11; rm -rf /'\n");
    const version = loadConfig(dir);
    expect(version.ok ? "" : ja(version.problem)).toContain("image_build.npm_version");
    // draw.io の CLI は、false と書いたときだけ入れない。真偽値のほかは拒否する
    write("image_build:\n  drawio: false\n");
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { imageBuild: { drawio: false } } });
    write("image_build:\n  drawio: true\n");
    const withDrawio = loadConfig(dir);
    expect(withDrawio.ok && withDrawio.config.imageBuild).toEqual({});
    write("image_build:\n  drawio: 'no'\n");
    const drawio = loadConfig(dir);
    expect(drawio.ok ? "" : ja(drawio.problem)).toContain("image_build.drawio");
  });

  it("言語ごとのイメージ（images）を読み、認証の値・予約された名前・危ない URL は拒否する（PBI-41）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (extra: string) =>
      writeFileSync(
        join(dir, "config.yaml"),
        `default_agent: x
agents:
  x:
    runtime: stub
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
${extra}`,
      );
    const problem = () => {
      const result = loadConfig(dir);
      return result.ok ? "" : ja(result.problem);
    };
    write("");
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { images: {} } });
    write(`images:
  java17:
    description: Java 17・Maven・Gradle
    base_image: registry.example.com/ci/java:17
    env:
      GOPROXY: https://proxy.example.com,direct
      PIP_INDEX_URL: https://pypi.example.com/simple
    maven_mirror: https://maven.example.com/repository/maven-public/
  py:
    description: Python 3.12
    base_image: python:3.12-slim
    image: registry.example.com/sacty/py:1
    node_image: registry.example.com/library/node:26
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        images: {
          java17: {
            name: "java17",
            // 書かなければ sacty-agent-<名前>:<既定のイメージの版>
            image: "sacty-agent-java17:1.14.0",
            description: "Java 17・Maven・Gradle",
            baseImage: "registry.example.com/ci/java:17",
            env: {
              GOPROXY: "https://proxy.example.com,direct",
              PIP_INDEX_URL: "https://pypi.example.com/simple",
            },
            mavenMirror: "https://maven.example.com/repository/maven-public/",
          },
          py: {
            image: "registry.example.com/sacty/py:1",
            nodeImage: "registry.example.com/library/node:26",
            env: {},
          },
        },
      },
    });
    const image = (body: string) =>
      write(`images:\n  java:\n    description: d\n    base_image: b\n${body}`);
    // 認証の値（名前・URL のユーザー名とパスワード）は、コンテナの中のすべてのコマンドに見えるので書けない
    for (const env of [
      "NPM_TOKEN: x",
      "MAVEN_PASSWORD: x",
      "PIP_INDEX_URL: https://user:pass@pypi.example.com/simple",
      "GITHUB_API_KEY: x",
    ]) {
      image(`    env:\n      ${env}\n`);
      expect(problem()).toContain("認証の値");
    }
    // sacty・docker の設定とぶつかる名前
    for (const env of [
      "PATH: /x",
      "HOME: /x",
      "CODEX_HOME: /x",
      "DOCKER_HOST: x",
      "NPM_CONFIG_REGISTRY: x",
    ]) {
      image(`    env:\n      ${env}\n`);
      expect(problem()).toContain("PATH・HOME");
    }
    image("    env:\n      lower: x\n");
    expect(problem()).toContain("英大文字・数字・_");
    image('    env:\n      GOPROXY: "a\\nb"\n');
    expect(loadConfig(dir).ok).toBe(false);
    // Maven・Gradle の設定に埋め込むので、ユーザー名・パスワードや記号を含む URL は書けない
    for (const url of [
      "https://user:pass@maven.example.com/",
      '"https://maven.example.com/\'x"',
      '"https://maven.example.com/<x>"',
      "ftp://maven.example.com/",
    ]) {
      image(`    maven_mirror: ${url}\n`);
      expect(loadConfig(dir).ok).toBe(false);
    }
    // イメージを作るときのパッケージとコマンド（PBI-50）
    image(
      "    packages: [nss, nspr, libstdc++, 'python3.12-pip', 'curl=8.5.0-2']\n    run:\n      - dnf config-manager --add-repo https://rpm.example.com/repo\n      - npx -y playwright@1.56.0 install-deps chromium\n",
    );
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        images: {
          java: {
            packages: ["nss", "nspr", "libstdc++", "python3.12-pip", "curl=8.5.0-2"],
            run: [
              "dnf config-manager --add-repo https://rpm.example.com/repo",
              "npx -y playwright@1.56.0 install-deps chromium",
            ],
          },
        },
      },
    });
    // シェルの特別な文字を含むパッケージの名前・複数行のコマンドは書けない
    for (const name of ["'nss; rm -rf /'", "'$(id)'", "'-y'", "'a b'"]) {
      image(`    packages: [${name}]\n`);
      expect(problem()).toContain("パッケージの名前");
    }
    // 有効にするパッケージのリポジトリ（PBI-59）。書かなければ渡さない
    image("    packages: [nss]\n");
    const loaded = loadConfig(dir);
    expect(loaded.ok && loaded.config.images?.java?.enableRepos).toBeUndefined();
    image("    enable_repos: [corp-baseos, 'corp.app_stream:9', crb]\n    packages: [nss]\n");
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: { images: { java: { enableRepos: ["corp-baseos", "corp.app_stream:9", "crb"] } } },
    });
    image("    enable_repos: []\n    packages: [nss]\n");
    const empty = loadConfig(dir);
    expect(empty.ok && empty.config.images?.java?.enableRepos).toBeUndefined();
    // Dockerfile の RUN に展開するので、シェルの特別な文字・空白・オプションに見える ID は書けない
    for (const id of ["'a;id'", "'$(id)'", "'-x'", "'a b'", "''", "'a,b'", "'a*'", "'.hidden'"]) {
      image(`    enable_repos: [${id}]\n    packages: [nss]\n`);
      expect(problem()).toContain("リポジトリの ID");
    }
    // packages が無ければ、書いても効かないので止める
    image("    enable_repos: [crb]\n");
    expect(problem()).toContain("packages も書いてください");
    image('    run: ["a\\nb"]\n');
    expect(problem()).toContain("1行のコマンド");
    image("    run: ['']\n");
    expect(loadConfig(dir).ok).toBe(false);
    // default は既定のイメージの名前なので使えない。名前の形も決まっている
    for (const name of ["default", "Java", "a b"]) {
      write(`images:\n  "${name}":\n    description: d\n    base_image: b\n`);
      expect(problem()).toContain("images の名前");
    }
  });

  it("ゲートウェイ経由は Codex の bedrock・openai-compatible だけ。リトライの上限を読み、書かなければ既定にする（PBI-37・PBI-134）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    const problem = () => {
      const r = loadConfig(dir);
      return r.ok ? "" : ja(r.problem);
    };
    const providerYaml = (key: string, auth: string) => `providers:
  ${key}:
    auth: ${auth}
    via_gateway: true
    available_models:
      gpt-6.1-sol: { input: 1, cached_input: 0.1, output: 2 }
      claude-sonnet-5-5: { input: 1, cached_input: 0.1, output: 2 }
`;
    write(providerYaml("codex", "{ mode: api-key, secret: k }"));
    expect(problem()).toBe(
      "設定ファイルに誤りがあります（providers.codex.via_gateway）：ゲートウェイ経由（via_gateway）は、providers.codex の auth.mode が bedrock か openai-compatible のときだけ使えます。",
    );
    write(providerYaml("claude", "{ mode: bedrock, secret: k, region: us-east-1 }"));
    expect(problem()).toContain("providers.claude.via_gateway");
    const bedrock = providerYaml("codex", "{ mode: bedrock, secret: k, region: us-east-2 }");
    write(bedrock);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        defaultAgent: { via_gateway: true },
        gatewayRetry: { maxAttempts: 8, maxWaitMs: 600_000 },
      },
    });
    // OpenAI 互換の接続先は、接続先の側でゲートウェイ経由にする
    write(
      providerYaml("codex", "{ mode: openai-compatible, base_url: https://gw.example.com/v1 }"),
    );
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: { defaultAgent: { via_gateway: false, endpoint: { viaGateway: true } } },
    });
    write(`${bedrock}gateway:\n  retry:\n    max_attempts: 3\n    max_wait_sec: 30\n`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: { gatewayRetry: { maxAttempts: 3, maxWaitMs: 30_000 }, hostAddress: "host-gateway" },
    });
    // コンテナから見たホストのアドレス（Rancher Desktop。PBI-40）
    write(`${bedrock}gateway:\n  host_address: 192.168.5.2\n`);
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { hostAddress: "192.168.5.2" } });
    // docker の引数に紛れ込むものは書けない
    write(`${bedrock}gateway:\n  host_address: "1.2.3.4 --privileged"\n`);
    expect(problem()).toContain("gateway.host_address は、ホスト名か IP アドレス");
  });

  it("画面の認証（web.auth）は、書かなければ ON、false なら OFF。真偽でない値は誤り（PBI-133）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    const base = `default_agent: x
agents:
  x:
    runtime: stub
`;
    write(base);
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { webAuth: true } });
    write(`${base}web:\n  auth: false\n`);
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { webAuth: false } });
    write(`${base}web:\n  auth: true\n`);
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { webAuth: true } });
    write(`${base}web: {}\n`);
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { webAuth: true } });
    for (const value of ['"off"', "no", "0"]) {
      write(`${base}web:\n  auth: ${value}\n`);
      expect(loadConfig(dir).ok).toBe(false);
    }
    // 雛形は ON のまま（OFF の例はコメントだけ）
    expect(CONFIG_TEMPLATE).toMatch(/^# web:\n# {3}auth: false$/m);
  });

  it("雛形の Codex × Bedrock の例は、コメントを外せばそのまま読める（PBI-32）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    let yaml = sub(CONFIG_TEMPLATE, ACTIVE_CODEX_AUTH, "");
    yaml = sub(yaml, /^ {4}# (auth: \{ mode: bedrock, .*region: us-east-2.*)$/m, "    $1");
    yaml = sub(yaml, /^ {4}# (via_gateway: true)$/m, "    $1");
    writeFileSync(join(dir, "config.yaml"), yaml);
    const result = loadConfig(dir);
    expect(result).toMatchObject({
      ok: true,
      config: {
        defaultAgent: {
          id: "codex_standard",
          runtime: "codex",
          auth: { mode: "bedrock", secret: "bedrock-api-key", endpoint: "runtime" },
          via_gateway: true,
        },
      },
    });
  });

  it("雛形の OpenAI 互換の接続先・step_agents・agents の上書きの例は、コメントを外せばそのまま読める（PBI-40・PBI-134）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    /** 「# <first>」から次の「#」で始まらない行までの、行の頭のコメントを外す。 */
    const uncommentBlock = (text: string, first: string) => {
      const lines = text.split("\n");
      const start = lines.indexOf(first);
      expect(start, first).toBeGreaterThanOrEqual(0);
      const end = lines.findIndex((l, i) => i > start && !l.startsWith("#"));
      return [
        ...lines.slice(0, start),
        ...lines.slice(start, end).map((l) => l.replace(/^# ?/, "")),
        ...lines.slice(end),
      ].join("\n");
    };
    let yaml = sub(CONFIG_TEMPLATE, ACTIVE_CODEX_AUTH, "");
    yaml = sub(
      yaml,
      /^ {4}# auth:\n {4}# {3}mode: openai-compatible\n {4}# {3}(base_url: .*)\n {4}# {3}(secret: .*)$/m,
      "    auth:\n      mode: openai-compatible\n      $1\n      $2",
    );
    yaml = sub(yaml, /^ {4}# (via_gateway: true)$/m, "    $1");
    yaml = uncommentBlock(yaml, "# step_agents:");
    yaml = uncommentBlock(yaml, "# agents:");
    writeFileSync(join(dir, "config.yaml"), yaml);
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    expect(result.config.defaultAgent).toMatchObject({
      id: "codex_standard",
      endpoint: {
        name: "codex",
        baseUrl: "https://ai-gateway.example.com/v1",
        secret: "op://Work/AI-Gateway/api-key",
        viaGateway: true,
      },
    });
    expect(result.config.stepAgents?.design?.id).toBe("codex_advanced");
    expect(result.config.stepAgents?.orchestrator?.id).toBe("codex_lite");
    // 上書きは項目ごと（model は既定のまま）
    expect(result.config.agents?.codex_ultimate).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning_effort: "xhigh",
    });
    expect(result.config.agents?.stub?.price).toMatchObject({ input: 3, output: 15 });
    // providers.claude の無い claude_lite は、書いた（上書きした）ので警告する
    expect(result.config.agents?.claude_lite).toBeUndefined();
    expect((result.config.agentWarnings ?? []).map((w) => ja(w))).toEqual([
      "エージェント「claude_lite」は、providers.claude が無いので使えません。",
    ]);
  });

  it("雛形の images の例は、コメントを外せばそのまま読める（PBI-41）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const lines = CONFIG_TEMPLATE.split("\n");
    const start = lines.indexOf("# images:");
    const end = lines.findIndex((l, i) => i > start && !l.startsWith("#"));
    const images = lines.slice(start, end).map((l) => l.replace(/^# ?/, ""));
    writeFileSync(join(dir, "config.yaml"), `${CONFIG_TEMPLATE}\n${images.join("\n")}\n`);
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    expect(Object.keys(result.config.images ?? {})).toEqual(["java17", "python", "go"]);
    expect(result.config.images?.go?.env).toEqual({
      GOPROXY: "https://goproxy.example.com",
      GONOSUMDB: "git.example.com",
    });
  });

  it("agents の空の名前は、理由つきで拒否する（default_agent が空の名前でも。PR #131 再レビュー指摘）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    writeFileSync(
      join(dir, "config.yaml"),
      `default_agent: ""
agents:
  "":
    runtime: stub
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
  strong:
    runtime: stub
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
`,
    );
    const result = loadConfig(dir);
    expect(result).toMatchObject({
      ok: false,
      problem: { code: "config.invalid", params: { detail: { code: "config.agentNameEmpty" } } },
    });
    expect(renderMessage((result as { problem: unknown }).problem, "ja")).toContain(
      "agents の名前は空にできません。",
    );
  });

  it("使えない認証方式の組み合わせや、存在しない既定のAIは理由つきで拒否する", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    write(
      "providers:\n  claude:\n    auth: { mode: openai-compatible, base_url: https://gw.example.com/v1 }\n",
    );
    const problem = () => {
      const result = loadConfig(dir);
      return result.ok ? "" : ja(result.problem);
    };
    expect(problem()).toBe(
      "設定ファイルに誤りがあります（providers.claude.auth.mode）：claude-code では openai-compatible を使えません（使えるもの：subscription, api-key, bedrock）。",
    );
    // コードと引数で返す（画面が画面の言語の文にする）
    expect(loadConfig(dir)).toMatchObject({
      ok: false,
      problem: {
        code: "config.invalid",
        params: {
          detail: {
            code: "config.authUnsupported",
            params: { runtime: "claude-code", mode: "openai-compatible" },
          },
        },
      },
    });
    expect(renderMessage((loadConfig(dir) as { problem: unknown }).problem, "en")).toBe(
      "The config file has an error (providers.claude.auth.mode): claude-code cannot use openai-compatible (supported: subscription, api-key, bedrock).",
    );
    // Bedrock の接続先は Codex だけ（Claude Code に書いても使われないので、誤りとして知らせる。PBI-32）
    write(
      "providers:\n  claude:\n    auth: { mode: bedrock, secret: k, region: us-east-1, endpoint: mantle }\n",
    );
    expect(problem()).toBe(
      "設定ファイルに誤りがあります（providers.claude.auth.endpoint）：Bedrock の接続先（endpoint）は Codex だけで選べます。Claude Code では書かないでください。",
    );
    write("providers:\n  claude:\n    auth: { mode: subscription }\n");
    expect(problem()).toContain("providers.claude.auth.secret");
    // Bedrock のモデル名は、agents で上書きする
    write(`providers:
  codex:
    auth: { mode: bedrock, secret: k, region: us-east-2, endpoint: runtime }
    available_models:
      global.openai.gpt-6-sol: { input: 1.25, cached_input: 0.125, output: 10 }
agents:
  codex_standard:
    model: global.openai.gpt-6-sol
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        defaultAgent: {
          runtime: "codex",
          model: "global.openai.gpt-6-sol",
          auth: { mode: "bedrock", endpoint: "runtime" },
        },
      },
    });
    write("default_agent: missing\n");
    expect(problem()).toContain('default_agent の "missing" が agents にありません');
    write("default_agent: [unclosed");
    expect(problem()).toContain("YAML");
  });
});

describe("認証ファイルの書き戻し", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("コンテナで更新され、ホストが変わっていなければ書き戻す", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-sync-"));
    const host = join(dir, "auth.json");
    const staged = { dir, name: "staged.json" };
    writeFileSync(host, "old");
    writeFileSync(join(dir, "staged.json"), "refreshed");
    expect(syncBackIfChanged(host, staged, sha("old"))).toBe("written");
    expect(readFileSync(host, "utf8")).toBe("refreshed");
  });

  it("コンテナで変わっていなければ何もしない", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-sync-"));
    const host = join(dir, "auth.json");
    const staged = { dir, name: "staged.json" };
    writeFileSync(host, "old");
    writeFileSync(join(dir, "staged.json"), "old");
    expect(syncBackIfChanged(host, staged, sha("old"))).toBe("unchanged");
  });

  it("実行中にホスト側が変わっていたら、利用者の操作を優先して書き戻さない", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-sync-"));
    const host = join(dir, "auth.json");
    const staged = { dir, name: "staged.json" };
    writeFileSync(host, "re-login by user");
    writeFileSync(join(dir, "staged.json"), "refreshed");
    expect(syncBackIfChanged(host, staged, sha("old"))).toBe("host-changed");
    expect(readFileSync(host, "utf8")).toBe("re-login by user");
  });

  // コンテナは一時ディレクトリの中を、ホストのほかのファイルへのリンクや FIFO に差し替えられる（PBI-71）
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-sync-"));
    const host = join(dir, "auth.json");
    writeFileSync(host, "old");
    const other = join(dir, "other-host-file");
    writeFileSync(other, "contents of another host file");
    const staging = join(dir, "staging");
    mkdirSync(staging);
    return { host, other, staging };
  };

  it("ステージしたファイルがホストのほかのファイルへのリンクなら、読まずに書き戻さない", () => {
    const { host, other, staging } = setup();
    symlinkSync(other, join(staging, "auth.json"));
    expect(syncBackIfChanged(host, { dir: staging, name: "auth.json" }, sha("old"))).toBe(
      "not-regular",
    );
    expect(readFileSync(host, "utf8")).toBe("old");
  });

  it("途中のディレクトリがリンクなら、その先を読まずに書き戻さない", () => {
    const { host, other, staging } = setup();
    // other-host-file のあるディレクトリ（dir）を、一時ディレクトリの中の sub に見せる
    symlinkSync(dir, join(staging, "sub"));
    expect(syncBackIfChanged(host, { dir: staging, name: "sub/other-host-file" }, sha("old"))).toBe(
      "not-regular",
    );
    expect(readFileSync(host, "utf8")).toBe("old");
    expect(readFileSync(other, "utf8")).toBe("contents of another host file");
  });

  it("一時ディレクトリそのものがリンクなら、読まずに書き戻さない", () => {
    const { host } = setup();
    const linked = join(dir, "linked-staging");
    symlinkSync(dir, linked);
    expect(syncBackIfChanged(host, { dir: linked, name: "other-host-file" }, sha("old"))).toBe(
      "not-regular",
    );
    expect(readFileSync(host, "utf8")).toBe("old");
  });

  it.skipIf(process.platform === "win32")(
    "ステージしたファイルが FIFO なら、待たずに読まずに書き戻さない",
    () => {
      const { host, staging } = setup();
      const fifo = join(staging, "auth.json");
      execFileSync("mkfifo", [fifo]);
      // 書き手を置く（リンクを辿って普通に読むと、待ったうえで書き手の中身を書き戻してしまう。テストが止まらず落ちるように）
      const writer = spawn("sh", ["-c", 'printf "from fifo" > "$0"', fifo], { stdio: "ignore" });
      try {
        expect(syncBackIfChanged(host, { dir: staging, name: "auth.json" }, sha("old"))).toBe(
          "not-regular",
        );
        expect(readFileSync(host, "utf8")).toBe("old");
      } finally {
        writer.kill();
      }
    },
    5_000,
  );

  it("ステージしたファイルが消えていれば何もしない", () => {
    const { host, staging } = setup();
    expect(syncBackIfChanged(host, { dir: staging, name: "auth.json" }, sha("old"))).toBe(
      "unchanged",
    );
    expect(readFileSync(host, "utf8")).toBe("old");
  });
});

describe("秘密情報の除去", () => {
  it("渡した秘密情報を、短くても [REDACTED] に置き換える（空の値は無視する）", async () => {
    const { redact } = await import("./redact.js");
    expect(redact("token=abcdefgh12345 and abcdefgh12345", ["abcdefgh12345"])).toBe(
      "token=[REDACTED] and [REDACTED]",
    );
    // 名前を指定して取り出した値は、短くても残さない（長い値から先に置き換える）
    expect(redact("pin=pin123 / pin1234", ["pin123", "pin1234", ""])).toBe(
      "pin=[REDACTED] / [REDACTED]",
    );
  });

  it("コードと引数の文言は、引数の文（外から来た文）から秘密情報を取り除く（PBI-11b）", async () => {
    const { redactText } = await import("./redact.js");
    expect(
      redactText(
        {
          code: "pr.failed",
          params: {
            detail: { code: "git.failed", params: { command: "push", detail: "x ghp_1 y" } },
          },
        },
        ["ghp_1"],
      ),
    ).toEqual({
      code: "pr.failed",
      params: {
        detail: { code: "git.failed", params: { command: "push", detail: "x [REDACTED] y" } },
      },
    });
    expect(redactText("token ghp_1", ["ghp_1"])).toBe("token [REDACTED]");

    // 秘密情報がコードや決まった値（列挙）と重なっても、文言の形は壊さない（レビュー指摘）
    const nested = {
      code: "pr.failed",
      params: {
        detail: {
          code: "github.failed",
          params: { action: "createPr", status: 401, detail: "failed token", hint: "token" },
        },
      },
    };
    const redacted = redactText(nested, ["failed", "token"]);
    expect(redacted).toEqual({
      code: "pr.failed",
      params: {
        detail: {
          code: "github.failed",
          params: {
            action: "createPr",
            status: 401,
            detail: "[REDACTED] [REDACTED]",
            hint: "token",
          },
        },
      },
    });
    expect(renderMessage(redacted, "en")).toBe(
      "Could not open the PR: Could not open the PR: GitHub API 401 [REDACTED] [REDACTED] (the token is invalid)",
    );
    // 知らないコードは、コードを変えずに引数の文字列だけを取り除く
    expect(redactText({ code: "x.failed", params: { a: "failed" } }, ["failed"])).toEqual({
      code: "x.failed",
      params: { a: "[REDACTED]" },
    });
  });

  it("認証ファイルのJSONから、トークンらしい文字列を取り出す", async () => {
    const { secretStringsInJson } = await import("./redact.js");
    const json = JSON.stringify({
      tokens: { access_token: "a".repeat(40), refresh_token: "r".repeat(40) },
      last_refresh: "2026",
    });
    expect(secretStringsInJson(json)).toEqual(["a".repeat(40), "r".repeat(40)]);
    // JSON でないファイルは全体を秘密情報とみなすが、短すぎるものは推測の対象にしない
    expect(secretStringsInJson("not-json-token-value")).toEqual(["not-json-token-value"]);
    expect(secretStringsInJson("x\n")).toEqual([]);
  });
});

describe("停止時の後処理（偽のdockerコマンド）", () => {
  let dir: string;
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("実行中に止めても、更新された認証ファイルを書き戻し、一時ファイルを消す", async () => {
    const { chmodSync, existsSync, mkdirSync } = await import("node:fs");
    const { DockerExecutor } = await import("./docker.js");
    dir = mkdtempSync(join(tmpdir(), "sacty-fakedocker-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // run：マウントされた認証ファイルを更新してから、止められるまで待つ。kill：run を止める。
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "kill" ]; then kill "$(cat "$here/run.pid")"; exit 0; fi
# ps：止めたコンテナはもう無い
if [ "$1" = "ps" ]; then exit 0; fi
echo $$ > "$here/run.pid"
prev=""; host=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in *:/.codex*) host="\${a%%:/.codex*}";; esac
  fi
  prev="$a"
done
echo "$host" > "$here/staging.path"
printf 'refreshed-token' > "$host/auth.json"
trap 'exit 137' TERM
touch "$here/ready"
while true; do sleep 0.05; done
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const hostAuth = join(dir, "auth.json");
    writeFileSync(hostAuth, "old-token");
    const executor = new DockerExecutor();
    const running = executor.run({
      runId: "r1",
      image: "img",
      workspaceDir: dir,
      invocation: {
        command: ["codex"],
        env: { CODEX_HOME: "/.codex" },
        stage: {
          containerDir: "/.codex",
          files: [{ hostPath: hostAuth, name: "auth.json", syncBack: true }],
        },
        parser: "codex-jsonl",
      },
    });
    // 偽dockerが認証ファイルを更新し、止められる用意をするまで待ってから止める（決まった時間は待たない）
    await waitFor(() => existsSync(join(bin, "ready")), {
      what: "偽の docker が認証ファイルを更新した合図（ready）",
      source: { name: "偽の docker の実行", ended: running },
    });
    executor.abortAll();
    const outcome = await running;

    expect(outcome).toMatchObject({ kind: "failed", message: { code: "run.daemonStopped" } });
    expect(outcome.kind === "failed" && ja(outcome.message)).toContain("中断");
    expect(readFileSync(hostAuth, "utf8")).toBe("refreshed-token");
    const staging = readFileSync(join(bin, "staging.path"), "utf8").trim();
    expect(existsSync(staging)).toBe(false);
  });

  it("止め始めた後に始めた実行は、コンテナを起動しない（作業領域を写す間に止めたとき。PBI-156）", async () => {
    const { DockerExecutor } = await import("./docker.js");
    dir = mkdtempSync(join(tmpdir(), "sacty-fakedocker-"));
    const spawned: string[][] = [];
    const spawnImpl = ((_command: string, args: string[]) => {
      spawned.push(args);
      throw new Error("起動してはいけない");
    }) as unknown as typeof import("node:child_process").spawn;
    const executor = new DockerExecutor(undefined, spawnImpl);
    executor.abortAll();
    const outcome = await executor.run({
      runId: "r1",
      image: "img",
      workspaceDir: dir,
      invocation: { command: ["claude"], env: {}, parser: "claude-json" },
    });
    expect(outcome).toMatchObject({ kind: "failed", message: { code: "run.daemonStopped" } });
    expect(spawned).toEqual([]);
  });
});

describe("認証ファイルの書き戻しでコンテナの中を信じない（偽のdockerコマンド。PBI-71）", () => {
  let dir: string;
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 偽の docker を置く。run の本体（$host がステージの一時ディレクトリ、$here が偽の docker の場所）と、ps の答えを渡す。 */
  const fakeDocker = async (run: string, ps = "exit 0") => {
    const { chmodSync } = await import("node:fs");
    dir = mkdtempSync(join(tmpdir(), "sacty-fakedocker-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "kill" ]; then kill "$(cat "$here/run.pid")" 2>/dev/null; exit 0; fi
if [ "$1" = "ps" ]; then ${ps}; fi
echo $$ > "$here/run.pid"
prev=""; host=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in *:/.codex*) host="\${a%%:/.codex*}";; esac
  fi
  prev="$a"
done
${run}
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const hostAuth = join(dir, "auth.json");
    writeFileSync(hostAuth, "old-token");
    return { bin, hostAuth };
  };
  const invocation = (hostAuth: string): Invocation => ({
    command: ["codex"],
    env: { CODEX_HOME: "/.codex" },
    stage: {
      containerDir: "/.codex",
      files: [{ hostPath: hostAuth, name: "auth.json", syncBack: true }],
    },
    parser: "codex-jsonl",
  });
  const warnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

  it("コンテナが止まったことを確かめられなければ書き戻さず、理由をデーモンのログに残す", async () => {
    const { existsSync } = await import("node:fs");
    const { DockerExecutor, RunningContainers } = await import("./docker.js");
    // ps は、いつまでもコンテナがあると答える（止まったことを確かめられない）
    const { bin, hostAuth } = await fakeDocker(
      `printf 'refreshed-token' > "$host/auth.json"
touch "$here/ready"
trap 'exit 137' TERM
while true; do sleep 0.05; done`,
      "echo still-running; exit 0",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const executor = new DockerExecutor(undefined, undefined, new RunningContainers(spawn, 10, 1));
    const running = executor.run({
      runId: "r71a",
      image: "img",
      workspaceDir: dir,
      invocation: invocation(hostAuth),
    });
    await waitFor(() => existsSync(join(bin, "ready")), {
      what: "偽の docker が認証ファイルを更新した合図（ready）",
      source: { name: "偽の docker の実行", ended: running },
    });
    executor.abortAll();
    const outcome = await running;

    expect(outcome).toMatchObject({
      kind: "failed",
      message: { code: "run.containerNotConfirmed" },
    });
    expect(readFileSync(hostAuth, "utf8")).toBe("old-token");
    const logged = warnings(warn);
    expect(logged).toContain("止まったことを確かめられないため");
    expect(logged).toContain(hostAuth);
    // 認証の値はログに出さない
    expect(logged).not.toContain("refreshed-token");
    expect(logged).not.toContain("old-token");
  });

  it("コンテナが認証ファイルをホストのほかのファイルへのリンクに差し替えても、その中身を書き戻さない", async () => {
    const { DockerExecutor } = await import("./docker.js");
    const { hostAuth } = await fakeDocker(
      `rm -f "$host/auth.json"
ln -s "$here/../other-host-file" "$host/auth.json"
echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'`,
    );
    writeFileSync(join(dir, "other-host-file"), "contents of another host file");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await new DockerExecutor().run({
      runId: "r71b",
      image: "img",
      workspaceDir: dir,
      invocation: invocation(hostAuth),
    });

    expect(outcome.kind).toBe("completed");
    expect(readFileSync(hostAuth, "utf8")).toBe("old-token");
    const logged = warnings(warn);
    expect(logged).toContain("通常のファイルとして読めない");
    expect(logged).not.toContain("contents of another host file");
    expect(logged).not.toContain("old-token");
  });
});

describe("コンテナで更新されたトークンの除去（偽のdockerコマンド）", () => {
  let dir: string;
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("更新後のトークンを出力に含めても作業履歴用の出力には残さず、ホストへは書き戻す", async () => {
    const { chmodSync, mkdirSync } = await import("node:fs");
    const { DockerExecutor } = await import("./docker.js");
    dir = mkdtempSync(join(tmpdir(), "sacty-fakedocker-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const newToken = "n".repeat(40);
    // 出力の JSON に、1 文字だけ Unicode エスケープしたトークンも書く（デコードすると元に戻る形。PBI-131）
    const message = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `new token is ${newToken} {"body":"\\u006e${newToken.slice(1)}"}`,
      },
    });
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
prev=""; host=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in *:/.codex*) host="\${a%%:/.codex*}";; esac
  fi
  prev="$a"
done
printf '{"tokens":{"access_token":"${newToken}"}}' > "$host/auth.json"
printf '%s\\n' '${message}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}'
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const hostAuth = join(dir, "auth.json");
    writeFileSync(hostAuth, JSON.stringify({ tokens: { access_token: "o".repeat(40) } }));
    const outcome = await new DockerExecutor().run({
      runId: "r2",
      image: "img",
      workspaceDir: dir,
      invocation: {
        command: ["codex"],
        env: { CODEX_HOME: "/.codex" },
        stage: {
          containerDir: "/.codex",
          files: [{ hostPath: hostAuth, name: "auth.json", syncBack: true }],
        },
        parser: "codex-jsonl",
      },
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.output).toBe('new token is [REDACTED] {"body":"[REDACTED]"}');
      expect(outcome.output).not.toContain(newToken);
    }
    expect(readFileSync(hostAuth, "utf8")).toContain(newToken);
  });

  it("ゲートウェイに届くよう、host.docker.internal を設定のホストのアドレスに向けて起動する（PBI-40）", async () => {
    const { chmodSync, mkdirSync } = await import("node:fs");
    const { DockerExecutor } = await import("./docker.js");
    dir = mkdtempSync(join(tmpdir(), "sacty-fakedocker-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // run：受け取った引数を残して、結果を返す
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
here=$(dirname "$0")
if [ "$1" != "run" ]; then exit 0; fi
printf '%s\\n' "$@" > "$here/args.txt"
echo '{"type":"result","is_error":false,"result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const addHost = async (invocation: Partial<Invocation>) => {
      await new DockerExecutor().run({
        runId: "r5",
        image: "img",
        workspaceDir: dir,
        invocation: { command: ["claude"], env: {}, parser: "claude-json", ...invocation },
      });
      const args = readFileSync(join(bin, "args.txt"), "utf8").split("\n");
      const i = args.indexOf("--add-host");
      return i < 0 ? undefined : args[i + 1];
    };
    expect(await addHost({})).toBeUndefined();
    expect(await addHost({ hostGateway: true })).toBe("host.docker.internal:host-gateway");
    expect(await addHost({ hostGateway: true, hostAddress: "192.168.5.2" })).toBe(
      "host.docker.internal:192.168.5.2",
    );
  });

  it("コンテキストを、マウントする設定のディレクトリに写してから実行する（PBI-6）", async () => {
    const { chmodSync, mkdirSync } = await import("node:fs");
    const { DockerExecutor } = await import("./docker.js");
    dir = mkdtempSync(join(tmpdir(), "sacty-fakedocker-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // run：設定のディレクトリにマウントされたものの一覧を残して、結果を返す
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
here=$(dirname "$0")
if [ "$1" != "run" ]; then exit 0; fi
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in *:/tmp/sacty-claude-config) host="\${a%%:/tmp/sacty-claude-config}"; (cd "$host" && find . -type f | sort) > "$here/seen.txt";; esac
  fi
  prev="$a"
done
echo '{"type":"result","is_error":false,"result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const ctx = join(dir, "ctx");
    mkdirSync(join(ctx, "skills", "review"), { recursive: true });
    writeFileSync(join(ctx, "CLAUDE.md"), "# 規約");
    writeFileSync(join(ctx, "skills", "review", "SKILL.md"), "スキル");
    const outcome = await new DockerExecutor().run({
      runId: "r2",
      image: "img",
      workspaceDir: dir,
      invocation: {
        command: ["claude"],
        env: { CLAUDE_CONFIG_DIR: "/tmp/sacty-claude-config" },
        stage: { containerDir: "/tmp/sacty-claude-config", files: [], seedDir: ctx },
        parser: "claude-json",
      },
    });
    expect(outcome.kind).toBe("completed");
    expect(readFileSync(join(bin, "seen.txt"), "utf8").trim().split("\n")).toEqual([
      "./CLAUDE.md",
      "./skills/review/SKILL.md",
    ]);
  });
});

describe("判定を読み取れなかったときの文言（PBI-11b レビュー指摘）", () => {
  it("sacty が補う説明はコードで返し、ゴールガーディアンが書いた理由はそのまま返す", async () => {
    const { extractVerdict, extractFinalReview } = await import("../prompts.js");
    const unreadable = extractVerdict("判定はありません");
    expect(unreadable).toEqual({
      verdict: "undecidable",
      reason: { code: "guardian.verdictUnreadable" },
    });
    expect(renderMessage(unreadable.reason, "en")).toBe(
      "Could not read a verdict from the Goal Guardian's output.",
    );
    expect(
      extractVerdict('```json\n{"sacty-verdict": {"verdict": "approved", "reason": "妥当"}}\n```'),
    ).toEqual({ verdict: "approved", reason: "妥当" });

    const none = extractFinalReview("出力なし", ["TV-1"], ["r-1"]);
    expect(none.viewpoints[0]?.reason).toEqual({ code: "review.unreadable" });
    expect(none.remarks[0]?.reason).toEqual({ code: "review.unreadable" });
    expect(none.summary).toEqual({ code: "review.unreadable" });
    const partial = extractFinalReview(
      '```json\n{"sacty-final-review": {"viewpoints": [{"id": "TV-1", "verified": true, "reason": "確認済み"}], "remarks": [], "summary": "所見"}}\n```',
      ["TV-1", "TV-2"],
      [],
    );
    expect(partial.viewpoints.map((v) => v.reason)).toEqual([
      "確認済み",
      { code: "review.verdictMissing" },
    ]);
    expect(renderMessage(partial.viewpoints[1]?.reason, "en")).toBe("No verdict was given.");
    expect(partial.summary).toBe("所見");
  });
});

describe("PR の指摘の戻し先の判断（PBI-14b）", () => {
  it("選べる工程のうちの戻し先と理由を読み、読めなければ判断できなかったものにする", async () => {
    const { extractRework } = await import("../prompts.js");
    const targets = ["implement", "design", "requirements"] as const;
    const block = (v: unknown) => `\`\`\`json\n${JSON.stringify({ "sacty-rework": v })}\n\`\`\``;
    expect(extractRework(block({ target: "design", reason: "観点" }), targets)).toEqual({
      target: "design",
      reason: "観点",
    });
    expect(extractRework(block({ target: "undecidable", reason: "不明" }), targets)).toEqual({
      reason: "不明",
    });
    // 選べない工程や、理由の無い判断は読まない
    expect(extractRework(block({ target: "pr", reason: "x" }), targets)).toEqual({
      reason: { code: "guardian.reworkUnreadable" },
    });
    expect(extractRework("出力なし", targets)).toEqual({
      reason: { code: "guardian.reworkUnreadable" },
    });
  });
});

describe("オーケストレーターの出力（PBI-17）", () => {
  it("候補の工程の組み合わせと理由を読み、候補に無いもの・理由の無いものは読まない", async () => {
    const { extractStepPlan } = await import("../prompts.js");
    const block = (v: unknown) => `\`\`\`json\n${JSON.stringify({ "sacty-steps": v })}\n\`\`\``;
    expect(extractStepPlan(block({ plan: "skip-design", reason: "小さい" }))).toEqual({
      plan: "skip-design",
      reason: "小さい",
    });
    expect(extractStepPlan(block({ plan: "investigate", reason: "質問" }))).toEqual({
      plan: "investigate",
      reason: "質問",
    });
    expect(extractStepPlan(block({ plan: "everything", reason: "x" }))).toBeUndefined();
    expect(extractStepPlan(block({ plan: "standard", reason: "" }))).toBeUndefined();
    expect(extractStepPlan("出力なし")).toBeUndefined();
  });
});

describe("オーケストレーターのセッションの再開（PBI-67）", () => {
  const claude: AgentConfig = {
    ...base,
    id: "c",
    runtime: "claude-code",
    auth: { mode: "subscription", secret: "claude-oauth-token" },
  };
  const codex: AgentConfig = {
    ...base,
    id: "x",
    runtime: "codex",
    auth: { mode: "api-key", secret: "openai-key" },
    model: "gpt-x",
  };
  const session = { resume: "abc-123", filesDir: "/host/sessions/t/orchestrator/files" };

  it("Claude Code：--resume で再開し、複製なら --fork-session を足す。戻すファイルの場所を渡す", async () => {
    const plain = await buildInvocation(claude, "prompt", secrets, () => {}, "orchestrator");
    expect(plain.command).not.toContain("--resume");
    expect(plain.resumed).toBeUndefined();
    expect(plain.stage?.sessionDir).toBeUndefined();

    const resumed = await buildInvocation(
      claude,
      "prompt",
      secrets,
      () => {},
      "orchestrator",
      undefined,
      undefined,
      session,
    );
    const i = resumed.command.indexOf("--resume");
    expect(resumed.command[i + 1]).toBe("abc-123");
    expect(resumed.command).not.toContain("--fork-session");
    // 再開した実行の modelUsage には前の実行の分も入るので、使用量は各 result の usage から数える（PBI-154）
    expect(resumed.resumed).toBe(true);
    // 指示は、これまでどおり -p の指示として、標準入力で渡す（PBI-149）
    expect(resumed.command.slice(0, 3)).toEqual(["claude", "-p", "--output-format"]);
    expect(resumed.stdin).toBe("prompt");
    expect(resumed.stage).toEqual({
      containerDir: "/tmp/sacty-claude-config",
      files: [],
      sessionDir: session.filesDir,
    });

    const forked = await buildInvocation(
      claude,
      "prompt",
      secrets,
      () => {},
      "chat",
      undefined,
      undefined,
      { ...session, fork: true },
    );
    expect(forked.command).toContain("--fork-session");
    expect(forked.resumed).toBe(true);
    expect(forked.command[forked.command.indexOf("--resume") + 1]).toBe("abc-123");
  });

  it("Codex：`codex exec <オプション> resume <ID> -- -` で再開し、指示は標準入力で渡す（複製の引数は無い）", async () => {
    const plain = await buildInvocation(codex, "prompt", secrets, () => {}, "orchestrator");
    expect(plain.command).not.toContain("resume");
    const resumed = await buildInvocation(
      codex,
      "prompt",
      secrets,
      () => {},
      "chat",
      undefined,
      undefined,
      { ...session, fork: true },
    );
    expect(resumed.command.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(resumed.command.slice(-4)).toEqual(["resume", "abc-123", "--", "-"]);
    expect(resumed.stdin).toBe("prompt");
    // オプションは resume より前（exec のオプションとして読ませる）
    const at = resumed.command.indexOf("resume");
    for (const option of ["--json", "--skip-git-repo-check", "--sandbox", "--model"]) {
      expect(resumed.command.indexOf(option)).toBeGreaterThan(0);
      expect(resumed.command.indexOf(option)).toBeLessThan(at);
    }
    expect(resumed.stage).toMatchObject({ containerDir: "/.codex", sessionDir: session.filesDir });
  });

  it("Codex：`-` で始まる指示（`--- メモリー ---` など）も、引数に入れずに標準入力でそのまま渡す（PBI-149）", async () => {
    const prompt = "--- メモリー ---\n本文";
    const inv = await buildInvocation(codex, prompt, secrets, () => {}, "orchestrator");
    expect(inv.command.slice(-2)).toEqual(["--", "-"]);
    expect(inv.command).not.toContain(prompt);
    expect(inv.stdin).toBe(prompt);
  });

  it("大きな指示（1つの引数の上限 128 KiB を超える）も、引数に入れない（PBI-149）", async () => {
    const prompt = "差分".repeat(100_000);
    for (const agent of [claude, codex]) {
      const inv = await buildInvocation(agent, prompt, secrets, () => {}, "final-review");
      expect(inv.stdin).toBe(prompt);
      // どの引数も上限より十分小さい
      expect(Math.max(...inv.command.map((a) => Buffer.byteLength(a)))).toBeLessThan(10_000);
    }
  });

  it("スタブは再開しない", async () => {
    const stub: AgentConfig = { ...base, id: "s", runtime: "stub", auth: { mode: "stub" } };
    const inv = await buildInvocation(
      stub,
      "prompt",
      secrets,
      () => {},
      "orchestrator",
      undefined,
      undefined,
      session,
    );
    expect(inv.stage).toBeUndefined();
    expect(inv.command).not.toContain("--resume");
  });

  describe("偽の docker コマンド", () => {
    let dir: string;
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    });

    const fakeDocker = async () => {
      const { chmodSync, mkdirSync } = await import("node:fs");
      dir = mkdtempSync(join(tmpdir(), "sacty-fakedocker-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      // run：設定の場所に置かれたファイルの一覧を残し、セッションに書き足して（再開と同じ）、結果を返す
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/sh
here=$(dirname "$0")
if [ "$1" != "run" ]; then exit 0; fi
echo ran >> "$here/runs.txt"
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in *:/tmp/sacty-claude-config) host="\${a%%:/tmp/sacty-claude-config}"; (cd "$host" && find . -type f | sort) > "$here/seen.txt"; echo '{"added":true}' >> "$host/projects/-workspace/abc-123.jsonl";; esac
  fi
  prev="$a"
done
echo '{"type":"result","is_error":false,"result":"ok","session_id":"abc-123","usage":{"input_tokens":1,"output_tokens":1}}'
`,
      );
      chmodSync(join(bin, "docker"), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      return bin;
    };

    it("保存したセッションを、コンテキストの後に設定の場所へ写して実行する。保存した元のファイルは書き換えない", async () => {
      const { mkdirSync } = await import("node:fs");
      const { DockerExecutor } = await import("./docker.js");
      const bin = await fakeDocker();
      const ctx = join(dir, "ctx");
      mkdirSync(ctx, { recursive: true });
      writeFileSync(join(ctx, "CLAUDE.md"), "# 規約");
      const files = join(dir, "store");
      mkdirSync(join(files, "projects", "-workspace"), { recursive: true });
      writeFileSync(join(files, "projects", "-workspace", "abc-123.jsonl"), '{"turn":1}\n');
      const outcome = await new DockerExecutor().run({
        runId: "r67",
        image: "img",
        workspaceDir: dir,
        invocation: {
          command: ["claude"],
          env: {},
          stage: {
            containerDir: "/tmp/sacty-claude-config",
            files: [],
            seedDir: ctx,
            sessionDir: files,
          },
          parser: "claude-json",
        },
      });
      expect(outcome.kind).toBe("completed");
      expect(readFileSync(join(bin, "seen.txt"), "utf8").trim().split("\n")).toEqual([
        "./CLAUDE.md",
        "./projects/-workspace/abc-123.jsonl",
      ]);
      // コンテナが書き足したのは、実行ごとの写し（保存した元は変わらない）
      expect(readFileSync(join(files, "projects", "-workspace", "abc-123.jsonl"), "utf8")).toBe(
        '{"turn":1}\n',
      );
    });

    it("保存したセッションを戻せなければ、コンテナを起動せずに失敗にする", async () => {
      const { existsSync } = await import("node:fs");
      const { DockerExecutor } = await import("./docker.js");
      const bin = await fakeDocker();
      const outcome = await new DockerExecutor().run({
        runId: "r68",
        image: "img",
        workspaceDir: dir,
        invocation: {
          command: ["claude"],
          env: {},
          stage: {
            containerDir: "/tmp/sacty-claude-config",
            files: [],
            sessionDir: join(dir, "missing"),
          },
          parser: "claude-json",
        },
      });
      expect(outcome).toMatchObject({ kind: "failed", reason: "error" });
      expect(outcome.kind === "failed" && ja(outcome.message)).toContain(
        "オーケストレーターのセッションを、実行の設定の場所に戻せませんでした",
      );
      expect(outcome.usage).toBeUndefined();
      expect(existsSync(join(bin, "runs.txt"))).toBe(false);
    });
  });
});

describe("再開の拒否の判定（PBI-67 レビュー指摘。本物の出力）", () => {
  it("Claude Code 2.1.296・Codex 0.160.0 が、無いセッションの再開を断ったときの出力を、再開の拒否と読む", async () => {
    const { resumeRejected } = await import("../service.js");
    // sacty-agent のイメージで、認証なしに `claude -p hi --output-format stream-json --verbose --resume <無い ID>` を実行した出力
    const id = "0b1c2d3e-0000-4000-8000-000000000000";
    const claude = parseClaudeResult(
      `${JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 0,
        session_id: id,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
        errors: [`No conversation found with session ID: ${id}`],
      })}\n`,
      1,
      `No conversation found with session ID: ${id}\n`,
    );
    expect(claude).toMatchObject({ kind: "failed", reason: "error" });
    expect(resumeRejected("claude-code", claude)).toBe(true);
    expect(resumeRejected("codex", claude)).toBe(false);
    // `codex exec --json … resume <無い ID> hi` の出力（標準出力は空、標準エラー出力に理由。終了コード 1）
    const codex = parseCodexEvents(
      "",
      1,
      `Error: thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)\n`,
    );
    expect(codex).toMatchObject({ kind: "failed", reason: "error" });
    expect(resumeRejected("codex", codex)).toBe(true);
    expect(resumeRejected("claude-code", codex)).toBe(false);
    // ほかの失敗は、再開の拒否ではない
    expect(resumeRejected("claude-code", parseClaudeResult("", 137, "Killed\n"))).toBe(false);
    expect(resumeRejected("codex", parseCodexEvents("", 1, "Error: stream disconnected\n"))).toBe(
      false,
    );
  });
});

describe("エージェントの段階（PBI-119）", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  // 接続先は両方。単価は、claude は sonnet だけ、codex は luna だけ（PBI-134）
  const base = `providers:
  claude:
    auth: { mode: subscription, secret: claude-oauth-token }
    available_models:
      claude-sonnet-5-5: { input: 3, cached_input: 0.3, output: 15 }
  codex:
    auth: { mode: api-key, secret: openai-key }
    available_models:
      gpt-6-luna: { input: 1, cached_input: 0.1, output: 2 }
agents:
`;

  it("claude_<段階>・codex_<段階> を、runtime ごと・段階ごとの段階のエージェントとして読む（単価のあるものだけ）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    writeFileSync(
      join(dir, "config.yaml"),
      `${base}  codex_other:
    runtime: codex
    model: gpt-6-luna
`,
    );
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    expect(Object.keys(result.config.tierAgents?.["claude-code"] ?? {})).toEqual([
      "entry",
      "standard",
    ]);
    expect(result.config.tierAgents?.["claude-code"]?.standard).toMatchObject({
      id: "claude_standard",
      model: "claude-sonnet-5-5",
      reasoning_effort: "medium",
    });
    expect(result.config.tierAgents?.codex?.lite).toMatchObject({
      id: "codex_lite",
      model: "gpt-6-luna",
      reasoning_effort: "low",
    });
    // 段階の名前でないもの（codex_other）は、普通のエージェント
    expect(result.config.agents?.codex_other).toMatchObject({ runtime: "codex" });
    expect(Object.keys(result.config.tierAgents?.codex ?? {})).toEqual(["lite", "entry"]);
  });

  it("段階の名前の接頭辞と runtime が合わなければ、どの項目かを示して止める", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    writeFileSync(join(dir, "config.yaml"), `${base}  claude_lite:\n    runtime: codex\n`);
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = renderMessage(result.problem, "ja");
    expect(text).toContain("agents.claude_lite.runtime");
    expect(text).toContain('"claude_lite" は段階のエージェントなので、runtime を claude-code に');
  });

  it("雛形の providers.claude の例のコメントを外すと、両ツールの 5 段階すべてが使える（PBI-119・PBI-134）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const lines = CONFIG_TEMPLATE.split("\n");
    const start = lines.indexOf("  # claude:");
    expect(start).toBeGreaterThan(0);
    const end = lines.findIndex((l, i) => i > start && !l.startsWith("  #"));
    const yaml = lines
      .map((l, i) => (i >= start && i < end ? l.replace(/^ {2}# ?/, "  ") : l))
      .join("\n");
    writeFileSync(join(dir, "config.yaml"), yaml);
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    const all = ["lite", "entry", "standard", "advanced", "ultimate"];
    expect(Object.keys(result.config.tierAgents?.["claude-code"] ?? {})).toEqual(all);
    expect(Object.keys(result.config.tierAgents?.codex ?? {})).toEqual(all);
    expect(result.config.tierAgents?.["claude-code"]?.ultimate).toMatchObject({
      model: "claude-opus-5-5",
      reasoning_effort: "high",
      auth: { mode: "subscription", secret: "claude-oauth-token" },
    });
    expect(result.config.agentWarnings).toEqual([]);
    // 既定の工程の AI は、providers.codex があるので codex_standard のまま
    expect(result.config.defaultAgent.id).toBe("codex_standard");
  });
});
