"use server";

import { CreateTicketInput } from "@sacty/core";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createTicket } from "@/lib/daemon";

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
