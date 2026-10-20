import { createHash } from "node:crypto";
import {
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
import { dirname, join } from "node:path";
import type { ArchivedAgentFile } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OrchestratorSessionStore,
  sessionMainFile,
  validSessionId,
} from "./orchestrator-sessions.js";

let dir: string;
let store: OrchestratorSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-orch-sessions-"));
  store = new OrchestratorSessionStore(join(dir, "sessions"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 実行ごとに写した元のファイル（PBI-66 の runs/<タスク>/<実行>/agent）を作り、記録（大きさとハッシュ）を返す。 */
function archive(
  runId: string,
  files: Record<string, string>,
): {
  sourceDir: string;
  files: ArchivedAgentFile[];
} {
  const sourceDir = join(dir, "runs", runId, "agent");
  const recorded: ArchivedAgentFile[] = [];
  for (const [path, content] of Object.entries(files)) {
    const abs = join(sourceDir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    recorded.push({
      path,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      sourceBytes: Buffer.byteLength(content),
    });
  }
  return { sourceDir, files: recorded };
}

const claude = { agentId: "claude", runtime: "claude-code" as const };
const main = (id: string) => `projects/-workspace/${id}.jsonl`;

async function saveClaude(taskId: string, runId: string, sessionId: string, extra = {}) {
  const archived = archive(runId, { [main(sessionId)]: `{"run":"${runId}"}\n`, ...extra });
  return store.save(taskId, { ...claude, sessionId, runId, ...archived });
}

describe("オーケストレーターのセッションの置き場所（PBI-67）", () => {
  it("無ければ新しく始める（first）。保存すると、同じエージェントなら再開する", async () => {
    expect(await store.plan("t1", claude)).toEqual({ mode: "new", reason: "first" });
    expect(await saveClaude("t1", "r1", "s-1", { "history.jsonl": "{}\n" })).toEqual({
      saved: true,
    });
    const plan = await store.plan("t1", claude);
    expect(plan).toEqual({
      mode: "resume",
      sessionId: "s-1",
      filesDir: join(dir, "sessions", "t1", "orchestrator", "generations", "r1", "files"),
    });
    // 設定の場所からの相対パスのまま置く（そのまま戻せば再開できる）
    if (plan.mode !== "resume") throw new Error("unreachable");
    expect(readFileSync(join(plan.filesDir, main("s-1")), "utf8")).toBe('{"run":"r1"}\n');
    expect(readFileSync(join(plan.filesDir, "history.jsonl"), "utf8")).toBe("{}\n");
    // ほかのタスクとは混ざらない
    expect(await store.plan("t2", claude)).toEqual({ mode: "new", reason: "first" });
  });

  it("エージェントの ID か AI の種類が違えば、前のセッションを引き継いで新しく始める（agent_changed）", async () => {
    await saveClaude("t1", "r1", "s-1");
    const handoff = {
      agentId: "claude",
      runtime: "claude-code",
      sessionId: "s-1",
      mainFile: join(
        dir,
        "sessions",
        "t1",
        "orchestrator",
        "generations",
        "r1",
        "files",
        main("s-1"),
      ),
    };
    expect(await store.plan("t1", { ...claude, agentId: "other" })).toEqual({
      mode: "new",
      reason: "agent_changed",
      handoff,
    });
    expect(await store.plan("t1", { ...claude, runtime: "codex" })).toEqual({
      mode: "new",
      reason: "agent_changed",
      handoff,
    });
  });

  it("前のエージェントのセッションの本体が記録と違えば、引き継がずに新しく始める", async () => {
    await saveClaude("t1", "r1", "s-1");
    writeFileSync(
      join(dir, "sessions", "t1", "orchestrator", "generations", "r1", "files", main("s-1")),
      "changed\n",
    );
    expect(await store.plan("t1", { ...claude, agentId: "other" })).toEqual({
      mode: "new",
      reason: "agent_changed",
    });
  });

  it("上限で間を省いたファイルがあれば、新しく始める（truncated）", async () => {
    const archived = archive("r1", { [main("s-1")]: "{}\n" });
    const files = archived.files.map((f) => ({
      ...f,
      truncated: { droppedBytes: 10, droppedLines: 1 },
    }));
    expect(
      await store.save("t1", { ...claude, sessionId: "s-1", runId: "r1", ...archived, files }),
    ).toEqual({ saved: true });
    expect(await store.plan("t1", claude)).toEqual({ mode: "new", reason: "truncated" });
  });

  it("保存したファイルが書き換えられた・消えた・記録が壊れたら、新しく始める（files_broken）", async () => {
    const filesDir = join(dir, "sessions", "t1", "orchestrator", "generations", "r1", "files");
    const json = join(dir, "sessions", "t1", "orchestrator", "session.json");
    const cases: (() => void)[] = [
      () => writeFileSync(join(filesDir, main("s-1")), "edited\n"),
      () => rmSync(join(filesDir, main("s-1"))),
      () => {
        rmSync(join(filesDir, main("s-1")));
        symlinkSync(join(dir, "runs", "r1", "agent", main("s-1")), join(filesDir, main("s-1")));
      },
      () => writeFileSync(json, "{broken"),
      () => writeFileSync(json, JSON.stringify({ version: 2 })),
      // 記録のセッションの ID・パスが不正
      () => {
        const s = JSON.parse(readFileSync(json, "utf8"));
        writeFileSync(json, JSON.stringify({ ...s, sessionId: "--flag" }));
      },
      () => {
        const s = JSON.parse(readFileSync(json, "utf8"));
        writeFileSync(
          json,
          JSON.stringify({ ...s, files: [{ ...s.files[0], path: "../../../etc/passwd" }] }),
        );
      },
      () => {
        const s = JSON.parse(readFileSync(json, "utf8"));
        writeFileSync(json, JSON.stringify({ ...s, runId: "../x" }));
      },
      // セッションの本体が記録に無い
      () => {
        const s = JSON.parse(readFileSync(json, "utf8"));
        writeFileSync(json, JSON.stringify({ ...s, sessionId: "other" }));
      },
    ];
    for (const [i, breakIt] of cases.entries()) {
      rmSync(join(dir, "sessions"), { recursive: true, force: true });
      await saveClaude("t1", "r1", "s-1");
      expect((await store.plan("t1", claude)).mode).toBe("resume");
      breakIt();
      expect(await store.plan("t1", claude), String(i)).toEqual({
        mode: "new",
        reason: "files_broken",
      });
    }
  });

  it("保存できないとき：セッションの ID が無い・使えない形、本体のファイルが無い、元のファイルが記録と違う・リンク", async () => {
    const archived = archive("r1", { [main("s-1")]: "{}\n" });
    expect(
      await store.save("t1", { ...claude, sessionId: undefined, runId: "r1", ...archived }),
    ).toEqual({
      saved: false,
      notSaved: "no_session",
    });
    for (const bad of ["--resume", "a/b", "../x", "", "a b", "x".repeat(200)]) {
      expect(
        await store.save("t1", { ...claude, sessionId: bad, runId: "r1", ...archived }),
        bad,
      ).toEqual({ saved: false, notSaved: "no_session" });
    }
    expect(
      await store.save("t1", { ...claude, sessionId: "s-2", runId: "r1", ...archived }),
    ).toEqual({
      saved: false,
      notSaved: "session_missing",
    });
    // 写した後に書き換えられた元のファイル
    writeFileSync(join(archived.sourceDir, main("s-1")), "tampered\n");
    expect(
      await store.save("t1", { ...claude, sessionId: "s-1", runId: "r1", ...archived }),
    ).toEqual({
      saved: false,
      notSaved: "copy_failed",
    });
    // リンクに差し替えられた元のファイル（辿らない）
    rmSync(join(archived.sourceDir, main("s-1")));
    writeFileSync(join(dir, "outside"), "{}\n");
    symlinkSync(join(dir, "outside"), join(archived.sourceDir, main("s-1")));
    expect(
      await store.save("t1", { ...claude, sessionId: "s-1", runId: "r1", ...archived }),
    ).toEqual({
      saved: false,
      notSaved: "copy_failed",
    });
    // どれも保存していない（途中まで写したものも残さない）
    expect(await store.plan("t1", claude)).toEqual({ mode: "new", reason: "first" });
    expect(existsSync(join(dir, "sessions", "t1", "orchestrator", "generations", "r1"))).toBe(
      false,
    );
    // ID の形が不正なタスク・実行
    expect(
      await store.save("../t", { ...claude, sessionId: "s-1", runId: "r1", ...archived }),
    ).toEqual({
      saved: false,
      notSaved: "copy_failed",
    });
    expect(await store.plan("../t", claude)).toEqual({ mode: "new", reason: "first" });
  });

  it("保存に失敗しても、前に保存したものはそのまま再開できる", async () => {
    await saveClaude("t1", "r1", "s-1");
    const archived = archive("r2", { [main("s-1")]: "{}\n" });
    writeFileSync(join(archived.sourceDir, main("s-1")), "tampered\n");
    expect(
      (await store.save("t1", { ...claude, sessionId: "s-1", runId: "r2", ...archived })).saved,
    ).toBe(false);
    const plan = await store.plan("t1", claude);
    expect(plan.mode === "resume" && plan.filesDir).toContain(join("generations", "r1"));
  });

  it("いまのものと、その1つ前の保存だけを残す（読んでいる途中の複製のため）", async () => {
    const generations = () =>
      readdirSync(join(dir, "sessions", "t1", "orchestrator", "generations")).sort();
    await saveClaude("t1", "r1", "s-1");
    expect(generations()).toEqual(["r1"]);
    await saveClaude("t1", "r2", "s-1");
    expect(generations()).toEqual(["r1", "r2"]);
    await saveClaude("t1", "r3", "s-1");
    expect(generations()).toEqual(["r2", "r3"]);
    const plan = await store.plan("t1", claude);
    expect(plan.mode === "resume" && plan.filesDir).toContain(join("generations", "r3"));
  });

  it("中止の片付け：タスクのセッションを消す。ほかのタスクは消さない", async () => {
    await saveClaude("t1", "r1", "s-1");
    await saveClaude("t2", "r2", "s-2");
    expect(store.has("t1")).toBe(true);
    store.remove("t1");
    expect(store.has("t1")).toBe(false);
    expect(existsSync(join(dir, "sessions", "t1"))).toBe(false);
    expect(store.has("t2")).toBe(true);
    store.remove("../sessions");
    expect(existsSync(join(dir, "sessions"))).toBe(true);
  });

  it("セッションの本体のファイル：Claude Code は projects/<作業ディレクトリ>/<ID>.jsonl、Codex は sessions/…/rollout-…-<ID>.jsonl", () => {
    expect(sessionMainFile("claude-code", "s-1", [{ path: "projects/-workspace/s-1.jsonl" }])).toBe(
      "projects/-workspace/s-1.jsonl",
    );
    // サブエージェントのファイル・履歴は本体ではない
    expect(
      sessionMainFile("claude-code", "s-1", [
        { path: "projects/-workspace/s-1/subagents/s-1.jsonl" },
        { path: "history.jsonl" },
        { path: "projects/s-1.jsonl" },
      ]),
    ).toBeUndefined();
    const rollout = "sessions/2026/10/14/rollout-2026-10-14T10-00-00-t-1.jsonl";
    expect(sessionMainFile("codex", "t-1", [{ path: rollout }])).toBe(rollout);
    expect(sessionMainFile("codex", "t-1", [{ path: `archived_${rollout}` }])).toBeUndefined();
    // ID の末尾だけが同じものは、本体ではない
    expect(sessionMainFile("codex", "1", [{ path: rollout }])).toBeUndefined();
    expect(sessionMainFile("codex", "x-t-1", [{ path: rollout }])).toBeUndefined();
    expect(
      sessionMainFile("claude-code", "../x", [{ path: "projects/-workspace/../x.jsonl" }]),
    ).toBeUndefined();
    expect(validSessionId("0d6c5a8e-1b2c-4d5e-8f90-123456789abc")).toBe(true);
    expect(validSessionId("-x")).toBe(false);
  });
});
