"use server";

import { CreateTicketInput, type ProjectDefinitionInput, StepKey } from "@sacty/core";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
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
  const parsed = CreateTicketInput.safeParse(values);
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  }

  let taskId: string;
  try {
    taskId = (await createTicket(parsed.data)).id;
  } catch {
    return {
      message: "チケットを作成できませんでした。sactyのデーモンが動いているか確認してください。",
      values,
    };
  }
  redirect(`/tasks/${taskId}`);
}

export type ResumeState = { message?: string; capUsd?: string };

/** 一時停止中のタスクを再開する。予算で止まった場合は、累計の新しい上限を受け取る。 */
export async function resumeTaskAction(
  _prev: ResumeState,
  formData: FormData,
): Promise<ResumeState> {
  const taskId = String(formData.get("taskId") ?? "");
  const rawCap = formData.get("capUsd");
  const capText = typeof rawCap === "string" ? rawCap.trim() : "";
  let capUsd: number | undefined;
  if (capText) {
    capUsd = Number(capText);
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      return { message: "新しい上限は、0より大きい金額で入力してください。", capUsd: capText };
    }
  }

  try {
    const result = await resumeTask(taskId, capUsd);
    if (!result.ok) return { message: result.message, capUsd: capText };
  } catch {
    return {
      message: "再開できませんでした。sactyのデーモンが動いているか確認してください。",
      capUsd: capText,
    };
  }
  refresh();
  return {};
}

export type GateState = { message?: string; comments?: string; target?: StepKey };

const DAEMON_DOWN = "操作できませんでした。sactyのデーモンが動いているか確認してください。";

/** 承認ゲートでの判断（承認・差し戻し・上限を超えた差し戻し）。どれを押したかは decision で受け取る。 */
export async function gateAction(_prev: GateState, formData: FormData): Promise<GateState> {
  const taskId = String(formData.get("taskId") ?? "");
  const step = StepKey.safeParse(formData.get("step"));
  const decision = String(formData.get("decision") ?? "");
  const comments = String(formData.get("comments") ?? "");
  const submission = Number(formData.get("submission"));
  const rawTarget = formData.get("target");
  const target = rawTarget === null ? undefined : StepKey.safeParse(rawTarget).data;
  if (!step.success || (rawTarget !== null && !target)) {
    return { message: "工程が不正です。", comments };
  }
  if (!Number.isInteger(submission) || submission < 1) {
    return { message: "提出回が不正です。画面を更新してください。", comments };
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
    return { message: DAEMON_DOWN, comments, target };
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
  const taskId = String(formData.get("taskId") ?? "");
  const proposalId = String(formData.get("proposalId") ?? "");
  const accept = formData.get("decision") === "accept";
  let result: Awaited<ReturnType<typeof decideChange>>;
  try {
    result = await decideChange(taskId, proposalId, accept);
  } catch {
    return { message: DAEMON_DOWN };
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
  const id = String(formData.get("id") ?? "") || undefined;
  let definition: unknown;
  try {
    definition = JSON.parse(String(formData.get("definition") ?? ""));
  } catch {
    return { message: "入力を読み取れませんでした。画面を更新してください。" };
  }
  let result: Awaited<ReturnType<typeof saveProject>>;
  try {
    result = await saveProject(id, definition as ProjectDefinitionInput);
  } catch {
    return { message: DAEMON_DOWN };
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
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { message: "インポートするファイルを選んでください。" };
  }
  if (file.size > IMPORT_MAX_BYTES) {
    return {
      message: "ファイルが大きすぎます。sacty からエクスポートしたファイルを選んでください。",
    };
  }
  let exported: unknown;
  try {
    exported = JSON.parse(await file.text());
  } catch {
    return {
      message:
        "ファイルを JSON として読めません。sacty からエクスポートしたファイルを選んでください。",
    };
  }
  let result: Awaited<ReturnType<typeof importProject>>;
  try {
    result = await importProject(exported);
  } catch {
    return { message: DAEMON_DOWN };
  }
  if (!result.ok) return { message: result.message };
  // redirect は例外で画面を移すので、try の外で呼ぶ
  redirect(`/projects/${result.project.id}`);
}
