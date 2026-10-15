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

  /**
   * 「PR作成」の工程（pr）を前提にした、古いタスクの記録を捨てる（PBI-110）。工程 pr は無くし、互換の層は作らないので、
   * これらの記録は今の形として読めない（読むとデーモンが起動できない）。起動時に、作業履歴を読む前に呼ぶ。
   * - 捨てるタスク：工程に pr を含むタスク（StepsChosen の steps）と、工程 pr を指す記録（step・target が pr）のあるタスク。
   *   処理中のタスク（承認待ち・実行待ちなど）も捨てる。
   * - 関係するタスクも一緒に捨てる：タスク分割の親と子（子の1つだけを捨てると、親が子の完了を待ち続けるため）、マージの後の
   *   監視の修正のタスクと元のタスク（元のタスクの記録から、捨てた修正のタスクを作り直さないため）。
   * - 作業履歴は追記専用なので、同じトランザクションの中で削除を拒むトリガーを外し、消してから作り直す。
   * 捨てたタスクの ID を返す（無ければ空。何もしない）。作業領域・セッションログ・GitHub のブランチと PR は消さない。
   */
  purgeLegacyPrStepTasks(): string[] {
    const marked = (
      this.db
        .prepare(
          `SELECT DISTINCT task_id FROM activity WHERE json_valid(payload) AND (
            (type = 'StepsChosen' AND EXISTS (SELECT 1 FROM json_each(payload, '$.steps') WHERE value = 'pr'))
            OR json_extract(payload, '$.step') = 'pr'
            OR json_extract(payload, '$.target') = 'pr'
          )`,
        )
        .all() as { task_id: string }[]
    ).map((r) => r.task_id);
    if (marked.length === 0) return [];
    // タスクのつながり（子 → 親、修正のタスク → 元のタスク）。どちら向きにもたどって、つながったタスクをまとめて捨てる
    const links = this.db
      .prepare(
        `SELECT task_id, json_extract(payload, '$.parent.taskId') AS parent,
            json_extract(payload, '$.fix.taskId') AS origin
          FROM activity WHERE type = 'TaskCreated' AND json_valid(payload)`,
      )
      .all() as { task_id: string; parent: string | null; origin: string | null }[];
    const neighbors = new Map<string, Set<string>>();
    const connect = (a: string, b: string) => {
      neighbors.set(a, (neighbors.get(a) ?? new Set()).add(b));
      neighbors.set(b, (neighbors.get(b) ?? new Set()).add(a));
    };
    for (const link of links) {
      if (link.parent) connect(link.task_id, link.parent);
      if (link.origin) connect(link.task_id, link.origin);
    }
    const purged = new Set<string>();
    const queue = [...marked];
    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (purged.has(id)) continue;
      purged.add(id);
      for (const next of neighbors.get(id) ?? []) if (!purged.has(next)) queue.push(next);
    }
    const ids = [...purged].sort();
    const remove = this.db.prepare("DELETE FROM activity WHERE task_id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DROP TRIGGER IF EXISTS activity_no_delete");
      for (const id of ids) remove.run(id);
      this.db.exec(SCHEMA);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return ids;
  }

  /** テスト専用：生のSQLを実行する（追記専用の保証を確かめるため）。 */
  rawExecForTest(sql: string) {
    this.db.exec(sql);
  }

  close() {
    this.db.close();
  }
}
