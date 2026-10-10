import { randomUUID } from "node:crypto";
import {
  applyEvent,
  CreateTicketInput,
  type LedgerEvent,
  MVP_STEPS,
  project,
  type Task,
} from "@sacty/core";
import type { LedgerStore } from "./ledger.js";

export const DEFAULT_PROJECT_ID = "default";

/**
 * タスクの読み書きの窓口。書き込みは必ず台帳への追記を通り、
 * 読み取り用の状態は台帳から復元したものを保持する。
 */
export class TaskService {
  private tasks: Map<string, Task>;

  constructor(private readonly ledger: LedgerStore) {
    this.tasks = project(ledger.all());
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): { task: Task; ledger: LedgerEvent[] } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return { task, ledger: this.ledger.forTask(id) };
  }

  createTicket(raw: unknown): Task {
    const input = CreateTicketInput.parse(raw);
    const taskId = randomUUID();
    const written = this.ledger.append({
      taskId,
      projectId: DEFAULT_PROJECT_ID,
      events: [
        {
          actor: "person",
          event: { type: "TaskCreated", payload: { ...input, start: "ticket" } },
        },
        { actor: "sacty", event: { type: "StepsChosen", payload: { steps: [...MVP_STEPS] } } },
      ],
    });
    for (const event of written) {
      this.tasks = applyEvent(this.tasks, event);
    }
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("created task is missing from the projection");
    return task;
  }
}
