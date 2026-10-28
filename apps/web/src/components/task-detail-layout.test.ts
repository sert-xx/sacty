import { type ActivityEvent, project, type Task } from "@sacty/core";
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
// 監査の中身は audit.test.ts で確かめる。ここではタブが出るかだけを見る
vi.mock("@/components/audit", () => ({ TaskAuditCard: () => null }));
const { TaskDetailView, currentStep } = await import("./task-detail");

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

function newTask(): Task {
  const task = project([created]).get("task-1");
  if (!task) throw new Error("task missing");
  return task;
}

function render(task: Task, extra: Partial<TaskDetailData> = {}): string {
  return renderToStaticMarkup(
    createElement(TaskDetailView, {
      data: { task, activity: [created], projectName: "Payments", children: [], ...extra },
    }),
  );
}

/** id の要素の開始タグ。 */
function tag(html: string, id: string): string {
  return html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
}

describe("タスクの詳細の並び", () => {
  it("概要だけを開き、ほかのタブの中身は隠して描いておく", () => {
    const task = newTask();
    task.status = "running";
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const html = render(task);
      const l = messagesFor(language).task.layout;
      for (const label of [l.overview, l.activity, l.costs, l.settings]) {
        expect(html).toContain(label);
      }
      expect(tag(html, "tab-overview")).toContain('aria-selected="true"');
      expect(tag(html, "panel-overview")).not.toContain("hidden");
      for (const tab of ["activity", "costs", "settings"]) {
        expect(tag(html, `panel-${tab}`)).toContain("hidden");
      }
      // 監査していないタスクには、監査のタブを出さない
      expect(html).not.toContain('id="tab-audit"');
      // 作業履歴の行は、監査の根拠からたどれるよう、作業履歴のタブにだけ ID を付ける
      expect(html.match(/id="event-event-1"/g)).toHaveLength(1);
    }
  });

  it("監査したタスクには、監査のタブを出す", () => {
    locale = "ja";
    const html = render(newTask(), { audit: null });
    expect(html).toContain('id="tab-audit"');
  });

  it("成果物は、いまの工程を開き、承認済みの工程も折りたたまずに出す", () => {
    locale = "ja";
    const task = newTask();
    task.status = "running";
    task.steps = [
      { key: "requirements", state: "done" },
      { key: "design", state: "active" },
    ];
    task.approved.requirements = {
      output: "Approved requirements",
      testViewpoints: [],
      submission: 1,
      at: "2026-10-16T00:00:00.000Z",
    };
    task.outputs.design = "Design draft";
    const html = render(task);
    expect(html).toContain("Approved requirements");
    expect(html).toContain("Design draft");
    // 承認済みでも、見出しだけの折りたたみ（details）にしない
    expect(html).not.toMatch(/<details aria-labelledby="deliverable-requirements"/);
    const requirements = html.indexOf('id="deliverable-requirements"');
    const design = html.indexOf('id="deliverable-design"');
    // 開いているのは、いまの工程（設計）の成果物だけ
    expect(html.lastIndexOf("<div hidden", requirements)).toBeGreaterThan(-1);
    expect(html.slice(html.lastIndexOf("<div", design - 200), design)).not.toContain("hidden");
  });

  it("いまの工程は、作業中・承認待ち・最後に終えた工程の順に選ぶ", () => {
    const task = newTask();
    task.steps = [
      { key: "requirements", state: "done" },
      { key: "design", state: "done" },
      { key: "implement", state: "todo" },
    ];
    expect(currentStep(task)).toBe("design");
    task.gate = { step: "requirements" } as Task["gate"];
    expect(currentStep(task)).toBe("requirements");
    task.steps[2] = { key: "implement", state: "active" };
    expect(currentStep(task)).toBe("implement");
  });

  it("右の列のプロパティに、PR・リポジトリ・ブランチ・テストを出す", () => {
    locale = "ja";
    const task = newTask();
    task.repository = {
      url: "https://github.com/acme/payments-api",
      baseBranch: "main",
      baseCommit: "4f2c9a1",
    } as Task["repository"];
    task.stepsChoice = { reason: "local change" } as Task["stepsChoice"];
    task.steps = [{ key: "implement", state: "active" }];
    task.testCommand = "npm test";
    task.pullRequest = {
      url: "https://github.com/acme/payments-api/pull/128",
      number: 128,
      repo: "acme/payments-api",
      branch: "sacty/task-1",
      commit: "9e1d0c4b2a7f",
    } as Task["pullRequest"];
    const html = render(task);
    const properties = html.slice(html.indexOf('id="properties"'));
    expect(properties).toContain("acme/payments-api");
    expect(properties).toContain('href="https://github.com/acme/payments-api/pull/128"');
    expect(properties).toContain("main");
    expect(properties).toContain("npm test");
  });

  it("変更の申し出が無ければ、申し出と判定の欄を出さない", () => {
    locale = "ja";
    const task = newTask();
    task.approved.requirements = {
      output: "Approved requirements",
      testViewpoints: [],
      submission: 1,
      at: "2026-10-16T00:00:00.000Z",
    };
    expect(render(task)).not.toContain('id="proposals"');
  });
});
