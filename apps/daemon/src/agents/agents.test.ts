import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentConfig, agentFor, CONFIG_TEMPLATE, loadConfig } from "../config.js";
import { MemorySecretStore } from "../secrets.js";
import { dockerRunArgs, syncBackIfChanged } from "./docker.js";
import { buildInvocation, type Invocation } from "./invocation.js";
import { classifyFailure, parseClaudeResult, parseCodexEvents } from "./parse.js";

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
    expect(claude.command.slice(6)).toEqual([
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
    expect(inv.command.slice(3, 6)).toEqual(["--output-format", "stream-json", "--verbose"]);
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
      "prompt",
    ]);
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
      "prompt",
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
    expect(mantle.command.slice(-3)).toEqual(["--model", "openai.gpt-6-sol", "prompt"]);
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

  it("`sacty config init` の雛形はそのまま読める", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    writeFileSync(join(dir, "config.yaml"), CONFIG_TEMPLATE);
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultAgent.id).toBe("claude-subscription");
      expect(result.config.budgetPerTaskUsd).toBe(1);
      expect(result.config.defaultAgent.price).toEqual({
        input: 3,
        cachedInput: 0.3,
        cacheWrite: 3.75,
        output: 15,
      });
    }
  });

  it("秘密情報には 1Password の参照も書け、使うアカウントを読む（PBI-34）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (secret: string, extra = "") =>
      writeFileSync(
        join(dir, "config.yaml"),
        `default_agent: x
agents:
  x:
    runtime: codex
    auth: { mode: bedrock, secret: "${secret}", region: us-east-2 }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
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

  it("providers の接続先・エージェントごとのモデルとリーズニングエフォート・工程ごとのエージェントを読む（PBI-40）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    const base = `providers:
  corp-gw:
    base_url: https://ai-gw.example.com/llm/v1/
    secret: op://Work/AI-GW/api-key
    via_gateway: true
agents:
  sol-high:
    runtime: codex
    provider: corp-gw
    model: gpt-6-sol
    reasoning_effort: high
    price_per_mtok_usd: { input: 2, cached_input: 0.2, output: 12 }
  luna-low:
    runtime: codex
    provider: corp-gw
    model: gpt-6-luna
    reasoning_effort: low
    price_per_mtok_usd: { input: 0.3, cached_input: 0.03, output: 1.5 }
`;
    write(`${base}default_agent: luna-low
guardian_agent: sol-high
step_agents:
  orchestrator: luna-low
  design: sol-high
`);
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    const sol = result.config.stepAgents?.design;
    expect(sol).toMatchObject({
      id: "sol-high",
      model: "gpt-6-sol",
      reasoning_effort: "high",
      auth: { mode: "provider", provider: "corp-gw" },
      endpoint: {
        name: "corp-gw",
        baseUrl: "https://ai-gw.example.com/llm/v1",
        secret: "op://Work/AI-GW/api-key",
        viaGateway: true,
      },
      price: { input: 2, cachedInput: 0.2, output: 12 },
    });
    // 工程ごとに書いたものはそれ、書いていなければ default_agent（統合レビューは guardian_agent）
    expect(agentFor(result.config, "design").id).toBe("sol-high");
    expect(agentFor(result.config, "orchestrator").id).toBe("luna-low");
    expect(agentFor(result.config, "implement").id).toBe("luna-low");
    expect(agentFor(result.config, "integrate").id).toBe("sol-high");

    const problem = (yaml: string) => {
      write(yaml);
      const r = loadConfig(dir);
      return r.ok ? "" : ja(r.problem);
    };
    expect(problem(`${base}default_agent: luna-low\nstep_agents:\n  design: nope\n`)).toContain(
      'step_agents.design の "nope" が agents にありません',
    );
    expect(
      problem(
        `${base.replace("provider: corp-gw\n    model: gpt-6-sol", "provider: other\n    model: gpt-6-sol")}default_agent: luna-low\n`,
      ),
    ).toContain('providers に "other" がありません');
    expect(
      problem(
        `${base.replace("reasoning_effort: high", "reasoning_effort: HIGH!")}default_agent: luna-low\n`,
      ),
    ).toContain("リーズニングエフォート");
    // 接続先は、いまは Codex だけ
    expect(
      problem(
        `${base.replace("runtime: codex\n    provider: corp-gw\n    model: gpt-6-sol", "runtime: claude-code\n    provider: corp-gw\n    model: gpt-6-sol")}default_agent: luna-low\n`,
      ),
    ).toContain("claude-code では provider を使えません");
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
    auth: { mode: stub }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
${extra}`,
      );
    write("");
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { imageBuild: {} } });
    write(`image_build:
  base_image: registry.example.com/library/node:22-bookworm-slim
  npm_registry: https://npm.example.com/repository/npm/
  npm_token: npm-token
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        imageBuild: {
          baseImage: "registry.example.com/library/node:22-bookworm-slim",
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
    auth: { mode: stub }
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
    node_image: registry.example.com/library/node:22
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        images: {
          java17: {
            name: "java17",
            // 書かなければ sacty-agent-<名前>:<既定のイメージの版>
            image: "sacty-agent-java17:0.1.0",
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
            nodeImage: "registry.example.com/library/node:22",
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

  it("ゲートウェイ経由は Codex × Bedrock だけ。リトライの上限を読み、書かなければ既定にする（PBI-37）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    const agentYaml = (runtime: string, auth: string) => `default_agent: x
agents:
  x:
    runtime: ${runtime}
    auth: ${auth}
    via_gateway: true
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
`;
    write(agentYaml("codex", "{ mode: api-key, secret: k }"));
    const result = loadConfig(dir);
    expect(result.ok ? "" : ja(result.problem)).toBe(
      "設定ファイルに誤りがあります（agents.x.via_gateway）：ゲートウェイ経由（via_gateway）は、いまは Codex × Bedrock（auth.mode: bedrock）だけで使えます。",
    );
    write(agentYaml("codex", "{ mode: bedrock, secret: k, region: us-east-2 }"));
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        defaultAgent: { via_gateway: true },
        gatewayRetry: { maxAttempts: 8, maxWaitMs: 600_000 },
      },
    });
    write(
      `${agentYaml("codex", "{ mode: bedrock, secret: k, region: us-east-2 }")}gateway:\n  retry:\n    max_attempts: 3\n    max_wait_sec: 30\n`,
    );
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: { gatewayRetry: { maxAttempts: 3, maxWaitMs: 30_000 }, hostAddress: "host-gateway" },
    });
    // コンテナから見たホストのアドレス（Rancher Desktop。PBI-40）
    write(
      `${agentYaml("codex", "{ mode: bedrock, secret: k, region: us-east-2 }")}gateway:\n  host_address: 192.168.5.2\n`,
    );
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { hostAddress: "192.168.5.2" } });
    // docker の引数に紛れ込むものは書けない
    write(
      `${agentYaml("codex", "{ mode: bedrock, secret: k, region: us-east-2 }")}gateway:\n  host_address: "1.2.3.4 --privileged"\n`,
    );
    const bad = loadConfig(dir);
    expect(bad.ok ? "" : ja(bad.problem)).toContain(
      "gateway.host_address は、ホスト名か IP アドレス",
    );
  });

  it("雛形の Codex × Bedrock の例は、コメントを外せばそのまま読める（PBI-32）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const lines = CONFIG_TEMPLATE.split("\n");
    const start = lines.indexOf("  # codex-bedrock:");
    const end = lines.findIndex((l, i) => i > start && l.trim() === "");
    const example = lines.slice(start, end).map((l) => l.replace(/^ {2}# ?/, "  "));
    const yaml = CONFIG_TEMPLATE.replace(
      "default_agent: claude-subscription",
      "default_agent: codex-bedrock",
    ).replace("\nagents:\n", `\nagents:\n${example.join("\n")}\n`);
    writeFileSync(join(dir, "config.yaml"), yaml);
    const result = loadConfig(dir);
    expect(result).toMatchObject({
      ok: true,
      config: {
        defaultAgent: {
          id: "codex-bedrock",
          runtime: "codex",
          auth: { mode: "bedrock", secret: "bedrock-api-key", endpoint: "runtime" },
        },
      },
    });
  });

  it("雛形の providers・接続先を使うエージェント・step_agents の例は、コメントを外せばそのまま読める（PBI-40）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const lines = CONFIG_TEMPLATE.split("\n");
    const block = (first: string) => {
      const start = lines.indexOf(first);
      const end = lines.findIndex((l, i) => i > start && !l.trimStart().startsWith("#"));
      return lines.slice(start, end).map((l) => l.replace(/^( *)# ?/, "$1"));
    };
    const providers = block("# providers:");
    const agentExample = block("  # sol-high:");
    const stepAgents = block("# step_agents:").map((l) =>
      l.replaceAll("luna-low", "sol-high").replaceAll("sol-medium", "sol-high"),
    );
    const yaml = CONFIG_TEMPLATE.replace(
      "default_agent: claude-subscription",
      "default_agent: sol-high",
    ).replace(
      "\nagents:\n",
      `\n${providers.join("\n")}\n${stepAgents.join("\n")}\nagents:\n${agentExample.join("\n")}\n`,
    );
    writeFileSync(join(dir, "config.yaml"), yaml);
    const result = loadConfig(dir);
    if (!result.ok) throw new Error(ja(result.problem));
    expect(result.config.defaultAgent).toMatchObject({
      id: "sol-high",
      reasoning_effort: "high",
      endpoint: { name: "corp-gw", viaGateway: true },
    });
    expect(result.config.stepAgents?.design?.id).toBe("sol-high");
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

  it("使えない認証方式の組み合わせや、存在しない既定のAIは理由つきで拒否する", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    write(`default_agent: x
agents:
  x:
    runtime: codex
    auth: { mode: stub }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
`);
    const problem = () => {
      const result = loadConfig(dir);
      return result.ok ? "" : ja(result.problem);
    };
    expect(problem()).toBe(
      "設定ファイルに誤りがあります（agents.x.auth.mode）：codex では stub を使えません（使えるもの：subscription, api-key, bedrock, provider）。",
    );
    // コードと引数で返す（画面が画面の言語の文にする）
    expect(loadConfig(dir)).toMatchObject({
      ok: false,
      problem: {
        code: "config.invalid",
        params: {
          detail: { code: "config.authUnsupported", params: { runtime: "codex", mode: "stub" } },
        },
      },
    });
    expect(renderMessage((loadConfig(dir) as { problem: unknown }).problem, "en")).toBe(
      "The config file has an error (agents.x.auth.mode): codex cannot use stub (supported: subscription, api-key, bedrock, provider).",
    );
    // Bedrock の接続先は Codex だけ（Claude Code に書いても使われないので、誤りとして知らせる。PBI-32）
    write(`default_agent: x
agents:
  x:
    runtime: claude-code
    auth: { mode: bedrock, secret: k, region: us-east-1, endpoint: mantle }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
`);
    expect(problem()).toBe(
      "設定ファイルに誤りがあります（agents.x.auth.endpoint）：Bedrock の接続先（endpoint）は Codex だけで選べます。Claude Code では書かないでください。",
    );
    write(`default_agent: x
agents:
  x:
    runtime: codex
    model: global.openai.gpt-6-sol
    auth: { mode: bedrock, secret: k, region: us-east-2, endpoint: runtime }
    price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: true,
      config: {
        defaultAgent: { runtime: "codex", auth: { mode: "bedrock", endpoint: "runtime" } },
      },
    });
    write(`default_agent: missing
agents: {}
`);
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
    // 偽dockerが認証ファイルを更新するまで待ってから止める
    for (let i = 0; i < 100 && !existsSync(join(bin, "staging.path")); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100));
    executor.abortAll();
    const outcome = await running;

    expect(outcome).toMatchObject({ kind: "failed", message: { code: "run.daemonStopped" } });
    expect(outcome.kind === "failed" && ja(outcome.message)).toContain("中断");
    expect(readFileSync(hostAuth, "utf8")).toBe("refreshed-token");
    const staging = readFileSync(join(bin, "staging.path"), "utf8").trim();
    expect(existsSync(staging)).toBe(false);
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
    while (!existsSync(join(bin, "ready"))) await new Promise((r) => setTimeout(r, 20));
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
echo '{"type":"item.completed","item":{"type":"agent_message","text":"new token is ${newToken}"}}'
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
      expect(outcome.output).toBe("new token is [REDACTED]");
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
