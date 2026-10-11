import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";

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
