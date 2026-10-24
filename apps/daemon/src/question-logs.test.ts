import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityEvent } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUESTION_LOG_INDEX, stageQuestionLogs } from "./question-logs.js";
import { SessionLogStore } from "./session-logs.js";

let dir: string;
let store: SessionLogStore;
let dest: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-question-logs-"));
  store = new SessionLogStore(join(dir, "runs"), {
    events: { head: 64, tail: 32 },
    stderr: { head: 1024, tail: 1024 },
  });
  dest = join(dir, "staged");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** ディレクトリの下のファイル（相対パス）。 */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out.sort();
}

let seq = 0;
const ev = (taskId: string, type: string, payload: Record<string, unknown>): ActivityEvent =>
  ({
    seq: ++seq,
    id: `e${seq}`,
    taskId,
    projectId: "default",
    actor: "sacty",
    at: "2026-10-14T00:00:00.000Z",
    type,
    payload,
  }) as unknown as ActivityEvent;

/** 実行のログを、実際のセッションログと同じ形で残す。 */
function run(
  taskId: string,
  runId: string,
  role: string,
  options: { stdout?: string; secrets?: string[]; close?: boolean } = {},
) {
  const log = store.open(
    { taskId, runId, role, agentId: "claude", runtime: "claude-code", authMode: "subscription" },
    () => options.secrets ?? [],
  );
  if (options.stdout) log.stdout(options.stdout);
  log.stderr("warn\n");
  if (options.close !== false) log.close({ kind: "completed", output: "" });
}

/** エージェントの元のファイルを置き、その記録（AgentSessionArchived）を返す。 */
function agentFile(taskId: string, runId: string, path: string, content: string): ActivityEvent {
  const abs = join(store.agentFilesDir(taskId, runId) ?? "", ...path.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  const bytes = Buffer.byteLength(content);
  return ev(taskId, "AgentSessionArchived", {
    runId,
    role: "design",
    agentId: "claude",
    runtime: "claude-code",
    files: [
      {
        path,
        bytes,
        sourceBytes: bytes,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    limitBytes: 1000,
    skipped: [],
  });
}

describe("質問への答えに読ませるセッションログ（PBI-91）", () => {
  it("このタスクの終わった実行のログと、記録したエージェントのファイルだけを並べ、ほかのタスク・ログ以外のファイルは並べない", () => {
    // 同じミリ秒に作成されても、実行順を検証できるよう時刻を明示する。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
    run("t1", "r-req", "requirements", {
      stdout: '{"type":"tool","command":"grep TOKEN=s3cr3t"}\n',
      secrets: ["s3cr3t"],
    });
    vi.setSystemTime(new Date("2026-10-14T00:00:01.000Z"));
    run("t1", "r-design", "design", { stdout: '{"type":"text"}\n' });
    const archived = agentFile("t1", "r-design", "projects/w/s.jsonl", '{"m":"設計の元"}\n');
    // 記録の無いファイル（認証の写しなど）は並べない
    writeFileSync(join(store.agentFilesDir("t1", "r-design") ?? "", ".credentials.json"), "{}");
    // 実行のログの場所にある、ログ以外のファイル・リンク
    writeFileSync(join(dir, "runs", "t1", "notes.txt"), "ログではない");
    writeFileSync(join(dir, "outside.json"), JSON.stringify({ runId: "x", role: "y" }));
    symlinkSync(join(dir, "outside.json"), join(dir, "runs", "t1", "link.meta.json"));
    // ほかのタスク
    run("t2", "r-other", "requirements", { stdout: '{"type":"other-task"}\n' });

    const logs = stageQuestionLogs({
      store,
      taskId: "t1",
      activity: [
        ev("t1", "AgentRunCompleted", { runId: "r-req", step: "requirements" }),
        ev("t1", "AgentRunCompleted", { runId: "r-design", step: "design" }),
        archived,
      ],
      dest,
    });

    expect(tree(dest)).toEqual([
      QUESTION_LOG_INDEX,
      "r-design/agent/projects/w/s.jsonl",
      "r-design/events.jsonl",
      "r-design/meta.json",
      "r-design/stderr.log",
      "r-req/events.jsonl",
      "r-req/meta.json",
      "r-req/stderr.log",
    ]);
    expect(logs.runs.map((r) => [r.runId, r.status, r.role, r.attempt])).toEqual([
      ["r-req", "available", "requirements", 1],
      ["r-design", "available", "design", 1],
    ]);
    expect(logs.runs[1]?.agentFiles).toEqual({ count: 1, truncated: 0, skipped: 0 });
    // 伏せた後のもの（秘密の値は出ない）
    const events = readFileSync(join(dest, "r-req", "events.jsonl"), "utf8");
    expect(events).toContain("grep TOKEN=");
    expect(events).not.toContain("s3cr3t");
    const index = readFileSync(join(dest, QUESTION_LOG_INDEX), "utf8");
    expect(index).not.toContain("r-other");
    expect(JSON.parse(index)).toMatchObject({ taskId: "t1", runs: logs.runs });
    // 並べた場所を消しても、元のログは残る（ハードリンクか写し）
    rmSync(dest, { recursive: true, force: true });
    expect(store.read("t1", "r-req")?.events).toContain("grep TOKEN=");
  });

  it("終わっていない・ログの無い・記録を読めない・間を省いた実行も、その旨を一覧に出す（終わっていない実行は並べない）", () => {
    run("t1", "r-running", "implement", { stdout: '{"type":"partial"}\n', close: false });
    run("t1", "r-long", "design", { stdout: `${'{"type":"x"}\n'.repeat(50)}` });
    mkdirSync(join(dir, "runs", "t1"), { recursive: true });
    writeFileSync(join(dir, "runs", "t1", "r-broken.meta.json"), "{壊れた");
    const archived = agentFile("t1", "r-long", "projects/w/s.jsonl", "abc\n");
    // 記録と大きさの違うファイルは並べない
    writeFileSync(
      join(store.agentFilesDir("t1", "r-long") ?? "", "projects/w/s.jsonl"),
      "changed\n",
    );

    const logs = stageQuestionLogs({
      store,
      taskId: "t1",
      activity: [
        ev("t1", "AgentRunFailed", { runId: "r-old", step: "requirements" }),
        ev("t1", "OrchestratorSessionUsed", { runId: "r-chat-self", role: "chat" }),
        archived,
      ],
      dest,
      exclude: ["r-chat-self"],
    });
    const byId = Object.fromEntries(logs.runs.map((r) => [r.runId, r]));
    expect(byId["r-running"]).toMatchObject({ status: "unfinished", files: [] });
    expect(byId["r-old"]).toMatchObject({ status: "missing", role: "requirements" });
    expect(byId["r-broken"]).toMatchObject({ status: "unreadable", unreadable: ["meta.json"] });
    expect(byId["r-long"]).toMatchObject({
      status: "available",
      truncated: ["events"],
      unreadable: ["agent/projects/w/s.jsonl"],
    });
    expect(byId["r-chat-self"]).toBeUndefined();
    expect(tree(dest).filter((p) => p.startsWith("r-running") || p.includes("agent/"))).toEqual([]);
    expect(readFileSync(join(dest, "r-long", "events.jsonl"), "utf8")).toContain("sacty.truncated");
  });

  it("タスクのログの場所を開けない（ディレクトリでない・権限が無い）なら、ログの無い実行として記録せず、例外を投げる", () => {
    run("t1", "r1", "requirements", { stdout: "{}\n" });
    const activity = [ev("t1", "AgentRunCompleted", { runId: "r1", step: "requirements" })];
    const taskDir = join(dir, "runs", "t1");
    rmSync(taskDir, { recursive: true, force: true });
    writeFileSync(taskDir, "ディレクトリではない");
    expect(() => stageQuestionLogs({ store, taskId: "t1", activity, dest })).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
    expect(existsSync(join(dest, QUESTION_LOG_INDEX))).toBe(false);
    if (process.getuid?.() !== 0) {
      rmSync(taskDir, { force: true });
      mkdirSync(taskDir);
      chmodSync(taskDir, 0o000);
      try {
        expect(() => stageQuestionLogs({ store, taskId: "t1", activity, dest })).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
      } finally {
        chmodSync(taskDir, 0o700);
      }
    }
    // 場所が無い（まだ実行が無い）ときだけ、ログの無い実行として一覧に出す
    rmSync(taskDir, { recursive: true, force: true });
    expect(stageQuestionLogs({ store, taskId: "t1", activity, dest }).runs).toMatchObject([
      { runId: "r1", status: "missing" },
    ]);
  });

  it("includeRunning なら、実行中の実行のいまの写しを並べ、後から分かった秘密情報も伏せる（元のファイルは変えない）", () => {
    store = new SessionLogStore(join(dir, "runs")); // 上限で省かない大きさ
    const secrets = ["early-secret"];
    const log = store.open(
      {
        taskId: "t1",
        runId: "r-running",
        role: "implement",
        agentId: "claude",
        runtime: "claude-code",
        authMode: "subscription",
      },
      () => secrets,
    );
    log.stdout(
      '{"type":"tool","cmd":"npm test early-secret"}\n{"type":"tool","cmd":"late-token"}\n',
    );
    log.stdout('{"type":"half');
    log.stderr("still running\n");
    // 書き始めた後に分かった秘密情報（ファイルには、閉じるまで残っている）
    log.addSecrets(["late-token"]);

    const logs = stageQuestionLogs({
      store,
      taskId: "t1",
      activity: [],
      dest,
      includeRunning: true,
    });
    expect(logs.runs).toMatchObject([
      { runId: "r-running", status: "running", role: "implement", attempt: 1, truncated: [] },
    ]);
    expect(logs.runs[0]?.snapshotAt).toEqual(expect.any(String));
    expect(tree(dest)).toEqual([
      QUESTION_LOG_INDEX,
      "r-running/events.jsonl",
      "r-running/meta.json",
      "r-running/stderr.log",
    ]);
    const events = readFileSync(join(dest, "r-running", "events.jsonl"), "utf8");
    expect(events).toContain("npm test");
    expect(events).not.toContain("early-secret");
    expect(events).not.toContain("late-token");
    // 書き終えていない行は入れない
    expect(events).not.toContain("half");
    expect(readFileSync(join(dest, "r-running", "stderr.log"), "utf8")).toBe("still running\n");
    expect(JSON.parse(readFileSync(join(dest, "r-running", "meta.json"), "utf8"))).toMatchObject({
      runId: "r-running",
      role: "implement",
    });
    // 写しはハードリンクではない（元のファイルは、閉じるときに伏せ直すまでそのまま）
    expect(store.read("t1", "r-running")?.events).toContain("late-token");

    // 閉じた後は、終わった実行として並べる
    log.close({ kind: "completed", output: "" });
    const after = join(dir, "staged-after");
    expect(
      stageQuestionLogs({ store, taskId: "t1", activity: [], dest: after, includeRunning: true })
        .runs,
    ).toMatchObject([{ runId: "r-running", status: "available" }]);
    expect(readFileSync(join(after, "r-running", "events.jsonl"), "utf8")).not.toContain(
      "late-token",
    );
  });

  it("実行中の写しでも、上限で間を省いたら目印を入れて末尾を残す。このデーモンで開いていない実行は並べない", () => {
    const log = store.open(
      {
        taskId: "t1",
        runId: "r-long",
        role: "implement",
        agentId: "claude",
        runtime: "claude-code",
        authMode: "subscription",
      },
      () => [],
    );
    for (let i = 0; i < 20; i++) log.stdout(`{"type":"x","n":${i}}\n`);
    // 終わりを記録できなかった実行（デーモンが止まった）は、ほかのデーモンからは実行中に見えない
    run("t1", "r-orphan", "design", { stdout: "{}\n", close: false });
    const restarted = new SessionLogStore(join(dir, "runs"));
    const orphan = stageQuestionLogs({
      store: restarted,
      taskId: "t1",
      activity: [],
      dest: join(dir, "staged-restarted"),
      includeRunning: true,
    });
    expect(orphan.runs.map((r) => r.status)).toEqual(["unfinished", "unfinished"]);

    const logs = stageQuestionLogs({
      store,
      taskId: "t1",
      activity: [],
      dest,
      includeRunning: true,
    });
    const byId = Object.fromEntries(logs.runs.map((r) => [r.runId, r]));
    expect(byId["r-long"]).toMatchObject({ status: "running", truncated: ["events"] });
    // 同じデーモン（store）では、まだ閉じていないので実行中
    expect(byId["r-orphan"]).toMatchObject({ status: "running" });
    const events = readFileSync(join(dest, "r-long", "events.jsonl"), "utf8");
    expect(events).toContain("sacty.truncated");
    expect(events).toContain('"n":19}');
    // どの行も、壊れていない JSON
    for (const line of events.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    // includeRunning でなければ、これまでどおり並べない
    const off = join(dir, "staged-off");
    expect(
      stageQuestionLogs({ store, taskId: "t1", activity: [], dest: off }).runs.map((r) => r.status),
    ).toEqual(["unfinished", "unfinished"]);
    expect(tree(off)).toEqual([QUESTION_LOG_INDEX]);
    log.close({ kind: "completed", output: "" });
  });

  it("まだ実行の無いタスクでも一覧を作り、ID の形が違うタスクのログは探さない", () => {
    expect(stageQuestionLogs({ store, taskId: "t1", activity: [], dest }).runs).toEqual([]);
    expect(existsSync(join(dest, QUESTION_LOG_INDEX))).toBe(true);
    run("t2", "r-other", "requirements", { stdout: "{}\n" });
    const other = join(dir, "staged2");
    expect(
      stageQuestionLogs({ store, taskId: "../runs/t2", activity: [], dest: other }).runs,
    ).toEqual([]);
    expect(tree(other)).toEqual([QUESTION_LOG_INDEX]);
  });
});
