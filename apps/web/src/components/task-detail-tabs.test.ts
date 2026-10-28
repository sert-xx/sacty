// @vitest-environment jsdom
import { type ActivityEvent, project, type Task } from "@sacty/core";
import { act, type FC, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetailData } from "@/lib/task-detail-data";

/*
 * タスクの詳細のタブ（PR #250 レビュー指摘）。既存のリンクのハッシュ（#audit・#proposals・#event-…）で、要素のある
 * タブを開くこと、出していないタブの指定は概要にすること、矢印キーで移れること、工程の無い古いタスクでも監視の
 * 記録を出すことを、実際の DOM で確かめる。
 */
vi.mock("@/app/actions", () => ({
  deriveTaskAction: async () => ({}),
  pauseTaskAction: async () => ({}),
  cancelTaskAction: async () => ({}),
  resumeTaskAction: async () => ({}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
// 中身は各部品のテストで確かめる。ここではリンクの先の要素だけを置く
vi.mock("@/components/audit", () => ({
  TaskAuditCard: () => h("h2", { id: "audit" }, "audit"),
}));
vi.mock("@/components/proposals", () => ({
  Proposals: () => h("h2", { id: "proposals" }, "proposals"),
}));
vi.mock("@/components/deployment", () => ({
  DeploymentWatchCard: () => h("p", { id: "deployment-watch" }, "watch"),
}));

const { I18nProvider } = await import("@/i18n/client");
const { TaskDetailView } = await import("./task-detail");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const created = {
  id: "e1",
  seq: 1,
  taskId: "t1",
  projectId: "p1",
  actor: "person",
  at: "2026-10-16T00:00:00.000Z",
  type: "TaskCreated",
  payload: { title: "Timeout", body: "Make it configurable", start: "sacty", budgetCapUsd: 5 },
} as ActivityEvent;

function newTask(): Task {
  const task = project([created]).get("t1");
  if (!task) throw new Error("task missing");
  return task;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function render(task: Task, extra: Partial<TaskDetailData> = {}) {
  const data: TaskDetailData = {
    task,
    activity: [created],
    projectName: "Payments",
    children: [],
    ...extra,
  };
  act(() =>
    root.render(
      h(
        I18nProvider as unknown as FC<{ locale: "ja" }>,
        { locale: "ja" },
        h(TaskDetailView, { data }),
      ),
    ),
  );
}

const panel = (key: string) => document.getElementById(`panel-${key}`) as HTMLElement;

describe("タスクの詳細のタブ", () => {
  it("開いた URL のハッシュ（#audit）の要素があるタブを開いて、そこへ移る", () => {
    window.history.replaceState(null, "", "/tasks/t1#audit");
    render(newTask(), { audit: null });
    expect(panel("audit").hidden).toBe(false);
    expect(panel("overview").hidden).toBe(true);
    expect(document.getElementById("audit")?.scrollIntoView).toHaveBeenCalled();
  });

  it("同じ画面でハッシュが変わったら（#proposals・#event-…）、そのタブへ切り替える", () => {
    const task = newTask();
    task.proposals = [{} as Task["proposals"][number]];
    window.history.replaceState(null, "", "/tasks/t1?tab=costs");
    render(task);
    expect(panel("costs").hidden).toBe(false);
    act(() => {
      window.history.replaceState(null, "", "/tasks/t1?tab=costs#proposals");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(panel("overview").hidden).toBe(false);
    expect(panel("costs").hidden).toBe(true);
    act(() => {
      window.history.replaceState(null, "", "/tasks/t1#event-e1");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(panel("activity").hidden).toBe(false);
  });

  it("出していないタブ（監査の無いタスクの ?tab=audit）は、概要にする", () => {
    window.history.replaceState(null, "", "/tasks/t1?tab=audit");
    render(newTask());
    expect(document.getElementById("tab-audit")).toBeNull();
    expect(panel("overview").hidden).toBe(false);
    expect(document.getElementById("tab-overview")?.getAttribute("aria-selected")).toBe("true");
  });

  it("矢印キー・End で隣・最後のタブへ移り、フォーカスも移る", () => {
    render(newTask());
    const overview = document.getElementById("tab-overview") as HTMLElement;
    expect(overview.tabIndex).toBe(0);
    expect((document.getElementById("tab-activity") as HTMLElement).tabIndex).toBe(-1);
    act(() => {
      overview.focus();
      overview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(panel("activity").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("tab-activity");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(document.activeElement?.id).toBe("tab-settings");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement?.id).toBe("tab-overview");
  });

  it("成果物の工程のタブは、パネルと結び付き、矢印キーで移れる", () => {
    const task = newTask();
    task.status = "running";
    task.steps = [
      { key: "requirements", state: "done" },
      { key: "design", state: "active" },
    ];
    task.outputs.design = "Design draft";
    task.outputs.requirements = "Requirements draft";
    render(task);
    const design = document.getElementById("deliverable-tab-design") as HTMLElement;
    expect(design.getAttribute("aria-controls")).toBe("deliverable-panel-design");
    const designPanel = document.getElementById("deliverable-panel-design") as HTMLElement;
    expect(designPanel.getAttribute("role")).toBe("tabpanel");
    expect(designPanel.getAttribute("aria-labelledby")).toBe("deliverable-tab-design");
    expect(designPanel.hidden).toBe(false);
    act(() => {
      design.focus();
      design.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(document.activeElement?.id).toBe("deliverable-tab-requirements");
    expect(designPanel.hidden).toBe(true);
    expect((document.getElementById("deliverable-panel-requirements") as HTMLElement).hidden).toBe(
      false,
    );
  });

  it("マージの後の監視の工程の無い古いタスクでも、監視の記録があれば成果物に出す", () => {
    const task = newTask();
    task.status = "idle";
    task.steps = [{ key: "implement", state: "done" }];
    task.deployment = {} as Task["deployment"];
    render(task);
    expect(document.getElementById("deliverable-tab-deployment")).not.toBeNull();
    expect(document.getElementById("deployment-watch")).not.toBeNull();
  });
});
