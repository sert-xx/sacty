import { type ActivityEvent, EventInput, message, project, type Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

/*
 * 実装が終わらないための一時停止の、タスクの詳細の表示（PBI-355）。作業履歴の未完了の記録から、残っていることを分けて、
 * 再開の欄に渡すところまでを、タスクの詳細を描いて確かめる（分ける関数と再開の欄は、それぞれのテストで確かめている）。
 */
let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({
  pauseTaskAction: async () => ({}),
  cancelTaskAction: async () => ({}),
  resumeTaskAction: async () => ({}),
  rerunTaskAction: async () => ({}),
  analyzeErrorsAction: async () => ({}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { TaskDetailView } = await import("./task-detail");

/** 記録の形（既定値を含む）は、作業履歴に書くときと同じスキーマで作る。 */
const event = (seq: number, { actor = "sacty", ...input }: Record<string, unknown>) =>
  ({
    ...EventInput.parse(input),
    id: `event-${seq}`,
    seq,
    taskId: "t1",
    projectId: "default",
    actor,
    at: "2026-11-17T00:00:00.000Z",
  }) as ActivityEvent;

/** 実装が終わらずに止まったタスクの作業履歴。recorded：未完了の記録の残っていること。stopped：理由の文に入れたもの。 */
function pausedActivity(recorded: string[], stopped = recorded): ActivityEvent[] {
  return [
    event(1, {
      type: "TaskCreated",
      actor: "person",
      payload: { title: "Task t1", body: "Work", start: "sacty", budgetCapUsd: 10 },
    }),
    event(2, {
      type: "StepsChosen",
      payload: {
        steps: ["implement"],
        plan: "direct",
        reason: { code: "orchestrator.unreadable" },
        fallback: false,
        testCommand: "npm test",
      },
    }),
    event(3, {
      type: "RepositoryPrepared",
      payload: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "b1" },
    }),
    event(4, {
      type: "AgentRunStarted",
      payload: { runId: "r1", step: "implement", agentId: "a", authMode: "subscription" },
    }),
    event(5, {
      type: "AgentRunCompleted",
      payload: {
        runId: "r1",
        step: "implement",
        agentId: "a",
        authMode: "subscription",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        costUsd: 0,
        estimated: true,
        output: "# 実装",
        completion: recorded.length > 0 ? { status: "incomplete", remaining: recorded } : null,
      },
    }),
    event(6, {
      type: "ImplementationIncomplete",
      payload: { remaining: recorded, ...(recorded.length === 0 ? { undeclared: true } : {}) },
    }),
    event(7, {
      type: "TaskPaused",
      payload: {
        reason: "incomplete",
        message: message("implement.incomplete", {
          count: 11,
          stalled: false,
          declared: recorded.length > 0,
          remaining: stopped.slice(0, 5).join(" / "),
          total: stopped.length,
        }),
      },
    }),
  ];
}

function render(activity: ActivityEvent[]): string {
  const task = project(activity).get("t1") as Task;
  expect(task.status).toBe("paused");
  expect(task.pausedReason).toBe("incomplete");
  return renderToStaticMarkup(
    createElement(TaskDetailView, {
      data: { task, activity, projectName: "Project", children: [] },
    }),
  );
}

/** 再開の欄（一時停止の案内）の中の HTML。 */
const notice = (html: string) => html.slice(html.indexOf('id="paused"'), html.indexOf("<form"));
const items = (html: string) => [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]);

describe("実装が終わらないための一時停止の、タスクの詳細の表示（PBI-355）", () => {
  const seven = ["A / B を直す", "2件目", "3件目", "4件目", "5件目", "6件目", "7件目"];

  it("日英で、残っていることを理由の文から除き、5 件までの箇条書きと、全部の件数を出す", () => {
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const r = messagesFor(language).parts.resume;
      const html = notice(render(pausedActivity(seven)));
      expect(html).toContain(`>${r.remainingTitle}</p>`);
      // 項目の中の「 / 」では分けない
      expect(items(html)).toEqual(seven.slice(0, 5));
      expect(html).toContain(r.remainingMore(7));
      // 理由の文には、つないだ 1 行を出さない（再開の案内は出す）
      expect(html).not.toContain("A / B を直す / 2件目");
      expect(html).not.toContain(language === "ja" ? "残っていること：" : "What remains:");
      expect(html).toContain(
        language === "ja"
          ? "前の実行の続きから実装を続けます"
          : "from where the previous run left off",
      );
    }
  });

  it("5 件までなら、全部の件数は出さない", () => {
    locale = "ja";
    const html = notice(render(pausedActivity(seven.slice(0, 5))));
    expect(items(html)).toEqual(seven.slice(0, 5));
    expect(html).not.toContain("ほか、全");
  });

  it("残っていることが無い（申告が無い・読めない）ときは、理由の文だけを出す", () => {
    locale = "ja";
    const html = notice(render(pausedActivity([])));
    expect(html).toContain("実装し終えたかの申告が無いか読めないまま終わりました");
    expect(html).not.toContain(messagesFor("ja").parts.resume.remainingTitle);
    expect(items(html)).toEqual([]);
  });

  it("未完了の記録が理由の文字列と合わないときは、分けずに、理由の文をそのまま出す", () => {
    locale = "ja";
    const html = notice(render(pausedActivity(["別の記録"], ["A", "B"])));
    expect(html).toContain("残っていること：A / B。");
    expect(items(html)).toEqual([]);
  });
});
