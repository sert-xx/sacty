import type { CreateTicketInput, LedgerEvent, Task } from "@sacty/core";
import { connection } from "next/server";

/**
 * デーモンのAPIを呼ぶ。サーバー側でだけ使う（トークンをブラウザに渡さないため）。
 * 接続先とトークンは `sacty up` が環境変数で渡すので、リクエスト時に読む。
 */
export class DaemonUnavailableError extends Error {}

async function daemonFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await connection();
  const url = process.env.SACTY_DAEMON_URL;
  const token = process.env.SACTY_DAEMON_TOKEN;
  if (!url || !token) {
    throw new DaemonUnavailableError(
      "デーモンの接続先が設定されていません。`sacty up` で起動してください。",
    );
  }
  try {
    return await fetch(`${url}${path}`, {
      ...init,
      cache: "no-store",
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
  } catch {
    throw new DaemonUnavailableError(
      "デーモンに接続できません。`sacty up` が動いているか確認してください。",
    );
  }
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    throw new Error(`daemon responded ${res.status}`);
  }
  return res;
}

export async function listTasks(): Promise<Task[]> {
  const res = await ensureOk(await daemonFetch("/api/tasks"));
  return ((await res.json()) as { tasks: Task[] }).tasks;
}

export async function getTask(id: string): Promise<{ task: Task; ledger: LedgerEvent[] } | null> {
  const res = await daemonFetch(`/api/tasks/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return (await res.json()) as { task: Task; ledger: LedgerEvent[] };
}

export async function createTicket(input: CreateTicketInput): Promise<Task> {
  const res = await ensureOk(
    await daemonFetch("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return ((await res.json()) as { task: Task }).task;
}
