import { describe, expect, it } from "vitest";
import { FLAKY_KNOWN_MIN_TASKS, flakyFailureLine } from "./events.js";
import { flakyTests, knownFlakyTests } from "./flaky-tests.js";
import type { Task } from "./projection.js";

// 認めた不安定な失敗を、作業履歴（タスクの状態）からプロジェクトごとに集計する（PBI-312）

const REPO = "https://github.com/acme/app";
const seen = (at: string, o: Partial<{ name: string; file: string; reason: string }> = {}) => ({
  name: "ui > 保存",
  file: "tests/ui.spec.ts",
  reason: "別の画面",
  at,
  ...o,
});
const task = (id: string, o: Partial<Task> = {}) =>
  ({
    id,
    projectId: "p1",
    title: `タスク ${id}`,
    repo: REPO,
    status: "idle",
    steps: [],
    ...o,
  }) as unknown as Task;
const seenIn = (id: string, at: string, o: Partial<Task> = {}) =>
  task(id, { flakySightings: [seen(at)], ...o });

describe("不安定なテストの集計（PBI-312）", () => {
  it("0 件：記録が無ければ空", () => {
    expect(flakyTests([], "p1")).toEqual([]);
    expect(flakyTests([task("a")], "p1")).toEqual([]);
  });

  it("1 件：名前・タスクの数・最後に見た日時・タスクと PR へのリンクを出す", () => {
    const pr = { url: `${REPO}/pull/7` } as Task["pullRequest"];
    expect(flakyTests([seenIn("a", "2026-01-01", { pullRequest: pr })], "p1")).toEqual([
      {
        name: "ui > 保存",
        file: "tests/ui.spec.ts",
        repo: REPO,
        taskCount: 1,
        lastSeenAt: "2026-01-01",
        reason: "別の画面",
        tasks: [
          {
            taskId: "a",
            taskTitle: "タスク a",
            at: "2026-01-01",
            pullRequestUrl: `${REPO}/pull/7`,
          },
        ],
        known: false,
      },
    ]);
  });

  it("複数件：テストごとに分け、既知のものを先に、新しい順に並べる", () => {
    const other = { name: "b" };
    const list = flakyTests(
      [
        task("a", { flakySightings: [seen("2026-01-01"), seen("2026-01-09", other)] }),
        seenIn("b", "2026-01-02"),
        seenIn("c", "2026-01-03"),
      ],
      "p1",
    );
    expect(list.map((t) => [t.name, t.taskCount, t.known, t.lastSeenAt])).toEqual([
      ["ui > 保存", 3, true, "2026-01-03"],
      ["b", 1, false, "2026-01-09"],
    ]);
    expect(list[0]?.tasks.map((t) => t.taskId)).toEqual(["c", "b", "a"]);
  });

  it("同じタスクで複数回見ても1と数え、最後の記録を使う", () => {
    const [test] = flakyTests(
      [
        task("a", {
          flakySightings: [
            seen("2026-01-01", { reason: "古い根拠" }),
            seen("2026-01-05", { reason: "新しい根拠" }),
            seen("2026-01-03", { reason: "途中の根拠" }),
          ],
        }),
      ],
      "p1",
    );
    expect(test).toMatchObject({ taskCount: 1, lastSeenAt: "2026-01-05", reason: "新しい根拠" });
    expect(test?.tasks).toHaveLength(1);
  });

  it("./ の有無はそろえ、ファイルかリポジトリが違えば別のテストと数える", () => {
    const list = flakyTests(
      [
        seenIn("a", "2026-01-01"),
        task("b", { flakySightings: [seen("2026-01-02", { file: "./tests/ui.spec.ts" })] }),
        task("c", { flakySightings: [seen("2026-01-03", { file: "tests/other.spec.ts" })] }),
        seenIn("d", "2026-01-04", { repo: "https://github.com/acme/other" }),
        seenIn("e", "2026-01-05", { repo: "https://github.com/ACME/app.git" }),
      ],
      "p1",
    );
    expect(list.map((t) => [t.repo, t.file, t.taskCount])).toEqual([
      [REPO, "tests/ui.spec.ts", 3],
      ["https://github.com/acme/other", "tests/ui.spec.ts", 1],
      [REPO, "tests/other.spec.ts", 1],
    ]);
  });

  it("別のプロジェクトの記録は混ざらない", () => {
    const tasks = [
      seenIn("a", "2026-01-01"),
      seenIn("b", "2026-01-02", { projectId: "p2" }),
      seenIn("c", "2026-01-03", { projectId: "p2" }),
      seenIn("d", "2026-01-04", { projectId: "p2" }),
    ];
    expect(flakyTests(tasks, "p1")[0]).toMatchObject({ taskCount: 1, known: false });
    expect(flakyTests(tasks, "p2")[0]).toMatchObject({ taskCount: 3, known: true });
    expect(flakyTests(tasks, "p3")).toEqual([]);
    expect(knownFlakyTests(tasks, task("x"))).toEqual([]);
  });

  it(`既知は ${FLAKY_KNOWN_MIN_TASKS} タスクから。リポジトリの違うタスクには渡さない`, () => {
    const two = [seenIn("a", "2026-01-01"), seenIn("b", "2026-01-02")];
    expect(knownFlakyTests(two, task("x"))).toEqual([]);
    const three = [...two, seenIn("c", "2026-01-03")];
    const test = { name: "ui > 保存", file: "tests/ui.spec.ts" };
    expect(knownFlakyTests(three, task("x"))).toEqual([test]);
    expect(knownFlakyTests(three, task("x", { repo: "https://github.com/acme/other" }))).toEqual(
      [],
    );
    expect(knownFlakyTests(three, task("x", { repo: undefined }))).toEqual([]);
  });

  it("画面に出す文は伏せる", () => {
    const [test] = flakyTests([seenIn("a", "2026-01-01")], "p1", (text) => `伏せた ${text}`);
    expect(test?.tasks[0]?.taskTitle).toBe("伏せた タスク a");
    expect(test?.reason).toBe("伏せた 別の画面");
    expect(test?.name).toBe("伏せた ui > 保存");
  });

  describe("そのテストを直すタスク", () => {
    const three = [seenIn("a", "2026-01-01"), seenIn("b", "2026-01-02"), seenIn("c", "2026-01-03")];
    const flakyFix = { name: "ui > 保存", file: "tests/ui.spec.ts" };

    it("終わっていなければ添える。既知のままで、提案は重ねない", () => {
      const [test] = flakyTests([...three, task("fix", { flakyFix, status: "queued" })], "p1");
      expect(test).toMatchObject({
        known: true,
        fixTask: { taskId: "fix", title: "タスク fix" },
      });
    });

    it("中止したら添えない（また提案する）", () => {
      const [test] = flakyTests([...three, task("fix", { flakyFix, status: "cancelled" })], "p1");
      expect(test?.fixTask).toBeUndefined();
    });

    it("PR をマージせずに終えたら添えない（また提案する）", () => {
      const done = task("fix", {
        flakyFix,
        status: "idle",
        steps: [{ state: "done" }] as unknown as Task["steps"],
      });
      expect(flakyTests([...three, done], "p1")[0]?.fixTask).toBeUndefined();
    });

    it("別のテスト・別のリポジトリを直すタスクは関係しない", () => {
      const list = [
        task("x", { flakyFix: { ...flakyFix, name: "別" }, status: "queued" }),
        task("y", { flakyFix, status: "queued", repo: "https://github.com/acme/other" }),
      ];
      expect(flakyTests([...three, ...list], "p1")[0]?.fixTask).toBeUndefined();
    });

    it("PR をマージしたら、それより前の記録は数えず、後の記録だけを数え直す", () => {
      const merged = task("fix", {
        flakyFix,
        pullRequestMerge: { at: "2026-01-03" } as Task["pullRequestMerge"],
      });
      expect(flakyTests([...three, merged], "p1")).toEqual([]);
      expect(knownFlakyTests([...three, merged], task("x"))).toEqual([]);
      const [again] = flakyTests([...three, merged, seenIn("d", "2026-01-04")], "p1");
      expect(again).toMatchObject({ taskCount: 1, known: false });
      expect(again?.fixTask).toBeUndefined();
    });
  });
});

describe("認めた不安定な失敗の1行（PBI-312）", () => {
  const f = { name: "n", file: "f", reason: "r" };
  it("実行し直しを省いたものは、0 回中 0 回と書かない", () => {
    expect(flakyFailureLine({ ...f, runs: 0, passes: 0 })).toBe(
      "n（f。既知の不安定なテストで、実行し直しを省いた）：r",
    );
    expect(flakyFailureLine({ ...f, runs: 3, passes: 2 })).toBe(
      "n（f。実行し直して 3 回中 2 回通った）：r",
    );
  });
});
