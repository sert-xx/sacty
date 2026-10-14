import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerExecutor, HeadTailText } from "./agents/docker.js";
import {
  ClaudeOutcomeReader,
  CodexOutcomeReader,
  parseClaudeResult,
  parseCodexEvents,
} from "./agents/parse.js";
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

  const done = {
    kind: "completed" as const,
    output: "",
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  const line = (n: number) => `${JSON.stringify({ n: String(n).padStart(6, "0") })}\n`; // 15 バイト

  it("上限を超えたら先頭と末尾を行の切れ目で残し、間を省いたことを目印の行と記録に残す", () => {
    const store = new SessionLogStore(join(dir, "runs"), {
      events: { head: 50, tail: 47 },
      stderr: { head: 30, tail: 20 },
    });
    const log = store.open(info, () => []);
    expect(Buffer.byteLength(line(0))).toBe(15);
    for (let i = 0; i < 10; i++) log.stdout(line(i));
    log.stdout('{"type":"result","result":"ok"}\n');
    log.stderr("e".repeat(100));
    log.stderr("最後のエラー\n");
    log.close(done);
    const read = store.read("task-1", "run-1");
    const lines = read?.events.trimEnd().split("\n") ?? [];
    // 先頭：50 バイトに収まる3行。末尾：47 バイトに収まる行の頭から（最後の result の行が残る）
    expect(lines.slice(0, 3)).toEqual([0, 1, 2].map((i) => line(i).trim()));
    expect(JSON.parse(lines[3] ?? "")).toEqual({
      type: TRUNCATED_EVENT,
      droppedBytes: 15 * 6,
      droppedLines: 6,
      headBytes: 50,
      tailBytes: 47,
    });
    expect(lines.slice(4)).toEqual([line(9).trim(), '{"type":"result","result":"ok"}']);
    // どの行も壊れた JSON ではない
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    // 改行の無い標準エラー出力は、先頭も末尾も文字の切れ目で切る
    expect(read?.stderr.startsWith(`${"e".repeat(30)}\n[sacty] truncated`)).toBe(true);
    expect(read?.stderr.endsWith("e最後のエラー\n")).toBe(true);
    expect(read?.meta.truncated).toEqual({
      events: { droppedBytes: 90, droppedLines: 6 },
      stderr: { droppedBytes: 100 + 19 - 30 - 20, droppedLines: 0 },
    });
  });

  it("先頭と末尾に収まれば、何も省かず目印も足さない（改行で終わらない最後の行も残す）", () => {
    const store = new SessionLogStore(join(dir, "runs"), {
      events: { head: 30, tail: 40 },
      stderr: { head: 5, tail: 5 },
    });
    const log = store.open(info, () => []);
    const text = `${line(1)}${line(2)}${line(3)}{"type":"result"}`;
    // 届いた分の境目は、行の途中にもある
    for (let i = 0; i < text.length; i += 7) log.stdout(text.slice(i, i + 7));
    log.stderr("0123456789");
    log.close(done);
    const read = store.read("task-1", "run-1");
    expect(read?.events).toBe(text);
    expect(read?.stderr).toBe("0123456789");
    expect(read?.meta.truncated).toBeUndefined();
  });

  it("届いた分の境目がどこでも、先頭は行の切れ目で終わり、末尾は行の頭から始まる", () => {
    const text = Array.from({ length: 20 }, (_, i) => line(i)).join("");
    for (const size of [1, 4, 15, 16, 31, 64]) {
      const root = join(dir, `runs-chunk-${size}`);
      const store = new SessionLogStore(root, {
        events: { head: 37, tail: 37 },
        stderr: { head: 10, tail: 10 },
      });
      const log = store.open(info, () => []);
      for (let i = 0; i < text.length; i += size) log.stdout(text.slice(i, i + size));
      log.close(done);
      const lines = store.read("task-1", "run-1")?.events.trimEnd().split("\n") ?? [];
      expect(lines).toEqual([
        line(0).trim(),
        line(1).trim(),
        expect.stringContaining(TRUNCATED_EVENT),
        line(18).trim(),
        line(19).trim(),
      ]);
    }
  });

  // 先頭の上限ごとに分ける（1つのテストで全部を回すと、負荷が高いときに既定の時間切れを超える）
  it.each(Array.from({ length: 20 }, (_, i) => 1 + i * 2))(
    "伏せてから切り詰める（先頭・末尾の切れ目にまたがる秘密情報の、一部も残さない。先頭 %i）",
    (head) => {
      const secret = "S3CR3T-0123456789abcdef";
      const text = `ab${secret}cd${"x".repeat(30)}ef${secret}gh`;
      for (let tail = 1; tail < 40; tail += 3) {
        const store = new SessionLogStore(join(dir, "runs"), {
          events: { head, tail },
          stderr: { head, tail },
        });
        const runId = `run-${tail}`;
        const log = store.open({ ...info, runId }, () => [secret]);
        // 届いた分の境目でも切れる
        log.stderr(text.slice(0, 7));
        log.stderr(text.slice(7, 40));
        log.stderr(text.slice(40));
        log.close({ kind: "failed", reason: "error", message: "x" });
        const stderr = store.read("task-1", runId)?.stderr ?? "";
        for (let i = 0; i + 6 <= secret.length; i++) {
          expect(stderr, `tail ${tail}`).not.toContain(secret.slice(i, i + 6));
        }
      }
    },
  );

  it("先頭に収まる、改行で終わらない最後の行（スタブの出力など）も残す", () => {
    const store = new SessionLogStore(join(dir, "runs"), {
      events: { head: 100, tail: 10 },
      stderr: { head: 10, tail: 10 },
    });
    const log = store.open(info, () => []);
    log.stdout(line(1));
    log.stdout('{"type":"res');
    log.stdout('ult"}');
    log.close(done);
    expect(store.read("task-1", "run-1")?.events).toBe(`${line(1)}{"type":"result"}`);
  });

  it("先頭に収まらない長い行は、改行が届かなくても先頭の上限を超えて書かない", () => {
    const store = new SessionLogStore(join(dir, "runs"), {
      events: { head: 20, tail: 10 },
      stderr: { head: 10, tail: 10 },
    });
    const log = store.open(info, () => []);
    log.stdout(line(1));
    for (let i = 0; i < 10; i++) log.stdout('"xxxx"');
    log.close(done);
    const events = store.read("task-1", "run-1")?.events ?? "";
    // 先頭の1行と、間を省いた目印だけ（途中から始まる行は末尾にも残さない）
    const lines = events.trimEnd().split("\n");
    expect(lines).toEqual([line(1).trim(), expect.stringContaining(TRUNCATED_EVENT)]);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ droppedBytes: 60, droppedLines: 0 });
  });

  it("UTF-8 の文字の途中では切らない", () => {
    const store = new SessionLogStore(join(dir, "runs"), {
      events: { head: 10, tail: 10 },
      stderr: { head: 10, tail: 10 },
    });
    const log = store.open(info, () => []);
    log.stderr("あいうえおかきくけこ"); // 30 バイト
    log.close({ kind: "failed", reason: "error", message: "x" });
    const stderr = store.read("task-1", "run-1")?.stderr ?? "";
    expect(stderr.startsWith("あいう\n[sacty]")).toBe(true);
    expect(stderr.endsWith("omitted.\nくけこ")).toBe(true);
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
touch "${dir}/ready"
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
    // 出力を書き終えてから止める（決まった時間を待つと、負荷が高いときは書く前に止めてしまう）
    while (!existsSync(join(dir, "ready"))) await new Promise((r) => setTimeout(r, 20));
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

describe("絵文字・補助漢字（サロゲートペア）を壊さない（PR 71 のレビュー指摘）", () => {
  const info = {
    taskId: "task-1",
    runId: "run-1",
    role: "design",
    agentId: "claude",
    runtime: "claude-code",
    authMode: "subscription",
  };
  const failed = { kind: "failed" as const, reason: "error" as const, message: "x" };

  it("秘密情報を伏せるために持っておく分の切れ目で、文字を壊さない（再現の例）", () => {
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info, () => ["abcdef"]);
    log.stderr("😀1234");
    log.stdout('{"text":"😀1234"}\n');
    log.close(failed);
    const read = store.read("task-1", "run-1");
    expect(read?.stderr).toBe("😀1234");
    expect(read?.events).toBe('{"text":"😀1234"}\n');
  });

  describe("届いた分の境目・持っておく分の切れ目・先頭と末尾の切れ目がどこでも、文字を壊さない（総当たり）", () => {
    const secret = "S3CRET-𠮷-value";
    const lines = [
      `{"text":"😀${secret}𠮷"}\n`,
      `{"text":"𠮷😀😀"}\n`,
      `{"text":"a😀b${secret}"}\n`,
      `{"text":"𩸽😀"}\n`,
    ];
    const text = lines.join("");
    const expected = text.split(secret).join("[REDACTED]");
    const markerLine = new RegExp(`^.*${TRUNCATED_EVENT}.*\n`, "m");
    const stderrMarker = /\n?\[sacty\] truncated: [^\n]*omitted\.\n/;
    // 秘密情報・上限の組み合わせごとに分ける（1つのテストで全部を回すと、負荷が高いときに既定の時間切れを超える）。
    // 組み合わせの中では、届いた分の境目をすべて確かめる
    const cases = [
      { name: "伏せる値あり", secrets: [secret] },
      { name: "伏せる値が出力に無い", secrets: ["xyz"] },
      { name: "伏せる値なし", secrets: [] as string[] },
    ].flatMap((c) =>
      (
        [
          [1000, 1000],
          [40, 30],
          [33, 61],
          [7, 9],
          [50, 5],
        ] as const
      ).map(([head, tail]) => ({ ...c, head, tail })),
    );
    it.each(cases)("$name / 先頭 $head / 末尾 $tail", ({ secrets, head, tail }) => {
      const want = secrets.includes(secret) ? expected : text;
      // 1つの場所に、境目ごとに別の実行として残す（実行ごとに場所を作り直さない）
      const store = new SessionLogStore(join(dir, "runs"), {
        events: { head, tail },
        stderr: { head, tail },
      });
      for (let cut = 1; cut < text.length; cut += 2) {
        const runId = `run-${cut}`;
        const log = store.open({ ...info, runId }, () => secrets);
        // サロゲートペアの途中で分かれて届くこともある
        log.stdout(text.slice(0, cut));
        log.stdout(text.slice(cut));
        log.stderr(text.slice(0, cut));
        log.stderr(text.slice(cut));
        log.close(failed);
        const read = store.read("task-1", runId);
        for (const out of [read?.events ?? "", read?.stderr ?? ""]) {
          expect(out, `cut ${cut}`).not.toContain("\uFFFD");
          if (secrets.includes(secret)) expect(out, `cut ${cut}`).not.toContain(secret.slice(0, 6));
        }
        // 間を省いても、残った先頭と末尾は元の内容の先頭と末尾のまま
        const [eventsHead = "", eventsTail = ""] = (read?.events ?? "").split(markerLine);
        expect(want.startsWith(eventsHead), `cut ${cut}`).toBe(true);
        expect(want.endsWith(eventsTail), `cut ${cut}`).toBe(true);
        const [errHead = "", errTail = ""] = (read?.stderr ?? "").split(stderrMarker);
        expect(want.startsWith(errHead), `cut ${cut}`).toBe(true);
        expect(want.endsWith(errTail), `cut ${cut}`).toBe(true);
        if (head === 1000) {
          expect(read?.events, `cut ${cut}`).toBe(want);
          expect(read?.stderr, `cut ${cut}`).toBe(want);
        }
      }
    });
  });

  it("持っておく分の切れ目は、秘密情報が届いた分の境目をまたいでも伏せられる長さのまま", () => {
    const secret = "😀secret😀";
    const text = `x${secret}y${secret}`;
    for (let cut = 1; cut < text.length; cut++) {
      const r = new StreamRedactor(() => [secret]);
      const written = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.flush();
      expect(written).toBe("x[REDACTED]y[REDACTED]");
    }
  });
});

describe("最後の答えの読み取りは、出力の全体を持たずに逐次に読む（PR 71 のレビュー指摘）", () => {
  const events = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "途中 😀" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(5000) }] } },
    { type: "result", is_error: false, result: "# 答え 😀", usage },
  ];
  const stdout = `warning\n${jsonl(...events)}\n`;

  it("届いた分の境目がどこでも、まとめて読んだときと同じ結果になる", () => {
    const whole = parseClaudeResult(stdout, 0);
    expect(whole).toMatchObject({ kind: "completed", output: "# 答え 😀" });
    for (const size of [1, 2, 7, 100, 4096]) {
      const reader = new ClaudeOutcomeReader();
      for (let i = 0; i < stdout.length; i += size) reader.push(stdout.slice(i, i + size));
      expect(reader.finish(0)).toEqual(whole);
    }
    const codex = jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "答え" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
      },
    );
    const reader = new CodexOutcomeReader();
    for (let i = 0; i < codex.length; i += 3) reader.push(codex.slice(i, i + 3));
    expect(reader.finish(0)).toEqual(parseCodexEvents(codex, 0));
  });

  it("上限より長い行は読まずに飛ばし、その後の行（最後の result）は読む", () => {
    const reader = new ClaudeOutcomeReader(1000);
    reader.push(`${JSON.stringify(events[1])}\n`);
    // 長い行は、少しずつ届いても持ち続けない
    reader.push('{"type":"user","message":{"content":"');
    for (let i = 0; i < 100; i++) reader.push("y".repeat(100));
    reader.push('"}}\n');
    reader.push(`${JSON.stringify(events[3])}\n`);
    expect(reader.finish(0)).toMatchObject({ kind: "completed", output: "# 答え 😀" });
    // result の行が長すぎれば、result が無いものとして失敗にする（途中の発言を理由にする）
    const long = new ClaudeOutcomeReader(1000);
    long.push(`${JSON.stringify(events[1])}\n`);
    long.push(`${JSON.stringify({ ...events[3], result: "z".repeat(2000) })}\n`);
    expect(long.finish(0)).toMatchObject({ kind: "failed", message: "途中 😀" });
  });

  it("改行が届かない長い行は、少しずつ届いても持ち続けず、読まない", () => {
    const reader = new ClaudeOutcomeReader(1000);
    reader.push(`${JSON.stringify(events[1])}\n`);
    reader.push('{"type":"assistant","message":{"content":[{"type":"text","text":"長い');
    for (let i = 0; i < 100; i++) {
      reader.push("y".repeat(100));
      expect(reader.buffered).toBeLessThanOrEqual(1000);
    }
    reader.push('"}]}}\n');
    // result が無いので失敗。理由は、読めた最後の発言（長い行は読んでいない）
    expect(reader.finish(1)).toMatchObject({ kind: "failed", message: "途中 😀" });
  });

  it("result が複数あれば、最後のものを読む", () => {
    const two = jsonl(
      { type: "result", is_error: false, result: "1回目", usage },
      { type: "result", is_error: false, result: "2回目", usage },
    );
    const reader = new ClaudeOutcomeReader();
    reader.push(two);
    expect(reader.finish(0)).toMatchObject({ kind: "completed", output: "2回目" });
  });

  it("JSON の行が無い出力は、先頭（上限まで）だけを持つ。整形した大きすぎる JSON は読まない", () => {
    const big = JSON.stringify(
      { type: "result", is_error: false, result: "r".repeat(300 * 1024), usage },
      null,
      2,
    );
    expect(parseClaudeResult(big, 0)).toMatchObject({ kind: "failed" });
    const small = JSON.stringify({ type: "result", is_error: false, result: "ok", usage }, null, 2);
    expect(parseClaudeResult(small, 0)).toMatchObject({ kind: "completed", output: "ok" });
  });

  it("JSON の行が無い出力は、先頭だけを理由に使う", () => {
    const reader = new ClaudeOutcomeReader();
    for (let i = 0; i < 100; i++) reader.push("error line\n".repeat(1000));
    const outcome = reader.finish(1);
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && String(outcome.message).length).toBeLessThanOrEqual(2000);
  });

  it("標準エラー出力は、先頭と末尾だけを持つ", () => {
    const text = new HeadTailText(10, 20);
    text.push("0123456789HEAD-DONE");
    for (let i = 0; i < 1000; i++) text.push("middle ");
    text.push("...the last error");
    const kept = text.toString();
    expect(kept.startsWith("0123456789\n…\n")).toBe(true);
    expect(kept.endsWith("...the last error")).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(10 + 3 + 20);
    // 末尾が上限の2倍に届かなくても、返すときは末尾の上限に収める
    const mid = new HeadTailText(5, 10);
    mid.push("01234");
    mid.push("abcdefghijklmno");
    expect(mid.toString()).toBe("01234\n…\nfghijklmno");
    const small = new HeadTailText(10, 20);
    small.push("short");
    small.push(" and fits");
    expect(small.toString()).toBe("short and fits");
  });
});
