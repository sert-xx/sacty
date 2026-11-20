import { type ActivityEvent, EventInput, project, type Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";
import { elapsedText, runningNow, stoppedRunId } from "@/lib/run-status";

/*
 * タスクの概要の「いま実行していること」の行と、一時停止のカードのリンク。作業履歴からタスクを作り、タスクの詳細を描いて確かめる。
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

const START = Date.parse("2026-11-20T00:00:00.000Z");
const minutesAfter = (n: number) => new Date(START + n * 60_000).toISOString();

let seq = 0;
const event = (at: string, { actor = "sacty", ...input }: Record<string, unknown>) =>
  ({
    ...EventInput.parse(input),
    id: `event-${++seq}`,
    seq,
    taskId: "t1",
    projectId: "default",
    actor,
    at,
  }) as ActivityEvent;

const base = (): ActivityEvent[] => [
  event(minutesAfter(-5), {
    type: "TaskCreated",
    actor: "person",
    payload: { title: "Task", body: "Work", start: "sacty", budgetCapUsd: 10 },
  }),
  event(minutesAfter(-4), {
    type: "StepsChosen",
    payload: {
      steps: ["design", "implement"],
      plan: "direct",
      reason: { code: "orchestrator.unreadable" },
      fallback: false,
      testCommand: "npm test",
    },
  }),
];
const started = (runId: string, step = "design", at = minutesAfter(0)) =>
  event(at, {
    type: "AgentRunStarted",
    payload: { runId, step, agentId: "a", authMode: "subscription" },
  });
const failed = (runId: string, step = "design", at = minutesAfter(1)) =>
  event(at, {
    type: "AgentRunFailed",
    payload: {
      runId,
      step,
      agentId: "a",
      reason: "usage_limit",
      message: "limit reached",
    },
  });
const paused = (reason: string, at = minutesAfter(2)) =>
  event(at, { type: "TaskPaused", payload: { reason, message: "stopped" } });

function taskOf(activity: ActivityEvent[]): Task {
  const task = project(activity).get("t1");
  if (!task) throw new Error("task missing");
  return task;
}

function render(task: Task, activity: ActivityEvent[]): string {
  return renderToStaticMarkup(
    createElement(TaskDetailView, {
      data: { task, activity, projectName: "Project", children: [] },
    }),
  );
}

/** 概要の行（無ければ空）。 */
const row = (html: string) => html.match(/<p data-testid="run-status"[\s\S]*?<\/p>/)?.[0] ?? "";
/** 一時停止のカードの中のリンクの欄（無ければ空）。 */
const links = (html: string) =>
  html.match(/<p[^>]*data-testid="paused-links"[\s\S]*?<\/p>/)?.[0] ?? "";

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("経過の書き方の境界", () => {
  const e = messagesFor("ja").task.runStatus.elapsed;
  const min = (n: number) => n * 60_000;
  it.each([
    [0, "1分未満"],
    [59_999, "1分未満"],
    [min(1), "1分"],
    [min(12) + 30_000, "12分"],
    [min(59), "59分"],
    [min(59) + 59_999, "59分"],
    [min(60), "1時間"],
    [min(65), "1時間5分"],
    [min(125), "2時間5分"],
    [min(26 * 60 + 1), "26時間1分"],
    [-5_000, "1分未満"],
  ])("日本語 %i ms → %s", (ms, text) => {
    expect(elapsedText(ms, e)).toBe(text);
  });
  it("英語でも同じ境界", () => {
    const en = messagesFor("en").task.runStatus.elapsed;
    expect(elapsedText(min(1), en)).toBe("1 min");
    expect(elapsedText(min(60), en)).toBe("1 h");
    expect(elapsedText(min(65), en)).toBe("1 h 5 min");
  });
});

describe("実行中の行", () => {
  it("工程の名前・経過・ログへのリンクを 1 行で出し、経過は aria-live に入れない", () => {
    const activity = [...base(), started("run-7")];
    const task = taskOf(activity);
    expect(task.status).toBe("running");
    vi.setSystemTime(START + 12 * 60_000);
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const m = messagesFor(language);
      const html = row(render(task, activity));
      expect(html).toContain(m.task.runStatus.running(m.labels.step.design));
      expect(html).toContain(m.task.runStatus.elapsed.minutes(12));
      expect(html).toContain(m.task.runStatus.elapsedLabel);
      expect(html).toContain('href="/tasks/t1/runs/run-7"');
      expect(html).toContain(m.runLog.open);
      expect(html).not.toContain("aria-live");
    }
  });

  it("実装の工程でも、調査など別の工程でも出る（成果物の欄の形によらない）", () => {
    const activity = [...base(), started("run-8", "implement")];
    locale = "ja";
    vi.setSystemTime(START + 65 * 60_000);
    const html = row(render(taskOf(activity), activity));
    expect(html).toContain("実装を実行中");
    expect(html).toContain("1時間5分");
  });

  it("開始の記録を取れないときは、経過を出さず、工程の名前とログへのリンクだけにする", () => {
    const full = [...base(), started("run-9")];
    const task = taskOf(full);
    // 古い記録など：開始の記録が作業履歴に無い
    locale = "ja";
    vi.setSystemTime(START + 12 * 60_000);
    const html = row(render(task, base()));
    expect(html).toContain("設計を実行中");
    expect(html).toContain('href="/tasks/t1/runs/run-9"');
    expect(html).not.toContain("経過");
    expect(html).not.toContain("12分");
    expect(html).not.toContain("1分未満");
  });

  it("開始の時刻が読めなければ、経過の起点を持たない（誤った時間を出さない）", () => {
    const activity = [...base(), started("run-10")];
    const task = taskOf(activity);
    const broken = activity.map((e) =>
      e.type === "AgentRunStarted" ? { ...e, at: "not a time" } : e,
    ) as ActivityEvent[];
    expect(runningNow(task, broken)).toEqual({
      runId: "run-10",
      step: "design",
      startedAtMs: undefined,
    });
  });
});

describe("最初の工程が始まる前の行", () => {
  it("していることの名前だけを出す（経過もログへのリンクも出さない）", () => {
    const activity = base();
    const task = taskOf(activity);
    expect(task.status).toBe("queued");
    task.preparing = "gathering";
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const html = row(render(task, activity));
      expect(html).toContain(messagesFor(language).labels.state.preparing.gathering);
      expect(html).not.toContain("href=");
      expect(html).not.toContain(messagesFor(language).task.runStatus.elapsedLabel);
    }
  });
});

describe("実行していないときは行を出さない", () => {
  it("実行待ち（準備の段階も無い）・承認待ち・判断待ち・一時停止・完了・中止", () => {
    locale = "ja";
    const activity = [...base(), started("run-1"), failed("run-1"), paused("usage_limit")];
    const make = (patch: Partial<Task>) => ({ ...taskOf(activity), ...patch }) as Task;
    const cases: Partial<Task>[] = [
      { status: "queued" },
      { status: "awaiting_approval" },
      { status: "escalated" },
      { status: "paused", pausedReason: "manual" },
      { status: "idle" },
      { status: "cancelled" },
      // 実行中でも、実行の ID が無ければ（実行ではない処理）出さない
      { status: "running", currentRunId: undefined },
    ];
    for (const patch of cases) {
      expect(row(render(make(patch), activity)), JSON.stringify(patch)).toBe("");
    }
  });

  it("実行が終わって一時停止になると、行が消える", () => {
    locale = "ja";
    const running = [...base(), started("run-2")];
    expect(row(render(taskOf(running), running))).not.toBe("");
    const after = [...running, failed("run-2"), paused("usage_limit")];
    expect(row(render(taskOf(after), after))).toBe("");
  });
});

describe("一時停止のカードのリンク", () => {
  it("エラーレポートが出ていて、止まった実行があれば、両方を出す", () => {
    const activity = [...base(), started("run-3"), failed("run-3"), paused("usage_limit")];
    const task = taskOf(activity);
    expect(task.status).toBe("paused");
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const r = messagesFor(language).parts.resume;
      const html = render(task, activity);
      const box = links(html);
      expect(box).toMatch(new RegExp(`href="#error-report"[^>]*>${r.viewErrorReport}<`));
      expect(box).toMatch(new RegExp(`href="/tasks/t1/runs/run-3"[^>]*>${r.viewStoppedRun}<`));
      // 飛び先は右の列のエラーレポート（固定の見出しに隠れない）
      expect(html).toMatch(
        /<section[^>]*scroll-mt-60[^>]*aria-labelledby="error-report"|<section[^>]*aria-labelledby="error-report"[^>]*scroll-mt-60/,
      );
      expect(html).toContain('id="error-report"');
    }
  });

  it("エラーレポートが無いとき（人が手で一時停止し、エラーの記録が無い）は、リンクの欄を出さない", () => {
    const activity = [...base(), paused("manual")];
    const task = taskOf(activity);
    locale = "ja";
    const html = render(task, activity);
    expect(html).not.toContain('id="error-report"');
    expect(links(html)).toBe("");
  });

  it("止まった実行が無ければ、ログのリンクを出さずエラーレポートだけを出す", () => {
    // 失敗の実行が今回の一時停止の前に無い（別の実行が完了した後に止まった）
    const activity = [
      ...base(),
      started("run-4"),
      failed("run-4"),
      started("run-5", "design", minutesAfter(3)),
      event(minutesAfter(4), {
        type: "AgentRunCompleted",
        payload: {
          runId: "run-5",
          step: "design",
          agentId: "a",
          authMode: "subscription",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          costUsd: 0,
          estimated: true,
          output: "# 設計",
        },
      }),
      paused("budget", minutesAfter(5)),
    ];
    const task = taskOf(activity);
    locale = "ja";
    const box = links(render(task, activity));
    expect(box).toContain("エラーレポートを見る");
    expect(box).not.toContain("止まった実行のログを見る");
    expect(box).not.toContain("/runs/");
  });

  it("人が手で一時停止したタスクは、過去の失敗の実行へつながない", () => {
    const activity = [...base(), started("run-6"), failed("run-6"), paused("manual")];
    const task = taskOf(activity);
    locale = "ja";
    const box = links(render(task, activity));
    expect(box).not.toContain("止まった実行のログを見る");
    expect(box).not.toContain("/runs/");
  });
});

describe("stoppedRunId", () => {
  it("再開した後の一時停止は、再開より前の失敗へつながない", () => {
    const activity = [
      ...base(),
      started("old"),
      failed("old"),
      paused("usage_limit"),
      event(minutesAfter(3), { type: "TaskResumed", actor: "person", payload: { retry: true } }),
      paused("budget", minutesAfter(4)),
    ];
    const task = { ...taskOf(activity), status: "paused", pausedReason: "budget" } as Task;
    expect(stoppedRunId(task, activity)).toBeUndefined();
  });

  it("一時停止していないタスクでは返さない", () => {
    const activity = [...base(), started("r"), failed("r"), paused("error")];
    const task = { ...taskOf(activity), status: "queued" } as Task;
    expect(stoppedRunId(task, activity)).toBeUndefined();
  });
});

describe("一時停止中の実装の成果物の欄", () => {
  it("「作業中」を出さず、止まっていることが分かる語にする", () => {
    const activity = [
      ...base(),
      started("run-11", "implement"),
      failed("run-11", "implement"),
      paused("error"),
    ];
    const task = taskOf(activity);
    expect(task.status).toBe("paused");
    task.steps = [{ key: "implement", state: "active" }];
    for (const language of ["ja", "en"] as const) {
      locale = language;
      const p = messagesFor(language).parts.implementation;
      const html = render(task, activity);
      expect(html).toContain(p.paused);
      expect(html).not.toContain(`>${p.working}<`);
      expect(html).not.toContain(p.running);
    }
  });
});
