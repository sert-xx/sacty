import { type ActivityEvent, project, type Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({
  pauseTaskAction: async () => ({}),
  cancelTaskAction: async () => ({}),
  resumeTaskAction: async () => ({}),
  rerunTaskAction: async () => ({}),
  deriveTaskAction: async () => ({}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { TaskDetailView } = await import("./task-detail");

const created = (taskId: string, extra: Record<string, unknown> = {}) =>
  ({
    id: `event-${taskId}`,
    seq: 1,
    taskId,
    projectId: "default",
    actor: "person",
    at: "2026-10-20T00:00:00.000Z",
    type: "TaskCreated",
    payload: { title: `Task ${taskId}`, body: "Work", start: "sacty", budgetCapUsd: 10, ...extra },
  }) as ActivityEvent;

/** 調査を終えて完了したタスク。 */
const completed = (task: Task, extra: Partial<Task> = {}): Task => ({
  ...task,
  status: "idle",
  steps: [{ key: "investigate", state: "done" }] as Task["steps"],
  ...extra,
});

function render(task: Task, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(TaskDetailView, {
      data: { task, activity: [], projectName: "Project", children: [], ...extra },
    }),
  );
}

describe("完了したタスクから続きのタスクを作る（派生）", () => {
  it("日英で、完了したタスクに続きのタスクのカードと作るボタンを出し、作ったタスクを並べる", () => {
    const task = completed(project([created("t1")]).get("t1") as Task, {
      derivedTasks: ["t2", "t3"],
    });
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const html = render(task, { derivedTasks: [{ id: "t2", title: "Task t2" }, { id: "t3" }] });
      expect(html).toContain('data-testid="derive-open"');
      expect(html).toContain(messagesFor(language).parts.derive.title);
      expect(html).toContain('href="/tasks/t2"');
      expect(html).toContain("Task t2");
      // 読めなかったタスクは ID を出す
      expect(html).toContain('href="/tasks/t3"');
    }
  });

  it("完了していない・中止したタスクには出さない", () => {
    locale = "ja";
    const task = project([created("t1")]).get("t1") as Task;
    expect(render(task)).not.toContain('data-testid="derive-open"');
    expect(render(completed(task, { status: "cancelled" }))).not.toContain(
      'data-testid="derive-open"',
    );
  });

  it("続きのタスクは、元のタスクへ案内する", () => {
    locale = "ja";
    const original = project([created("t1")]).get("t1") as Task;
    const next = project([created("t2", { derivedFrom: { taskId: "t1" } })]).get("t2") as Task;
    const html = render(next, { derivedFrom: original });
    expect(html).toContain('data-testid="derived-from"');
    expect(html).toContain('href="/tasks/t1"');
    expect(html).toContain("Task t1");
  });
});
