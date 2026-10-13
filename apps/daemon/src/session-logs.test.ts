import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerExecutor } from "./agents/docker.js";
import { parseClaudeResult, parseCodexEvents } from "./agents/parse.js";
import { SessionLogStore, StreamRedactor, TRUNCATED_EVENT, validLogId } from "./session-logs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-session-logs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
const usage = {
  input_tokens: 10,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 30,
  output_tokens: 40,
};

describe("Claude Code の stream-json の読み取り（PBI-62）", () => {
  const init = { type: "system", subtype: "init", session_id: "s", model: "claude", tools: [] };
  const assistant = (content: unknown[]) => ({
    type: "assistant",
    message: { role: "assistant", content },
    session_id: "s",
  });
  const toolResult = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }],
    },
  };

  it("途中の出来事の後の、最後の result から出力と使用量を読む", () => {
    const stdout = jsonl(
      init,
      assistant([{ type: "thinking", thinking: "考える" }]),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      toolResult,
      assistant([{ type: "text", text: "途中の発言" }]),
      { type: "result", subtype: "success", is_error: false, result: "# 要求要件", usage },
    );
    expect(parseClaudeResult(`${stdout}\n`, 0)).toEqual({
      kind: "completed",
      output: "# 要求要件",
      usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
    });
  });

  it("失敗の result を、利用上限・認証・その他に分類する", () => {
    const fail = (result: string) =>
      parseClaudeResult(
        jsonl(init, assistant([{ type: "text", text: result }]), {
          type: "result",
          subtype: "success",
          is_error: true,
          result,
          usage,
        }),
        1,
      );
    expect(fail("Claude AI usage limit reached|1760000000")).toMatchObject({
      kind: "failed",
      reason: "usage_limit",
      usage: { input: 10 },
    });
    expect(fail("Invalid API key · Please run /login")).toMatchObject({
      kind: "failed",
      reason: "auth",
      message: "Invalid API key · Please run /login",
    });
    expect(fail("something broke")).toMatchObject({ kind: "failed", reason: "error" });
  });

  it("result の文が無い失敗（error_max_turns など）は、errors か種類を理由にする", () => {
    expect(
      parseClaudeResult(
        jsonl(init, { type: "result", subtype: "error_max_turns", is_error: true, usage }),
        1,
      ),
    ).toMatchObject({ kind: "failed", reason: "error", message: "error_max_turns" });
    expect(
      parseClaudeResult(
        jsonl({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["API Error: 429 rate limit"],
        }),
        1,
      ),
    ).toMatchObject({
      kind: "failed",
      reason: "usage_limit",
      message: "API Error: 429 rate limit",
    });
  });

  it("result が無い（途中で落ちた）ときは、途中の出来事を成功として読まず、失敗にする", () => {
    const events = jsonl(init, assistant([{ type: "text", text: "作業中" }]));
    // 終了コードが 0 でも、最後の答えが無いので失敗
    expect(parseClaudeResult(events, 0)).toMatchObject({ kind: "failed", message: "作業中" });
    // 標準エラー出力があれば、それを理由にする
    expect(parseClaudeResult(events, 1, "OAuth token has expired")).toMatchObject({
      kind: "failed",
      reason: "auth",
      message: "OAuth token has expired",
    });
    // 発言も標準エラー出力も無ければ、JSON の行そのものではなく終了コードを理由にする
    expect(parseClaudeResult(jsonl(init), 137)).toMatchObject({
      kind: "failed",
      message: "exit code 137",
    });
  });

  it("これまでの json の形（type の無い1つのオブジェクト・整形した JSON）も読む", () => {
    expect(parseClaudeResult(JSON.stringify({ result: "ok", usage }), 0)).toMatchObject({
      kind: "completed",
      output: "ok",
    });
    expect(
      parseClaudeResult(JSON.stringify({ type: "result", result: "ok", usage }, null, 2), 0),
    ).toMatchObject({ kind: "completed", output: "ok" });
  });

  it("Codex の途中の出来事（コマンドの実行・考えたこと）があっても、最後の答えと使用量はこれまでどおり", () => {
    const stdout = jsonl(
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i0", type: "reasoning", text: "考える" } },
      {
        type: "item.started",
        item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" },
      },
      {
        type: "item.completed",
        item: { id: "i1", type: "command_execution", command: "ls", exit_code: 0 },
      },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: "答え" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 },
      },
    );
    expect(parseCodexEvents(stdout, 0)).toEqual({
      kind: "completed",
      output: "答え",
      usage: { input: 60, cacheRead: 40, cacheWrite: 0, output: 5 },
    });
  });
});

describe("流れてくる出力からの秘密情報の除去（PBI-62）", () => {
  const secret = "sk-ant-oat01-ABCDEFGHIJKLMNOP";

  it("値が届いた分の境目をまたいでも、どこで切れても伏せる", () => {
    const text = `{"type":"assistant","text":"token=${secret}"}\n{"type":"x"}\n`;
    for (let cut = 1; cut < text.length; cut++) {
      const r = new StreamRedactor(() => [secret]);
      const written = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.flush();
      expect(written).not.toContain(secret);
      expect(written).toBe(text.replace(secret, "[REDACTED]"));
    }
  });

  it("1文字ずつ届いても伏せ、行をまたいだ出来事にも漏らさない", () => {
    const text = `a${secret}\n${secret}b\n`;
    const r = new StreamRedactor(() => [secret]);
    let written = "";
    for (const ch of text) written += r.push(ch);
    written += r.flush();
    expect(written).toBe("a[REDACTED]\n[REDACTED]b\n");
  });

  it("JSON の文字列の中でエスケープされた形の値も伏せる", () => {
    const odd = 'pa"ss\\word-1234567';
    const line = JSON.stringify({ text: `key ${odd}` });
    const r = new StreamRedactor(() => [odd]);
    const written = r.push(line) + r.flush();
    expect(written).not.toContain(JSON.stringify(odd).slice(1, -1));
    expect(written).toContain("[REDACTED]");
  });
});

describe("セッションログの保存（PBI-62）", () => {
  const info = {
    taskId: "task-1",
    runId: "run-1",
    role: "design",
    agentId: "claude",
    runtime: "claude-code",
    authMode: "subscription",
  };

  it("途中の出来事と標準エラー出力を、実行ごとのファイルに残し、結果を記録する", () => {
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info, () => []);
    log.stdout('{"type":"system"}\n');
    log.stderr("warn: x\n");
    log.stdout('{"type":"result","result":"ok"}\n');
    log.close({
      kind: "completed",
      output: "ok",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    const read = store.read("task-1", "run-1");
    expect(read?.events).toBe('{"type":"system"}\n{"type":"result","result":"ok"}\n');
    expect(read?.stderr).toBe("warn: x\n");
    expect(read?.meta).toMatchObject({ ...info, outcome: { kind: "completed" } });
    expect(read?.meta.finishedAt).toBeTruthy();
    expect(read?.meta.truncated).toBeUndefined();
    expect(existsSync(join(dir, "runs", "task-1", "run-1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "runs", "task-1", "run-1.stderr.log"))).toBe(true);
  });

  it("失敗した実行も、伏せた理由と一緒に残す。開いた直後（終わりの前）も、始めたことは残る", () => {
    const store = new SessionLogStore(join(dir, "runs"));
    const secrets: string[] = [];
    const log = store.open(info, () => secrets);
    expect(store.read("task-1", "run-1")?.meta.finishedAt).toBeUndefined();
    secrets.push("super-secret-value");
    log.stderr("boom super-secret-value\n");
    log.close({ kind: "failed", reason: "auth", message: "401 super-secret-value" });
    const read = store.read("task-1", "run-1");
    expect(read?.stderr).toBe("boom [REDACTED]\n");
    expect(read?.meta.outcome).toEqual({
      kind: "failed",
      reason: "auth",
      message: "401 [REDACTED]",
    });
  });

  it("書き始めた後に分かった秘密情報（更新されたトークンなど）も、閉じるときに全体から伏せ直す", () => {
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info, () => ["old-token-value"]);
    log.stdout('{"text":"new is refreshed-token-xyz"}\n');
    log.stderr("refreshed-token-xyz\n");
    log.addSecrets(["refreshed-token-xyz"]);
    log.close({ kind: "failed", reason: "error", message: "x" });
    const read = store.read("task-1", "run-1");
    expect(read?.events).toBe('{"text":"new is [REDACTED]"}\n');
    expect(read?.stderr).toBe("[REDACTED]\n");
  });

  it("上限を超えたら行の切れ目で切り詰め、切り詰めたことを末尾の行と記録に残す", () => {
    const store = new SessionLogStore(join(dir, "runs"), { events: 50, stderr: 30 });
    const log = store.open(info, () => []);
    const line = `${JSON.stringify({ n: "x".repeat(6) })}\n`; // 15 バイト
    expect(Buffer.byteLength(line)).toBe(15);
    for (let i = 0; i < 10; i++) log.stdout(line);
    log.stderr("e".repeat(100));
    log.close({
      kind: "completed",
      output: "",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    const read = store.read("task-1", "run-1");
    const lines = read?.events.trimEnd().split("\n") ?? [];
    // 50 バイトに収まる3行と、切り詰めの目印
    expect(lines.slice(0, 3)).toEqual([line.trim(), line.trim(), line.trim()]);
    expect(JSON.parse(lines[3] ?? "")).toEqual({
      type: TRUNCATED_EVENT,
      limitBytes: 50,
      droppedBytes: 150 - 45,
    });
    expect(lines).toHaveLength(4);
    // 改行の無い標準エラー出力は、文字の切れ目で切る
    expect(read?.stderr.startsWith(`${"e".repeat(30)}\n[sacty] truncated`)).toBe(true);
    expect(read?.meta.truncated).toEqual({ events: 105, stderr: 70 });
  });

  it("伏せてから切り詰める（上限の境目にまたがる秘密情報の、前半も残さない）", () => {
    const secret = "S3CR3T-0123456789abcdef";
    for (let limit = 1; limit < 40; limit++) {
      const root = join(dir, `runs-${limit}`);
      const store = new SessionLogStore(root, { events: limit, stderr: limit });
      const log = store.open(info, () => [secret]);
      // 値が上限の境目にまたがり、さらに届いた分の境目でも切れる
      const text = `ab${secret}cd`;
      log.stderr(text.slice(0, 7));
      log.stderr(text.slice(7));
      log.close({ kind: "failed", reason: "error", message: "x" });
      const stderr = store.read("task-1", "run-1")?.stderr ?? "";
      expect(stderr).not.toContain(secret.slice(0, 6));
    }
  });

  it("UTF-8 の文字の途中では切らない", () => {
    const store = new SessionLogStore(join(dir, "runs"), { events: 10, stderr: 10 });
    const log = store.open(info, () => []);
    log.stderr("あいうえお"); // 15 バイト
    log.close({ kind: "failed", reason: "error", message: "x" });
    expect(store.read("task-1", "run-1")?.stderr.startsWith("あいう\n[sacty]")).toBe(true);
  });

  it("パスに使えない ID では書かず・読まない（ほかの場所を読ませない）", () => {
    const store = new SessionLogStore(join(dir, "runs"));
    writeFileSync(join(dir, "secret.meta.json"), "{}");
    for (const bad of ["..", "../x", "a/b", "", "a.b", "x".repeat(129)]) {
      expect(validLogId(bad)).toBe(false);
      expect(store.read(bad, "run-1")).toBeUndefined();
      expect(store.read("task-1", bad)).toBeUndefined();
      expect(store.path(bad, "run-1", "events")).toBeUndefined();
      store
        .open({ ...info, runId: bad }, () => [])
        .close({ kind: "failed", reason: "error", message: "x" });
    }
    expect(store.read("..", "secret")).toBeUndefined();
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("ログの無い実行（ログを残す前の実行など）は無いものとして返す", () => {
    const store = new SessionLogStore(join(dir, "runs"));
    expect(store.read("task-1", "missing")).toBeUndefined();
  });
});

describe("実行器のセッションログ（偽の docker コマンド。PBI-62）", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  const fakeDocker = (script: string) => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "docker"),
      // kill：run を止める。ps：止めたコンテナはもう無い
      `#!/bin/sh\nif [ "$1" = "kill" ]; then kill "$(cat "${dir}/run.pid")"; exit 0; fi\nif [ "$1" != "run" ]; then exit 0; fi\necho $$ > "${dir}/run.pid"\n${script}`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
  };
  const info = {
    taskId: "task-1",
    runId: "run-1",
    role: "design",
    agentId: "claude",
    runtime: "claude-code",
    authMode: "subscription",
  };

  it("途中の出来事・標準エラー出力を、届くたびに伏せて残し、最後の答えはこれまでどおり読む", async () => {
    const secret = "oauth-token-1234567890";
    // 秘密情報を、出力の書き込みの途中で区切って出す
    fakeDocker(`printf '{"type":"system","subtype":"init"}\\n{"type":"assistant","message":{"content":[{"type":"text","text":"tok oauth-token-12'
sleep 0.1
printf '34567890"}]}}\\n'
echo "stderr oauth-token-1234567890" >&2
echo '{"type":"result","is_error":false,"result":"done oauth-token-1234567890","usage":{"input_tokens":3,"output_tokens":4}}'
`);
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info, () => [secret]);
    const outcome = await new DockerExecutor().run({
      runId: "run-1",
      image: "img",
      workspaceDir: dir,
      invocation: { command: ["claude"], env: {}, parser: "claude-json" },
      log,
    });
    log.close(outcome);
    expect(outcome).toMatchObject({ kind: "completed", usage: { input: 3, output: 4 } });
    const read = store.read("task-1", "run-1");
    expect(read?.events).not.toContain(secret);
    expect(read?.stderr).not.toContain(secret);
    expect(read?.events.split("\n").filter(Boolean)).toHaveLength(3);
    expect(read?.events).toContain('"text":"tok [REDACTED]"');
    expect(read?.stderr).toBe("stderr [REDACTED]\n");
  });

  it("途中で止めた実行（デーモンの停止）も、それまでの出来事が残る", async () => {
    fakeDocker(`echo '{"type":"system","subtype":"init"}'
echo "starting" >&2
trap 'exit 137' TERM
while true; do sleep 0.05; done
`);
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info, () => []);
    const executor = new DockerExecutor();
    const running = executor.run({
      runId: "run-1",
      image: "img",
      workspaceDir: dir,
      invocation: { command: ["claude"], env: {}, parser: "claude-json" },
      log,
    });
    await new Promise((r) => setTimeout(r, 300));
    executor.abortAll();
    const outcome = await running;
    log.close(outcome);
    const read = store.read("task-1", "run-1");
    expect(read?.events).toBe('{"type":"system","subtype":"init"}\n');
    expect(read?.stderr).toBe("starting\n");
    expect(read?.meta.outcome).toMatchObject({
      kind: "failed",
      message: { code: "run.daemonStopped" },
    });
  });
});
