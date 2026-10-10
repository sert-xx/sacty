import {
  type CleanupTarget,
  type CreateTicketInput,
  type LedgerEvent,
  type Project,
  type ProjectDefinitionInput,
  renderMessage,
  type StepKey,
  type Task,
} from "@sacty/core";
import { connection } from "next/server";
import { getMessages } from "@/i18n/server";

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
    throw new DaemonUnavailableError((await getMessages()).common.daemon.notConfigured);
  }
  try {
    return await fetch(`${url}${path}`, {
      ...init,
      cache: "no-store",
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
  } catch {
    throw new DaemonUnavailableError((await getMessages()).common.daemon.unreachable);
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

/** チケットを作る。作成先のプロジェクトが無いなどは、画面に出せる理由を返す。 */
export async function createTicket(
  input: CreateTicketInput,
): Promise<{ ok: true; task: Task } | { ok: false; message: string }> {
  const res = await daemonFetch("/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  await ensureOk(res);
  return { ok: true, task: ((await res.json()) as { task: Task }).task };
}

export type IntakeStatus = {
  lastRunAt?: string;
  imported?: number;
  /** 取り込めなかった取り込み元（検索の条件）と理由。 */
  errors?: { query?: string; message: string }[];
};

export type DaemonStatus = {
  agent: { id: string; runtime: string; authMode: string } | null;
  problems: string[];
  /** GitHub Issue の取り込み（設定が無ければ null）。 */
  intake: IntakeStatus | null;
};

export type ProjectView = {
  project: Project;
  exclusions: { org: string; repos: { repo: string; projectName: string }[] }[];
};

export async function listProjects(): Promise<Project[]> {
  const res = await ensureOk(await daemonFetch("/api/projects"));
  return ((await res.json()) as { projects: Project[] }).projects;
}

export async function getProject(id: string): Promise<ProjectView | null> {
  const res = await daemonFetch(`/api/projects/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return (await res.json()) as ProjectView;
}

/** プロジェクトを作る（id なし）か変える。入力の誤りや重複は、画面に出せる理由を返す。 */
export async function saveProject(
  id: string | undefined,
  definition: ProjectDefinitionInput,
): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
  const res = await daemonFetch(id ? `/api/projects/${encodeURIComponent(id)}` : "/api/projects", {
    method: id ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(definition),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400) {
    return { ok: false, message: await inputMessage(res) };
  }
  await ensureOk(res);
  return { ok: true, project: ((await res.json()) as { project: Project }).project };
}

/** プロジェクトの定義のエクスポート（JSON）。無ければ null。 */
export async function exportProject(id: string): Promise<unknown | null> {
  const res = await daemonFetch(`/api/projects/${encodeURIComponent(id)}/export`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return res.json();
}

/** エクスポートした定義を、新しいプロジェクトとしてインポートする。 */
export async function importProject(
  exported: unknown,
): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
  const res = await daemonFetch("/api/projects/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(exported),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400) {
    return { ok: false, message: await inputMessage(res, { file: true }) };
  }
  await ensureOk(res);
  return { ok: true, project: ((await res.json()) as { project: Project }).project };
}

export type CleanupItem = { target: CleanupTarget; present: boolean; detail?: string };

/** 中止したときに片付けるもの（確認の画面に並べる）。 */
export async function getCleanupPlan(id: string): Promise<CleanupItem[] | null> {
  const res = await daemonFetch(`/api/tasks/${encodeURIComponent(id)}/cleanup-plan`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return ((await res.json()) as { plan: CleanupItem[] }).plan;
}

/** 人間が一時停止する（実行中ならコンテナを止める）。 */
export function pauseTask(id: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/pause`, {});
}

/** 中止して、sacty が作ったものを片付ける。 */
export function cancelTask(id: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/cancel`, {});
}

/** GitHub Issue の取り込みを、間隔を待たずに実行する。 */
export async function runIntake(): Promise<OpResult> {
  return postOp("/api/intake/run", {});
}

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
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400)
    return { ok: false, message: (await getMessages()).common.daemon.invalidAmount };
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
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400) {
    return { ok: false, message: await inputMessage(res) };
  }
  await ensureOk(res);
  return { ok: true };
}

export function approveStep(id: string, step: StepKey, submission: number): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/approve`, { step, submission });
}

export function requestChanges(
  id: string,
  input: {
    step: StepKey;
    submission: number;
    target?: StepKey;
    comments: string[];
    continueOverLimit: boolean;
  },
): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/request-changes`, input);
}

export function decideChange(id: string, proposalId: string, accept: boolean): Promise<OpResult> {
  return postOp(
    `/api/tasks/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/decide`,
    { accept },
  );
}

export function voidRemark(id: string, remarkId: string): Promise<OpResult> {
  return postOp(
    `/api/tasks/${encodeURIComponent(id)}/remarks/${encodeURIComponent(remarkId)}/void`,
    {},
  );
}

/**
 * 状態に合わない操作（409）の理由を、画面の言語の文にする。デーモンは文言のコードと引数で返す（PBI-11）。
 */
async function operationMessage(res: Response): Promise<string> {
  const { locale } = await getMessages();
  const json = (await res.json()) as { messages?: unknown[]; message?: unknown };
  // 古いデーモンは、日本語の文（message）で返す
  const list = json.messages ?? [json.message];
  return list.map((m) => renderMessage(m, locale)).join("\n");
}

/**
 * 入力の誤り（400）の理由を、画面の言語の文にする。デーモンは誤りを文言のコードと引数で返す（PBI-11）。
 * どの項目の誤りかが分かるように、場所（例：repositories.0.baseBranch）を添える。
 */
async function inputMessage(res: Response, options: { file?: boolean } = {}): Promise<string> {
  const m = await getMessages();
  const json = (await res.json()) as { issues?: { message?: unknown; path?: unknown[] }[] };
  const issue = json.issues?.[0];
  const text = issue?.message
    ? renderMessage(issue.message, m.locale)
    : options.file
      ? m.common.daemon.checkFile
      : m.common.daemon.checkInput;
  return issue?.path?.length ? m.common.daemon.atPath(text, issue.path.join(".")) : text;
}
