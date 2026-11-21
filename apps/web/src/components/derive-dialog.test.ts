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

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

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

  it("日英で、作るボタンは、上部の操作の並び（再レビューと同じ所）の中に、再レビューと同じ見た目・ヒントで出し、概要の欄には置かない", () => {
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const m = messagesFor(language).parts.derive;
      const task = completed(project([created("t1")]).get("t1") as Task);
      const html = render(task);
      const button = html.indexOf('data-testid="derive-open"');
      expect(button).toBeGreaterThan(-1);
      expect(html.match(/data-testid="derive-open"/g)).toHaveLength(1);
      // 上部の操作の並びの中（その直下の枠の中）にあり、タブの並び・概要の欄より前
      const actions = html.lastIndexOf("flex flex-wrap items-start gap-2", button);
      expect(actions).toBeGreaterThan(-1);
      const between = html.slice(actions, button);
      const depth =
        (between.match(/<div/g) ?? []).length - (between.match(/<\/div>/g) ?? []).length;
      expect(depth).toBe(1); // 操作の並び（開いたまま）の下の、ボタンとヒントを入れる枠だけ
      expect(button).toBeLessThan(html.indexOf('role="tablist"'));
      expect(button).toBeLessThan(html.indexOf('id="derived-tasks"'));
      // 再レビューと同じボタン（outline・min-h-10）
      const tag = html.slice(
        html.lastIndexOf("<button", button),
        html.indexOf("</button>", button),
      );
      expect(tag).toContain("min-h-10");
      expect(tag).toContain("border-border bg-background");
      // 横のヒント。概要の欄の補足とは別の文
      expect(html).toContain(escapeHtml(m.openHint));
      // 一覧の空の表示は概要の欄に残る
      expect(html.indexOf(escapeHtml(m.none))).toBeGreaterThan(html.indexOf('id="derived-tasks"'));
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
