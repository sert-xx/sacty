import { DatabaseSync } from "node:sqlite";
import { SactySettings } from "@sacty/core";

/** sacty 全体の設定の保存先（プロジェクトとは別。PBI-26）。 */
export interface SettingsStore {
  get(): SactySettings;
  put(settings: SactySettings): SactySettings;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** SQLite による sacty 全体の設定の保存先（作業履歴と同じファイル。1行だけ）。 */
export class SqliteSettingsStore implements SettingsStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.dropRemovedItems();
  }

  /**
   * 消した設定の項目を、保存されている設定から消す（開くたびに。消すものが無ければ書かない）。
   * - triageOff の pullRequests（取り込むラベルの PR の On/Off。取り込むラベルは Issue だけを取り込むようになった。PBI-99）
   */
  private dropRemovedItems(): void {
    const row = this.db.prepare("SELECT value FROM settings WHERE id = 1").get() as
      | { value: string }
      | undefined;
    if (!row) return;
    const value = JSON.parse(row.value) as { triageOff?: unknown };
    if (!Array.isArray(value.triageOff) || !value.triageOff.includes("pullRequests")) return;
    const triageOff = value.triageOff.filter((kind) => kind !== "pullRequests");
    const { triageOff: _removed, ...rest } = value;
    this.db
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE id = 1")
      .run(
        JSON.stringify(triageOff.length > 0 ? { ...rest, triageOff } : rest),
        this.now().toISOString(),
      );
  }

  get(): SactySettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE id = 1").get() as
      | { value: string }
      | undefined;
    return SactySettings.parse(row ? JSON.parse(row.value) : {});
  }

  put(settings: SactySettings): SactySettings {
    this.db
      .prepare(
        `INSERT INTO settings (id, value, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(settings), this.now().toISOString());
    return this.get();
  }

  close(): void {
    this.db.close();
  }
}

/** メモリに置く設定（テスト用）。 */
export class MemorySettingsStore implements SettingsStore {
  constructor(private settings: SactySettings = {}) {}
  get(): SactySettings {
    return this.settings;
  }
  put(settings: SactySettings): SactySettings {
    this.settings = settings;
    return settings;
  }
  close(): void {}
}
