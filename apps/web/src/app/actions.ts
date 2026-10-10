"use server";

import {
  CreateTicketInput,
  type ProjectDefinitionInput,
  StepKey,
  TICKET_BODY_MAX,
  TICKET_TITLE_MAX,
} from "@sacty/core";
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale, LANG_COOKIE, type LanguagePreference } from "@/i18n/locale";
import { getMessages } from "@/i18n/server";
import {
  approveStep,
  createTicket,
  decideChange,
  importProject,
  requestChanges,
  resumeTask,
  runIntake,
  saveProject,
  voidRemark,
} from "@/lib/daemon";

export type CreateTicketState = {
  fieldErrors?: { title?: string[]; body?: string[] };
  message?: string;
  values?: { title: string; body: string };
};

/** チケットを作成し、作ったタスクの詳細へ移る。 */
export async function createTicketAction(
  _prev: CreateTicketState,
  formData: FormData,
): Promise<CreateTicketState> {
  const values = {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
  };
  const a = (await getMessages()).common.action;
  const parsed = CreateTicketInput.safeParse(values);
  if (!parsed.success) {
    // 検査の結果を、画面の言語の文言にする
    const fieldErrors: NonNullable<CreateTicketState["fieldErrors"]> = {};
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === "title") {
        fieldErrors.title = [
          issue.code === "too_big" ? a.titleTooLong(TICKET_TITLE_MAX) : a.titleRequired,
        ];
      }
      if (issue.path[0] === "body") fieldErrors.body = [a.bodyTooLong(TICKET_BODY_MAX)];
    }
    return { fieldErrors, values };
  }

  // 作成先は、フォームを表示したときのプロジェクト（送信時の cookie ではない）。存在はデーモンが検査する
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) {
    return { message: a.ticketNoProject, values };
  }
  let result: Awaited<ReturnType<typeof createTicket>>;
  try {
    result = await createTicket({ ...parsed.data, projectId });
  } catch {
    return { message: a.ticketFailed, values };
  }
  if (!result.ok) return { message: result.message, values };
  const taskId = result.task.id;
  redirect(`/tasks/${taskId}`);
}

export type ResumeState = { message?: string; capUsd?: string };

/** 一時停止中のタスクを再開する。予算で止まった場合は、累計の新しい上限を受け取る。 */
export async function resumeTaskAction(
  _prev: ResumeState,
  formData: FormData,
): Promise<ResumeState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const rawCap = formData.get("capUsd");
  const capText = typeof rawCap === "string" ? rawCap.trim() : "";
  let capUsd: number | undefined;
  if (capText) {
    capUsd = Number(capText);
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      return { message: a.capPositive, capUsd: capText };
    }
  }

  try {
    const result = await resumeTask(taskId, capUsd);
    if (!result.ok) return { message: result.message, capUsd: capText };
  } catch {
    return { message: a.resumeFailed, capUsd: capText };
  }
  refresh();
  return {};
}

export type GateState = { message?: string; comments?: string; target?: StepKey };

/** 承認ゲートでの判断（承認・差し戻し・上限を超えた差し戻し）。どれを押したかは decision で受け取る。 */
export async function gateAction(_prev: GateState, formData: FormData): Promise<GateState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const step = StepKey.safeParse(formData.get("step"));
  const decision = String(formData.get("decision") ?? "");
  const comments = String(formData.get("comments") ?? "");
  const submission = Number(formData.get("submission"));
  const rawTarget = formData.get("target");
  const target = rawTarget === null ? undefined : StepKey.safeParse(rawTarget).data;
  if (!step.success || (rawTarget !== null && !target)) {
    return { message: a.invalidStep, comments };
  }
  if (!Number.isInteger(submission) || submission < 1) {
    return { message: a.invalidSubmission, comments };
  }

  let result: Awaited<ReturnType<typeof approveStep>>;
  try {
    if (decision === "approve") {
      result = await approveStep(taskId, step.data, submission);
    } else {
      const lines = comments
        .split("\n")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      result = await requestChanges(taskId, {
        step: step.data,
        submission,
        target,
        comments: lines,
        continueOverLimit: decision === "continue",
      });
    }
  } catch {
    return { message: a.daemonDown, comments, target };
  }
  if (!result.ok) return { message: result.message, comments, target };
  // redirect は例外で画面を移すので、try の外で呼ぶ
  redirect(`/tasks/${taskId}`);
}

export async function voidRemarkAction(formData: FormData): Promise<void> {
  const taskId = String(formData.get("taskId") ?? "");
  const remarkId = String(formData.get("remarkId") ?? "");
  await voidRemark(taskId, remarkId);
  refresh();
}

export type DecideChangeState = { message?: string };

/** ゴールガーディアンが判定できなかった変更の申し出を、認めるか認めないかを決める。 */
export async function decideChangeAction(
  _prev: DecideChangeState,
  formData: FormData,
): Promise<DecideChangeState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const proposalId = String(formData.get("proposalId") ?? "");
  const accept = formData.get("decision") === "accept";
  let result: Awaited<ReturnType<typeof decideChange>>;
  try {
    result = await decideChange(taskId, proposalId, accept);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

export type SaveProjectState = { message?: string; saved?: boolean };

/** プロジェクトを作る・変える。定義は編集画面が JSON にまとめて送る。 */
export async function saveProjectAction(
  _prev: SaveProjectState,
  formData: FormData,
): Promise<SaveProjectState> {
  const a = (await getMessages()).common.action;
  const id = String(formData.get("id") ?? "") || undefined;
  let definition: unknown;
  try {
    definition = JSON.parse(String(formData.get("definition") ?? ""));
  } catch {
    return { message: a.unreadableInput };
  }
  let result: Awaited<ReturnType<typeof saveProject>>;
  try {
    result = await saveProject(id, definition as ProjectDefinitionInput);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  if (!id) redirect(`/projects/${result.project.id}`);
  refresh();
  return { saved: true };
}

/** GitHub Issue の取り込みを、すぐに実行する。 */
export async function runIntakeAction(): Promise<void> {
  await runIntake();
  refresh();
}

export type ImportProjectState = { message?: string };

/** ファイルの大きさの上限（プロジェクトの定義なので、十分に小さい）。 */
const IMPORT_MAX_BYTES = 1_000_000;

/** エクスポートしたプロジェクトの定義のファイルを、新しいプロジェクトとしてインポートする。 */
export async function importProjectAction(
  _prev: ImportProjectState,
  formData: FormData,
): Promise<ImportProjectState> {
  const a = (await getMessages()).common.action;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { message: a.chooseFile };
  }
  if (file.size > IMPORT_MAX_BYTES) {
    return { message: a.fileTooLarge };
  }
  let exported: unknown;
  try {
    exported = JSON.parse(await file.text());
  } catch {
    return { message: a.notJson };
  }
  let result: Awaited<ReturnType<typeof importProject>>;
  try {
    result = await importProject(exported);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  // redirect は例外で画面を移すので、try の外で呼ぶ
  redirect(`/projects/${result.project.id}`);
}

/** 画面の言語を選ぶ（system はブラウザの言語に従う）。 */
export async function setLanguageAction(preference: LanguagePreference): Promise<void> {
  const store = await cookies();
  if (isLocale(preference)) {
    store.set(LANG_COOKIE, preference, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    store.delete(LANG_COOKIE);
  }
  refresh();
}
