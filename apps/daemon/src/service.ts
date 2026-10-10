import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Actor,
  ApproveStepInput,
  activeStep,
  applyEvent,
  BUDGET_WARN_RATIO,
  budgetState,
  CreateTicketInput,
  changeRounds,
  computeCostUsd,
  DEFAULT_BUDGET_USD,
  type EventInput,
  formatUsd,
  GATED_STEPS,
  type LedgerEvent,
  MAX_CHANGE_REQUESTS,
  MVP_STEPS,
  project,
  RequestChangesInput,
  ResumeTaskInput,
  type Task,
} from "@sacty/core";
import type { AgentExecutor } from "./agents/docker.js";
import { buildInvocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { redact } from "./agents/redact.js";
import type { ConfigResult } from "./config.js";
import type { LedgerStore } from "./ledger.js";
import { buildPrompt, EXECUTABLE_STEPS, extractResponses } from "./prompts.js";
import { SecretNotFoundError, type SecretStore } from "./secrets.js";

export const DEFAULT_PROJECT_ID = "default";

/** 状態に合わない操作（一時停止していないタスクの再開など）。APIでは409にする。 */
export class InvalidOperationError extends Error {}

export type ServiceDeps = {
  ledger: LedgerStore;
  /** 呼ぶたびに設定を読み直す（デーモンを止めずに設定を変えられるように）。 */
  config: () => ConfigResult;
  secrets: SecretStore;
  executor: AgentExecutor;
  /** タスクごとの作業領域を作る場所。 */
  workspaceRoot: string;
};

export type DaemonStatus = {
  agent: { id: string; runtime: string; authMode: string } | null;
  problems: string[];
};

/**
 * タスクの読み書きの窓口。書き込みは必ず台帳への追記を通り、
 * 読み取り用の状態は台帳から復元したものを保持する。
 */
export class TaskService {
  private tasks: Map<string, Task>;

  constructor(private readonly deps: ServiceDeps) {
    this.tasks = project(deps.ledger.all());
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): { task: Task; ledger: LedgerEvent[] } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return { task, ledger: this.deps.ledger.forTask(id) };
  }

  status(): DaemonStatus {
    const config = this.deps.config();
    if (!config.ok) return { agent: null, problems: [config.problem] };
    const agent = config.config.defaultAgent;
    return {
      agent: { id: agent.id, runtime: agent.runtime, authMode: agent.auth.mode },
      problems: [],
    };
  }

  private append(
    task: Pick<Task, "id" | "projectId">,
    events: { actor: Actor; event: EventInput }[],
  ) {
    const written = this.deps.ledger.append({
      taskId: task.id,
      projectId: task.projectId,
      events,
    });
    for (const event of written) {
      this.tasks = applyEvent(this.tasks, event);
    }
    const updated = this.tasks.get(task.id);
    if (!updated) throw new Error("task is missing from the projection");
    return updated;
  }

  createTicket(raw: unknown): Task {
    const input = CreateTicketInput.parse(raw);
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    return this.append({ id: randomUUID(), projectId: DEFAULT_PROJECT_ID }, [
      {
        actor: "person",
        event: { type: "TaskCreated", payload: { ...input, start: "ticket", budgetCapUsd } },
      },
      { actor: "sacty", event: { type: "StepsChosen", payload: { steps: [...MVP_STEPS] } } },
    ]);
  }

  /** 実行待ちのタスク（古い順）。 */
  queuedTaskIds(): string[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === "queued" && activeStep(t))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => t.id);
  }

  /** デーモンが止まって中断された実行を、失敗として記録して一時停止する。 */
  recoverInterrupted(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "running" || !task.currentRunId) continue;
      const step = activeStep(task) ?? "requirements";
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId: task.currentRunId,
              step,
              agentId: "unknown",
              reason: "error",
              message: "デーモンが停止したため、実行が中断されました。",
            },
          },
        },
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "error" } } },
      ]);
    }
  }

  /** 実行待ちのタスクの、現在の工程をエージェントで実行する。 */
  async runNext(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task?.status !== "queued") return;
    const step = activeStep(task);
    if (!step) return;
    const config = this.deps.config();
    if (!config.ok) return; // 設定の問題は status() で画面に出す。タスクは実行待ちのまま。

    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
      return;
    }

    const agent = config.config.defaultAgent;
    const runId = randomUUID();
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "AgentRunStarted",
          payload: { runId, step, agentId: agent.id, authMode: agent.auth.mode },
        },
      },
    ]);

    // 実行に渡した秘密情報。台帳に書く前に、出力やエラー文から取り除く。
    const usedSecrets: string[] = [];
    let outcome: AgentOutcome;
    try {
      const invocation = await buildInvocation(
        agent,
        buildPrompt(task, step),
        this.deps.secrets,
        (value) => usedSecrets.push(value),
      );
      const workspaceDir = join(this.deps.workspaceRoot, task.id);
      mkdirSync(workspaceDir, { recursive: true });
      outcome = await this.deps.executor.run({
        runId,
        image: config.config.image,
        workspaceDir,
        invocation,
      });
    } catch (error) {
      outcome = {
        kind: "failed",
        reason: error instanceof SecretNotFoundError ? "auth" : "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    outcome =
      outcome.kind === "failed"
        ? { ...outcome, message: redact(outcome.message, usedSecrets) }
        : { ...outcome, output: redact(outcome.output, usedSecrets) };

    // サブスクリプションは実際の請求が発生しないので、同じ単価で換算した値として扱う
    const estimated = agent.auth.mode === "subscription" || agent.auth.mode === "stub";
    const costUsd = outcome.usage ? computeCostUsd(outcome.usage, agent.price) : 0;

    if (outcome.kind === "failed") {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId,
              step,
              agentId: agent.id,
              reason: outcome.reason,
              message: outcome.message,
              usage: outcome.usage,
              costUsd,
              estimated,
            },
          },
        },
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: outcome.reason } } },
      ]);
      // 失敗した実行の費用でも、80%の通知は判定する（一時停止はすでにしている）
      this.warnIfNeeded(this.mustGet(task.id));
      return;
    }

    const latest = this.mustGet(task.id);
    const { output, responses } = extractResponses(
      outcome.output,
      new Set(latest.remarks.filter((r) => r.step === step && !r.voided).map((r) => r.id)),
    );
    const events: { actor: Actor; event: EventInput }[] = [
      {
        actor: "agent",
        event: {
          type: "AgentRunCompleted",
          payload: {
            runId,
            step,
            agentId: agent.id,
            authMode: agent.auth.mode,
            usage: outcome.usage,
            costUsd,
            estimated,
            output,
            responses,
          },
        },
      },
    ];
    // 承認ゲートのある工程は、人間の承認待ちで止める
    if (GATED_STEPS.includes(step)) {
      events.push({
        actor: "sacty",
        event: {
          type: "StepSubmitted",
          payload: { step, submission: (latest.submissions[step] ?? 0) + 1 },
        },
      });
    }
    this.checkBudget(this.append(task, events));
  }

  private mustGet(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`task ${id} is missing from the projection`);
    return task;
  }

  /** 予算の80%に達していて、まだ通知していなければ通知を記録する。 */
  private warnIfNeeded(task: Task): Task {
    if (task.budget.warned || task.budget.usedUsd < task.budget.capUsd * BUDGET_WARN_RATIO) {
      return task;
    }
    return this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "BudgetWarned",
          payload: { usedUsd: task.budget.usedUsd, capUsd: task.budget.capUsd },
        },
      },
    ]);
  }

  /** 実行の完了後に予算を判定する。1回で上限を超えた場合も、通知を記録してから止める。 */
  private checkBudget(task: Task) {
    const warned = this.warnIfNeeded(task);
    // 承認待ちのタスクは、すでに人間の判断で止まっている。予算超過は次の実行の前に判定する。
    if (warned.status === "idle" && budgetState(warned.budget) === "exceeded") {
      this.append(warned, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
    }
  }

  /** 一時停止中のタスクを再開する。予算で止まった場合は、累計の新しい上限が必要。 */
  resume(id: string, raw: unknown): Task {
    const input = ResumeTaskInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError("タスクが見つかりません。");
    if (task.status !== "paused") {
      throw new InvalidOperationError("一時停止中のタスクではありません。");
    }
    const events: { actor: Actor; event: EventInput }[] = [];
    const needsCap = task.pausedReason === "budget";
    if (needsCap && input.capUsd === undefined) {
      throw new InvalidOperationError("予算で止まったタスクを再開するには、新しい上限が必要です。");
    }
    if (input.capUsd !== undefined) {
      if (input.capUsd <= task.budget.usedUsd) {
        throw new InvalidOperationError(
          `新しい上限は、使用済み（${formatUsd(task.budget.usedUsd)}）より大きい金額にしてください。`,
        );
      }
      events.push({
        actor: "person",
        event: { type: "BudgetCapRaised", payload: { capUsd: input.capUsd } },
      });
    }
    events.push({
      actor: "person",
      event: { type: "TaskResumed", payload: { retry: task.resumeTo === "queued" } },
    });
    return this.append(task, events);
  }

  private gateTask(id: string, step: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError("タスクが見つかりません。");
    if (task.status !== "awaiting_approval" && task.status !== "escalated") {
      throw new InvalidOperationError("承認待ちのタスクではありません。");
    }
    const gateStep = task.gate?.step ?? task.escalation?.step;
    if (gateStep !== step) {
      throw new InvalidOperationError("この工程は承認待ちではありません。");
    }
    return task;
  }

  /** 承認する。工程を完了にし、次の工程を実行対象にする（実行できる工程なら実行待ちにする）。 */
  approve(id: string, raw: unknown): Task {
    const { step } = ApproveStepInput.parse(raw);
    const task = this.gateTask(id, step);
    const index = task.steps.findIndex((s) => s.key === step);
    const nextStep = task.steps[index + 1]?.key;
    const next = nextStep && EXECUTABLE_STEPS.includes(nextStep) ? "queued" : "idle";
    return this.append(task, [
      { actor: "person", event: { type: "StepApproved", payload: { step, next } } },
    ]);
  }

  /**
   * 差し戻す。指摘は台帳に累積し、工程を実行し直す。
   * 同じ工程への差し戻しが上限を超える場合はエスカレーションにし、人間に続けるかを判断してもらう。
   */
  requestChanges(id: string, raw: unknown): Task {
    const input = RequestChangesInput.parse(raw);
    const task = this.gateTask(id, input.step);
    const rounds = changeRounds(task, input.step);

    if (task.status === "awaiting_approval" && input.comments.length === 0) {
      throw new InvalidOperationError("差し戻すには、指摘を1件以上入力してください。");
    }
    const round = rounds + 1;
    const toRemarks = (texts: string[]) =>
      texts.map((text, i) => ({ id: `${input.step}-${round}-${i + 1}`, text }));

    if (task.status === "awaiting_approval" && rounds >= MAX_CHANGE_REQUESTS) {
      return this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskEscalated",
            payload: {
              step: input.step,
              reason: "too_many_changes",
              pendingRemarks: toRemarks(input.comments),
            },
          },
        },
      ]);
    }

    let remarks = toRemarks(input.comments);
    let overLimit = false;
    if (task.status === "escalated") {
      if (!input.continueOverLimit) {
        throw new InvalidOperationError(
          `差し戻しが上限（${MAX_CHANGE_REQUESTS}回）に達しています。続ける場合は、上限を超えて差し戻すことを選んでください。`,
        );
      }
      overLimit = true;
      if (remarks.length === 0) remarks = task.escalation?.pendingRemarks ?? [];
      if (remarks.length === 0) {
        throw new InvalidOperationError("差し戻すには、指摘を1件以上入力してください。");
      }
    }
    return this.append(task, [
      {
        actor: "person",
        event: {
          type: "ChangesRequested",
          payload: { step: input.step, round, remarks, overLimit },
        },
      },
    ]);
  }

  /** 前提が変わった指摘を無効にする。以降、エージェントには渡さない。 */
  voidRemark(id: string, remarkId: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError("タスクが見つかりません。");
    const remark = task.remarks.find((r) => r.id === remarkId);
    if (!remark) throw new InvalidOperationError("指摘が見つかりません。");
    if (remark.voided) return task;
    return this.append(task, [
      { actor: "person", event: { type: "RemarkVoided", payload: { remarkId } } },
    ]);
  }
}
