import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const files = ["docs/spec", "docs/user"].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name)),
);

/** sacty が課す変更行数の上限は無い（PBI-452）。仕様書・ユーザードキュメントに、その上限の文が残らない。 */
describe("セキュリティ対応の変更行数の上限（PBI-452）", () => {
  it.each([
    "行数の上限",
    "300 行",
    "limit on changed lines",
    "cap on changed lines",
    "SECURITY_FIX_MAX_CHANGED_LINES",
  ])("仕様書・ユーザードキュメントに「%s」が残らない", (phrase) => {
    const found = files.filter((f) => readFileSync(join(ROOT, f), "utf8").includes(phrase));
    expect(found).toEqual([]);
  });
});
