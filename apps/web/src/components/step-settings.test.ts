// @vitest-environment jsdom
import { type ActivityEvent, EventInput, project, type Task } from "@sacty/core";
import { type FC, createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetailData } from "@/lib/task-detail-data";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/p1/tasks/t1",
}));
vi.mock("@/app/actions", () => {
  const action = vi.fn(async () => ({}));
  return {
    createTaskAction: action,
    resumeTaskAction: action,
    gateAction: action,
    voidRemarkAction: action,
    changeStepImageAction: action,
    changeStepAgentAction: action,
    decideChangeAction: action,
    followProjectAction: action,
    setLanguageAction: action,
    pauseTaskAction: action,
    rereviewTaskAction: action,
    retryExportAction: action,
    askQuestionAction: action,
    cancelTaskAction: action,
    adoptAuditProposalAction: action,
    rejectAuditProposalAction: action,
    deleteAuditMemoryAction: action,
    resumeAuditAction: action,
  };
});

const { I18nProvider } = await import("@/i18n/client");
const { LiveTaskDetail } = await import("./task-detail");
const { StepCosts } = await import("./step-costs");
const { liveVersion } = await import("@/lib/live-server");

function render(node: ReactNode): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = renderToStaticMarkup(
    h(I18nProvider as unknown as FC<{ locale: "ja" }>, { locale: "ja" }, node),
  );
  return div;
}

let seq = 0;
const ev = (input: EventInput, actor: ActivityEvent["actor"] = "sacty") =>
  ({
    ...EventInput.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId: "t1",
    projectId: "p1",
    actor,
    at: `2026-10-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
  }) as ActivityEvent;

/** 要求要件と実装の工程があり、要求要件を一度、換算した概算の費用で実行したタスク。 */
function history(): ActivityEvent[] {
  seq = 0;
  return [
    ev({ type: "TaskCreated", payload: { title: "t", body: "", start: "sacty" } }, "person"),
    ev(
      {
        type: "StepsChosen",
        payload: { steps: ["requirements", "implement"], plan: "skip-design", reason: "理由" },
      },
      "orchestrator",
    ),
    ev({
      type: "AgentRunStarted",
      payload: { runId: "r1", step: "requirements", agentId: "a", authMode: "subscription" },
    }),
    ev({
      type: "AgentRunCompleted",
      payload: {
        runId: "r1",
        step: "requirements",
        agentId: "a",
        authMode: "subscription",
        usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.1,
        estimated: true,
        output: "# 要求要件",
      },
    }),
  ];
}

function taskOf(events: ActivityEvent[]): Task {
  const task = project(events).get("t1");
  if (!task) throw new Error("no task");
  return task;
}

const images = {
  problems: [],
  images: [
    { name: "node", description: "Node.js" },
    { name: "python", description: "Python" },
  ],
};
const agents = {
  problems: [],
  agents: [
    { id: "codex_standard", runtime: "codex" },
    { id: "claude_standard", runtime: "claude" },
  ],
  stepAgents: { requirements: "codex_standard", implement: "codex_standard" },
};

function detail(patch: Partial<TaskDetailData> = {}, task = taskOf(history())): HTMLDivElement {
  const data: TaskDetailData = {
    task,
    activity: history(),
    projectName: "Acme",
    children: [],
    cleanupPlan: [],
    imageStatus: images,
    agentStatus: agents,
    ...patch,
  };
  return render(h(LiveTaskDetail, { id: "t1", initial: data, initialVersion: liveVersion(data) }));
}

const section = (div: HTMLElement, id: string) =>
  div.querySelector(`[data-testid="${id}"]`) as HTMLDetailsElement | null;

describe("タスク詳細：工程のイメージ・工程のエージェントの折りたたみ（PBI-138）", () => {
  it("確かめが要らなければ、見出し（補足の印を含む）だけを出して閉じ、中身は開けば読める", () => {
    const div = detail();
    for (const [id, row, title] of [
      ["step-images", "step-image-row-", "工程のイメージ"],
      ["step-agents", "step-agent-row-", "工程のエージェント"],
    ] as const) {
      const box = section(div, id);
      expect(box?.tagName).toBe("DETAILS");
      expect(box?.open).toBe(false);
      const summary = box?.querySelector(":scope > summary");
      expect(summary?.textContent).toContain(title);
      expect(summary?.querySelector('[data-slot="hint"]')).not.toBeNull();
      // 中身（工程ごとの行・変更のフォーム）は details の中にある
      expect(box?.querySelector(`[data-testid^="${row}"]`)).not.toBeNull();
      expect(box?.querySelector("select")).not.toBeNull();
    }
  });

  it("イメージの候補を確かめられないときは、工程のイメージを開いて出す", () => {
    const div = detail({ imageStatus: undefined });
    expect(section(div, "step-images")?.open).toBe(true);
    expect(section(div, "step-agents")?.open).toBe(false);
  });

  it("images に無いイメージを使っているときは、工程のイメージを開いて出す", () => {
    const task = { ...taskOf(history()), images: { implement: "ruby" } };
    const div = detail({}, task);
    expect(section(div, "step-images")?.open).toBe(true);
  });

  it("エージェントの候補を確かめられないときは、工程のエージェントを開いて出す", () => {
    const div = detail({ agentStatus: undefined });
    expect(section(div, "step-agents")?.open).toBe(true);
    expect(section(div, "step-images")?.open).toBe(false);
  });

  it("使えるエージェントに無い名前を使っているときは、工程のエージェントを開いて出す", () => {
    const div = detail({ agentStatus: { ...agents, stepAgents: { implement: "gone_agent" } } });
    expect(section(div, "step-agents")?.open).toBe(true);
  });

  it("使えるエージェントの名前だけなら、人が選んだ工程があっても閉じたまま", () => {
    const task = { ...taskOf(history()), agents: { implement: "claude_standard" } };
    const div = detail({}, task);
    expect(section(div, "step-agents")?.open).toBe(false);
  });
});

describe("工程ごとの費用：概算の説明は見出しの補足だけ（PBI-138）", () => {
  it("換算した費用でも、工程の行・合計・各回の内訳のセルに「概算」を出さず、見出しの補足で説明する", () => {
    const events = history();
    const div = render(h(StepCosts, { task: taskOf(events), activity: events, subtasks: [] }));
    const cells = [...div.querySelectorAll("table td")].map((td) => td.textContent ?? "");
    expect(cells.some((c) => c.includes("$0.10"))).toBe(true);
    expect(cells.some((c) => c.includes("概算"))).toBe(false);
    expect(div.querySelectorAll('table [data-slot="hint"]')).toHaveLength(0);
    const heading = div.querySelector("#step-costs");
    expect(heading?.textContent).toContain("工程ごとの費用");
    expect(heading?.querySelector('[data-slot="hint"]')?.textContent).toContain(
      "換算した概算で、実際の請求ではありません",
    );
  });
});
