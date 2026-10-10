import { z } from "zod";

/** 工程の種類。MVPの固定工程は requirements → design → implement → pr。 */
export const StepKey = z.enum(["requirements", "design", "implement", "pr"]);
export type StepKey = z.infer<typeof StepKey>;

/** MVPで使う固定の工程。オーケストレーターが工程を選ぶのはPBI-7以降。 */
export const MVP_STEPS: readonly StepKey[] = ["requirements", "design", "implement", "pr"];

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
