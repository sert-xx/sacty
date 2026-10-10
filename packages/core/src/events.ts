import { z } from "zod";

/** 工程の種類。MVPの固定工程は requirements → design → implement → pr。 */
export const StepKey = z.enum(["requirements", "design", "implement", "pr"]);
export type StepKey = z.infer<typeof StepKey>;

/** MVPで使う固定の工程。オーケストレーターが工程を選ぶのはPBI-7以降。 */
export const MVP_STEPS: readonly StepKey[] = ["requirements", "design", "implement", "pr"];

/** 誰がその記録を残したか。 */
export const Actor = z.enum(["person", "sacty", "orchestrator", "guardian", "agent"]);
export type Actor = z.infer<typeof Actor>;

const TaskCreated = z.object({
  type: z.literal("TaskCreated"),
  payload: z.object({
    title: z.string(),
    body: z.string(),
    start: z.enum(["ticket"]),
  }),
});

const StepsChosen = z.object({
  type: z.literal("StepsChosen"),
  payload: z.object({
    steps: z.array(StepKey).min(1),
  }),
});

/** 台帳に書けるイベント（追加する前の形）。 */
export const EventInput = z.discriminatedUnion("type", [TaskCreated, StepsChosen]);
export type EventInput = z.infer<typeof EventInput>;

/** 台帳に記録されたイベント。seq は台帳全体で単調増加する。 */
export type LedgerEvent = EventInput & {
  seq: number;
  id: string;
  taskId: string;
  projectId: string;
  at: string;
  actor: Actor;
};

export const TICKET_TITLE_MAX = 200;
export const TICKET_BODY_MAX = 10_000;

/** 画面から受け付けるチケット作成の入力。 */
export const CreateTicketInput = z.object({
  title: z
    .string()
    .trim()
    .min(1, "タイトルを入力してください。")
    .max(TICKET_TITLE_MAX, `タイトルは${TICKET_TITLE_MAX}文字以内で入力してください。`),
  body: z
    .string()
    .trim()
    .max(
      TICKET_BODY_MAX,
      `内容は${TICKET_BODY_MAX.toLocaleString("ja-JP")}文字以内で入力してください。`,
    )
    .default(""),
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;
