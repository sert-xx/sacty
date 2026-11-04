import { DatabaseSync } from "node:sqlite";
import { type Project, ProjectDefinition } from "@sacty/core";

/** プロジェクトの保存先。作業履歴と違い、設定なので書き換えられる。 */
export interface ProjectStore {
  all(): Project[];
  get(id: string): Project | undefined;
  /** 作るか、置き換える。 */
  put(id: string, definition: ProjectDefinition): Project;
  /**
   * 保存した版（updatedAt）の定義。読み込んだ後にほかの保存があった保存を併合するときの、元の定義（PBI-301）。
   * 古くなって消えた版・無い版は undefined。
   */
  revision(id: string, updatedAt: string): ProjectDefinition | undefined;
  /** 消す。無ければ false。 */
  delete(id: string): boolean;
  close(): void;
}

type Row = { id: string; definition: string; created_at: string; updated_at: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_revisions (
  id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  definition TEXT NOT NULL,
  PRIMARY KEY (id, updated_at)
);
`;

/** 併合のために残す、プロジェクトごとの保存した版の数（古いものから消す）。 */
export const REVISIONS_KEPT = 50;

function toProject(row: Row): Project {
  return {
    ...ProjectDefinition.parse(JSON.parse(row.definition)),
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite によるプロジェクトの保存先（作業履歴と同じファイル）。 */
export class SqliteProjectStore implements ProjectStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  all(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as Row[];
    return rows.map(toProject);
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  put(id: string, definition: ProjectDefinition): Project {
    // 更新の時刻は、設定を読んだ後に変わったかを照合する版として使う（PBI-274）。同じミリ秒の2回の保存や、時計の巻き戻りでも
    // 前の値と必ず変わるよう、前の値より後にする
    const previous = (
      this.db.prepare("SELECT updated_at FROM projects WHERE id = ?").get(id) as
        | { updated_at: string }
        | undefined
    )?.updated_at;
    const clock = this.now().getTime();
    const at = new Date(
      previous !== undefined ? Math.max(clock, new Date(previous).getTime() + 1) : clock,
    ).toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, definition, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(definition), at, at);
    // 併合のために、保存した版の定義を残す（PBI-301）。多くなったら古いものから消す
    this.db
      .prepare(
        "INSERT OR REPLACE INTO project_revisions (id, updated_at, definition) VALUES (?, ?, ?)",
      )
      .run(id, at, JSON.stringify(definition));
    this.db
      .prepare(
        `DELETE FROM project_revisions WHERE id = ? AND updated_at NOT IN (
           SELECT updated_at FROM project_revisions WHERE id = ? ORDER BY updated_at DESC LIMIT ?
         )`,
      )
      .run(id, id, REVISIONS_KEPT);
    const saved = this.get(id);
    if (!saved) throw new Error("project is missing after put");
    return saved;
  }

  revision(id: string, updatedAt: string): ProjectDefinition | undefined {
    const row = this.db
      .prepare("SELECT definition FROM project_revisions WHERE id = ? AND updated_at = ?")
      .get(id, updatedAt) as { definition: string } | undefined;
    if (!row) return undefined;
    try {
      return ProjectDefinition.parse(JSON.parse(row.definition));
    } catch {
      // 今の定義の形に合わなくなった版は、併合の元にしない
      return undefined;
    }
  }

  delete(id: string): boolean {
    this.db.prepare("DELETE FROM project_revisions WHERE id = ?").run(id);
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

/** 設定を持たないメモリ上の保存先（テスト用）。 */
export class MemoryProjectStore implements ProjectStore {
  private readonly items = new Map<string, Project>();
  private readonly revisions = new Map<string, ProjectDefinition>();
  private clock = 0;

  all(): Project[] {
    return [...this.items.values()];
  }

  get(id: string): Project | undefined {
    return this.items.get(id);
  }

  put(id: string, definition: ProjectDefinition): Project {
    const at = new Date(Date.UTC(2026, 9, 10, 0, 0, this.clock++)).toISOString();
    const project = {
      ...definition,
      id,
      createdAt: this.items.get(id)?.createdAt ?? at,
      updatedAt: at,
    };
    this.items.set(id, project);
    this.revisions.set(`${id}\n${at}`, definition);
    return project;
  }

  revision(id: string, updatedAt: string): ProjectDefinition | undefined {
    return this.revisions.get(`${id}\n${updatedAt}`);
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }

  close(): void {}
}
