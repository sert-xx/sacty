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

describe("PR のレビューの子タスクへのリンク（PBI-330）", () => {
  it("日英で、同じ PR の子タスクが複数あっても、状態を添えて中止した子と今の子を区別する", () => {
    const review = { kind: "github_pull_request", repo: "https://github.com/acme/app", number: 7 };
    const tasks = project([
      created(1, "p1"),
      created(2, "c1", {
        start: "github_pull_request",
        source: { ...review, url: "https://github.com/acme/app/pull/7", review: "sacty" },
        reviewOf: { taskId: "p1", step: "requirements" },
      }),
      cancelled(3, "c1"),
      created(4, "c2", {
        start: "github_pull_request",
        source: { ...review, url: "https://github.com/acme/app/pull/7", review: "sacty" },
        reviewOf: { taskId: "p1", step: "requirements" },
      }),
    ]);
    const [parent, first, second] = ["p1", "c1", "c2"].map((id) => tasks.get(id) as Task);
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const m = messagesFor(language);
      const html = renderToStaticMarkup(
        createElement(TaskDetailView, {
          data: {
            task: parent as Task,
            activity: [],
            projectName: "Project",
            children: [],
            reviewTasks: [first, second].map((t) => ({
              id: (t as Task).id,
              title: (t as Task).title,
              step: "requirements" as const,
              number: 7,
              task: t as Task,
            })),
          },
        }),
      );
      const step = m.labels.step.requirements;
      expect(html).toContain(m.task.reviewTaskOf(step, 7, m.labels.status.cancelled));
      expect(html).toContain(m.task.reviewTaskOf(step, 7, m.labels.status.queued));
      expect(html.match(/data-testid="review-task"/g)).toHaveLength(2);
    }
  });
});
