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

/**
 * テスト観点。設計の工程で作り、設計の承認で凍結する。最終レビュー（PBI-10）の基準になる。
 * id は sacty が提出ごとに振る（TV-1, TV-2, …）。
 */
export const TestViewpoint = z.object({
  id: z.string().min(1),
  /** 何を確かめるか。 */
  title: z.string().min(1),
  /** 入力・前提。 */
  input: z.string().min(1),
  /** 期待する結果。 */
  expected: z.string().min(1),
});
export type TestViewpoint = z.infer<typeof TestViewpoint>;

/** 変更の申し出に対する、ゴールガーディアンの判定。 */
export const Verdict = z.enum(["approved", "rejected", "undecidable"]);
export type Verdict = z.infer<typeof Verdict>;

/** 実装の検証（テストと最終レビュー）が、続けて通らなかったときに止める回数。 */
export const MAX_VERIFY_ATTEMPTS = 3;

/** 観点ごとの、テストの対応。工程エージェントが申告する。 */
export const TestMapping = z.object({
  viewpointId: z.string().min(1),
  /** テストの場所と名前（例：src/pay.test.ts › 同じキーの再送）。 */
  tests: z.array(z.string().min(1)),
});
export type TestMapping = z.infer<typeof TestMapping>;

/** タスクが止まった理由。verification：実装の検証が続けて通らない。 */
export const PauseReason = z.enum(["budget", "usage_limit", "auth", "error", "verification"]);
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
    /** 設計の工程で作ったテスト観点。PBI-7までの台帳には無い。 */
    testViewpoints: z.array(TestViewpoint).default([]),
    /** 実装の工程が申告した、観点とテストの対応。 */
    testMap: z.array(TestMapping).default([]),
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
  payload: z.object({
    reason: PauseReason,
    /** 止まった理由の詳しい説明（実行の失敗の記録が無い場合）。 */
    message: z.string().optional(),
  }),
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

/**
 * 待機していた工程を実行待ちにする。工程が後から実行できるようになったとき
 * （例：PBI-7で承認され、設計の工程が無かったため待機していたタスク）に使う。
 */
const StepQueued = z.object({
  type: z.literal("StepQueued"),
  payload: z.object({ step: StepKey }),
});

/**
 * 工程エージェントの、承認済みの成果物（要求要件・設計）への変更の申し出。
 * id はタスクの中で一意（CP-1, CP-2, …）。
 */
const ChangeProposed = z.object({
  type: z.literal("ChangeProposed"),
  payload: z.object({
    proposalId: z.string().min(1),
    /** 申し出た工程。 */
    fromStep: StepKey,
    /** 変更したい、承認済みの工程。 */
    target: StepKey,
    /** 変更したい理由。 */
    reason: z.string().min(1),
    /** 理由の根拠となる事実（コード、仕様、実行結果など）。 */
    facts: z.array(z.string().min(1)),
    /** 変更後の成果物の全文。 */
    proposed: z.string().min(1),
    /** 設計の変更で、テスト観点も変える場合の変更後の全件。 */
    testViewpoints: z.array(TestViewpoint).optional(),
  }),
});

/** ゴールガーディアンの判定。判定ごとに新しいセッションで実行する。 */
const ChangeJudged = z.object({
  type: z.literal("ChangeJudged"),
  payload: z.object({
    proposalId: z.string(),
    verdict: Verdict,
    reason: z.string(),
    agentId: z.string(),
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/** ゴールガーディアンが判定できなかった申し出への、人間の判断。 */
const ChangeDecided = z.object({
  type: z.literal("ChangeDecided"),
  payload: z.object({ proposalId: z.string(), accept: z.boolean() }),
});

/**
 * 認められた変更を反映する。設計は承認済みの版を置き換える。
 * 要求要件は承認を取り消し、変更後の要求要件を人間の再承認に回す（続く StepSubmitted）。
 */
const ChangeApplied = z.object({
  type: z.literal("ChangeApplied"),
  payload: z.object({ proposalId: z.string() }),
});

/** 実装の対象リポジトリを、タスクの作業領域に用意した。 */
const RepositoryPrepared = z.object({
  type: z.literal("RepositoryPrepared"),
  payload: z.object({
    url: z.string(),
    baseBranch: z.string(),
    /** 作業の起点にしたコミット。 */
    baseCommit: z.string(),
  }),
});

/**
 * sacty がテストを実行した結果。終了コードが0で、すべての観点にテストが対応していれば合格。
 * 不合格なら実装をやり直す（続けて通らなければ一時停止）。
 */
const TestsRun = z.object({
  type: z.literal("TestsRun"),
  payload: z.object({
    command: z.string(),
    exitCode: z.number().int(),
    /** テストが対応していない観点。 */
    unmappedViewpoints: z.array(z.string()),
    passed: z.boolean(),
    /** 出力の末尾。 */
    output: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
});

const ViewpointReview = z.object({
  viewpointId: z.string(),
  /** テストが、その観点を本当に検証しているか。 */
  verified: z.boolean(),
  reason: z.string(),
});

const RemarkReview = z.object({
  remarkId: z.string(),
  /** 指摘された問題が、今回の成果物で再発していないか。 */
  notRecurred: z.boolean(),
  reason: z.string(),
});

/** ゴールガーディアンの最終レビュー。観点ごと・人間の指摘ごとに判定する。 */
const FinalReviewed = z.object({
  type: z.literal("FinalReviewed"),
  payload: z.object({
    passed: z.boolean(),
    viewpoints: z.array(ViewpointReview),
    remarks: z.array(RemarkReview),
    /** 全体への所見（形式を読めなかった場合の理由など）。 */
    summary: z.string(),
    agentId: z.string(),
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/**
 * ゴールガーディアンの最終レビューを実行できなかった（利用上限など）。実装の問題ではないので
 * やり直さずに止め、再開すると最終レビューからやり直す。使った分の費用は予算に入れる。
 */
const FinalReviewFailed = z.object({
  type: z.literal("FinalReviewFailed"),
  payload: z.object({
    reason: z.enum(["usage_limit", "auth", "error"]),
    message: z.string(),
    agentId: z.string(),
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

const ChangesRequested = z.object({
  type: z.literal("ChangesRequested"),
  payload: z.object({
    /** 承認ゲートで止まっていた工程。 */
    step: StepKey,
    /**
     * やり直す工程（指摘はこの工程に付く）。承認ゲートの工程か、それより前の工程。
     * 前の工程に戻すと、その工程から先の承認は取り消され、人間の再承認が必要になる。
     * PBI-7までの台帳には無いので、step で補う。
     */
    target: StepKey.optional(),
    /** やり直す工程への、何回目の差し戻しか。 */
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
    /** 差し戻しが上限を超えた工程（やり直す工程）。PBI-7までの台帳には無いので、step で補う。 */
    target: StepKey.optional(),
    /**
     * too_many_changes：差し戻しが上限を超えた
     * change_undecidable：ゴールガーディアンが変更の申し出を判定できなかった
     */
    reason: z.enum(["too_many_changes", "change_undecidable"]),
    /** 判定できなかった申し出（change_undecidable のとき）。 */
    proposalId: z.string().optional(),
    /** 上限に達したときに人間が書いていた指摘。差し戻しを続ける場合に使う。 */
    pendingRemarks: z.array(Remark).default([]),
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
  StepQueued,
  ChangeProposed,
  ChangeJudged,
  ChangeDecided,
  ChangeApplied,
  RepositoryPrepared,
  TestsRun,
  FinalReviewed,
  FinalReviewFailed,
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
/** 画面が表示していた提出回。現在のゲートと一致しなければ拒否する（古い成果物を見たまま判断させないため）。 */
const Submission = z.number().int().positive();

export const ApproveStepInput = z.object({ step: StepKey, submission: Submission });
export type ApproveStepInput = z.infer<typeof ApproveStepInput>;

/** 承認ゲートで差し戻す入力。指摘は1行に1件。 */
export const RequestChangesInput = z.object({
  step: StepKey,
  submission: Submission,
  /** やり直す工程。省略すると承認ゲートの工程。 */
  target: StepKey.optional(),
  comments: z
    .array(z.string().trim().max(2_000, "指摘は1件あたり2,000文字以内にしてください。"))
    .max(50, "指摘は一度に50件までにしてください。")
    .transform((list) => list.filter((c) => c.length > 0)),
  /** エスカレーションの後、上限を超えて差し戻しを続けるか。 */
  continueOverLimit: z.boolean().default(false),
});
export type RequestChangesInput = z.input<typeof RequestChangesInput>;

/** ゴールガーディアンが判定できなかった変更の申し出を、人間が判断する入力。 */
export const DecideChangeInput = z.object({ accept: z.boolean() });
export type DecideChangeInput = z.infer<typeof DecideChangeInput>;
