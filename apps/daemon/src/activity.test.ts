import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderMessage } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeLegacyTasksAtStartup, SqliteActivityStore } from "./activity.js";
import { loadConfig } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-activity-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** PBI-20 より前の、以前の名前（ledger）のテーブル。 */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_task ON ledger (task_id, seq);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
`;

describe("作業履歴の保存先（PBI-20）", () => {
  it("以前の名前（ledger）のテーブルを引き継ぎ、記録済みの行と seq の続きを使い、追記専用のままにする", () => {
    const path = join(dir, "sacty.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(LEGACY_SCHEMA);
    const insert = legacy.prepare(
      "INSERT INTO ledger (id, task_id, project_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    // 画面で作ったタスクは、以前は開始地点を ticket と記録していた
    insert.run(
      "e1",
      "t1",
      "default",
      "2026-10-10T00:00:00.000Z",
      "person",
      "TaskCreated",
      JSON.stringify({ title: "古いタスク", body: "", start: "ticket", budgetCapUsd: 1 }),
    );
    insert.run(
      "e2",
      "t1",
      "default",
      "2026-10-10T00:00:01.000Z",
      "sacty",
      "StepsChosen",
      JSON.stringify({ steps: ["investigate"] }),
    );
    legacy.close();

    const store = new SqliteActivityStore(path);
    const events = store.forTask("t1");
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "TaskCreated"],
      [2, "StepsChosen"],
    ]);
    expect(events[0]?.type === "TaskCreated" && events[0].payload.start).toBe("sacty");
    const [added] = store.append({
      taskId: "t1",
      projectId: "default",
      events: [{ actor: "person", event: { type: "TaskCancelled", payload: { cleanup: [] } } }],
    });
    expect(added?.seq).toBe(3);
    store.close();

    const db = new DatabaseSync(path);
    const names = db
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => `${r.type}:${r.name}`);
    // 以前のテーブル・索引・トリガーは残らない
    expect(names).toEqual([
      "table:activity",
      "trigger:activity_no_delete",
      "trigger:activity_no_update",
      "index:activity_task",
    ]);
    expect(() => db.exec("UPDATE activity SET actor = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM activity")).toThrow(/append-only/);
    db.close();

    // 2回目以降に開いても、そのまま使える
    const again = new SqliteActivityStore(path);
    expect(again.all()).toHaveLength(3);
    again.close();
  });
});

describe("「PR作成」の工程を前提にした古いタスクを捨てる（PBI-110）", () => {
  /** 今の形では読めない記録を含む作業履歴を、直接書き込む（工程 pr は無くした）。 */
  function seed(path: string, rows: [task: string, type: string, payload: unknown][]) {
    new SqliteActivityStore(path).close();
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      "INSERT INTO activity (id, task_id, project_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    rows.forEach(([task, type, payload], i) => {
      insert.run(
        `e${i}`,
        task,
        "default",
        "2026-10-15T00:00:00.000Z",
        "sacty",
        type,
        JSON.stringify(payload),
      );
    });
    db.close();
  }
  const created = (extra: Record<string, unknown> = {}) => ({
    title: "t",
    body: "",
    start: "sacty",
    budgetCapUsd: 1,
    ...extra,
  });

  it("工程 pr を含むタスクと、つながったタスク（分割の親子・修正のタスクと元のタスク）を消し、残りは読める", () => {
    const path = join(dir, "sacty.db");
    seed(path, [
      // 承認待ちの古いタスク（処理中のものも消す）
      ["old", "TaskCreated", created()],
      ["old", "StepsChosen", { steps: ["requirements", "design", "implement", "pr"] }],
      ["old", "StepSubmitted", { step: "pr", submission: 1 }],
      // 分割の親（工程 pr は無い）と、子（1つは pr を含み、1つはまだ工程を選んでいない）
      ["parent", "TaskCreated", created()],
      [
        "parent",
        "StepsChosen",
        { steps: ["investigate", "requirements", "design", "split", "integrate"] },
      ],
      [
        "child-1",
        "TaskCreated",
        created({ start: "split", parent: { taskId: "parent", dependsOn: [] } }),
      ],
      ["child-1", "StepsChosen", { steps: ["implement", "pr"] }],
      [
        "child-2",
        "TaskCreated",
        created({ start: "split", parent: { taskId: "parent", dependsOn: ["child-1"] } }),
      ],
      // マージの後の監視の、元のタスク（pr を含む）と修正のタスク（まだ工程を選んでいない）
      ["origin", "TaskCreated", created()],
      ["origin", "StepsChosen", { steps: ["implement", "pr"] }],
      [
        "fix",
        "TaskCreated",
        created({
          start: "deployment",
          fix: { taskId: "origin", kind: "ci", fingerprint: "f", depth: 1 },
        }),
      ],
      // 工程の組み合わせに pr が無くても、pr の工程を指す記録（step・target）があれば消す
      ["step-only", "TaskCreated", created()],
      ["step-only", "StepsChosen", { steps: ["implement"] }],
      ["step-only", "StepSubmitted", { step: "pr", submission: 1 }],
      ["target-only", "TaskCreated", created()],
      ["target-only", "StepsChosen", { steps: ["implement"] }],
      [
        "target-only",
        "ChangesRequested",
        { step: "implement", target: "pr", round: 1, remarks: [{ id: "r", text: "x" }] },
      ],
      // 今の形のタスクと、工程を選ぶ前のタスクは残す
      ["current", "TaskCreated", created()],
      ["current", "StepsChosen", { steps: ["requirements", "design", "implement"] }],
      ["fresh", "TaskCreated", created()],
    ]);
    const store = new SqliteActivityStore(path);
    expect(() => store.all()).toThrow();
    expect(store.purgeLegacyPrStepTasks()).toEqual([
      "child-1",
      "child-2",
      "fix",
      "old",
      "origin",
      "parent",
      "step-only",
      "target-only",
    ]);
    expect([...new Set(store.all().map((e) => e.taskId))]).toEqual(["current", "fresh"]);
    // 2回目は何もしない。追記専用の保証は戻っている
    expect(store.purgeLegacyPrStepTasks()).toEqual([]);
    expect(() => store.rawExecForTest("DELETE FROM activity")).toThrow(/append-only/);
    const [added] = store.append({
      taskId: "current",
      projectId: "default",
      events: [{ actor: "person", event: { type: "TaskCancelled", payload: { cleanup: [] } } }],
    });
    expect(added?.seq).toBeGreaterThan(20);
    store.close();
  });

  it("起動時は、設定（config.yaml）に誤りがある間は消さずに止め、古い step_agents.pr には消すよう案内する（レビュー指摘）", () => {
    const path = join(dir, "sacty.db");
    seed(path, [
      ["old", "TaskCreated", created()],
      ["old", "StepsChosen", { steps: ["implement", "pr"] }],
    ]);
    const config = (stepAgents: string) =>
      writeFileSync(
        join(dir, "config.yaml"),
        [
          "default_agent: x",
          ...(stepAgents ? ["step_agents:", stepAgents] : []),
          "agents:",
          "  x:",
          "    runtime: claude-code",
          "    auth: { mode: subscription, secret: claude-oauth-token }",
          "    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }",
        ].join("\n"),
      );
    const store = new SqliteActivityStore(path);
    config("  pr: x");
    const blocked = purgeLegacyTasksAtStartup(store, () => loadConfig(dir));
    expect("blocked" in blocked && blocked.blocked.tasks).toEqual(["old"]);
    const problem = "blocked" in blocked ? blocked.blocked.problem : "";
    expect(renderMessage(problem, "ja")).toBe(
      "設定ファイルの step_agents に pr があります。「PR作成」の工程は無くなりました（実装の工程の中で PR を作ります）。step_agents から pr を消してください。",
    );
    expect(renderMessage(problem, "en")).toContain("Delete pr from step_agents.");
    // 消していない
    expect(store.legacyPrStepTasks()).toEqual(["old"]);
    // 直したら消す
    config("  implement: x");
    expect(purgeLegacyTasksAtStartup(store, () => loadConfig(dir))).toEqual({ purged: ["old"] });
    expect(store.all()).toEqual([]);
    store.close();
  });

  it("捨てるものが無ければ、設定に誤りがあっても起動を止めない（設定を見ない）", () => {
    const path = join(dir, "sacty.db");
    seed(path, [["a", "TaskCreated", created()]]);
    const store = new SqliteActivityStore(path);
    let read = 0;
    expect(
      purgeLegacyTasksAtStartup(store, () => {
        read += 1;
        return { ok: false, problem: "x" };
      }),
    ).toEqual({ purged: [] });
    expect(read).toBe(0);
    store.close();
  });

  it("工程 pr を含むタスクが無ければ、何も消さない", () => {
    const path = join(dir, "sacty.db");
    seed(path, [
      ["a", "TaskCreated", created()],
      ["a", "StepsChosen", { steps: ["investigate"] }],
    ]);
    const store = new SqliteActivityStore(path);
    expect(store.purgeLegacyPrStepTasks()).toEqual([]);
    expect(store.all()).toHaveLength(2);
    store.close();
  });
});
