import { beforeEach, describe, expect, it, vi } from "vitest";

const daemon = vi.hoisted(() => ({
  task: { id: "t1", title: "T", projectId: "p", status: "queued", currentRunId: undefined } as {
    id: string;
    title: string;
    projectId: string;
    status: string;
    currentRunId: string | undefined;
  },
}));
vi.mock("@/lib/daemon", () => ({
  getTask: async () => ({ task: daemon.task, activity: [] }),
  getRunLog: async () => null,
  getAgentFiles: async () => null,
}));

const { loadRunLog, runningThis } = await import("./run-log-data");

describe("runningThis", () => {
  it("実行中で、同じ実行の ID のときだけ真", () => {
    expect(runningThis({ status: "running", currentRunId: "r1" }, "r1")).toBe(true);
    expect(runningThis({ status: "running", currentRunId: "r2" }, "r1")).toBe(false);
    expect(runningThis({ status: "running" }, "r1")).toBe(false);
    expect(runningThis({ status: "queued", currentRunId: "r1" }, "r1")).toBe(false);
  });
});

describe("loadRunLog（最初の表示）", () => {
  beforeEach(() => {
    daemon.task = {
      id: "t1",
      title: "T",
      projectId: "p",
      status: "queued",
      currentRunId: undefined,
    };
  });
  it("タスクがその実行を今も実行中なら running を渡す", async () => {
    daemon.task = { ...daemon.task, status: "running", currentRunId: "r1" };
    expect((await loadRunLog("t1", "r1"))?.running).toBe(true);
    expect((await loadRunLog("t1", "other"))?.running).toBe(false);
  });
  it("実行中でなければ running は偽", async () => {
    expect((await loadRunLog("t1", "r1"))?.running).toBe(false);
  });
});
