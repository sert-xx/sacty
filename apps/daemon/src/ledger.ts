import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type Actor, EventInput, type LedgerEvent } from "@sacty/core";

/**
 * 台帳の保存先。将来PostgreSQLに差し替えられるよう、デーモンはこの型だけに依存する。
 * 追記と読み取りしか持たない。
 */
export interface LedgerStore {
  append(entry: { taskId: string; projectId: string; events: AppendItem[] }): LedgerEvent[];
  all(): LedgerEvent[];
  forTask(taskId: string): LedgerEvent[];
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

function toEvent(row: Row): LedgerEvent {
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

/** SQLiteによる台帳。UPDATEとDELETEはトリガーで拒否する。 */
export class SqliteLedgerStore implements LedgerStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
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
      "INSERT INTO ledger (id, task_id, project_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
    );
    const at = this.now().toISOString();
    const written: LedgerEvent[] = [];
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
    return (this.db.prepare("SELECT * FROM ledger ORDER BY seq").all() as Row[]).map(toEvent);
  }

  forTask(taskId: string) {
    return (
      this.db.prepare("SELECT * FROM ledger WHERE task_id = ? ORDER BY seq").all(taskId) as Row[]
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
