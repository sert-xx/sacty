import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type ActivityEvent, type Actor, EventInput } from "@sacty/core";

/**
 * 作業履歴の保存先。将来PostgreSQLに差し替えられるよう、デーモンはこの型だけに依存する。
 * 追記と読み取りしか持たない。
 */
export interface ActivityStore {
  append(entry: { taskId: string; projectId: string; events: AppendItem[] }): ActivityEvent[];
  all(): ActivityEvent[];
  forTask(taskId: string): ActivityEvent[];
  close(): void;
}

export type AppendItem = { actor: Actor; event: EventInput };

type Row = {
  seq: number;
  id: string;
  task_id: string;
  project_id: string;
  at: string;
  actor: Actor;
  type: string;
  payload: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_task ON activity (task_id, seq);
CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
`;

/**
 * 以前の名前（ledger）のテーブルがあれば、作業履歴（activity）のテーブルに名前を変える（PBI-20）。
 * 記録済みの行と seq の続きはそのまま引き継ぐ。索引とトリガーは、名前を変えて作り直す。
 */
const RENAME_LEGACY = `
DROP TRIGGER IF EXISTS ledger_no_update;
DROP TRIGGER IF EXISTS ledger_no_delete;
DROP INDEX IF EXISTS ledger_task;
ALTER TABLE ledger RENAME TO activity;
`;

function toEvent(row: Row): ActivityEvent {
  const parsed = EventInput.parse({ type: row.type, payload: JSON.parse(row.payload) });
  return {
    ...parsed,
    seq: row.seq,
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    at: row.at,
    actor: row.actor,
  };
}

/** SQLiteによる作業履歴。UPDATEとDELETEはトリガーで拒否する。 */
export class SqliteActivityStore implements ActivityStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    const table = (name: string) =>
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (table("ledger") && !table("activity")) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(RENAME_LEGACY);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.db.exec(SCHEMA);
  }

  append({
    taskId,
    projectId,
    events,
  }: {
    taskId: string;
    projectId: string;
    events: AppendItem[];
  }) {
    const insert = this.db.prepare(
      "INSERT INTO activity (id, task_id, project_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
    );
    const at = this.now().toISOString();
    const written: ActivityEvent[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { actor, event } of events) {
        const valid = EventInput.parse(event);
        const row = insert.get(
          randomUUID(),
          taskId,
          projectId,
          at,
          actor,
          valid.type,
          JSON.stringify(valid.payload),
        ) as Row;
        written.push(toEvent(row));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return written;
  }

  all() {
    return (this.db.prepare("SELECT * FROM activity ORDER BY seq").all() as Row[]).map(toEvent);
  }

  forTask(taskId: string) {
    return (
      this.db.prepare("SELECT * FROM activity WHERE task_id = ? ORDER BY seq").all(taskId) as Row[]
    ).map(toEvent);
  }

  /** テスト専用：生のSQLを実行する（追記専用の保証を確かめるため）。 */
  rawExecForTest(sql: string) {
    this.db.exec(sql);
  }

  close() {
    this.db.close();
  }
}
