import type {
  LedgerEvent,
  PauseReason,
  Remark,
  StepKey,
  TestViewpoint,
  Verdict,
} from "./events.js";

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
  /** 工程エージェントの、最新の提出での対応。最新の提出で回答がなければ未回答（undefined）。 */
  response?: string;
  /** 対応を書いた提出回。 */
  respondedIn?: number;
  /** 前提が変わったなどの理由で、人間が無効にした指摘。エージェントには渡さない。 */
  voided: boolean;
};

/** 人間が承認した成果物。承認を取り消す（前の工程に差し戻す）まで変わらない。 */
export type ApprovedOutput = {
  submission: number;
  output: string;
  /** 設計の工程のテスト観点。 */
  testViewpoints: TestViewpoint[];
  at: string;
};

/** 工程エージェントの、承認済みの成果物への変更の申し出と、その判定。 */
export type TaskProposal = {
  id: string;
  fromStep: StepKey;
  target: StepKey;
  reason: string;
  facts: string[];
  proposed: string;
  testViewpoints?: TestViewpoint[];
  proposedAt: string;
  /** ゴールガーディアンの判定。無ければ判定中。 */
  judgement?: { verdict: Verdict; reason: string; at: string };
  /** 判定できなかった申し出への、人間の判断。 */
  decision?: { accept: boolean; at: string };
  /** 変更を反映したか。 */
  applied: boolean;
};

/** 申し出が認められたか（ゴールガーディアンの承認か、人間の判断）。未決なら undefined。 */
export function proposalAccepted(p: TaskProposal): boolean | undefined {
  if (p.decision) return p.decision.accept;
  if (p.judgement?.verdict === "approved") return true;
  if (p.judgement?.verdict === "rejected") return false;
  return undefined;
}

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
  /** 設計の最新の提出のテスト観点。 */
  testViewpoints: TestViewpoint[];
  /** 承認済みで凍結された成果物。 */
  approved: Partial<Record<StepKey, ApprovedOutput>>;
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
  /** 変更の申し出（古い順）。 */
  proposals: TaskProposal[];
  /** エスカレーションの内容（差し戻しを続ける場合に使う、やり直す工程と書きかけの指摘）。 */
  escalation?: { step: StepKey; target: StepKey; pendingRemarks: Remark[] };
  createdAt: string;
  updatedAt: string;
};

/** 前の工程からやり直す。その工程を実行対象にし、その工程から先の承認は取り消す。 */
function reopen(task: Task, target: StepKey) {
  const to = task.steps.findIndex((s) => s.key === target);
  task.steps = task.steps.map((s, i) => {
    if (i === to) return { ...s, state: "active" as const };
    if (i > to) return { ...s, state: "todo" as const };
    return s;
  });
  const keep = new Set(task.steps.slice(0, to).map((s) => s.key));
  task.approved = Object.fromEntries(
    Object.entries(task.approved).filter(([key]) => keep.has(key as StepKey)),
  );
}

class LedgerIntegrityError extends Error {
  constructor(event: LedgerEvent, detail: string) {
    super(`${event.type} (seq ${event.seq}) on task ${event.taskId}: ${detail}`);
  }
}

function findProposal(task: Task, event: LedgerEvent, id: string): TaskProposal {
  const proposal = task.proposals.find((p) => p.id === id);
  if (!proposal) throw new LedgerIntegrityError(event, `unknown proposal ${id}`);
  return proposal;
}

function updateProposal(task: Task, id: string, patch: Partial<TaskProposal>) {
  task.proposals = task.proposals.map((p) => (p.id === id ? { ...p, ...patch } : p));
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
      testViewpoints: [],
      approved: {},
      proposals: [],
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
        // 承認済みの成果物は凍結されている。変えるには、人間が差し戻して承認を取り消す必要がある
        if (task.approved[event.payload.step]) {
          throw new LedgerIntegrityError(event, "the step is already approved (frozen)");
        }
        if (event.payload.step === "design") task.testViewpoints = event.payload.testViewpoints;
        task.outputs = { ...task.outputs, [event.payload.step]: event.payload.output };
        // その工程の有効な指摘は、今回の提出で回答がなければ未回答に戻す
        // （前回の対応文が残ると、最新の成果物への対応だと誤認して承認してしまうため）
        const step = event.payload.step;
        const submission = (task.submissions[step] ?? 0) + 1;
        const responses = new Map(event.payload.responses.map((r) => [r.remarkId, r.text]));
        task.remarks = task.remarks.map((r) => {
          if (r.step !== step || r.voided) return r;
          const text = responses.get(r.id);
          return text === undefined
            ? { ...r, response: undefined, respondedIn: undefined }
            : { ...r, response: text, respondedIn: submission };
        });
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
      task.approved = {
        ...task.approved,
        [event.payload.step]: {
          submission: task.gate.submission,
          output: task.outputs[event.payload.step] ?? "",
          testViewpoints: event.payload.step === "design" ? task.testViewpoints : [],
          at: event.at,
        },
      };
      task.status = event.payload.next;
      task.gate = undefined;
      task.escalation = undefined;
      break;
    }

    case "StepQueued":
      if (task.status !== "idle") throw new LedgerIntegrityError(event, `status ${task.status}`);
      if (activeStep(task) !== event.payload.step) {
        throw new LedgerIntegrityError(event, "queued step is not the active step");
      }
      task.status = "queued";
      break;

    case "ChangesRequested": {
      if (task.status !== "awaiting_approval" && task.status !== "escalated") {
        throw new LedgerIntegrityError(event, `status ${task.status}`);
      }
      const target = event.payload.target ?? event.payload.step;
      if (target !== event.payload.step) {
        const at = task.steps.findIndex((s) => s.key === event.payload.step);
        const to = task.steps.findIndex((s) => s.key === target);
        if (to < 0 || to >= at) {
          throw new LedgerIntegrityError(event, "target must be a step before the gate");
        }
        reopen(task, target);
      }
      task.remarks = [
        ...task.remarks,
        ...event.payload.remarks.map((r) => ({
          id: r.id,
          step: target,
          round: event.payload.round,
          text: r.text,
          voided: false,
        })),
      ];
      task.status = "queued";
      task.gate = undefined;
      task.escalation = undefined;
      break;
    }

    case "RemarkVoided":
      if (!task.remarks.some((r) => r.id === event.payload.remarkId)) {
        throw new LedgerIntegrityError(event, "unknown remark");
      }
      task.remarks = task.remarks.map((r) =>
        r.id === event.payload.remarkId ? { ...r, voided: true } : r,
      );
      break;

    case "ChangeProposed":
      if (task.status !== "idle") throw new LedgerIntegrityError(event, `status ${task.status}`);
      if (task.proposals.some((p) => p.id === event.payload.proposalId)) {
        throw new LedgerIntegrityError(event, "proposal id is used twice");
      }
      if (!task.approved[event.payload.target]) {
        throw new LedgerIntegrityError(event, "only approved steps can be changed");
      }
      {
        const { proposalId, ...rest } = event.payload;
        task.proposals = [
          ...task.proposals,
          { ...rest, id: proposalId, proposedAt: event.at, applied: false },
        ];
      }
      break;

    case "ChangeJudged": {
      const proposal = findProposal(task, event, event.payload.proposalId);
      if (proposal.judgement) throw new LedgerIntegrityError(event, "already judged");
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      updateProposal(task, proposal.id, {
        judgement: { verdict: event.payload.verdict, reason: event.payload.reason, at: event.at },
      });
      break;
    }

    case "ChangeDecided": {
      const proposal = findProposal(task, event, event.payload.proposalId);
      if (task.status !== "escalated" || proposal.judgement?.verdict !== "undecidable") {
        throw new LedgerIntegrityError(event, "the proposal is not waiting for a person");
      }
      if (proposal.decision) throw new LedgerIntegrityError(event, "already decided");
      updateProposal(task, proposal.id, {
        decision: { accept: event.payload.accept, at: event.at },
      });
      task.status = "idle";
      break;
    }

    case "ChangeApplied": {
      const proposal = findProposal(task, event, event.payload.proposalId);
      if (proposalAccepted(proposal) !== true || proposal.applied) {
        throw new LedgerIntegrityError(event, "the proposal is not accepted or already applied");
      }
      const approved = task.approved[proposal.target];
      if (!approved) throw new LedgerIntegrityError(event, "the target is no longer approved");
      if (proposal.target === "requirements") {
        // 要求要件の変更は、承認を取り消して人間の再承認に回す
        reopen(task, proposal.target);
      } else {
        task.approved = {
          ...task.approved,
          [proposal.target]: {
            ...approved,
            output: proposal.proposed,
            testViewpoints: proposal.testViewpoints ?? approved.testViewpoints,
            at: event.at,
          },
        };
      }
      task.outputs = { ...task.outputs, [proposal.target]: proposal.proposed };
      if (proposal.target === "design" && proposal.testViewpoints) {
        task.testViewpoints = proposal.testViewpoints;
      }
      updateProposal(task, proposal.id, { applied: true });
      break;
    }

    case "TaskEscalated":
      if (event.payload.reason === "change_undecidable") {
        if (task.status !== "idle") throw new LedgerIntegrityError(event, `status ${task.status}`);
        const proposal = findProposal(task, event, event.payload.proposalId ?? "");
        if (proposal.judgement?.verdict !== "undecidable") {
          throw new LedgerIntegrityError(event, "the proposal is not undecidable");
        }
        task.status = "escalated";
        break;
      }
      if (task.status !== "awaiting_approval") {
        throw new LedgerIntegrityError(event, `status ${task.status}`);
      }
      task.status = "escalated";
      task.escalation = {
        step: event.payload.step,
        target: event.payload.target ?? event.payload.step,
        pendingRemarks: event.payload.pendingRemarks,
      };
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

/** 判定中、または人間の判断待ちの変更の申し出。 */
export function openProposal(task: Task): TaskProposal | undefined {
  return task.proposals.find(
    (p) => !p.judgement || (p.judgement.verdict === "undecidable" && !p.decision),
  );
}

/** その工程の最新の出力が、反映された変更の申し出によるものなら、その申し出。 */
export function appliedProposalFor(task: Task, step: StepKey): TaskProposal | undefined {
  const last = task.proposals.findLast((p) => p.applied && p.target === step);
  return last && task.outputs[step] === last.proposed ? last : undefined;
}
