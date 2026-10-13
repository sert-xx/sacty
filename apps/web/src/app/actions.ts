"use server";

import {
  CreateTaskInput,
  type ProjectDefinitionInput,
  StepKey,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
} from "@sacty/core";
import { refresh, revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale, LANG_COOKIE, type LanguagePreference } from "@/i18n/locale";
import { getMessages } from "@/i18n/server";
import {
  approveStep,
  cancelTask,
  createTask,
  decideChange,
  importProject,
  pauseTask,
  requestChanges,
  rereviewTask,
  resumeTask,
  runIntake,
  saveProject,
  saveSettings,
  testNotification,
  voidRemark,
} from "@/lib/daemon";

export type CreateTaskState = {
  fieldErrors?: { title?: string[]; body?: string[] };
  message?: string;
  values?: { title: string; body: string; repo?: string };
};

/** タスクを作成し、作ったタスクの詳細へ移る。 */
export async function createTaskAction(
  _prev: CreateTaskState,
  formData: FormData,
): Promise<CreateTaskState> {
  const repo = String(formData.get("repo") ?? "");
  const values = {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    // 対象リポジトリ（PBI-21）。プロジェクトの設定にあるかは、デーモンが検査する
    ...(repo ? { repo } : {}),
  };
  const a = (await getMessages()).common.action;
  // 作成先のプロジェクトは、下で別に確かめる（無ければ、入力の誤りではなく理由を返す）
  const parsed = CreateTaskInput.omit({ projectId: true }).safeParse(values);
  if (!parsed.success) {
    // 検査の結果を、画面の言語の文言にする
    const fieldErrors: NonNullable<CreateTaskState["fieldErrors"]> = {};
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === "title") {
        fieldErrors.title = [
          issue.code === "too_big" ? a.titleTooLong(TASK_TITLE_MAX) : a.titleRequired,
        ];
      }
      if (issue.path[0] === "body") fieldErrors.body = [a.bodyTooLong(TASK_BODY_MAX)];
    }
    return { fieldErrors, values };
  }

  // 作成先は、フォームを表示したときのプロジェクト（送信時の cookie ではない）。存在はデーモンが検査する
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) {
    return { message: a.createNoProject, values };
  }
  let result: Awaited<ReturnType<typeof createTask>>;
  try {
    result = await createTask({ ...parsed.data, projectId });
  } catch {
    return { message: a.createFailed, values };
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
  if (!id) {
    // 最初のプロジェクトなら、作成画面だけを出していた画面の枠（ヘッダー・サイドメニュー）も作り直す（PBI-22）
    revalidatePath("/", "layout");
    redirect(`/projects/${result.project.id}`);
  }
  refresh();
  return { saved: true };
}

export type SaveSettingsState = { message?: string; saved?: boolean };

/** sacty 全体の設定（取り込むラベルなど。PBI-26）を保存する。 */
export async function saveSettingsAction(
  _prev: SaveSettingsState,
  formData: FormData,
): Promise<SaveSettingsState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof saveSettings>>;
  try {
    result = await saveSettings({
      intakeLabel: String(formData.get("intakeLabel") ?? ""),
      // PR のレビューの取り込み（PBI-44）
      reviewLabel: String(formData.get("reviewLabel") ?? ""),
      reviewRequested: formData.get("reviewRequested") === "on",
      maxParallelTasks: String(formData.get("maxParallelTasks") ?? ""),
    });
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return { saved: true };
}

/** GitHub Issue の取り込みを、すぐに実行する。 */
export type TestNotificationState = { message?: string; sent?: boolean };

/** プロジェクトの通知先に、テストの通知を送る（保存済みの設定で送る。PBI-38）。 */
export async function testNotificationAction(
  _prev: TestNotificationState,
  formData: FormData,
): Promise<TestNotificationState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof testNotification>>;
  try {
    result = await testNotification(String(formData.get("projectId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  return result.ok ? { sent: true } : { message: result.message };
}

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
  // 最初のプロジェクトなら、作成画面だけを出していた画面の枠も作り直す（PBI-22）。
  // redirect は例外で画面を移すので、try の外で呼ぶ
  revalidatePath("/", "layout");
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

export type TaskControlState = { message?: string };

/** 人間が一時停止する。 */
export async function pauseTaskAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof pauseTask>>;
  try {
    result = await pauseTask(String(formData.get("taskId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

/** 再レビュー（PBI-44）。PR の最新のコミットでもう一度レビューして投稿する。 */
export async function rereviewTaskAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof rereviewTask>>;
  try {
    result = await rereviewTask(String(formData.get("taskId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

/** 中止して、sacty が作ったものを片付ける。 */
export async function cancelTaskAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof cancelTask>>;
  try {
    result = await cancelTask(String(formData.get("taskId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}
