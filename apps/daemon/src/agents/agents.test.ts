import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentConfig, CONFIG_TEMPLATE, loadConfig } from "../config.js";
import { MemorySecretStore } from "../secrets.js";
import { dockerRunArgs, syncBackIfChanged } from "./docker.js";
import { buildInvocation } from "./invocation.js";
import { classifyFailure, parseClaudeResult, parseCodexEvents } from "./parse.js";

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
    expect(inv.command).toContain("--output-format");
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
    expect(sub.env).toEqual({ CODEX_HOME: "/tmp/sacty-codex-home" });
    expect(sub.stage).toEqual({
      containerDir: "/tmp/sacty-codex-home",
      files: [{ hostPath: "/path/auth.json", name: "auth.json", syncBack: true }],
    });
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
    // イメージの後ろにコマンドが続く
    expect(args.slice(args.indexOf("sacty-agent:test") + 1)).toEqual(["claude", "-p", "prompt"]);
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
  });
});

describe("設定ファイル", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
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

  it("使えない認証方式の組み合わせや、存在しない既定のAIは理由つきで拒否する", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-config-"));
    const write = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);
    write(`default_agent: x
agents:
  x:
    runtime: codex
    auth: { mode: bedrock, secret: k, region: us-east-1 }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("bedrock"),
    });
    write(`default_agent: missing
agents: {}
`);
    expect(loadConfig(dir)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("missing"),
    });
    write("default_agent: [unclosed");
    expect(loadConfig(dir)).toMatchObject({ ok: false, problem: expect.stringContaining("YAML") });
  });
});

describe("認証ファイルの書き戻し", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("コンテナで更新され、ホストが変わっていなければ書き戻す", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-sync-"));
    const host = join(dir, "auth.json");
    const staged = join(dir, "staged.json");
    writeFileSync(host, "old");
    writeFileSync(staged, "refreshed");
    expect(syncBackIfChanged(host, staged, sha("old"))).toBe("written");
    expect(readFileSync(host, "utf8")).toBe("refreshed");
  });

  it("コンテナで変わっていなければ何もしない", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-sync-"));
    const host = join(dir, "auth.json");
    const staged = join(dir, "staged.json");
    writeFileSync(host, "old");
    writeFileSync(staged, "old");
    expect(syncBackIfChanged(host, staged, sha("old"))).toBe("unchanged");
  });

  it("実行中にホスト側が変わっていたら、利用者の操作を優先して書き戻さない", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-sync-"));
    const host = join(dir, "auth.json");
    const staged = join(dir, "staged.json");
    writeFileSync(host, "re-login by user");
    writeFileSync(staged, "refreshed");
    expect(syncBackIfChanged(host, staged, sha("old"))).toBe("host-changed");
    expect(readFileSync(host, "utf8")).toBe("re-login by user");
  });
});
