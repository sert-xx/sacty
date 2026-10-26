import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  idEntries,
  isSactyId,
  overlapsMounts,
  removeEntry,
  taskWorkspacePaths,
  workspaceRetirable,
} from "./workspace-cleanup.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-cleanup-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("作業領域の片付けの部品（PBI-157）", () => {
  it("タスク・実行の ID の形をした名前だけを選ぶ", () => {
    const id = randomUUID();
    expect(isSactyId(id)).toBe(true);
    expect(isSactyId("_git")).toBe(false);
    expect(isSactyId(`${id}x`)).toBe(false);
    mkdirSync(join(dir, id));
    mkdirSync(join(dir, "_cache"));
    mkdirSync(join(dir, `${id}.git`));
    expect(idEntries(dir)).toEqual([id]);
    expect(idEntries(dir, ".git")).toEqual([`${id}.git`]);
    // 根がリンクなら、たどらない
    symlinkSync(dir, join(dir, "link"));
    expect(idEntries(join(dir, "link"))).toEqual([]);
    expect(idEntries(join(dir, "missing"))).toEqual([]);
  });

  it("リンクはリンクだけを消し、先は消さない", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    const target = join(dir, "ws");
    mkdirSync(target);
    symlinkSync(outside, join(target, "inner"));
    symlinkSync(outside, join(dir, "top"));
    expect(await removeEntry(join(dir, "top"))).toBe(true);
    expect(await removeEntry(target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await removeEntry(join(dir, "missing"))).toBe(false);
  });

  it("マウントされている場所と、同じか上下の関係なら重なる", () => {
    const ws = join(dir, "ws");
    expect(overlapsMounts(ws, [join(ws, "repo")])).toBe(true);
    expect(overlapsMounts(join(ws, "repo"), [ws])).toBe(true);
    expect(overlapsMounts(ws, [ws])).toBe(true);
    expect(overlapsMounts(ws, [`${ws}2`])).toBe(false);
    expect(overlapsMounts(ws, [])).toBe(false);
  });

  it("工程を終えて止まり、監査が終わった（または監査しない）タスクだけ、作業領域を使わない", () => {
    const base = {
      status: "idle",
      steps: [{ key: "requirements", state: "done" }],
    } as unknown as Task;
    expect(workspaceRetirable(base)).toBe(true);
    expect(workspaceRetirable({ ...base, status: "paused" } as Task)).toBe(false);
    expect(
      workspaceRetirable({ ...base, steps: [{ key: "requirements", state: "active" }] } as Task),
    ).toBe(false);
    const audit = { auditId: "a" } as NonNullable<Task["audit"]>;
    expect(workspaceRetirable({ ...base, audit } as Task)).toBe(false);
    expect(workspaceRetirable({ ...base, audit: { ...audit, paused: { at: "x" } } } as Task)).toBe(
      false,
    );
    expect(workspaceRetirable({ ...base, audit: { ...audit, completedAt: "x" } } as Task)).toBe(
      true,
    );
    expect(
      workspaceRetirable({
        ...base,
        audit: { ...audit, failed: { at: "x", reason: "r" } },
      } as Task),
    ).toBe(true);
    expect(
      workspaceRetirable({ ...base, deployment: { state: "waiting" } } as unknown as Task),
    ).toBe(false);
    expect(workspaceRetirable({ ...base, unstoppedRuns: ["r1"] } as Task)).toBe(false);
  });

  it("タスクの作業領域と、退避した git のメタデータの場所", () => {
    expect(taskWorkspacePaths("/w", "t")).toEqual(["/w/t", "/w/_git/t.git"]);
  });
});
