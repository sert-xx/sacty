import { z } from "zod";

/** 工程の種類。MVPの固定工程は requirements → design → implement → pr。 */
export const StepKey = z.enum(["requirements", "design", "implement", "pr"]);
export type StepKey = z.infer<typeof StepKey>;

/** MVPで使う固定の工程。オーケストレーターが工程を選ぶのはPBI-7以降。 */
export const MVP_STEPS: readonly StepKey[] = ["requirements", "design", "implement", "pr"];

/** 人間の承認ゲートがある工程。 */
export const GATED_STEPS: readonly StepKey[] = ["requirements", "design"];

/** 同じ工程への差し戻しがこの回数を超えると、エスカレーションになる。 */
export const MAX_CHANGE_REQUESTS = 3;

/** 予算の既定値（1タスクあたり、米ドル）。 */
export const DEFAULT_BUDGET_USD = 1;

/** 予算のこの割合に達したら通知する。 */
export const BUDGET_WARN_RATIO = 0.8;

/** 誰がその記録を残したか。 */
export const Actor = z.enum(["person", "sacty", "orchestrator", "guardian", "agent"]);
export type Actor = z.infer<typeof Actor>;

/** エージェントの認証方式。 */
export const AuthMode = z.enum(["subscription", "api-key", "bedrock", "stub"]);
export type AuthMode = z.infer<typeof AuthMode>;

/** 1回の実行で使ったトークン数。キャッシュ読み込みは入力とは別枠にそろえて記録する。 */
export const TokenUsage = z.object({
  input: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** 人間の指摘。id は台帳の中で一意（例：requirements-2-1 は要求要件の2回目の差し戻しの1件目）。 */
export const Remark = z.object({ id: z.string().min(1), text: z.string().min(1) });
export type Remark = z.infer<typeof Remark>;

/** 工程エージェントの、指摘への対応。 */
export const RemarkResponse = z.object({ remarkId: z.string(), text: z.string() });
export type RemarkResponse = z.infer<typeof RemarkResponse>;

/** タスクが止まった理由。 */
export const PauseReason = z.enum(["budget", "usage_limit", "auth", "error"]);
export type PauseReason = z.infer<typeof PauseReason>;

const TaskCreated = z.object({
  type: z.literal("TaskCreated"),
  payload: z.object({
    title: z.string(),
    body: z.string(),
    start: z.enum(["ticket"]),
    // PBI-1の台帳には無いので既定値で補う
    budgetCapUsd: z.number().positive().default(DEFAULT_BUDGET_USD),
  }),
});

const StepsChosen = z.object({
  type: z.literal("StepsChosen"),
  payload: z.object({
    steps: z.array(StepKey).min(1),
  }),
});

const AgentRunStarted = z.object({
  type: z.literal("AgentRunStarted"),
  payload: z.object({
    runId: z.string(),
    step: StepKey,
    agentId: z.string(),
    authMode: AuthMode,
  }),
});

const AgentRunCompleted = z.object({
  type: z.literal("AgentRunCompleted"),
  payload: z.object({
    runId: z.string(),
    step: StepKey,
    agentId: z.string(),
    authMode: AuthMode,
    usage: TokenUsage,
    costUsd: z.number().nonnegative(),
    /** サブスクリプションなど、実際の請求ではなく換算した値か。 */
    estimated: z.boolean(),
    output: z.string(),
    /** 指摘への対応（再提出のとき）。PBI-2の台帳には無い。 */
    responses: z.array(RemarkResponse).default([]),
  }),
});

const AgentRunFailed = z.object({
  type: z.literal("AgentRunFailed"),
  payload: z.object({
    runId: z.string(),
    step: StepKey,
    agentId: z.string(),
    reason: z.enum(["usage_limit", "auth", "error"]),
    message: z.string(),
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

const BudgetWarned = z.object({
  type: z.literal("BudgetWarned"),
  payload: z.object({ usedUsd: z.number(), capUsd: z.number() }),
});

const TaskPaused = z.object({
  type: z.literal("TaskPaused"),
  payload: z.object({ reason: PauseReason }),
});

const BudgetCapRaised = z.object({
  type: z.literal("BudgetCapRaised"),
  payload: z.object({ capUsd: z.number().positive() }),
});

const TaskResumed = z.object({
  type: z.literal("TaskResumed"),
  payload: z.object({
    /** 実行待ちに戻して実行するか（失敗した実行のやり直しなど）、待機に戻すか。 */
    retry: z.boolean(),
  }),
});

const StepSubmitted = z.object({
  type: z.literal("StepSubmitted"),
  payload: z.object({ step: StepKey, submission: z.number().int().positive() }),
});

const StepApproved = z.object({
  type: z.literal("StepApproved"),
  payload: z.object({
    step: StepKey,
    /** 承認後の状態。次の工程を実行できるなら実行待ち、まだ実装されていなければ待機。 */
    next: z.enum(["queued", "idle"]),
  }),
});

const ChangesRequested = z.object({
  type: z.literal("ChangesRequested"),
  payload: z.object({
    step: StepKey,
    round: z.number().int().positive(),
    remarks: z.array(Remark).min(1),
    /** エスカレーションの後、上限を超えて差し戻したか。 */
    overLimit: z.boolean().default(false),
  }),
});

const RemarkVoided = z.object({
  type: z.literal("RemarkVoided"),
  payload: z.object({ remarkId: z.string() }),
});

const TaskEscalated = z.object({
  type: z.literal("TaskEscalated"),
  payload: z.object({
    step: StepKey,
    reason: z.enum(["too_many_changes"]),
    /** 上限に達したときに人間が書いていた指摘。差し戻しを続ける場合に使う。 */
    pendingRemarks: z.array(Remark),
  }),
});

/** 台帳に書けるイベント（追加する前の形）。 */
export const EventInput = z.discriminatedUnion("type", [
  TaskCreated,
  StepsChosen,
  AgentRunStarted,
  AgentRunCompleted,
  AgentRunFailed,
  BudgetWarned,
  TaskPaused,
  BudgetCapRaised,
  TaskResumed,
  StepSubmitted,
  StepApproved,
  ChangesRequested,
  RemarkVoided,
  TaskEscalated,
]);
export type EventInput = z.input<typeof EventInput>;
export type ParsedEventInput = z.infer<typeof EventInput>;

/** 台帳に記録されたイベント。seq は台帳全体で単調増加する。 */
export type LedgerEvent = ParsedEventInput & {
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

/** 一時停止中のタスクを再開する入力。予算で止まった場合は新しい上限（累計）が必要。 */
export const ResumeTaskInput = z.object({
  capUsd: z.number().positive().max(10_000).optional(),
});
export type ResumeTaskInput = z.infer<typeof ResumeTaskInput>;

/** 承認ゲートで承認する入力。 */
export const ApproveStepInput = z.object({ step: StepKey });
export type ApproveStepInput = z.infer<typeof ApproveStepInput>;

/** 承認ゲートで差し戻す入力。指摘は1行に1件。 */
export const RequestChangesInput = z.object({
  step: StepKey,
  comments: z
    .array(z.string().trim().max(2_000, "指摘は1件あたり2,000文字以内にしてください。"))
    .max(50, "指摘は一度に50件までにしてください。")
    .transform((list) => list.filter((c) => c.length > 0)),
  /** エスカレーションの後、上限を超えて差し戻しを続けるか。 */
  continueOverLimit: z.boolean().default(false),
});
export type RequestChangesInput = z.input<typeof RequestChangesInput>;
