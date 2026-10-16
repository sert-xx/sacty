import { type ActivityEvent, project, type Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({ gateAction: async () => ({}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { TaskDetailView } = await import("./task-detail");
const { GateForm } = await import("./gate-form");

function completedTask(): Task {
  const task = project([
    {
      id: "event-1",
      seq: 1,
      taskId: "task-1",
      projectId: "default",
      actor: "person",
      at: "2026-10-16T00:00:00.000Z",
      type: "TaskCreated",
      payload: { title: "Non-code work", body: "Work", start: "sacty", budgetCapUsd: 10 },
    } as ActivityEvent,
  ]).get("task-1");
  if (!task) throw new Error("task missing");
  task.status = "idle";
  return task;
}

describe("非コード工程の承認後の表示", () => {
  it("日英で承認済みの原稿・作業結果と書き出し先を再表示する", () => {
    const task = completedTask();
    for (const step of ["document", "operation"] as const) {
      task.steps.push({ key: step, state: "done" });
      task.approved[step] = {
        output: `Approved ${step}`,
        testViewpoints: [],
        submission: 1,
        at: "2026-10-16T00:00:00.000Z",
      };
      task.outputs[step] = `Unapproved ${step}`;
    }
    task.exportPlans = {
      document: { to: { via: "mcp", name: "docs", location: "handbook" }, reason: "requested" },
    };
    task.exports.document = {
      url: "https://example.com/handbook",
      last: {
        approvedAt: "2026-10-16T00:00:00.000Z",
        at: "2026-10-16T00:00:00.000Z",
        submission: 1,
        via: "mcp",
        name: "docs",
        url: "https://example.com/handbook",
      },
    };
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const html = renderToStaticMarkup(
        createElement(TaskDetailView, {
          data: {
            task,
            activity: [],
            projectName: "Project",
            children: [],
          },
        }),
      );
      for (const step of ["document", "operation"] as const) {
        expect(html).toContain(`id="deliverable-${step}"`);
        expect(html).toContain(`Approved ${step}`);
        expect(html).not.toContain(`Unapproved ${step}`);
      }
      expect(html).toContain('href="https://example.com/handbook"');
      expect(html).toContain(messagesFor(language).task.exports.exported(1));
    }
  });

  it("差戻し先のない実行結果は承認だけを表示し、確認・中止方法を案内する", () => {
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const html = renderToStaticMarkup(
        createElement(GateForm, {
          taskId: "task-1",
          step: "operation",
          submission: 1,
          targets: [],
          defaultTarget: "operation",
          escalated: false,
          maxChanges: 3,
          pendingComments: [],
        }),
      );
      expect(html).toContain('value="approve"');
      expect(html).not.toContain('value="request"');
      expect(html).not.toContain('name="comments"');
      expect(html).toContain(messagesFor(language).review.gate.operationExecutedHelp);
    }
  });
});
