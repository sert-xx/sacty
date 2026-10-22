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
    actor: "sacty",
    at: "2026-10-20T00:00:00.000Z",
    ...rest,
  }) as ActivityEvent;

const created = (seq: number, taskId: string) =>
  event(seq, taskId, {
    type: "TaskCreated",
    actor: "person",
    payload: { title: `Task ${taskId}`, body: "Work", start: "sacty", budgetCapUsd: 10 },
  });
const chosen = (seq: number, taskId: string, steps: string[], testCommand?: string) =>
  event(seq, taskId, {
    type: "StepsChosen",
    payload: {
      steps,
      plan: "direct",
      reason: { code: "orchestrator.unreadable" },
      fallback: false,
      testCommand,
    },
  });
const paused = (seq: number, taskId: string) =>
  event(seq, taskId, {
    type: "TaskPaused",
    payload: { reason: "error", message: { code: "orchestrator.testCommandUnknown" } },
  });

function render(task: Task): string {
  return renderToStaticMarkup(
    createElement(TaskDetailView, {
      data: { task, activity: [], projectName: "Project", children: [] },
    }),
  );
}

describe("テストが決まらずに止まったタスクの再開", () => {
  it("日英で、テストの扱い（決めずに再開・テストのコマンド・テストなし）を選べる", () => {
    const task = project([
      created(1, "t1"),
      chosen(2, "t1", ["investigate", "implement"]),
      paused(3, "t1"),
    ]).get("t1") as Task;
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const t = messagesFor(language).parts.resume.tests;
      const html = render(task);
      expect(html).toContain(t.legend);
      // 既定は「決めずに再開する」
      expect(html).toContain('name="tests" checked="" value=""');
      expect(html).toContain('name="tests" value="command"');
      expect(html).toContain('name="tests" value="none"');
      expect(html).toContain(t.none);
      // まだ工程を始めていないので、決めずに再開すると工程の選択からやり直すことを案内する
      expect(html).toContain(t.keepRechooseHint);
      expect(html).not.toContain(t.noneBugfix);
    }
  });

  it("不具合の修正は、テストなしを選べない", () => {
    locale = "ja";
    const t = messagesFor("ja").parts.resume.tests;
    const task = project([
      created(1, "t1"),
      chosen(2, "t1", ["investigate", "reproduce", "implement"]),
      paused(3, "t1"),
    ]).get("t1") as Task;
    const html = render(task);
    expect(html).toMatch(/type="radio" disabled=""[^>]*name="tests" value="none"/);
    expect(html).toContain(t.noneBugfix);
  });

  it("テストのコマンドが決まっているタスクが止まったときは、テストの扱いを出さない", () => {
    locale = "ja";
    const t = messagesFor("ja").parts.resume.tests;
    const task = project([
      created(1, "t1"),
      chosen(2, "t1", ["investigate", "implement"], "npm test"),
      paused(3, "t1"),
    ]).get("t1") as Task;
    const html = render(task);
    expect(html).toContain(messagesFor("ja").parts.resume.resume);
    expect(html).not.toContain(t.legend);
  });
});
