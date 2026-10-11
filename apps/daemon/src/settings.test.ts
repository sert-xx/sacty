import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
