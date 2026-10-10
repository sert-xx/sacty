import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Actor,
  activeStep,
  applyEvent,
  BUDGET_WARN_RATIO,
  budgetState,
  CreateTicketInput,
  computeCostUsd,
  DEFAULT_BUDGET_USD,
  type EventInput,
  formatUsd,
  type LedgerEvent,
  MVP_STEPS,
  project,
  ResumeTaskInput,
  type Task,
} from "@sacty/core";
import type { AgentExecutor } from "./agents/docker.js";
import { buildInvocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { redact } from "./agents/redact.js";
import type { ConfigResult } from "./config.js";
import type { LedgerStore } from "./ledger.js";
import { buildPrompt } from "./prompts.js";
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

    const done = this.append(task, [
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
            output: outcome.output,
          },
        },
      },
    ]);
    this.checkBudget(done);
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
    if (budgetState(warned.budget) === "exceeded") {
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
}
