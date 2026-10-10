"use server";

import { CreateTicketInput, StepKey } from "@sacty/core";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { approveStep, createTicket, requestChanges, resumeTask, voidRemark } from "@/lib/daemon";

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

export type GateState = { message?: string; comments?: string };

const DAEMON_DOWN = "操作できませんでした。sactyのデーモンが動いているか確認してください。";

/** 承認ゲートでの判断（承認・差し戻し・上限を超えた差し戻し）。どれを押したかは decision で受け取る。 */
export async function gateAction(_prev: GateState, formData: FormData): Promise<GateState> {
  const taskId = String(formData.get("taskId") ?? "");
  const step = StepKey.safeParse(formData.get("step"));
  const decision = String(formData.get("decision") ?? "");
  const comments = String(formData.get("comments") ?? "");
  if (!step.success) return { message: "工程が不正です。", comments };

  let result: Awaited<ReturnType<typeof approveStep>>;
  try {
    if (decision === "approve") {
      result = await approveStep(taskId, step.data);
    } else {
      const lines = comments
        .split("\n")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      result = await requestChanges(taskId, {
        step: step.data,
        comments: lines,
        continueOverLimit: decision === "continue",
      });
    }
  } catch {
    return { message: DAEMON_DOWN, comments };
  }
  if (!result.ok) return { message: result.message, comments };
  // redirect は例外で画面を移すので、try の外で呼ぶ
  redirect(`/tasks/${taskId}`);
}

export async function voidRemarkAction(formData: FormData): Promise<void> {
  const taskId = String(formData.get("taskId") ?? "");
  const remarkId = String(formData.get("remarkId") ?? "");
  await voidRemark(taskId, remarkId);
  refresh();
}
