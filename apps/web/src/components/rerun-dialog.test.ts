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
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { TaskDetailView } = await import("./task-detail");

const event = (seq: number, taskId: string, rest: Record<string, unknown>) =>
  ({
    id: `event-${seq}`,
    seq,
    taskId,
    projectId: "default",
    actor: "person",
    at: "2026-10-20T00:00:00.000Z",
    ...rest,
  }) as ActivityEvent;

const created = (seq: number, taskId: string, extra: Record<string, unknown> = {}) =>
  event(seq, taskId, {
    type: "TaskCreated",
    payload: { title: `Task ${taskId}`, body: "Work", start: "sacty", budgetCapUsd: 10, ...extra },
  });
const cancelled = (seq: number, taskId: string) =>
  event(seq, taskId, { type: "TaskCancelled", payload: { cleanup: [] } });

function render(task: Task, extra: { rerunOf?: Task; rerunBy?: Task } = {}): string {
  return renderToStaticMarkup(
    createElement(TaskDetailView, {
      data: { task, activity: [], projectName: "Project", children: [], ...extra },
    }),
  );
}

describe("中止したタスクの再実行", () => {
  it("日英で、中止したタスクに再実行のボタンを出す", () => {
    const tasks = project([created(1, "t1"), cancelled(2, "t1")]);
    const task = tasks.get("t1") as Task;
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const html = render(task);
      expect(html).toContain('data-testid="rerun-open"');
      expect(html).toContain(messagesFor(language).parts.rerun.open);
      expect(html).not.toContain('data-testid="rerun-by"');
    }
  });

  it("再実行したタスクは、ボタンの代わりに作ったタスクへ案内し、作ったタスクは元のタスクへ案内する", () => {
    locale = "ja";
    const tasks = project([
      created(1, "t1"),
      cancelled(2, "t1"),
      created(3, "t2", { noRepo: true, rerun: { taskId: "t1" } }),
    ]);
    const original = tasks.get("t1") as Task;
    const rerun = tasks.get("t2") as Task;
    const before = render(original, { rerunBy: rerun });
    expect(before).not.toContain('data-testid="rerun-open"');
    expect(before).toContain('data-testid="rerun-by"');
    expect(before).toContain('href="/tasks/t2"');
    expect(before).toContain("Task t2");
    const after = render(rerun, { rerunOf: original });
    expect(after).toContain('data-testid="rerun-of"');
    expect(after).toContain('href="/tasks/t1"');
  });

  it("中止していないタスクには、再実行のボタンを出さない", () => {
    locale = "ja";
    const task = project([created(1, "t1")]).get("t1") as Task;
    expect(render(task)).not.toContain('data-testid="rerun-open"');
  });
});
