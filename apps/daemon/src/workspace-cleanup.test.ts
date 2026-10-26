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
    expect(await removeEntry(dir, join(dir, "top"))).toBe(true);
    expect(await removeEntry(dir, target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await removeEntry(dir, join(dir, "missing"))).toBe(false);
    expect(await removeEntry(dir, join(dir, "missing", "child"))).toBe(false);
  });

  it("途中のディレクトリがリンクなら、その先を消さない。根の外のものも消さない（PBI-157 レビュー指摘）", async () => {
    const root = join(dir, "workspaces");
    const outside = join(dir, "outside");
    mkdirSync(join(outside, "t.git"), { recursive: true });
    writeFileSync(join(outside, "t.git", "HEAD"), "keep");
    mkdirSync(root);
    symlinkSync(outside, join(root, "_git"));
    await expect(removeEntry(root, join(root, "_git", "t.git"))).rejects.toThrow(/not a directory/);
    expect(readFileSync(join(outside, "t.git", "HEAD"), "utf8")).toBe("keep");
    await expect(removeEntry(root, outside)).rejects.toThrow(/not under/);
    await expect(removeEntry(root, root)).rejects.toThrow(/not under/);
    expect(existsSync(outside)).toBe(true);
  });

  it("読めないディレクトリは、ENOENT のほかは理由を知らせる", () => {
    const lines: string[] = [];
    writeFileSync(join(dir, "file"), "x");
    expect(idEntries(join(dir, "missing"), "", (line) => lines.push(line))).toEqual([]);
    expect(lines).toEqual([]);
    // ファイルの下を読もうとする（ENOTDIR）
    expect(idEntries(join(dir, "file", "x"), "", (line) => lines.push(line))).toEqual([]);
    expect(lines.join("\n")).toContain(join(dir, "file", "x"));
  });

  it("マウントされている場所と、同じか上下の関係なら重なる", () => {
    const ws = join(dir, "ws");
    expect(overlapsMounts(ws, [join(ws, "repo")])).toBe(true);
    expect(overlapsMounts(join(ws, "repo"), [ws])).toBe(true);
    expect(overlapsMounts(ws, [ws])).toBe(true);
    expect(overlapsMounts(ws, [`${ws}2`])).toBe(false);
    expect(overlapsMounts(ws, [])).toBe(false);
    // マウント元が / でも、配下と重なる（PBI-157 レビュー指摘）
    expect(overlapsMounts(ws, ["/"])).toBe(true);
    expect(overlapsMounts("/", [ws])).toBe(true);
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
