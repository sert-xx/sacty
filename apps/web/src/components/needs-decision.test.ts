import { type ActivityEvent, message, project, type Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";
import type { TaskDetailData } from "@/lib/task-detail-data";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({
  deriveTaskAction: async () => ({}),
  pauseTaskAction: async () => ({}),
  cancelTaskAction: async () => ({}),
  resumeTaskAction: async () => ({}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/audit", () => ({ TaskAuditCard: () => null }));
const { TaskDetailView } = await import("./task-detail");

const created = {
  id: "event-1",
  seq: 1,
  taskId: "task-1",
  projectId: "default",
  actor: "person",
  at: "2026-10-16T00:00:00.000Z",
  type: "TaskCreated",
  payload: { title: "Timeout", body: "Make it configurable", start: "sacty", budgetCapUsd: 5 },
} as ActivityEvent;

/** 実装の PR が承認待ちのまま、AI のレビューの指摘を取り込んで止まったタスク。 */
function stopped(reason: "needs_decision" | "unchanged"): Task {
  const task = project([created]).get("task-1") as Task;
  task.steps = [{ key: "implement", state: "active" } as never];
  task.status = "paused";
  task.pausedReason = reason;
  task.pausedMessage =
    reason === "needs_decision"
      ? message("review.needsDecision", {
          number: 7,
          findings: [{ finding: "構成を選び直す", reason: "方式を変えても解消しない" }],
        })
      : message("implement.unchanged", { number: 7 });
  task.pullRequest = {
    branch: "sacty/task-1",
    commit: "c1",
    url: "https://github.com/acme/app/pull/7",
    number: 7,
    repo: "https://github.com/acme/app",
  } as never;
  task.pullRequestState = "open";
  task.pendingReview = { keys: ["review:1"], remarks: ["構成を選び直す"], aiReview: [0] };
  return task;
}

function render(task: Task): string {
  const data: TaskDetailData = {
    task,
    activity: [created],
    projectName: "Payments",
    children: [],
  } as TaskDetailData;
  return renderToStaticMarkup(createElement(TaskDetailView, { data }));
}

describe("直しでは解消できない指摘で止めたタスクの表示（PBI-452）", () => {
  it.each([
    ["ja", "直しでは解消できない", "構成を選び直す"],
    ["en", "cannot be resolved by a rework", "構成を選び直す"],
  ] as const)(
    "理由の見出しは、変更の無いやり直しの見出しと違い、指摘と根拠を出す。「再開すると差し戻します」の案内は出さない（%s）",
    (language, heading, finding) => {
      locale = language;
      const labels = messagesFor(language).labels;
      expect(labels.pause.needs_decision).toContain(heading);
      expect(labels.pause.needs_decision).not.toBe(labels.pause.unchanged);
      const html = render(stopped("needs_decision"));
      expect(html).toContain(labels.pause.needs_decision);
      expect(html).toContain(finding);
      expect(html).toContain("方式を変えても解消しない");
      expect(html).not.toContain('data-testid="held-review"');
      // 比較：ほかの止まり方（変更の無いやり直し）では、同じ指摘を取り込んでいると案内が出る
      const other = render(stopped("unchanged"));
      expect(other).toContain('data-testid="held-review"');
      expect(other).toContain(labels.pause.unchanged);
    },
  );
});
