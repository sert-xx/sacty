import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSettingsStore } from "./settings.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sacty の設定の保存先（PBI-26）", () => {
  it("設定が無ければ空、保存したものは開き直しても読め、上書きできる", () => {
    const path = join(dir, "sacty.db");
    const store = new SqliteSettingsStore(path);
    expect(store.get()).toEqual({});
    expect(store.put({ intakeLabel: "sacty" })).toEqual({ intakeLabel: "sacty" });
    store.close();
    const again = new SqliteSettingsStore(path);
    expect(again.get()).toEqual({ intakeLabel: "sacty" });
    again.put({});
    expect(again.get()).toEqual({});
    again.close();
  });
});

describe("消した設定の項目の移行（PBI-99）", () => {
  /** これまでの版が保存した設定を、そのまま書く。 */
  const saveRaw = (path: string, value: unknown) => {
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO settings (id, value, updated_at) VALUES (1, ?, ?)").run(
      JSON.stringify(value),
      "2026-10-14T00:00:00.000Z",
    );
    db.close();
  };
  const readRaw = (path: string) => {
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT value, updated_at FROM settings WHERE id = 1").get() as {
      value: string;
      updated_at: string;
    };
    db.close();
    return { value: JSON.parse(row.value) as unknown, updatedAt: row.updated_at };
  };
  const now = () => new Date("2026-10-15T00:00:00.000Z");

  it("開くと、保存されている triageOff の pullRequests を消す。ほかの項目と種類は残し、空になれば項目ごと消す", () => {
    const path = join(dir, "sacty.db");
    saveRaw(path, {
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      triageOff: ["issues", "pullRequests", "tickets"],
    });
    const store = new SqliteSettingsStore(path, now);
    expect(store.get()).toEqual({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      triageOff: ["issues", "tickets"],
    });
    store.close();
    // 保存されているデータからも消えている
    expect(readRaw(path)).toEqual({
      value: {
        intakeLabel: "sacty",
        reviewLabel: "sacty-review",
        triageOff: ["issues", "tickets"],
      },
      updatedAt: "2026-10-15T00:00:00.000Z",
    });

    rmSync(path, { force: true });
    saveRaw(path, { intakeLabel: "sacty", triageOff: ["pullRequests"] });
    const only = new SqliteSettingsStore(path, now);
    expect(only.get()).toEqual({ intakeLabel: "sacty" });
    only.close();
    expect(readRaw(path).value).toEqual({ intakeLabel: "sacty" });
  });

  it("消すものが無ければ書き換えない（更新日時も変えない）", () => {
    const path = join(dir, "sacty.db");
    saveRaw(path, { intakeLabel: "sacty", triageOff: ["issues"] });
    const store = new SqliteSettingsStore(path, now);
    expect(store.get()).toEqual({ intakeLabel: "sacty", triageOff: ["issues"] });
    store.close();
    expect(readRaw(path).updatedAt).toBe("2026-10-14T00:00:00.000Z");
  });
});
