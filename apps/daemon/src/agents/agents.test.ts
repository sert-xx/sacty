import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentConfig, CONFIG_TEMPLATE, loadConfig } from "../config.js";
import { MemorySecretStore } from "../secrets.js";
import { dockerRunArgs, syncBackIfChanged } from "./docker.js";
import { buildInvocation } from "./invocation.js";
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
    expect((await buildInvocation(claude, "prompt", secrets)).stage).toBeUndefined();
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
      containerDir: "/tmp/sacty-codex-home",
      seedDir: "/host/ctx",
    });
    expect(codexInv.env.CODEX_HOME).toBe("/tmp/sacty-codex-home");
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
    expect(claude.command.slice(5)).toEqual([
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
    // 要求要件・設計の工程は、作業領域を読み取り専用でマウントする（PBI-15）
    expect(
      dockerRunArgs({
        runId: "r2",
        image: "sacty-agent:test",
        workspaceDir: "/ws/snap",
        readOnlyWorkspace: true,
        envNames: [],
        mounts: [],
        command: ["claude"],
      }),
    ).toContain("/ws/snap:/workspace:ro");
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
    const problem = () => {
      const result = loadConfig(dir);
      return result.ok ? "" : ja(result.problem);
    };
    expect(problem()).toBe(
      "設定ファイルに誤りがあります（agents.x.auth.mode）：codex では bedrock を使えません（使えるもの：subscription, api-key）。",
    );
    // コードと引数で返す（画面が画面の言語の文にする）
    expect(loadConfig(dir)).toMatchObject({
      ok: false,
      problem: {
        code: "config.invalid",
        params: {
          detail: { code: "config.authUnsupported", params: { runtime: "codex", mode: "bedrock" } },
        },
      },
    });
    expect(renderMessage((loadConfig(dir) as { problem: unknown }).problem, "en")).toBe(
      "The config file has an error (agents.x.auth.mode): codex cannot use bedrock (supported: subscription, api-key).",
    );
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
    case "$a" in *:/tmp/sacty-codex-home*) host="\${a%%:/tmp/sacty-codex-home*}";; esac
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
        env: { CODEX_HOME: "/tmp/sacty-codex-home" },
        stage: {
          containerDir: "/tmp/sacty-codex-home",
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
    case "$a" in *:/tmp/sacty-codex-home*) host="\${a%%:/tmp/sacty-codex-home*}";; esac
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
        env: { CODEX_HOME: "/tmp/sacty-codex-home" },
        stage: {
          containerDir: "/tmp/sacty-codex-home",
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
