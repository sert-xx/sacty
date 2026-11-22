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

const created = {
  id: "event-1",
  seq: 1,
  taskId: "t1",
  projectId: "default",
  actor: "person",
  at: "2026-10-20T00:00:00.000Z",
  type: "TaskCreated",
  payload: { title: "Task t1", body: "Work", start: "sacty", budgetCapUsd: 10 },
} as ActivityEvent;

function render(task: Task): string {
  return renderToStaticMarkup(
    createElement(TaskDetailView, {
      data: { task, activity: [], projectName: "Project", children: [] },
    }),
  );
}

describe("完了で消せなかった工程のブランチの表示（PBI-480）", () => {
  const base = project([created]).get("t1") as Task;
  const left = {
    ...base,
    stepBranchesLeft: [
      {
        branch: "sacty/task-t1-requirements-1",
        detail: {
          code: "cleanup.stepBranchUnrecorded",
          params: { branch: "sacty/task-t1-requirements-1" },
        },
      },
      { branch: "sacty/task-t1-requirements-2", detail: "network down" },
    ],
  } as Task;

  it("TV-10: 消せなかったブランチの名前と、理由を画面の言語にした文を出す", () => {
    for (const language of ["en", "ja"] as const) {
      locale = language;
      const html = render(left);
      expect(html).toContain('data-testid="branches-left"');
      expect(html).toContain(messagesFor(language).parts.control.branchesLeftTitle);
      expect(html).toContain("sacty/task-t1-requirements-1");
      expect(html).toContain("sacty/task-t1-requirements-2");
      expect(html).toContain("network down");
      expect(html).toContain(
        language === "en"
          ? "Not deleting branch sacty/task-t1-requirements-1 because the commit sacty last pushed is not recorded."
          : "ブランチ sacty/task-t1-requirements-1 を消しません",
      );
      expect(html).not.toContain("[object Object]");
    }
  });

  it("TV-7: 消せなかったブランチが無ければ、欄を出さない", () => {
    locale = "en";
    const html = render(base);
    expect(html).not.toContain('data-testid="branches-left"');
    expect(html).not.toContain("sacty/task-t1-requirements");
  });
});
