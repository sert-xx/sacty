import { describe, expect, it } from "vitest";
import type { TaskRow } from "@/lib/task-list-data";
import { indentShown } from "@/lib/task-rows";

const row = (id: string, parentId?: string): TaskRow => ({
  id,
  title: `題 ${id}`,
  child: parentId !== undefined,
  depth: 0,
  start: "sacty",
  repoless: false,
  steps: [],
  status: { text: "実行待ち", tone: "waiting" },
  createdAt: "2026-10-01T12:00:00.000Z",
  ...(parentId !== undefined ? { parentId } : {}),
});

describe("表示する行の字下げ（PBI-341）", () => {
  it("表示した親の下だけ字下げし、親の題を添える", () => {
    const shown = indentShown([row("p"), row("a", "p"), row("r", "a"), row("q", "p")]);
    expect(shown.map((r) => [r.id, r.shownDepth, r.parentTitle])).toEqual([
      ["p", 0, undefined],
      ["a", 1, "題 p"],
      ["r", 2, "題 a"],
      ["q", 1, "題 p"],
    ]);
  });
  it("絞り込みで親が隠れた子は、字下げせず親の題も添えない", () => {
    const shown = indentShown([row("a", "p"), row("r", "a")]);
    expect(shown.map((r) => [r.id, r.shownDepth, r.parentTitle])).toEqual([
      ["a", 0, undefined],
      ["r", 1, "題 a"],
    ]);
  });
  it("親が別のプロジェクトにある子は字下げしない", () => {
    expect(indentShown([row("o", "x")])[0]).toMatchObject({ shownDepth: 0 });
    expect(indentShown([row("o", "x")])[0]).not.toHaveProperty("parentTitle");
  });
});
