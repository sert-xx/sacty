import type { CreateTicketInput, LedgerEvent, StepKey, Task } from "@sacty/core";
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

export type DaemonStatus = {
  agent: { id: string; runtime: string; authMode: string } | null;
  problems: string[];
};

export async function getStatus(): Promise<DaemonStatus> {
  const res = await ensureOk(await daemonFetch("/api/status"));
  return (await res.json()) as DaemonStatus;
}

/** 再開する。状態に合わない場合は、画面に出せる理由を返す。 */
export async function resumeTask(
  id: string,
  capUsd: number | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await daemonFetch(`/api/tasks/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(capUsd === undefined ? {} : { capUsd }),
  });
  if (res.status === 409) {
    return { ok: false, message: ((await res.json()) as { message: string }).message };
  }
  if (res.status === 400) return { ok: false, message: "金額を正しく入力してください。" };
  await ensureOk(res);
  return { ok: true };
}

type OpResult = { ok: true } | { ok: false; message: string };

async function postOp(path: string, body: unknown): Promise<OpResult> {
  const res = await daemonFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    return { ok: false, message: ((await res.json()) as { message: string }).message };
  }
  if (res.status === 400) {
    const json = (await res.json()) as { issues?: { message: string }[] };
    return { ok: false, message: json.issues?.[0]?.message ?? "入力を確認してください。" };
  }
  await ensureOk(res);
  return { ok: true };
}

export function approveStep(id: string, step: StepKey): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/approve`, { step });
}

export function requestChanges(
  id: string,
  input: { step: StepKey; comments: string[]; continueOverLimit: boolean },
): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/request-changes`, input);
}

export function voidRemark(id: string, remarkId: string): Promise<OpResult> {
  return postOp(
    `/api/tasks/${encodeURIComponent(id)}/remarks/${encodeURIComponent(remarkId)}/void`,
    {},
  );
}
