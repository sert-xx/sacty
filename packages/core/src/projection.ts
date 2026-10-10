import type { LedgerEvent, PauseReason, Remark, StepKey } from "./events.js";

export type StepState = "todo" | "active" | "done" | "skip";

/**
 * queued：実行待ち（デーモンが次に工程を実行する）
 * running：エージェントが実行中
 * idle：実行が終わり、次の操作を待っている
 * paused：一時停止中（理由は pausedReason）
 * awaiting_approval：人間の承認待ち（gate の工程）
 * escalated：差し戻しが上限を超えたため、人間の判断待ち
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "idle"
  | "paused"
  | "awaiting_approval"
  | "escalated";

export type TaskRemark = {
  id: string;
  step: StepKey;
  /** 何回目の差し戻しで出た指摘か。 */
  round: number;
  text: string;
  /** 工程エージェントの、最新の対応。 */
  response?: string;
  /** 前提が変わったなどの理由で、人間が無効にした指摘。エージェントには渡さない。 */
  voided: boolean;
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  start: "ticket";
  status: TaskStatus;
  pausedReason?: PauseReason;
  /** 一時停止の直前の状態。再開時、実行待ち（やり直し）に戻すか待機に戻すかを決める。 */
  resumeTo?: "queued" | "idle";
  steps: { key: StepKey; state: StepState }[];
  /** 工程ごとの最新の出力。 */
  outputs: Partial<Record<StepKey, string>>;
  budget: {
    usedUsd: number;
    capUsd: number;
    warned: boolean;
    /** 換算値（サブスクリプションなど）を含むか。 */
    estimated: boolean;
  };
  currentRunId?: string;
  /** 承認ゲートで止まっている工程と、何回目の提出か。 */
  gate?: { step: StepKey; submission: number };
  /** 工程ごとの提出回数。 */
  submissions: Partial<Record<StepKey, number>>;
  remarks: TaskRemark[];
  /** エスカレーションの内容（差し戻しを続ける場合に使う、書きかけの指摘）。 */
  escalation?: { step: StepKey; pendingRemarks: Remark[] };
  createdAt: string;
  updatedAt: string;
};

class LedgerIntegrityError extends Error {
  constructor(event: LedgerEvent, detail: string) {
    super(`${event.type} (seq ${event.seq}) on task ${event.taskId}: ${detail}`);
  }
}

/** 浮動小数の誤差を、費用の表示や比較に影響しない桁で丸める。 */
function addUsd(a: number, b: number): number {
  return Math.round((a + b) * 1e6) / 1e6;
}

/**
 * 1件のイベントをタスクの状態に適用する。台帳を先頭から順に適用すれば、
 * いつでも同じ状態を復元できる（デーモンの再起動後も含む）。
 */
export function applyEvent(
  tasks: ReadonlyMap<string, Task>,
  event: LedgerEvent,
): Map<string, Task> {
  const next = new Map(tasks);
  const current = next.get(event.taskId);

  if (event.type === "TaskCreated") {
    if (current) throw new LedgerIntegrityError(event, "task is created twice");
    next.set(event.taskId, {
      id: event.taskId,
      projectId: event.projectId,
      title: event.payload.title,
      body: event.payload.body,
      start: event.payload.start,
      status: "queued",
      steps: [],
      outputs: {},
      submissions: {},
      remarks: [],
      budget: { usedUsd: 0, capUsd: event.payload.budgetCapUsd, warned: false, estimated: false },
      createdAt: event.at,
      updatedAt: event.at,
    });
    return next;
  }

  if (!current) throw new LedgerIntegrityError(event, "unknown task");
  const task: Task = { ...current, updatedAt: event.at };

  switch (event.type) {
    case "StepsChosen":
      task.steps = event.payload.steps.map((key, i) => ({
        key,
        state: i === 0 ? ("active" as const) : ("todo" as const),
      }));
      break;

    case "AgentRunStarted":
      if (task.status !== "queued") throw new LedgerIntegrityError(event, `status ${task.status}`);
      task.status = "running";
      task.currentRunId = event.payload.runId;
      break;

    case "AgentRunCompleted":
    case "AgentRunFailed": {
      if (task.currentRunId !== event.payload.runId) {
        throw new LedgerIntegrityError(event, "run id does not match the running run");
      }
      // 失敗した実行は、再開したときにやり直すので実行待ちに戻す
      task.status = event.type === "AgentRunCompleted" ? "idle" : "queued";
      task.currentRunId = undefined;
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      if (event.type === "AgentRunCompleted") {
        task.outputs = { ...task.outputs, [event.payload.step]: event.payload.output };
        const responses = new Map(event.payload.responses.map((r) => [r.remarkId, r.text]));
        task.remarks = task.remarks.map((r) =>
          responses.has(r.id) ? { ...r, response: responses.get(r.id) } : r,
        );
      }
      break;
    }

    case "StepSubmitted":
      if (task.status !== "idle") throw new LedgerIntegrityError(event, `status ${task.status}`);
      task.status = "awaiting_approval";
      task.gate = { step: event.payload.step, submission: event.payload.submission };
      task.submissions = { ...task.submissions, [event.payload.step]: event.payload.submission };
      break;

    case "StepApproved": {
      if (task.status !== "awaiting_approval" && task.status !== "escalated") {
        throw new LedgerIntegrityError(event, `status ${task.status}`);
      }
      if (task.gate?.step !== event.payload.step) {
        throw new LedgerIntegrityError(event, "approved step is not at the gate");
      }
      const index = task.steps.findIndex((s) => s.key === event.payload.step);
      task.steps = task.steps.map((s, i) => {
        if (i === index) return { ...s, state: "done" as const };
        if (i === index + 1) return { ...s, state: "active" as const };
        return s;
      });
      task.status = event.payload.next;
      task.gate = undefined;
      task.escalation = undefined;
      break;
    }

    case "ChangesRequested":
      if (task.status !== "awaiting_approval" && task.status !== "escalated") {
        throw new LedgerIntegrityError(event, `status ${task.status}`);
      }
      task.remarks = [
        ...task.remarks,
        ...event.payload.remarks.map((r) => ({
          id: r.id,
          step: event.payload.step,
          round: event.payload.round,
          text: r.text,
          voided: false,
        })),
      ];
      task.status = "queued";
      task.gate = undefined;
      task.escalation = undefined;
      break;

    case "RemarkVoided":
      if (!task.remarks.some((r) => r.id === event.payload.remarkId)) {
        throw new LedgerIntegrityError(event, "unknown remark");
      }
      task.remarks = task.remarks.map((r) =>
        r.id === event.payload.remarkId ? { ...r, voided: true } : r,
      );
      break;

    case "TaskEscalated":
      if (task.status !== "awaiting_approval") {
        throw new LedgerIntegrityError(event, `status ${task.status}`);
      }
      task.status = "escalated";
      task.escalation = { step: event.payload.step, pendingRemarks: event.payload.pendingRemarks };
      break;

    case "BudgetWarned":
      task.budget = { ...task.budget, warned: true };
      break;

    case "TaskPaused":
      if (task.status !== "queued" && task.status !== "idle") {
        throw new LedgerIntegrityError(event, `pause while ${task.status}`);
      }
      task.resumeTo = task.status;
      task.status = "paused";
      task.pausedReason = event.payload.reason;
      break;

    case "BudgetCapRaised":
      if (event.payload.capUsd <= task.budget.usedUsd) {
        throw new LedgerIntegrityError(event, "new cap must exceed the amount spent");
      }
      task.budget = { ...task.budget, capUsd: event.payload.capUsd };
      break;

    case "TaskResumed":
      if (task.status !== "paused") throw new LedgerIntegrityError(event, `status ${task.status}`);
      task.status = event.payload.retry ? "queued" : "idle";
      task.pausedReason = undefined;
      task.resumeTo = undefined;
      break;
  }

  next.set(event.taskId, task);
  return next;
}

/** 台帳のイベント列から、すべてのタスクの状態を復元する。 */
export function project(events: Iterable<LedgerEvent>): Map<string, Task> {
  let tasks = new Map<string, Task>();
  let lastSeq = 0;
  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new Error(`ledger is out of order at seq ${event.seq}`);
    }
    lastSeq = event.seq;
    tasks = applyEvent(tasks, event);
  }
  return tasks;
}

/** 現在実行対象の工程（active な工程）。 */
export function activeStep(task: Task): StepKey | undefined {
  return task.steps.find((s) => s.state === "active")?.key;
}

/** その工程で、これまでに何回差し戻されたか。 */
export function changeRounds(task: Task, step: StepKey): number {
  return task.remarks.filter((r) => r.step === step).reduce((max, r) => Math.max(max, r.round), 0);
}
