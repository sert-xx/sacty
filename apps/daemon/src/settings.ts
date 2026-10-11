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
