import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countOpenedMemories,
  expiredMemories,
  groupByLayer,
  type LiveMemory,
  lastUsefulAt,
  liveMemories,
  memoryLayerDir,
  memoryPromptLines,
  overCapacity,
  renderMemoryIndex,
  repositoryMemoryKey,
  syncMemoryLayers,
  taskMemoryLayers,
  usefulDates,
  writeMemoryLayer,
} from "./memory.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sacty-memory-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const live = (id: string, patch: Partial<LiveMemory> = {}): LiveMemory =>
  ({
    id,
    scope: "project",
    title: `題 ${id}`,
    summary: `概要 ${id}`,
    body: `中身 ${id}`,
    taskId: "t1",
    projectId: "p1",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsefulAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  }) as LiveMemory;

describe("メモリーの階層と場所（PBI-126）", () => {
  it("リポジトリの鍵は、clone の URL・SSH・大文字の揺れをそろえる。GitHub でなければ無い", () => {
    expect(repositoryMemoryKey("https://github.com/Acme/App.git")).toBe(
      "https://github.com/acme/app",
    );
    expect(repositoryMemoryKey("git@github.com:acme/app.git")).toBe("https://github.com/acme/app");
    expect(repositoryMemoryKey("/Users/me/app")).toBeUndefined();
  });

  it("プロジェクトは projects/<ID>、リポジトリは repos/<ホスト>/<オーナー>/<名前>。パスを外れる名前はハッシュにする", () => {
    expect(memoryLayerDir(root, { kind: "project", projectId: "default" })).toBe(
      join(root, "projects", "default"),
    );
    expect(memoryLayerDir(root, { kind: "repository", repo: "https://github.com/acme/app" })).toBe(
      join(root, "repos", "github.com", "acme", "app"),
    );
    const escaped = memoryLayerDir(root, { kind: "project", projectId: "../../etc" });
    expect(escaped.startsWith(join(root, "projects", "_"))).toBe(true);
    expect(memoryLayerDir(root, { kind: "project", projectId: ".." })).not.toBe(root);
  });

  it("タスクの階層は、プロジェクトと GitHub の対象リポジトリ。リポジトリが無ければプロジェクトだけ", () => {
    const withRepo = {
      projectId: "p1",
      repository: { url: "https://github.com/acme/app.git" },
    } as unknown as Task;
    expect(taskMemoryLayers(withRepo)).toEqual({
      project: { kind: "project", projectId: "p1" },
      repository: { kind: "repository", repo: "https://github.com/acme/app" },
    });
    expect(taskMemoryLayers({ projectId: "p1" } as unknown as Task)).toEqual({
      project: { kind: "project", projectId: "p1" },
    });
  });

  it("消したメモリーは集めない。登録した時刻を、有効な最終利用日の始まりにする", () => {
    const task = {
      id: "t1",
      projectId: "p1",
      audit: {
        memories: [
          {
            id: "m1",
            scope: "project",
            title: "a",
            summary: "b",
            body: "c",
            step: "implement",
            at: "2026-10-02T00:00:00.000Z",
          },
          {
            id: "m2",
            scope: "project",
            title: "a",
            summary: "b",
            body: "c",
            step: "implement",
            at: "2026-10-01T00:00:00.000Z",
            deleted: { at: "2026-10-03T00:00:00.000Z", reason: "person" },
          },
        ],
      },
    } as unknown as Task;
    expect(liveMemories([task])).toEqual([
      expect.objectContaining({
        id: "m1",
        taskId: "t1",
        projectId: "p1",
        createdAt: "2026-10-02T00:00:00.000Z",
        lastUsefulAt: "2026-10-02T00:00:00.000Z",
      }),
    ]);
    expect(liveMemories([])).toEqual([]);
  });
});

describe("件数の上限（PBI-126）", () => {
  it("階層ごとに数え、上限を超えた分を、有効な最終利用日の古いものから返す", () => {
    const at = (d: number) => `2026-10-0${d}T00:00:00.000Z`;
    const memories = [
      live("old", { lastUsefulAt: at(1) }),
      live("mid", { lastUsefulAt: at(2) }),
      live("new", { lastUsefulAt: at(3) }),
      live("repo", { scope: "repository", repo: "https://github.com/a/b", lastUsefulAt: at(1) }),
    ] as LiveMemory[];
    expect(overCapacity([], 2)).toEqual([]);
    expect(overCapacity(memories.slice(0, 1), 1)).toEqual([]);
    expect(overCapacity(memories.slice(0, 2), 2)).toEqual([]);
    expect(overCapacity(memories, 2).map((m) => m.id)).toEqual(["old"]);
    expect(overCapacity(memories, 1).map((m) => m.id)).toEqual(["mid", "old"]);
  });

  it("有効な最終利用日が同じなら、登録の古いものから返す", () => {
    const memories = [
      live("first", { createdAt: "2026-10-01T00:00:00.000Z" }),
      live("second", { createdAt: "2026-10-02T00:00:00.000Z" }),
    ];
    expect(overCapacity(memories, 1).map((m) => m.id)).toEqual(["first"]);
  });
});

describe("書き出し（PBI-126）", () => {
  const layer = { kind: "project" as const, projectId: "p1" };

  it("索引にはリンク・概要・有効な最終利用日だけを書き、中身は references の1ファイルに1件", () => {
    writeMemoryLayer(root, layer, [live("m1", { title: "題\nの [括弧]", body: "本文" })]);
    const dir = memoryLayerDir(root, layer);
    const index = readFileSync(join(dir, "SKILL.md"), "utf8");
    expect(index).toContain(
      "- [題 の 括弧](references/m1.md)：概要 m1（有効な最終利用日：2026-10-01）",
    );
    expect(index).not.toContain("本文");
    expect(readFileSync(join(dir, "references", "m1.md"), "utf8")).toContain("本文");
  });

  it("無くなったメモリーの中身を消し、メモリーが無くなれば階層ごと消す", () => {
    writeMemoryLayer(root, layer, [live("m1"), live("m2")]);
    writeMemoryLayer(root, layer, [live("m2")]);
    const dir = memoryLayerDir(root, layer);
    expect(readdirSync(join(dir, "references"))).toEqual(["m2.md"]);
    writeMemoryLayer(root, layer, []);
    expect(existsSync(dir)).toBe(false);
  });

  it("すべてを書き直すときは、記録の無い階層を消す。階層を指定すれば、ほかの階層に触れない", () => {
    const other = { kind: "project" as const, projectId: "p2" };
    mkdirSync(memoryLayerDir(root, other), { recursive: true });
    syncMemoryLayers(root, [live("m1")], [layer]);
    expect(existsSync(memoryLayerDir(root, other))).toBe(true);
    syncMemoryLayers(root, [live("m1")]);
    expect(existsSync(memoryLayerDir(root, other))).toBe(false);
    expect(existsSync(join(memoryLayerDir(root, layer), "references", "m1.md"))).toBe(true);
  });

  it("索引と指示は、関係するものだけを開くこと、ほかの決まりより優先度が低いことを書く", () => {
    const index = renderMemoryIndex(layer, []);
    expect(index).toContain("関係するものだけを開き");
    expect(index).toContain("食い違うときは、そちらに従って");
    const lines = memoryPromptLines(["/sacty-memory/project"]).join("\n");
    expect(lines).toContain("/sacty-memory/project");
    expect(lines).toContain("関係しないものは開かないでください");
    expect(lines).toContain("優先度が低い");
  });
});

describe("有効な最終利用日と掃除（PBI-127）", () => {
  const task = (id: string, queuedAt: string, useful: string[]) =>
    ({
      id,
      projectId: "p1",
      audit: { queuedAt, memories: [], survey: { usefulMemories: useful } },
    }) as unknown as Task;

  it("役に立ったと判断されたタスクの完了日の最新を、メモリーごとに取る", () => {
    const dates = usefulDates([
      task("a", "2026-10-05T00:00:00.000Z", ["m1"]),
      task("b", "2026-10-09T00:00:00.000Z", ["m1", "m2"]),
      task("c", "2026-10-07T00:00:00.000Z", ["m1"]),
      { id: "d", projectId: "p1" } as unknown as Task,
    ]);
    expect(dates.get("m1")).toBe("2026-10-09T00:00:00.000Z");
    expect(dates.get("m2")).toBe("2026-10-09T00:00:00.000Z");
    expect(dates.has("m3")).toBe(false);
    expect(usefulDates([]).size).toBe(0);
  });

  it("有効な最終利用日は、登録した時刻より前に戻さない", () => {
    expect(lastUsefulAt("2026-10-05T00:00:00.000Z", undefined)).toBe("2026-10-05T00:00:00.000Z");
    expect(lastUsefulAt("2026-10-05T00:00:00.000Z", "2026-10-01T00:00:00.000Z")).toBe(
      "2026-10-05T00:00:00.000Z",
    );
    expect(lastUsefulAt("2026-10-05T00:00:00.000Z", "2026-10-09T00:00:00.000Z")).toBe(
      "2026-10-09T00:00:00.000Z",
    );
  });

  it("残す日数を超えたものだけを返す（ちょうどは残す）", () => {
    const at = Date.parse("2026-10-01T00:00:00.000Z");
    const day = 86_400_000;
    const memories = [live("m1"), live("m2", { lastUsefulAt: "2026-10-02T00:00:00.000Z" })];
    expect(expiredMemories([], at + 100 * day, 1)).toEqual([]);
    expect(expiredMemories(memories, at + 10 * day - 1, 10)).toEqual([]);
    expect(expiredMemories(memories, at + 10 * day, 10)).toEqual([]);
    expect(expiredMemories(memories, at + 10 * day + 1, 10).map((m) => m.id)).toEqual(["m1"]);
    expect(expiredMemories(memories, at + 11 * day + 1, 10).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("開いた回数は、中身のファイルの場所だけを数える（索引の相対リンク・知らない ID・ほかの場所は数えない）", () => {
    const ids = new Set(["m1", "m2"]);
    const log = [
      '{"input":{"file_path":"/sacty-memory/project/references/m1.md"}}',
      "cat /sacty-memory/repository/references/m1.md",
      "- [題](references/m2.md)：概要",
      "/sacty-memory/project/references/m9.md",
      "/workspace/references/m2.md",
      "/sacty-memory/project/SKILL.md",
    ].join("\n");
    const counts = countOpenedMemories(log, ids);
    expect([...counts.entries()]).toEqual([["m1", 2]]);
    expect(countOpenedMemories("", ids).size).toBe(0);
    // 複数のログを足し合わせる
    countOpenedMemories("/sacty-memory/project/references/m2.md", ids, counts);
    expect(counts.get("m2")).toBe(1);
  });
});

describe("階層ごとに分ける（PR #136 レビュー指摘）", () => {
  it("1回の走査で階層に分け、各階層を新しい順にする。多くの階層でも件数に比例した時間で済む", () => {
    const memories: LiveMemory[] = [];
    for (let l = 0; l < 300; l++) {
      for (let i = 0; i < 30; i++) {
        memories.push(
          live(`m${l}-${i}`, {
            scope: "repository",
            repo: `https://github.com/o/r${l}`,
            lastUsefulAt: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
          } as Partial<LiveMemory>),
        );
      }
    }
    const started = performance.now();
    const groups = groupByLayer(memories);
    const over = overCapacity(memories, 30);
    expect(performance.now() - started).toBeLessThan(500);
    expect(groups.size).toBe(300);
    expect(over).toEqual([]);
    const first = groups.values().next().value?.memories ?? [];
    expect(first[0]?.lastUsefulAt >= (first.at(-1)?.lastUsefulAt ?? "")).toBe(true);
  });
});
