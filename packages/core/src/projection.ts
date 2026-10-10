import type { LedgerEvent, StepKey } from "./events.js";

export type StepState = "todo" | "active" | "done" | "skip";
export type TaskStatus = "queued";

export type Task = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  start: "ticket";
  status: TaskStatus;
  steps: { key: StepKey; state: StepState }[];
  createdAt: string;
  updatedAt: string;
};

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

  switch (event.type) {
    case "TaskCreated": {
      if (current) {
        throw new Error(`task ${event.taskId} is created twice (seq ${event.seq})`);
      }
      next.set(event.taskId, {
        id: event.taskId,
        projectId: event.projectId,
        title: event.payload.title,
        body: event.payload.body,
        start: event.payload.start,
        status: "queued",
        steps: [],
        createdAt: event.at,
        updatedAt: event.at,
      });
      return next;
    }
    case "StepsChosen": {
      if (!current) {
        throw new Error(`steps chosen for unknown task ${event.taskId} (seq ${event.seq})`);
      }
      next.set(event.taskId, {
        ...current,
        steps: event.payload.steps.map((key) => ({ key, state: "todo" as const })),
        updatedAt: event.at,
      });
      return next;
    }
  }
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
