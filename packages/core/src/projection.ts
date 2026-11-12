import { budgetState, chargeBudget } from "./cost.js";
import type {
  ActivityEvent,
  AuditAdoptNote,
  AuditMemoryRecord,
  AuditTarget,
  ContinuedPullRequest,
  ExportPlan,
  InvestigationKind,
  MemoryDeleteReason,
  OrchestratorSessionReason,
  ParsedEventInput,
  PauseReason,
  Provenance,
  Remark,
  RemarkSource,
  ReviewComment,
  ReviewRework,
  ReviewVerdict,
  ReworkAnswer,
  ReworkCause,
  SecurityCategory,
  SelfReview,
  StepKey,
  StepPlan,
  StepPullRequestKey,
  StepSettingMap,
  TaskSource,
  TaskTemplate,
  TestMapping,
  TestViewpoint,
  Verdict,
  VerificationRecord,
} from "./events.js";
import {
  bodyWithResumeNote,
  DEFAULT_DOCUMENTS_DIR,
  EXPORT_STEPS,
  exportSteps,
  guardianTestsPassed,
  isDocumentsDir,
  MAX_INTEGRATION_ATTEMPTS,
  RESUME_NOTE_MAX,
  REWORK_STEPS,
  rerunEditableBody,
  resumeNoteSections,
  reviewFlakyFailures,
  SKIPPABLE_STEPS,
  TASK_BODY_MAX,
  testsMadeNoProgress,
  withoutResumeNoteHeadings,
} from "./events.js";
import { advanceImplementBase } from "./implement-description.js";
import { type DaemonText, message } from "./message-code.js";
import type { DaemonMessage } from "./messages.js";

type PayloadOf<T extends ParsedEventInput["type"]> = Extract<
  ParsedEventInput,
  { type: T }
>["payload"];

export type TestsRunResult = PayloadOf<"TestsRun"> & { at: string };

/** 前回投稿したレビュー（PBI-111）。round は前回の回、headCommit は前回レビューしたコミット、at は投稿を記録した時刻。 */
export type PreviousReview = NonNullable<
  PayloadOf<"TaskCreated">["reviewRerequest"]
>["previousReview"];

export type FinalReview = PayloadOf<"FinalReviewed"> & { at: string };
/**
 * 最終レビューの前に作った実装の PR の CI（PullRequestPublished の verifying と PullRequestCiFinished）。startedAt は PR を
 * 作った・更新した時刻（待つ時間をここから数える）。result は CI が終わったら（無い・時間切れも）ある。rerun は、失敗した
 * ジョブの再実行を頼んだ記録（PBI-311。PullRequestCiRerunRequested）。あれば、待つ時間は rerun.at から数える。restored は、
 * 同じコミットの待ち直しで戻した記録で、元の失敗を渡すためだけのもの（待つ時間は startedAt から数える）。
 */
export type PullRequestCi = {
  commit: string;
  startedAt: string;
  /**
   * CI の結果を待たずに行った最終レビューが、このコミットで合格した（PBI-314）。CI が通れば（CI が無ければ）承認待ちに進み、
   * 落ちた・時間内に終わらなければ、CI の結果を見てもう一度最終レビューする。
   */
  reviewedBeforeResult?: true;
} & Partial<Omit<PayloadOf<"PullRequestCiFinished">, "commit">> & {
    finishedAt?: string;
    rerun?: Omit<PayloadOf<"PullRequestCiRerunRequested">, "commit"> & {
      at: string;
      restored?: true;
    };
  };

/**
 * 同じコミットの CI を待ち直すときに、前の再実行の記録を戻す（PBI-311）。戻さないと、再実行で通った結果だけが最終レビューに
 * 渡り、元の失敗が消える。1つも頼めなかった再実行は、無かったものとする。
 */
function restoredCiRerun(task: Task, commit: string): Pick<PullRequestCi, "rerun"> {
  const past = task.pullRequestCiReruns?.find((r) => r.commit === commit);
  if (!past || past.skipped) return {};
  const { commit: _commit, skipped: _skipped, ...rerun } = past;
  return { rerun: { ...rerun, restored: true } };
}

/**
 * 人が、ゴールガーディアンの不合格のまま実装の承認へ進められるか（VerificationOverridden）。実装の検証が続けて通らずに
 * 止まった（TaskPaused の verification）実装の工程。既存の PR を引き継ぐタスクは、不合格の実装を人の PR に積むことになり、
 * PR の本文にも覆した記録を残せないので、進められない（検証に通ってから積む）。ベースブランチとの競合の目印が残って
 * 止まったときも、目印のある実装は進められない。
 */
export function canOverrideVerification(task: Task): boolean {
  return (
    !task.continuedPullRequest &&
    task.status === "paused" &&
    task.pausedReason === "verification" &&
    activeStep(task) === "implement" &&
    !task.publishPending &&
    // 競合の目印が残ったままの実装は、レビューへ進められない（目印を消して提出し直す）
    task.verifyFeedback?.kind !== "merge"
  );
}

/**
 * 実装の作業領域が、いまベースにしているコミット。ベースブランチの最新を取り込んでいれば（baseMerge）その先頭、なければ
 * 起点のコミット。実装の差分（ここからの変更）と、変更が無いかの判定に使う。
 */
export function workBaseCommit(
  repository: NonNullable<Task["repository"]>,
  baseMerge: Task["baseMerge"],
): string {
  return baseMerge?.commit ?? repository.baseCommit;
}

/**
 * 依存のある子タスクが重ねて取り込める、実装の PR の合格したコミット（PBI-317）。最終レビューに合格して作った（ドラフトを
 * 外す段の）開いている PR だけ。検証の待ちのために作り直した PR（verifying）・人が不合格のままレビューへ進めた PR・引き継いだ
 * 人の PR・マージ・クローズした PR は使わない。作り直しの間（差し戻し・指摘の取り込み）も、次の PR を作るまでは前の合格した
 * コミットを返す。
 */
export function reviewedPullRequest(
  task: Task,
): { branch: string; commit: string; number: number; url?: string } | undefined {
  const pr = task.pullRequest;
  if (!pr?.number || pr.verifying || task.pullRequestState !== "open") return undefined;
  // PR のレビューの子タスクが、まだ指摘なしにしていない（PBI-331）
  if (pr.awaitingReview) return undefined;
  if (task.status === "cancelled" || task.continuedPullRequest) return undefined;
  if (task.verificationOverride?.submission === task.submissions.implement) return undefined;
  return {
    branch: pr.branch,
    // 指摘なしにした先頭（人が足したコミットを含む）から重ねる（PBI-331）
    commit: pr.reviewedCommit ?? pr.commit,
    number: pr.number,
    ...(pr.url ? { url: pr.url } : {}),
  };
}

/** 実装の PR がマージされたか（重ねた子タスクの付け替え。PBI-317）。 */
export function implementationMerged(task: Task): boolean {
  return task.pullRequestState === "merged" || task.pullRequestState === "merged_outdated";
}

/** 最終レビューの前に作った実装の PR の CI を待っているか（待つ間も、最終レビューは並べて進める。PBI-314）。 */
export function awaitingPullRequestCi(task: Task): boolean {
  return Boolean(task.pullRequestCi && task.pullRequestCi.result === undefined);
}

/**
 * CI の結果を待たずに合格した最終レビューを、CI の結果だけで確定できるか（PBI-314）。CI が初回で通った・CI が無いなら確定する。
 * 落ちた・時間内に終わらなかった・失敗したジョブの再実行で通った（PBI-311。元の失敗を不安定な失敗の候補として渡す）なら、
 * CI の結果を見て最終レビューし直す。
 */
export function ciConfirmsReview(ci: PullRequestCi | undefined): boolean {
  return ci?.result === "none" || (ci?.result === "passed" && ci.rerun === undefined);
}

/** 最終レビューに合格した後、CI の結果だけを待っているか（PBI-314。待つ間は最終レビューに進まない）。 */
export function awaitingCiAfterReview(task: Task): boolean {
  return Boolean(task.pullRequestCi?.reviewedBeforeResult && awaitingPullRequestCi(task));
}

/**
 * 検証に通った。実装の工程の中で、sacty が実装の PR を作るので、実行待ちにする（PBI-110。工程は進めない。PR を作ったら
 * 実装の承認待ちになり、PR のマージで実装を承認する）。
 */
function passVerification(task: Task): void {
  task.verification = undefined;
  resetVerifyFailures(task);
  task.verifyFeedback = undefined;
  task.publishPending = true;
  task.status = "queued";
}
export type IntegrationReview = PayloadOf<"IntegrationReviewed"> & { at: string };

/**
 * マージの後の監視の状態（PBI-89）。waiting：待っている（phase が ci なら CI/CD、check ならデプロイの確認）、passed：通った、
 * failed：失敗した、skipped：飛ばした（理由は reason）、timed_out：CI/CD が時間内に終わらなかった。
 */
export type DeploymentWatchState = "waiting" | "passed" | "failed" | "skipped" | "timed_out";

/**
 * 監視を飛ばした・確かめなかった理由（PBI-89）。no_commit：マージのコミットが取れない、no_ci：CI/CD が無い、no_skill：
 * デプロイの確認のスキルが無い（CI/CD は通った）、budget：予算の上限に達していた、check_unknown：デプロイの確認で
 * 確かめられなかった。
 */
export type DeploymentWatchReason = "no_commit" | "no_ci" | "no_skill" | "budget" | "check_unknown";

export type DeploymentWatch = PayloadOf<"DeploymentWatchStarted"> & {
  startedAt: string;
  state: DeploymentWatchState;
  /** 待っている段階（state が waiting のときだけ）。 */
  phase?: "ci" | "check";
  reason?: DeploymentWatchReason;
  /** 飛ばした理由の詳しい説明（スキルが外を指していた・予算など）。 */
  detail?: DaemonText;
  ci?: Omit<PayloadOf<"DeploymentCiFinished">, "skipCheck"> & { at: string };
  check?: {
    runId: string;
    skill: string;
    startedAt: string;
    result?: PayloadOf<"DeploymentChecked">["result"];
    /** スキルに従った CI/CD の確認・デプロイの確認それぞれの結果（PBI-116）。 */
    ci?: PayloadOf<"DeploymentChecked">["ci"];
    deployment?: PayloadOf<"DeploymentChecked">["deployment"];
    summary?: string;
    evidence?: string[];
    failed?: DaemonText;
    at?: string;
  };
  /** 登録した修正のタスク（1つの監視で1つまで）。 */
  fix?: PayloadOf<"DeploymentFixRegistered"> & { at: string };
  /** 修正のタスクを作らなかった理由。 */
  suppressed?: PayloadOf<"DeploymentFixSuppressed"> & { at: string };
  finishedAt?: string;
};

export type StepState = "todo" | "active" | "done" | "skip";

/**
 * queued：実行待ち（デーモンが次に工程を実行する）
 * running：エージェントが実行中
 * idle：実行が終わり、次の操作を待っている
 * paused：一時停止中（理由は pausedReason）
 * awaiting_approval：人間の承認待ち（gate の工程）
 * escalated：差し戻しが上限を超えたため、人間の判断待ち
 * cancelled：中止した（以降の操作は受け付けない。作業履歴は残る）
 * blocked：分割で作った子タスクが、依存先の子タスクの完了を待っている（PBI-27）
 * waiting_children：タスク分割の後、子タスクの完了を待っている（PBI-27）
 */
/**
 * 承認待ちの PR の今の head に、sacty 自身の AI のレビュー（sacty のレビューのタスクの投稿）が付いているか（PBI-302 D1）。
 * none：付いていない、reviewing：レビューのタスクが今の head をレビューしている、attached：今の head のレビューが投稿された。
 * 承認やマージは止めない。作業履歴から復元する状態ではなく、デーモンが画面と PR の本文のために、ほかのタスクを見て計算する。
 */
export type AiReviewOfHead = {
  head: string;
  /**
   * unknown は、PR が開いている間の最新の head をまだ GitHub から読めていない（デーモンの起動の直後など）。提出したコミット
   * （head）で計算すると、人が後から足したコミットを見落として「付いた」と誤るので、状況を出さない（PR #304 のレビュー）。
   */
  status: "none" | "reviewing" | "attached" | "unknown";
  /** attached のとき、投稿されたレビューの URL。 */
  url?: string;
};

export type TaskStatus =
  | "blocked"
  | "waiting_children"
  | "queued"
  | "running"
  | "idle"
  | "paused"
  | "awaiting_approval"
  | "escalated"
  | "cancelled";

export type TaskRemark = {
  id: string;
  step: StepKey;
  /** 何回目の差し戻しで出た指摘か。 */
  round: number;
  text: string;
  /** AI のレビュー（sacty のレビューのタスクの投稿）の指摘なら sacty_review。無ければ人の指摘（PBI-275）。 */
  source?: RemarkSource;
  /** 工程エージェントの、最新の提出での対応。最新の提出で回答がなければ未回答（undefined）。 */
  response?: string;
  /** 対応を書いた提出回。 */
  respondedIn?: number;
  /** 対応と一緒に、工程エージェントが人に確かめたいこととして挙げたこと（PBI-301）。対応と同じ提出回のものだけ持つ。 */
  confirm?: string;
  /**
   * この指摘を渡した実行が提出された提出回（回答の有無にかかわらず）。無ければ、まだその工程の実行がこの指摘を
   * 見て提出していない（差し戻しの直しの対象）。承認のあとに上流へ戻して再実行するとき、対応済みの古い指摘を
   * 今回の差し戻しと区別するのに使う。
   */
  submittedIn?: number;
  /** 前提が変わったなどの理由で、人間が無効にした指摘。エージェントには渡さない。 */
  voided: boolean;
};

/** 人間が承認した成果物。承認を取り消す（前の工程に差し戻す）まで変わらない。 */
export type ApprovedOutput = {
  submission: number;
  output: string;
  /** 設計の工程のテスト観点。 */
  testViewpoints: TestViewpoint[];
  at: string;
  /**
   * 人が PR の中で直してからマージして承認した（PBI-63）。sacty は、sacty が出した版（output を人が直した版にした
   * ときだけ）。fallback は、成果のファイルが消された・読めないので、sacty の版を承認済みにした。
   */
  edited?: { sacty?: string; fallback?: "deleted" | "unreadable" };
};

/** 古い head へのレビューとして捨てた、AI のレビューの指摘（PullRequestReviewDiscarded。PBI-291）。 */
export type DiscardedReview = Pick<PayloadOf<"PullRequestReviewDiscarded">, "number" | "head"> & {
  /** 捨てた時刻。 */
  at: string;
  items: PayloadOf<"PullRequestReviewDiscarded">["items"];
};

/**
 * PR のマージの記録（PBI-63。監査のため）。submitted は sacty が PR に出した最後のコミット、commit は PR の先頭の
 * コミット（人が直した最終のコミット）、mergeCommit はマージのコミット（取れれば）。edited は人が直してマージした。
 */
export type PullRequestMerge = Omit<PayloadOf<"PullRequestMerged">, "number" | "outdated"> & {
  at: string;
};

/** 工程エージェントの、承認済みの成果物への変更の申し出と、その判定。 */
export type TaskProposal = {
  id: string;
  fromStep: StepKey;
  target: StepKey;
  reason: string;
  facts: string[];
  proposed: string;
  testViewpoints?: TestViewpoint[];
  proposedAt: string;
  /** ゴールガーディアンの判定。無ければ判定中。 */
  judgement?: { verdict: Verdict; reason: DaemonText; at: string };
  /** 判定できなかった申し出への、人間の判断。 */
  decision?: { accept: boolean; at: string };
  /** 変更を反映したか。 */
  applied: boolean;
};

/**
 * タスクの詳細で、オーケストレーターにした質問と答え（PBI-54）。answer が無ければ答えを待っている。
 * 答えられなかったときは、text の代わりに failed（理由）を持つ。
 */
export type TaskQuestion = {
  id: string;
  text: string;
  askedAt: string;
  answer?: { text?: string; failed?: DaemonText; at: string };
};

/**
 * エラーレポートのための、オーケストレーターのエラーの分析。result が無ければ分析を待っている。
 * 分析できなかったときは、text の代わりに failed（理由）を持つ。
 */
export type TaskErrorAnalysis = {
  id: string;
  requestedAt: string;
  result?: { text?: string; failed?: DaemonText; at: string; runId?: string };
};

/**
 * 工程の成果の書き出し（PBI-56）。url は最後に書き出せた先（差し戻しの後に承認し直したら、ここを更新する）。
 * last は最後に結果を記録した書き出し、started は始めて、まだ結果を記録していない書き出し（デーモンが止まった・
 * 人間が止めたなど。次の書き出しで、目印のあるページを探して続ける）。retry は、人間が書き出し直しを求めた。
 */
export type TaskExport = {
  url?: string;
  last?: {
    approvedAt: string;
    submission: number;
    via: "platform" | "mcp";
    name: string;
    url?: string;
    failed?: DaemonText;
    at: string;
  };
  started?: { approvedAt: string; runId: string; at: string };
  retry?: boolean;
};

/**
 * 要求要件・設計の PR（PBI-57）。state は見守っている状態（open：開いている、merged：マージ済み、merged_outdated：
 * 最新の内容より前のものがマージされた、closed：マージせずに閉じられた）。superseded は、作り直したので sacty が閉じた。
 * submission は、何回目の提出の PR か（同じ PR を更新すると、最新の提出回にする）。
 */
/** sacty が作った PR に、取り込むラベルを付けた記録（PBI-88）。failed は付けられなかった理由。 */
export type PullRequestLabel = {
  repo: string;
  number: number;
  label: string;
  created?: boolean;
  failed?: DaemonText;
};

export type StepPullRequest = PayloadOf<"StepPullRequestPublished"> & {
  submission: number;
  state: "open" | "closed" | "merged" | "merged_outdated";
  superseded?: boolean;
  /** マージの記録（PBI-63）。 */
  merge?: PullRequestMerge;
};

/** 申し出が認められたか（ゴールガーディアンの承認か、人間の判断）。未決なら undefined。 */
export function proposalAccepted(p: TaskProposal): boolean | undefined {
  if (p.decision) return p.decision.accept;
  if (p.judgement?.verdict === "approved") return true;
  if (p.judgement?.verdict === "rejected") return false;
  return undefined;
}

/** 監査の原因（作業履歴の記録）と、その提案への人の判断（PBI-125）。at は見つけた時刻。 */
export type TaskAuditFinding = Omit<
  PayloadOf<"AuditDeepDived">["findings"][number],
  "proposals"
> & {
  at: string;
  proposals: (PayloadOf<"AuditDeepDived">["findings"][number]["proposals"][number] & {
    decision?:
      | {
          kind: "adopted";
          at: string;
          target: AuditTarget;
          fixTaskId?: string;
          /** 採用に添えた人の手入れ（PBI-151）。 */
          note?: AuditAdoptNote;
        }
      | { kind: "rejected"; at: string; reason: string };
  })[];
};

/** 監査が登録したメモリー（PBI-126）。at は登録した時刻。消したら deleted。 */
export type TaskAuditMemory = AuditMemoryRecord & {
  at: string;
  step: StepKey;
  deleted?: { at: string; reason: MemoryDeleteReason };
};

/** タスクの監査の状態（PBI-125）。usedUsd は監査の費用の合計で、タスクの予算とは別。 */
export type TaskAuditState = {
  auditId: string;
  queuedAt: string;
  capUsd: number;
  usedUsd: number;
  /** 換算値（サブスクリプションなど）を含むか。 */
  estimated: boolean;
  /** 80% の通知をした上限（上限を上げたら、また通知する）。 */
  warnedCapUsd?: number;
  /** 予算で一時停止している（上限を上げると外れる）。 */
  paused?: { at: string };
  /** seq は追記の順（同じ時刻の記録の前後を決める。PR #138 レビュー指摘）。 */
  survey?: Omit<PayloadOf<"AuditSurveyed">, "auditId" | "promotions"> & { at: string; seq: number };
  /** 深掘りを終えた工程（終えた順）。 */
  dives: (Omit<PayloadOf<"AuditDeepDived">, "auditId" | "findings" | "memories"> & {
    at: string;
  })[];
  findings: TaskAuditFinding[];
  /** この監査で登録したメモリー（PBI-126）。 */
  memories: TaskAuditMemory[];
  failed?: { at: string; reason: DaemonText; step?: StepKey };
  completedAt?: string;
};

/** 監査の対象か（完了したタスク。中止したタスクは監査しない。PBI-124）。 */
export function isAuditTarget(task: Task): boolean {
  return task.status === "idle" && isCompleted(task);
}

/** 監査を進めるべきか（終わっていない・失敗していない・予算で止まっていない）。 */
export function auditOpen(task: Task): boolean {
  const a = task.audit;
  return a !== undefined && !a.completedAt && !a.failed && !a.paused;
}

/** 次に深掘りする工程（大まかな監査が挙げた工程のうち、まだ深掘りしていないもの）。 */
export function nextAuditDive(audit: TaskAuditState): StepKey | undefined {
  const done = new Set(audit.dives.map((d) => d.step));
  return audit.survey?.concerns.find((c) => !done.has(c.step))?.step;
}

export type Task = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  /**
   * 人が再開のときに足した補足（TaskResumed の note。足した順）。説明の後にも見出しを付けて足すが、説明を書き換える
   * 取り込み（チケットのトリアージ）では、説明の見出しから読み直さずにこれを使う（チケットの文を人の補足と取り違えない）。
   */
  resumeNotes?: string[];
  start:
    | "sacty"
    | "github_issue"
    | "github_pull_request"
    | "split"
    | "jira"
    | "deployment"
    | "audit"
    | "schedule"
    | "security";
  /** スケジュールタスクが作ったタスクの、スケジュールタスクと予定の時刻。 */
  schedule?: PayloadOf<"TaskCreated">["schedule"];
  /** マージの後の監視で見つけた失敗の、修正のタスク（PBI-89）。元のタスクと、何段目か。 */
  fix?: PayloadOf<"TaskCreated">["fix"];
  /** 監査の改修の提案を採用して作ったタスクの、元の提案（PBI-125）。 */
  auditFix?: PayloadOf<"TaskCreated">["auditFix"];
  /** 不安定なテストの台帳の提案から作ったタスクが直すテスト（PBI-312）。 */
  flakyFix?: PayloadOf<"TaskCreated">["flakyFix"];
  /** セキュリティチェックのレポートの区分から作った対応のタスクの、元のタスクと区分。 */
  securityFix?: PayloadOf<"TaskCreated">["securityFix"];
  /** セキュリティチェックのタスクで、区分ごとに頼んだ対応のタスク（SecurityFixRequested）。 */
  securityFixes?: Partial<
    Record<SecurityCategory, PayloadOf<"SecurityFixRequested"> & { at: string }>
  >;
  /** 中止したタスクを、人が最初からやり直すために作ったタスクの、元のタスクと指定したイメージ（再実行）。 */
  rerun?: PayloadOf<"TaskCreated">["rerun"];
  /** 中止したタスクを再実行して作ったタスク（再実行は1度だけ）。 */
  rerunBy?: string;
  /** 完了したタスクから、続きの作業のために作ったタスクの、元のタスク（派生）。 */
  derivedFrom?: PayloadOf<"TaskCreated">["derivedFrom"];
  /** このタスクから派生して作ったタスク（作った順）。 */
  derivedTasks?: string[];
  /** 完了したタスクの監査（PBI-125）。監査を待つ記録（AuditQueued）が無ければ無い。 */
  audit?: TaskAuditState;
  /**
   * 実装の PR のマージの後の、CI/CD とデプロイの監視（PBI-89）。PBI-116 からは、マージの後の監視の工程（deployment）の中身。
   * PBI-116 より前の作業履歴では、工程の無い、完了したタスクの監視。
   */
  deployment?: DeploymentWatch;
  /** マージの後の監視の工程をするか（工程を選んだときに sacty が決めた。PBI-116）。skipped なら飛ばした理由。 */
  deploymentChoice?: PayloadOf<"StepsChosen">["deployment"];
  /**
   * 工程の見直しを待っている、終わった工程。工程が終わり、まだの工程に飛ばせる工程（skippableSteps）があるときに持つ。
   * 次の工程を実行する前に、オーケストレーターが要らない工程を飛ばすかを決める（StepsSkipped）と消える。
   */
  stepReview?: StepKey;
  /** 取り込み元（GitHub Issue）。 */
  source?: TaskSource;
  /** 取り込み元のチケット（JIRA など。PBI-52）。 */
  ticket?: {
    platform: string;
    service: "jira-cloud" | "jira-server";
    key: string;
    url: string;
    /** プロジェクトのコンテキストの PF から取り込んだ（PBI-74）。 */
    scope?: "project";
  };
  /**
   * タスクの開始時に情報収集のエージェントが集めて絞り込んだ情報（まとめと情報源）。オーケストレーター・工程・ゴールガーディアンの
   * 指示に添える。分割の子タスクは集めず、親のものを内容に添える。
   */
  gathered?: { brief: string; sources: { title: string; url?: string }[]; at: string };
  /** チケットから作業するリポジトリ・題・概要を決めた理由（PBI-52）。人が選んだら by は person。 */
  ticketTriage?: { reason: DaemonText; by: "orchestrator" | "person" };
  /**
   * オーケストレーターのセッション（PBI-67）。AI・セッションの ID・このセッションを使った回数・新しく始めた理由。
   * saved が false なら、最後の実行のセッションを保存できなかった（次は、その前に保存したものを再開する）。
   */
  orchestratorSession?: {
    agentId: string;
    runtime: "claude-code" | "codex";
    sessionId?: string;
    uses: number;
    reason?: OrchestratorSessionReason;
    saved: boolean;
    startedAt: string;
    lastUsedAt: string;
  };
  /** チケットに PR の URL をコメントした結果（PBI-52）。 */
  ticketPrComment?: { url: string } | { failed: DaemonText };
  /** 画面で作ったタスクの対象リポジトリ（リポジトリの URL。PBI-21・PBI-40）。Issue から取り込んだタスクは source.repo。 */
  repo?: string;
  /** 対象リポジトリを指定せずに作った（PBI-73）。リポジトリを決めた後も残る（作ったときの指定）。 */
  noRepo?: true;
  /** テンプレートで作った（PBI-90）。 */
  template?: TaskTemplate;
  /** 人がタスクの作成時に指定した工程の組み合わせ（進め方）。無ければオーケストレーターが選ぶ。 */
  requestedPlan?: StepPlan;
  /**
   * 人がタスクの作成時に指定した、タスクのイメージ（PBI-318）。デーモンが工程を選ぶ（選び直す）ときに、プロジェクトの
   * 対象の指定・オーケストレーターの選択より優先して、工程の選択（StepsChosen の image）に入れる。
   */
  requestedImage?: string;
  /**
   * 古い版（PBI-318 より前）の作業履歴の、作成時に工程ごとに指定したイメージ。工程を選んだ（選び直した）ときに、
   * ほかの決め方より優先して images（古い版の工程ごとのイメージ）に入れる。
   */
  requestedImages?: StepSettingMap;
  /**
   * 人がタスクの作成時に、進め方の工程ごとに指定したエージェント。作成のときから agents に入れ、工程を選び直しても
   * agents に戻す（タスクの詳細で変えたら、その変更が優先する）。
   */
  requestedAgents?: StepSettingMap;
  /**
   * 実装の検証に通った後、実装に変更が無かったので PR を作らなかった、実装の提出回（PBI-90・PBI-110）。その提出回が承認待ち・
   * 承認済みなら、変更なしの実装の承認（変更なしで完了）。
   */
  noChanges?: { submission: number };
  /**
   * 対象リポジトリを決めた理由（PBI-73）。リポジトリを指定せずに作ったタスクで、オーケストレーター・人が選んだとき、
   * 分割の子タスクに分割のエージェントが付けたとき。
   */
  repoChoice?: { reason: DaemonText; by: "orchestrator" | "person" };
  status: TaskStatus;
  /** 分割で作った子タスクの親と、依存先の子タスク（PBI-27）。 */
  parent?: { taskId: string; dependsOn: string[] };
  /** sacty が作った PR をレビューする子タスクの、親と、その PR を作った工程（PBI-330）。 */
  reviewOf?: { taskId: string; step: "requirements" | "design" | "implement" };
  /**
   * このタスクが作った PR をレビューする子タスク（作った順。PBI-330）。1つの PR につき1つ。PR を作り直したら、新しい PR に
   * もう1つ。
   */
  reviewTasks?: PayloadOf<"ReviewTaskCreated">[];
  /** 親の PR の更新で再レビューを始めたときの、親の PR の先頭（同じ更新で繰り返さない。PBI-330）。 */
  reviewRestartCommit?: string;
  /**
   * 依存先の子タスク（taskId）の実装の PR に重ねて始めた子タスクの、重ねている先（PBI-317）。branch はその PR のブランチ
   * （子タスクの起点のブランチ・PR の向き先・取り込む元）、commit は始めたときの依存先の合格したコミット（作業領域の起点）。
   * 依存先の PR がマージされ、ベースブランチに付け替えると無くなる。
   */
  stack?: { taskId: string; branch: string; commit: string };
  /**
   * 重ねていた依存先の PR がマージされて付け替えた、起点のブランチ（PBI-317）。作業領域をまだ用意していない子タスクが、
   * 初めて用意するときに使う（用意した後は repository.baseBranch）。
   */
  stackedBase?: string;
  /** タスク分割で決めた子タスク（PBI-27）。 */
  split?: {
    /**
     * 子タスク（内容は、デーモンが止まって作れなかった子タスクを作り直すために持つ）。round は何回目の
     * 分割で作ったか（1 が最初の分割、2 以降は統合レビューの後に追加した修正の子タスク。PBI-31）。
     */
    children: {
      taskId: string;
      title: string;
      body: string;
      dependsOn: string[];
      round: number;
      /** 子タスクに付けたリポジトリと理由（リポジトリの無い親を分けたとき。PBI-73）。 */
      repo?: string;
      repoReason?: string;
    }[];
    /** 分割した回数（最初の分割と、修正の子タスクの追加。PBI-31）。 */
    rounds: number;
    reason: string;
    at: string;
    /** 人間が中止を認めた子タスク（親を再開した）。完了したものと同じく扱う。 */
    acceptedCancellations: string[];
  };
  pausedReason?: PauseReason;
  /** 止まった理由の詳しい説明。 */
  pausedMessage?: DaemonText;
  /** 止めたが、無くなったことを確かめられなかったコンテナの実行。 */
  unstoppedRuns?: string[];
  /** 中止されたので親を止めた子タスク（再開すると、中止を認めたことになる。PBI-27）。 */
  pausedCancelledChildren?: string[];
  /**
   * 一時停止の直前の状態。再開時、実行待ち（やり直し）に戻すか待機に戻すかを決める。
   * 子タスクの完了を待っていたタスクは、その待ちに戻す（PBI-27）。
   */
  resumeTo?: "queued" | "idle" | "waiting_children" | "awaiting_approval";
  steps: { key: StepKey; state: StepState }[];
  /** 工程ごとの最新の出力。 */
  outputs: Partial<Record<StepKey, string>>;
  /** 設計の最新の提出のテスト観点。 */
  testViewpoints: TestViewpoint[];
  /** 承認済みで凍結された成果物。 */
  approved: Partial<Record<StepKey, ApprovedOutput>>;
  budget: {
    usedUsd: number;
    capUsd: number;
    warned: boolean;
    /** 換算値（サブスクリプションなど）を含むか。 */
    estimated: boolean;
    /**
     * 使った分の全体を読めなかった実行（時間切れなど）の回数（PBI-281）。その費用は、読めた分（下限）だけが usedUsd に入っている。
     * 無ければ 0 回。
     */
    unknownRuns?: number;
    /** 人が上限を上げた（BudgetCapRaised）。工程の組み合わせの予算（StepsChosen の budgetCapUsd）で上書きしない。 */
    raised?: true;
  };
  currentRunId?: string;
  /** 外部操作の実行開始。再開・差し戻しでも消さず、二重実行を防ぐ。 */
  operationAttempted?: boolean;
  /** 工程選択時に依頼から決めた単発作業の実行設定。 */
  operation?: PayloadOf<"StepsChosen">["operation"];
  /** 承認ゲートで止まっている工程と、何回目の提出か。 */
  gate?: { step: StepKey; submission: number };
  /** 工程ごとの提出回数。 */
  submissions: Partial<Record<StepKey, number>>;
  remarks: TaskRemark[];
  /** 変更の申し出（古い順）。 */
  proposals: TaskProposal[];
  /** 実装の対象リポジトリ。 */
  repository?: PayloadOf<"RepositoryPrepared">;
  /**
   * 作業領域に取り込んだ、ベースブランチの最新（BaseBranchMerged の最後のもの）。あれば、作業領域は起点のコミットではなく
   * この commit にマージした内容なので、実装の差分はこの commit からの変更になり、提出するコミットはこの commit を
   * 第2の親にしたマージコミットになる（まだ親に含まれていなければ）。
   */
  baseMerge?: PayloadOf<"BaseBranchMerged"> & { at: string };
  /**
   * 実装の観点とテストの対応。最新の提出が申告したもの。直しの提出（前に実装の提出がある）は、PR 全体の対応にするため、
   * 前の提出までに対応させたテストも、今回の申告に出てくる観点に残す（PBI-299）。
   */
  testMap: TestMapping[];
  /**
   * 実装の提出ごとの出力（古い順。PBI-299）。直しの後の PR の本文を、最後の直しの説明だけにせず、PR 全体の説明にするために
   * 持つ。要求要件・設計などの上流の工程を承認し直したら、実装をやり直す前提が変わるので、空に戻す。上限を超えたら古いものを捨てる。
   * 持たない記録（テストが作る不完全なタスクなど）は、`outputs.implement` だけを使う。
   */
  implementHistory?: string[];
  /**
   * 前の提出までの、PR 全体の説明の土台（最新の提出を除く。PBI-299）。最初の提出の前は無い。最後に「最後の直し」の節を付けて
   * 全体の説明を書き直した提出の、節以外の部分（そういう提出が無ければ最初の提出）。節を書かずに直しだけを書いた提出が
   * 続いても、履歴の上限を超えても、土台を失わないよう、履歴とは別に持つ。
   */
  implementBase?: string;
  /**
   * 実装の検証の進み具合。pending：最終レビュー（ゴールガーディアンがテストを実行して判定する）待ち。tests_passed は、それより
   * 前の版の記録だけ（sacty がテストのコンテナで実行したテストに通り、最終レビュー待ち）。
   * 検証が終わる（合格・不合格）と undefined に戻る。
   */
  verification?: "pending" | "tests_passed";
  /**
   * 実装が検証（テストと最終レビュー）に通り、sacty が実装の PR を作るのを待っている（PBI-110）。実行待ちのまま、実装の工程の
   * 中で PR を作り、実装の承認待ちにする。PR を作る（変更が無いと分かる）か、前の工程からやり直すと無くなる。
   */
  publishPending?: true;
  /**
   * 最終レビューの前に作った（更新した）実装の PR の CI（PullRequestPublished の verifying）。result が無い間は CI を待っている。
   * 最終レビューは CI を待たずに並べて行い、合格したら result を待つ（reviewedBeforeResult。PBI-314）。実装をやり直す（実装の
   * AgentRunCompleted）か、最終レビューが不合格か、前の工程からやり直すと無くなる（不合格では、待っている CI だけを捨てる）。
   */
  pullRequestCi?: PullRequestCi;
  /**
   * CI の失敗ジョブの再実行の記録（PBI-311）。コミットごとに1件。実装をやり直しても消さない（同じコミットのまま CI を待ち直しても、
   * コミットごとに1回だけ頼み、元の失敗を最終レビューに渡す）。skipped は、1つも頼めずに元の失敗のまま進んだ。
   */
  pullRequestCiReruns?: (NonNullable<PullRequestCi["rerun"]> & {
    commit: string;
    skipped?: true;
  })[];
  /**
   * 承認待ちの PR の今の head に付いた AI のレビューの状況（PBI-302 D1）。作業履歴からは復元しない。デーモンが画面に返すときだけ
   * 足す（`TaskService.view`）。
   */
  aiReview?: AiReviewOfHead;
  /** 人が、ゴールガーディアンの不合格のまま実装の承認へ進めた（VerificationOverridden）。submission はその提出回。 */
  verificationOverride?: { at: string; submission: number };
  /**
   * 最終レビューをしない流れ（PBI-331）で、セキュリティ対応の差分を修正の範囲と照らした結果（最後の FinalReviewSkipped）。
   * PR の本文と、PR のレビューの子タスクの指示に渡す。
   */
  securityScopeCheck?: PayloadOf<"FinalReviewSkipped">["securityScope"];
  /** 検証が続けて通らなかった回数。人間が再開するか、検証に通ると0に戻る。 */
  verifyFailures: number;
  /**
   * 最後の最終レビューで、テストが通らなかった原因として申告された失敗の名前（PBI-308）。人が再開しても消さない
   * （再開の後に同じ失敗なら、回数に関係なく止める）。テストが通る・前の工程からやり直す・人がレビューへ進めると消す。
   */
  failedTests?: string[];
  /** 実装をやり直しても1つも直らなかった、前回の失敗（PBI-308）。あれば、やり直さずに止める。 */
  verifyStalled?: string[];
  /**
   * 最終レビューの出力から判定を読み取れなかった回数（続けて。FinalReviewFailed の verdictUnreadable）。不合格ではないので
   * verifyFailures には数えない。最終レビューの判定が記録される・人間が再開する・前の工程からやり直すと0に戻る。
   */
  unreadableReviews?: number;
  /**
   * 最新の、sacty がテストのコンテナで実行したテストの結果（それより前の版の記録だけ。今の版は、最終レビューの tests に
   * ゴールガーディアンが実行したテストがある）と、最終レビュー。
   */
  lastTests?: TestsRunResult;
  lastReview?: FinalReview;
  /** すべての回の最終レビューが認めた不安定な失敗（不安定なテストの台帳に使う。PBI-312）。 */
  flakySightings?: { name: string; file: string; reason: string; at: string }[];
  /** 最新の統合レビュー（PBI-31）。 */
  integration?: IntegrationReview;
  /** 統合レビューが続けて通らなかった回数。合格するか、人間が差し戻すと0に戻る（PBI-31）。 */
  integrationFailures: number;
  /** 最後に工程エージェントへ渡したコンテキスト（使ったリポジトリとコミット）。 */
  context?: PayloadOf<"ContextResolved"> & { at: string };
  /** 中止したときの後片付けの結果。 */
  cancelled?: { at: string } & PayloadOf<"TaskCancelled">;
  /** sacty がプッシュしたブランチ（PRの作成の前に記録する）。 */
  pushedBranch?: PayloadOf<"BranchPushed">;
  /** sacty が作ったPR（またはブランチ）。 */
  /**
   * reviewedCommit は、PR のレビューの子タスクが指摘なしにして、sacty がドラフトを外した PR の先頭（PBI-331）。人がレビューの間に
   * コミットを足したときは、sacty が提出したコミット（commit）と違う。依存のある子タスクは、これを起点に重ねる。
   */
  pullRequest?: PayloadOf<"PullRequestPublished"> & { reviewedCommit?: string };
  /** 実装の承認待ちの間に見守っている、実装の PR の状態（PBI-14a・PBI-110）。PR を作っていなければ無い。 */
  pullRequestState?: "open" | "closed" | "merged" | "merged_outdated";
  /** 実装の PR のマージの記録（PBI-63）。 */
  pullRequestMerge?: PullRequestMerge;
  /**
   * 承認待ちの間に見守っている実装の PR が、ベースブランチと競合している（PullRequestConflicted）。commit は、そのときの
   * 提出のコミット。画面に出すだけで、取り込みは人の差し戻し・指摘で行う。画面に出すか（今の PR のものか）は
   * `pullRequestConflict` で決める。
   */
  pullRequestConflict?: { number: number; commit: string; at: string };
  /**
   * タスクブランチ（PBI-57）。これがあるタスクは、要求要件・設計をタスクブランチへの PR のマージで承認し、実装の PR を
   * タスクブランチからベースブランチに向けて作る。
   */
  taskBranch?: PayloadOf<"TaskBranchCreated">;
  /** 要求要件・設計の PR（作った順。同じ PR を更新したら、その PR を置き換える。PBI-57）。 */
  stepPullRequests: StepPullRequest[];
  /** sacty がプッシュした、要求要件・設計のブランチ（中止で消す。PBI-57）。 */
  stepBranches: string[];
  /**
   * sacty が作った PR に、取り込むラベルを付けた・付けられなかった記録（PR ごとに1件。PBI-88）。記録のある PR には、
   * 更新しても付け直さない。
   */
  pullRequestLabels?: PullRequestLabel[];
  /** 要求要件・設計の成果のファイルを置くディレクトリ（オーケストレーターが決めた。無ければ既定。PBI-57）。 */
  documentsDir?: string;
  /**
   * 引き継いで直す既存の PR（StepsChosen の continuedPullRequest）。実装はこの PR のブランチに積み、新しい PR を作らない。
   */
  continuedPullRequest?: ContinuedPullRequest;
  /**
   * 引き継いだ PR の指摘のうち、実装の工程の指示に渡したもの（ContinuedFeedbackPassed の keys）。PR の指摘として取り込み直さない。
   */
  handedOverFeedback?: string[];
  /** ゴールガーディアンの見逃し（最終レビューで合格にした成果物を、人間が差し戻した）。 */
  misses: (PayloadOf<"GuardianMissed"> & { at: string })[];
  /** やり直しの実装に渡す、直前の検証で通らなかった内容。 */
  verifyFeedback?:
    | { kind: "tests"; tests: TestsRunResult }
    | { kind: "review"; review: FinalReview }
    /** 提出の前に、ベースブランチとの競合の目印が作業領域に残っていた（BaseConflictsRemained）。 */
    | { kind: "merge"; files: string[] };
  /** エスカレーションの内容（差し戻しを続ける場合に使う、やり直す工程と書きかけの指摘）。 */
  escalation?: {
    step: StepKey;
    target: StepKey;
    pendingRemarks: Remark[];
    /** エスカレーションの理由（PBI-14b で足した。古い作業履歴には無い）。 */
    reason?: PayloadOf<"TaskEscalated">["reason"];
    /** ゴールガーディアンの判断の理由（PR の指摘の戻し先の確認のとき）。 */
    note?: DaemonText;
  };
  /** 調査の結果を、取り込み元の GitHub Issue に返したか（PBI-18）。 */
  issueComment?: { url: string } | { failed: DaemonText };
  /**
   * 承認した工程の成果でエージェントが頼んだ、GitHub の PR・Issue へのコメントを投稿した記録（工程ごとに、最後に
   * 投稿した承認の版）。
   */
  githubComments?: Partial<Record<StepKey, PayloadOf<"GitHubCommentsPosted"> & { at: string }>>;
  /** レビューの工程の対象の PR（PBI-19）。 */
  reviewTarget?: PayloadOf<"ReviewTargetResolved">;
  /** レビューの工程が書いた、PR の行へのコメント（PBI-19）。 */
  reviewComments: ReviewComment[];
  /** 再現の工程が申告した、再現のテスト（PBI-29）。 */
  reproductionTests: string[];
  /**
   * 文書作成の工程で、エージェントがタスクの説明の指示に従って外部に直接作った・直したページ（成果物）の URL（申告された順。
   * 重複なし）。差し戻しでは、これらのページを直させる（同じ内容の別のページを作らせない）。ページがあれば書き出さない。
   */
  documentPages?: string[];
  /** 再現の工程の後、sacty がテストで再現を確かめる前（PBI-29）。 */
  reproductionPending?: boolean;
  /** 最新の、再現の確かめの結果（PBI-29）。 */
  reproduction?: PayloadOf<"ReproductionChecked"> & { at: string };
  /**
   * レビューの結果を投稿した、PR のレビューの URL と時刻（PBI-19）。latestCommit は、投稿の直前の PR の先頭が、レビューした
   * コミットと違ったときの先頭（PBI-111）。
   */
  reviewPost?: { url: string; at: string; latestCommit?: string };
  /**
   * レビューの工程の、回ごとの判定（PBI-88・PBI-111）。verdict が無い回は、判定を読めなかった。
   */
  reviewVerdicts?: {
    round: number;
    verdict?: ReviewVerdict;
    /** PR のレビューの子タスクが示した、指摘の戻し先と原因（PBI-332）。 */
    rework?: ReviewRework;
    /** 戻し先を示した回の、実行のエージェント（PBI-332。戻し先の判断の記録に使う）。 */
    agentId?: string;
  }[];
  /**
   * 前回投稿したレビュー（再レビューのとき。PBI-111）。前回の指摘（本文と行へのコメント）と、投稿の後の作者の返答を
   * 再レビューのプロンプトに渡すため。
   */
  previousReview?: PreviousReview;
  /** GitHub再依頼の取り込み済み目印（取消・失敗後も維持）。 */
  reviewRerequest?: PayloadOf<"TaskCreated">["reviewRerequest"];
  /** 何回目のレビューか（「再レビュー」で2回目から。最初のレビューでは無い。PBI-44）。 */
  reviewRound?: number;
  /** オーケストレーターが決めた、テストのコマンド（PBI-25）。 */
  testCommand?: string;
  /**
   * オーケストレーターが、対象リポジトリにテストの仕組みが無いと判断した根拠（PBI-94）。これがあるタスクは、テストの
   * コマンドが無くても進め、実装の検証でテストを飛ばして、ゴールガーディアンがタスクの目的から判定する。
   */
  noTestsReason?: string;
  /**
   * オーケストレーターが、この依頼の成果物は文書のファイルだけと判断した（StepsChosen の documentsOnly。PBI-284）。
   * 人がテストの扱いを決め直したら（TestsDecided）、この判断は使わない。
   */
  documentsOnly?: true;
  /**
   * テストのコマンドかテストなしの理由（noTestsReason）を、人が再開のときに決めた（TestsDecided）。無ければ
   * オーケストレーターが決めたもの。
   */
  testsDecidedBy?: "person";
  /** テストの仕組みが無いタスクで、実装の最新の提出が用意して申告した、テストのコマンド（PBI-94）。 */
  addedTestCommand?: string;
  /** 最新の検証で、テストのコマンドが無いのでテストを飛ばした時刻（PBI-94）。テストを実行すると無くなる。 */
  testsSkippedAt?: string;
  /** オーケストレーターが判断した、調査の工程の性質（PBI-43）。無ければ内容の調査として扱う。 */
  investigation?: InvestigationKind;
  /** 工程ごとに使うイメージの名前（PBI-41）。書いていない工程は既定のイメージ。人が変えたら、変えた名前（PBI-106）。 */
  /**
   * 工程ごとの、最新の提出のセルフレビューの報告（PBI-120）。null は報告が無い・読めなかった。セルフレビューより前の記録の
   * 工程には無い。
   */
  selfReviews?: Partial<Record<StepKey, SelfReview | null>>;
  /**
   * 最新の実装の提出で、実装の工程が最後の変更の後に実行した検証の記録（PBI-305）。最終レビューが、同じ内容の結果として
   * 使い回す。作業領域が実装の工程の外で変わった（ベースブランチの取り込み・本文の差し替え）ら消す。
   */
  implementVerification?: VerificationRecord;
  /**
   * 工程ごとの、最新の提出の項目ごとの出典の分類（要求要件・設計）。null は結果が無い・読めなかった。分類より前の記録の
   * 工程には無い。
   */
  provenances?: Partial<Record<StepKey, Provenance | null>>;
  /**
   * タスクのイメージ（config.yaml の images の名前か default。PBI-318）。すべての工程・テスト・最終レビューで使う
   * （stepImageOf・verificationImageOf）。無ければ既定のイメージ（古い版の作業履歴なら、工程ごとの images）。
   */
  image?: string;
  /**
   * 古い版（PBI-318 より前）の作業履歴の、工程ごとのイメージ（PBI-41）。古い版で選んだ・変えた工程のイメージを、
   * どの工程がどのイメージで動いたかとして残す。タスクのイメージ（image）があれば、そちらを使う。
   */
  images?: Partial<Record<StepKey, string>>;
  /**
   * 工程を選んだときにイメージを決めたのが、再実行で人が指定したものか、作成時に人が指定したもの（request）か、
   * プロジェクトの対象の指定か、オーケストレーターか（PBI-41・PBI-318）。
   */
  imageSource?: "project" | "orchestrator" | "rerun" | "request";
  /** オーケストレーターが既定のイメージにした、images のどれも合わない理由（PBI-318）。 */
  defaultImageReason?: string;
  /** images の候補を見せたのに、理由が無いまま既定のイメージにした（PBI-318）。 */
  imageUnexplained?: true;
  /** 人が変えた、タスクの題（PBI-323）。最後の変更。チケットのトリアージは、人が変えた題を書き換えない。 */
  titleChange?: { from: string; to: string; at: string };
  /** 人が変えた、タスクのイメージ（PBI-318）。最後の変更。from が無いのは、古い版の工程ごとのイメージから変えたとき。 */
  imageChange?: { from?: string; to: string; at: string };
  /** 古い版（PBI-318 より前）の作業履歴の、既定のイメージにした工程ごとの理由（PBI-105）。 */
  defaultImageReasons?: Partial<Record<StepKey, string>>;
  /** 古い版（PBI-318 より前）の作業履歴の、理由が無いまま既定のイメージにした工程（PBI-105）。 */
  imagesUnexplained?: StepKey[];
  /** 古い版（PBI-318 より前）の作業履歴の、人が変えた工程のイメージ（PBI-106）。工程ごとに最後の変更。 */
  imageChanges?: Partial<Record<StepKey, { from: string; to: string; at: string }>>;
  /** 人が選んだ、工程のエージェント（config.yaml の agents の名前。PBI-121）。無い工程は config.yaml で決まる。 */
  agents?: Partial<Record<StepKey, string>>;
  /** 人が工程のエージェントを変えた記録（工程ごとの最新。PBI-121）。 */
  agentChanges?: Partial<Record<StepKey, { from: string; to: string; at: string }>>;
  /** 工程・テストの実行の前に起動する docker compose のサービス（PBI-47）。 */
  services?: PayloadOf<"StepsChosen">["services"];
  /** サービスを使う・使わないと判断した理由（PBI-70）。 */
  servicesReason?: string;
  /** オーケストレーターが決めた、工程ごとの書き出し先と理由（PBI-56。使える接続先が無かったときは無い）。 */
  exportPlans?: Partial<Record<StepKey, ExportPlan>>;
  /** 工程ごとの成果の書き出し（PBI-56）。 */
  exports: Partial<Record<StepKey, TaskExport>>;
  /** オーケストレーターが工程を選んだ理由（PBI-17。固定の工程だった作業履歴には無い）。 */
  stepsChoice?: { plan?: StepPlan; reason: DaemonText; fallback: boolean };
  /** 取り込んだ PR へのフィードバック（種類と ID。二重に取り込まないため。PBI-14b）。 */
  importedFeedback: string[];
  /**
   * 古い head へのレビューとして取り込まずに捨てた、AI のレビューの指摘（古い順。PBI-291）。人に届けるため、承認の画面に出す
   * （今の PR のものか・いつまで出すかは `discardedAiReviews` で決める）。
   */
  discardedReviews?: DiscardedReview[];
  /** オーケストレーターへの質問と答え（古い順。PBI-54）。 */
  questions: TaskQuestion[];
  /** エラーレポートのための、オーケストレーターのエラーの分析（古い順）。 */
  errorAnalyses: TaskErrorAnalysis[];
  /** 取り込んで、まだ差し戻しに反映していない PR の指摘と、ゴールガーディアンの戻し先の判断。 */
  pendingReview?: {
    keys: string[];
    remarks: string[];
    judgement?: {
      target?: StepKey;
      cause?: ReworkCause;
      answer?: ReworkAnswer;
      reason: DaemonText;
    };
    /** remarks のうち、AI のレビュー（sacty のレビューのタスクの投稿）の指摘の位置（PBI-275）。無ければすべて人の指摘。 */
    aiReview?: number[];
    /**
     * AI のレビューの指摘の位置（文字列）ごとの、投稿したレビューのタスクと回（PBI-332。`PullRequestReviewImported` の items の
     * review）。無い位置の指摘は、出どころの回が分からない。
     */
    aiReviewFrom?: Record<string, string>;
  };
  /**
   * 最後に PR の指摘で差し戻した戻し先と、ゴールガーディアンの判断の理由（PBI-58）。decided が false なら、
   * 戻し先を判断できなかったので実装をやり直した。人間が戻し先を確かめた作業履歴（PBI-14b）には無い。
   */
  prRework?: {
    target: StepKey;
    decided: boolean;
    /** ゴールガーディアンが判断した差し戻しの原因（PBI-268）。判断できなければ無い。 */
    cause?: ReworkCause;
    /** 原因が question_answer のとき、答えが推奨どおりか（PBI-302 B1）。as_recommended なら、答えの反映だけの軽い直しにした。 */
    answer?: ReworkAnswer;
    reason: DaemonText;
    at: string;
    /**
     * 戻し先の工程への、何回目の差し戻しか（その差し戻しの指摘の回。Remark.round と同じ）と、その差し戻しの指摘の ID。
     * 判断文を、判断した指摘の集合そのもので始まった作り直しの実行にだけ渡すために残す（PBI-300）。作業履歴の差し戻しの記録
     * （ChangesRequested）から投影するので、以前の作業履歴を読み直したときも設定される。
     */
    round: number;
    remarkIds: string[];
  };
  createdAt: string;
  updatedAt: string;
};

/** 前の工程からやり直す。その工程を実行対象にし、その工程から先の承認は取り消す。 */
function reopen(task: Task, target: StepKey) {
  const to = task.steps.findIndex((s) => s.key === target);
  task.steps = task.steps.map((s, i) => {
    if (i === to) return { ...s, state: "active" as const };
    // 飛ばした工程（マージの後の監視。PBI-116）は、飛ばしたまま
    if (i > to && s.state !== "skip") return { ...s, state: "todo" as const };
    return s;
  });
  // 前の工程からやり直すので、実装の検証の途中経過と失敗の回数・工程の見直しは持ち越さない
  task.stepReview = undefined;
  task.verification = undefined;
  task.verifyFeedback = undefined;
  resetVerifyFailures(task);
  task.unreadableReviews = undefined;
  task.publishPending = undefined;
  task.pullRequestCi = undefined;
  const keep = new Set(task.steps.slice(0, to).map((s) => s.key));
  task.approved = Object.fromEntries(
    Object.entries(task.approved).filter(([key]) => keep.has(key as StepKey)),
  );
}

/**
 * 工程を終え、次の工程に進める。飛ばした工程（skip。PBI-116）には進まない（その次のまだの工程へ）。次が無ければ、
 * どれも active にしない（タスクの完了）。
 */
function advance(task: Task, index: number) {
  const next = task.steps.findIndex((s, i) => i > index && s.state === "todo");
  task.steps = task.steps.map((s, i) => {
    if (i === index) return { ...s, state: "done" as const };
    if (i === next) return { ...s, state: "active" as const };
    return s;
  });
  // まだの工程に飛ばせる工程があれば、次の工程を実行する前に、オーケストレーターに見直させる（工程の見直し）
  const done = task.steps[index]?.key;
  task.stepReview = done && skippableSteps(task).length > 0 ? done : undefined;
}

/**
 * オーケストレーターが、工程の見直しで飛ばせる工程（工程の見直し）。まだの工程（実行対象・まだ）のうち、実装の前に置く
 * 文書やテストを作る工程（SKIPPABLE_STEPS）。組み合わせに実装の工程があるときだけ（成果物は実装で、ゴールガーディアンが
 * 最終レビューで判定する）。人がタスクの作成時に組み合わせを指定したタスクは、飛ばさない。
 */
export function skippableSteps(task: Task): StepKey[] {
  // 人が指定した組み合わせは、そのまま実行する（飛ばさない）
  if (task.requestedPlan) return [];
  if (!task.steps.some((s) => s.key === "implement" && s.state !== "skip")) return [];
  return task.steps
    .filter((s) => (s.state === "todo" || s.state === "active") && SKIPPABLE_STEPS.includes(s.key))
    .map((s) => s.key);
}

/** 工程を終えた後の、次の工程（無ければ undefined。飛ばした工程は除く）。 */
function nextStep(task: Task, step: StepKey): StepKey | undefined {
  const index = task.steps.findIndex((s) => s.key === step);
  return task.steps.find((s, i) => i > index && s.state === "todo")?.key;
}

/**
 * マージの後の監視の工程（PBI-116）が終わったら、工程を終えてタスクを完了にする。監視が終わり（通った・失敗した・飛ばした・
 * 時間切れ）、失敗なら修正のタスクを決めた（登録した・作らなかった）とき。失敗しても、タスクは止めない。
 */
function settleDeploymentStep(task: Task) {
  if (activeStep(task) !== "deployment" || task.status === "cancelled") return;
  const watch = task.deployment;
  if (!watch || watch.state === "waiting" || fixDecisionPending(task)) return;
  advance(
    task,
    task.steps.findIndex((s) => s.key === "deployment"),
  );
}

class ActivityIntegrityError extends Error {
  constructor(event: ActivityEvent, detail: string) {
    super(`${event.type} (seq ${event.seq}) on task ${event.taskId}: ${detail}`);
  }
}

/** 検証に通らなかった。失敗の内容を渡して、実装をやり直す（実行待ちに戻す）。 */
/** 実装の提出ごとの出力（`implementHistory`）を持つ件数の上限。直しが続いても、記録が際限なく大きくならないようにする。 */
const IMPLEMENT_HISTORY_MAX = 10;

/**
 * 直しの提出の、観点とテストの対応を、PR 全体の対応にする（PBI-299）。今回の申告に出てくる観点は、前の提出までのテストを先に、
 * 今回のテストを後に並べる（同じテストは1件）。テストを書かずに差分で確かめる観点（tests が空）は、今回の申告をそのまま使う
 * （テストを外して差分の確認に変えた、という申告を、前のテストで打ち消さない）。今回の申告に出てこない観点は、前の対応を残さない
 * （対応させていない観点として、これまでどおり検証で不合格になる）。
 */
function mergeTestMaps(previous: TestMapping[], next: TestMapping[]): TestMapping[] {
  return next.map((m) => {
    if (m.tests.length === 0) return m;
    const earlier = previous.find((p) => p.viewpointId === m.viewpointId)?.tests ?? [];
    return { ...m, tests: [...new Set([...earlier, ...m.tests])] };
  });
}

/** 検証の失敗の回数と一緒に、回をまたいで比べる失敗の記憶も消す（PBI-308）。 */
function resetVerifyFailures(task: Task) {
  task.verifyFailures = 0;
  task.failedTests = undefined;
  task.verifyStalled = undefined;
}

function failVerification(task: Task, feedback: NonNullable<Task["verifyFeedback"]>) {
  task.verification = undefined;
  task.verifyFailures += 1;
  task.verifyStalled = undefined;
  task.verifyFeedback = feedback;
  task.status = "queued";
}

/**
 * 成果物の本文を、工程の実行の外で差し替えた（変更の申し出の適用・人が PR の中で直してからのマージ）。前のセルフレビューは
 * 新しい本文を見ていないので、「記録なし」にする（PR #130 レビュー指摘）。出典の分類も同じ。それより前の記録（報告が無い）は
 * そのまま。
 */
function voidSubmissionChecks(task: Task, step: StepKey): void {
  // 差し替えた内容は、実装の工程の検証を通っていない（PBI-305）
  if (step === "implement") task.implementVerification = undefined;
  if (task.selfReviews?.[step] !== undefined) {
    task.selfReviews = { ...task.selfReviews, [step]: null };
  }
  // 出典の分類も、新しい本文の項目を分類していないので「記録なし」にする
  if (task.provenances?.[step] !== undefined) {
    task.provenances = { ...task.provenances, [step]: null };
  }
}

function findProposal(task: Task, event: ActivityEvent, id: string): TaskProposal {
  const proposal = task.proposals.find((p) => p.id === id);
  if (!proposal) throw new ActivityIntegrityError(event, `unknown proposal ${id}`);
  return proposal;
}

function updateProposal(task: Task, id: string, patch: Partial<TaskProposal>) {
  task.proposals = task.proposals.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

/**
 * 1件のイベントをタスクの状態に適用する。作業履歴を先頭から順に適用すれば、
 * いつでも同じ状態を復元できる（デーモンの再起動後も含む）。
 */
export function applyEvent(
  tasks: ReadonlyMap<string, Task>,
  event: ActivityEvent,
): Map<string, Task> {
  const next = new Map(tasks);
  const current = next.get(event.taskId);

  if (event.type === "TaskCreated") {
    if (current) throw new ActivityIntegrityError(event, "task is created twice");
    // 再実行（中止したタスクをやり直す）。元のタスクに、再実行で作ったタスクを記録する（再実行は1度だけ）。
    // 元のタスクが作業履歴に無ければ（取り込んだプロジェクトに含まれないなど）、記録だけを省く
    const rerunOf = event.payload.rerun && next.get(event.payload.rerun.taskId);
    if (rerunOf) {
      if (
        rerunOf.status !== "cancelled" ||
        rerunOf.rerunBy ||
        rerunOf.projectId !== event.projectId
      ) {
        throw new ActivityIntegrityError(event, "the rerun task is not a cancelled task to rerun");
      }
      next.set(rerunOf.id, { ...rerunOf, rerunBy: event.taskId });
    }
    // 派生（完了したタスクの続きの作業）。元のタスクに、派生で作ったタスクを記録する（いくつでも作れる）。
    // 派生で作ったタスクの再実行は、作ったときに元のタスクが完了していたので、いまの元のタスクの状態は問わない
    // （再レビューなどで完了でなくなっていても、つながりと記録を落とさない）。元のタスクが作業履歴に無ければ、記録だけを省く
    const derivedOf = event.payload.derivedFrom && next.get(event.payload.derivedFrom.taskId);
    if (derivedOf) {
      if (
        (!event.payload.rerun && !canDerive(derivedOf)) ||
        derivedOf.projectId !== event.projectId
      ) {
        throw new ActivityIntegrityError(event, "the derived task is not from a completed task");
      }
      next.set(derivedOf.id, {
        ...derivedOf,
        derivedTasks: [...(derivedOf.derivedTasks ?? []), event.taskId],
      });
    }
    next.set(event.taskId, {
      id: event.taskId,
      projectId: event.projectId,
      title: event.payload.title,
      body: event.payload.body,
      start: event.payload.start,
      ...(event.payload.source ? { source: event.payload.source } : {}),
      ...(event.payload.reviewRerequest
        ? {
            reviewRerequest: event.payload.reviewRerequest,
            previousReview: event.payload.reviewRerequest.previousReview,
            reviewRound: event.payload.reviewRerequest.previousReview.round + 1,
          }
        : {}),
      ...(event.payload.ticket ? { ticket: event.payload.ticket } : {}),
      ...(event.payload.repo ? { repo: event.payload.repo } : {}),
      ...(event.payload.noRepo ? { noRepo: true as const } : {}),
      ...(event.payload.repo && event.payload.repoReason
        ? { repoChoice: { reason: event.payload.repoReason, by: "orchestrator" as const } }
        : {}),
      ...(event.payload.parent ? { parent: event.payload.parent } : {}),
      ...(event.payload.reviewOf ? { reviewOf: event.payload.reviewOf } : {}),
      ...(event.payload.template ? { template: event.payload.template } : {}),
      ...(event.payload.plan ? { requestedPlan: event.payload.plan } : {}),
      ...(event.payload.image ? { requestedImage: event.payload.image } : {}),
      ...(event.payload.images ? { requestedImages: event.payload.images } : {}),
      ...(event.payload.agents
        ? { requestedAgents: event.payload.agents, agents: event.payload.agents }
        : {}),
      ...(event.payload.fix ? { fix: event.payload.fix } : {}),
      ...(event.payload.auditFix ? { auditFix: event.payload.auditFix } : {}),
      ...(event.payload.flakyFix ? { flakyFix: event.payload.flakyFix } : {}),
      ...(event.payload.securityFix ? { securityFix: event.payload.securityFix } : {}),
      ...(event.payload.rerun ? { rerun: event.payload.rerun } : {}),
      ...(event.payload.derivedFrom ? { derivedFrom: event.payload.derivedFrom } : {}),
      ...(event.payload.schedule ? { schedule: event.payload.schedule } : {}),
      // 依存先の子タスクがあれば、それが完了するまで待つ（PBI-27）
      status: event.payload.parent?.dependsOn.length ? "blocked" : "queued",
      steps: [],
      outputs: {},
      testViewpoints: [],
      approved: {},
      proposals: [],
      testMap: [],
      reviewComments: [],
      reproductionTests: [],
      verifyFailures: 0,
      integrationFailures: 0,
      misses: [],
      importedFeedback: [],
      questions: [],
      errorAnalyses: [],
      exports: {},
      stepPullRequests: [],
      stepBranches: [],
      submissions: {},
      remarks: [],
      budget: { usedUsd: 0, capUsd: event.payload.budgetCapUsd, warned: false, estimated: false },
      createdAt: event.at,
      updatedAt: event.at,
    });
    return next;
  }

  if (!current) throw new ActivityIntegrityError(event, "unknown task");
  // 写したエージェントのファイルの記録（PBI-66）は、中止の後にも受け付ける（中止で止めた実行の後に写すため）
  // オーケストレーターのセッションの記録（PBI-67）も同じ（中止で止めた実行の後に記録する）
  if (
    current.status === "cancelled" &&
    event.type !== "AgentSessionArchived" &&
    event.type !== "OrchestratorSessionUsed"
  ) {
    throw new ActivityIntegrityError(event, "the task is cancelled");
  }
  const task: Task = { ...current, updatedAt: event.at };

  switch (event.type) {
    case "StepsChosen":
      if (task.steps.length > 0)
        throw new ActivityIntegrityError(event, "steps are already chosen");
      {
        // マージの後の監視の工程は、スキルが無ければ飛ばす（PBI-116）
        const skipped = (key: StepKey) =>
          key === "deployment" &&
          event.payload.deployment !== undefined &&
          "skipped" in event.payload.deployment;
        const first = event.payload.steps.findIndex((key) => !skipped(key));
        task.steps = event.payload.steps.map((key, i) => ({
          key,
          state: skipped(key)
            ? ("skip" as const)
            : i === first
              ? ("active" as const)
              : ("todo" as const),
        }));
      }
      if (event.payload.deployment && event.payload.steps.includes("deployment")) {
        task.deploymentChoice = event.payload.deployment;
      }
      if (event.payload.testCommand) task.testCommand = event.payload.testCommand;
      if (event.payload.noTestsReason && !event.payload.testCommand) {
        task.noTestsReason = event.payload.noTestsReason;
      }
      if (event.payload.documentsOnly) task.documentsOnly = true;
      if (event.payload.steps.includes("operation")) task.operation = event.payload.operation;
      if (event.payload.investigation) task.investigation = event.payload.investigation;
      // タスクのイメージ（PBI-318）。作成時の人の指定は、デーモンが決めて image に入れている
      if (event.payload.image) task.image = event.payload.image;
      {
        // 古い版の作業履歴：人が作成時に工程ごとに指定したイメージは、選んだ工程の分だけ、プロジェクトの対象の指定・
        // オーケストレーターの選択より優先する
        const requested = Object.entries(task.requestedImages ?? {}).filter(([step]) =>
          event.payload.steps.includes(step as StepKey),
        );
        if (event.payload.images || requested.length > 0) {
          task.images = { ...event.payload.images, ...Object.fromEntries(requested) };
        }
      }
      if ((event.payload.image || event.payload.images) && event.payload.imageSource) {
        task.imageSource = event.payload.imageSource;
      }
      if (event.payload.defaultImageReason) {
        task.defaultImageReason = event.payload.defaultImageReason;
      }
      if (event.payload.imageUnexplained) task.imageUnexplained = true;
      if (event.payload.defaultImageReasons) {
        task.defaultImageReasons = event.payload.defaultImageReasons;
      }
      if (event.payload.imagesUnexplained) task.imagesUnexplained = event.payload.imagesUnexplained;
      if (event.payload.services) task.services = event.payload.services;
      if (event.payload.servicesReason) task.servicesReason = event.payload.servicesReason;
      if (event.payload.exports) task.exportPlans = event.payload.exports;
      if (event.payload.documentsDir) task.documentsDir = event.payload.documentsDir;
      if (event.payload.continuedPullRequest) {
        task.continuedPullRequest = event.payload.continuedPullRequest;
      }
      // 工程の組み合わせの予算（budget.per_plan_usd）。上限が変わるので、80% の通知をし直す
      if (event.payload.budgetCapUsd !== undefined) {
        task.budget = { ...task.budget, capUsd: event.payload.budgetCapUsd, warned: false };
      }
      if (event.payload.reason !== undefined) {
        task.stepsChoice = {
          ...(event.payload.plan ? { plan: event.payload.plan } : {}),
          reason: event.payload.reason,
          fallback: event.payload.fallback,
        };
      }
      break;

    case "AgentRunStarted":
      if (task.status !== "queued")
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      if (event.payload.step === "operation") {
        if (task.operationAttempted)
          throw new ActivityIntegrityError(event, "operation was already attempted");
        if (!task.operation)
          throw new ActivityIntegrityError(event, "operation settings are missing");
        task.operationAttempted = true;
      }
      task.status = "running";
      task.currentRunId = event.payload.runId;
      // 見直さずに工程を始めた（工程の見直しより前の作業履歴）なら、見直しは待たない
      task.stepReview = undefined;
      break;

    case "AgentRunCompleted":
    case "AgentRunFailed": {
      if (task.currentRunId !== event.payload.runId) {
        throw new ActivityIntegrityError(event, "run id does not match the running run");
      }
      // 失敗した実行は、再開したときにやり直すので実行待ちに戻す
      task.status = event.type === "AgentRunCompleted" ? "idle" : "queued";
      task.currentRunId = undefined;
      if (event.type === "AgentRunCompleted") {
        // 承認済みの成果物は凍結されている。変えるには、人間が差し戻して承認を取り消す必要がある
        if (task.approved[event.payload.step]) {
          throw new ActivityIntegrityError(event, "the step is already approved (frozen)");
        }
        if (event.payload.step === "design") task.testViewpoints = event.payload.testViewpoints;
        if (event.payload.step === "review") {
          task.reviewComments = event.payload.reviewComments;
          // 回ごとの判定（PBI-88・PBI-111）。同じ回をやり直したら置き換える
          const round = task.reviewRound ?? 1;
          task.reviewVerdicts = [
            ...(task.reviewVerdicts ?? []).filter((v) => v.round !== round),
            {
              round,
              ...(event.payload.reviewVerdict ? { verdict: event.payload.reviewVerdict } : {}),
              // 戻し先を示した回は、その実行のエージェントも残す（戻し先の判断の記録に使う。PBI-332）
              ...(event.payload.reviewRework
                ? { rework: event.payload.reviewRework, agentId: event.payload.agentId }
                : {}),
            },
          ];
        }
        // 前の回までのページに足す（今回に直さなかったページも成果物のまま。差し戻しでも同じページを直させる）
        if (event.payload.step === "document" && event.payload.documentPages.length > 0) {
          task.documentPages = [
            ...new Set([...(task.documentPages ?? []), ...event.payload.documentPages]),
          ];
        }
        if (event.payload.step === "reproduce") {
          task.reproductionTests = event.payload.reproductionTests;
          task.reproductionPending = true;
        }
        if (event.payload.step === "implement") {
          task.implementVerification = event.payload.verificationRecord;
          // 直しの提出は、PR 全体の対応にする：前の提出までに対応させたテストを、今回の申告に出てくる観点に残す（PBI-299）
          task.testMap = mergeTestMaps(
            (task.implementHistory?.length ?? 0) > 0 ? task.testMap : [],
            event.payload.testMap,
          );
          const previousOutput = task.implementHistory?.at(-1);
          task.implementBase =
            previousOutput === undefined
              ? undefined
              : advanceImplementBase(task.implementBase, previousOutput);
          task.implementHistory = [...(task.implementHistory ?? []), event.payload.output].slice(
            -IMPLEMENT_HISTORY_MAX,
          );
          task.addedTestCommand = event.payload.testCommand;
          task.verification = "pending";
          // やり直した実装は、PR を更新して CI を待ち直す
          task.pullRequestCi = undefined;
          // 前の回のテストの結果を、今回の検証の結果に見せない（今の版は、テストを最終レビューの中で実行する）
          task.lastTests = undefined;
          task.testsSkippedAt = undefined;
        }
        task.outputs = { ...task.outputs, [event.payload.step]: event.payload.output };
        // 提出の前のセルフレビュー（PBI-120）。報告をさせない工程・それより前の記録では、前の報告を残さない
        if (event.payload.selfReview !== undefined) {
          task.selfReviews = {
            ...task.selfReviews,
            [event.payload.step]: event.payload.selfReview,
          };
        } else if (task.selfReviews?.[event.payload.step] !== undefined) {
          const { [event.payload.step]: _dropped, ...rest } = task.selfReviews;
          task.selfReviews = rest;
        }
        // 出典の分類も同じ。分類させない工程・それより前の記録では、前の分類を残さない
        if (event.payload.provenance !== undefined) {
          task.provenances = {
            ...task.provenances,
            [event.payload.step]: event.payload.provenance,
          };
        } else if (task.provenances?.[event.payload.step] !== undefined) {
          const { [event.payload.step]: _dropped, ...rest } = task.provenances;
          task.provenances = rest;
        }
        // その工程の有効な指摘は、今回の提出で回答がなければ未回答に戻す
        // （前回の対応文が残ると、最新の成果物への対応だと誤認して承認してしまうため）
        const step = event.payload.step;
        const submission = (task.submissions[step] ?? 0) + 1;
        const responses = new Map(event.payload.responses.map((r) => [r.remarkId, r]));
        task.remarks = task.remarks.map((r) => {
          if (r.step !== step || r.voided) return r;
          const response = responses.get(r.id);
          return response === undefined
            ? {
                ...r,
                response: undefined,
                respondedIn: undefined,
                confirm: undefined,
                submittedIn: submission,
              }
            : {
                ...r,
                response: response.text,
                respondedIn: submission,
                confirm: response.confirm,
                submittedIn: submission,
              };
        });
      }
      break;
    }

    case "StepSubmitted":
      if (task.status !== "idle") throw new ActivityIntegrityError(event, `status ${task.status}`);
      task.status = "awaiting_approval";
      task.gate = { step: event.payload.step, submission: event.payload.submission };
      task.submissions = { ...task.submissions, [event.payload.step]: event.payload.submission };
      break;

    case "StepApproved": {
      if (task.status !== "awaiting_approval" && task.status !== "escalated") {
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      }
      if (task.gate?.step !== event.payload.step) {
        throw new ActivityIntegrityError(event, "approved step is not at the gate");
      }
      advance(
        task,
        task.steps.findIndex((s) => s.key === event.payload.step),
      );
      // 実装の PR をマージせずに実装を承認した（変更が無く PR を作らなかった。PBI-90）なら、見るマージが無いので、
      // マージの後の監視の工程を飛ばす（PBI-116）
      if (
        event.payload.step === "implement" &&
        task.pullRequestState !== "merged" &&
        activeStep(task) === "deployment"
      ) {
        task.steps = task.steps.map((s) =>
          s.key === "deployment" ? { ...s, state: "skip" as const } : s,
        );
      }
      const step = event.payload.step;
      const submitted = task.outputs[step] ?? "";
      // 人が PR の中で直してからマージした（PBI-63）。要求要件・設計は、人が直したファイルの内容を承認済みの成果にする
      // （後の工程は、人が直した版を読む。差し戻されたときも、人が直した版から作り直す）
      const merge = gateMerge(task);
      const final = merge?.document?.final;
      const output = final !== undefined ? documentOutput(final) : submitted;
      if (final !== undefined) {
        task.outputs = { ...task.outputs, [step]: output };
        voidSubmissionChecks(task, step);
      }
      task.approved = {
        ...task.approved,
        [step]: {
          submission: task.gate.submission,
          output,
          testViewpoints: step === "design" ? task.testViewpoints : [],
          at: event.at,
          ...(merge?.edited
            ? {
                edited: {
                  ...(final !== undefined ? { sacty: submitted } : {}),
                  ...(merge.document?.fallback ? { fallback: merge.document.fallback } : {}),
                },
              }
            : {}),
        },
      };
      task.status = event.payload.next;
      task.pendingReview = undefined;
      task.gate = undefined;
      task.escalation = undefined;
      // 上流の工程を承認し直したら、前の実装の説明・テストの対応は引き継がない（PBI-299）
      if (step !== "implement") {
        task.implementHistory = undefined;
        task.implementBase = undefined;
      }
      break;
    }

    case "StepCompleted": {
      if (task.status !== "idle" || activeStep(task) !== event.payload.step) {
        throw new ActivityIntegrityError(event, "the completed step is not the active step");
      }
      advance(
        task,
        task.steps.findIndex((s) => s.key === event.payload.step),
      );
      const submission = (task.submissions[event.payload.step] ?? 0) + 1;
      task.submissions = { ...task.submissions, [event.payload.step]: submission };
      task.approved = {
        ...task.approved,
        [event.payload.step]: {
          submission,
          output: task.outputs[event.payload.step] ?? "",
          testViewpoints: [],
          at: event.at,
        },
      };
      task.status = event.payload.next;
      if (event.payload.step !== "implement") {
        task.implementHistory = undefined;
        task.implementBase = undefined;
      }
      break;
    }

    // 工程の見直しで、オーケストレーターが要らない工程を飛ばした（工程の見直し）。飛ばした工程が実行対象なら、その次の
    // まだの工程を実行対象にする
    case "StepsSkipped": {
      if (task.stepReview !== event.payload.after) {
        throw new ActivityIntegrityError(event, "the step is not waiting for a review");
      }
      const skippable = skippableSteps(task);
      const skipped = event.payload.steps;
      if (skipped.some((step) => !skippable.includes(step))) {
        throw new ActivityIntegrityError(event, "the step cannot be skipped");
      }
      task.steps = task.steps.map((s) =>
        skipped.includes(s.key) ? { ...s, state: "skip" as const } : s,
      );
      if (!task.steps.some((s) => s.state === "active")) {
        const next = task.steps.findIndex((s) => s.state === "todo");
        task.steps = task.steps.map((s, i) =>
          i === next ? { ...s, state: "active" as const } : s,
        );
      }
      task.stepReview = undefined;
      break;
    }

    case "StepQueued":
      if (task.status !== "idle") throw new ActivityIntegrityError(event, `status ${task.status}`);
      if (activeStep(task) !== event.payload.step) {
        throw new ActivityIntegrityError(event, "queued step is not the active step");
      }
      task.status = "queued";
      break;

    case "ChangesRequested": {
      // 一時停止の間に届いた指摘（PBI-279）を、再開のあと、止まった工程を走り直す前に反映する差し戻し。承認ゲートは無く、
      // ゴールガーディアンが戻し先を判断し終えた指摘（pendingReview）を、実装の作り直しに渡す
      const fromHeld =
        (task.status === "queued" || task.status === "idle") &&
        event.payload.step === "implement" &&
        task.pendingReview?.judgement !== undefined &&
        reworkingPullRequest(task) !== undefined;
      if (!fromHeld && task.status !== "awaiting_approval" && task.status !== "escalated") {
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      }
      const target = event.payload.target ?? event.payload.step;
      if (target !== event.payload.step) {
        const at = task.steps.findIndex((s) => s.key === event.payload.step);
        const to = task.steps.findIndex((s) => s.key === target);
        if (to < 0 || to >= at) {
          throw new ActivityIntegrityError(event, "target must be a step before the gate");
        }
        reopen(task, target);
      }
      task.remarks = [
        ...task.remarks,
        ...event.payload.remarks.map((r) => ({
          id: r.id,
          step: target,
          round: event.payload.round,
          text: r.text,
          ...(r.source ? { source: r.source } : {}),
          voided: false,
        })),
      ];
      task.status = "queued";
      task.gate = undefined;
      task.escalation = undefined;
      // 止まった工程の途中経過（検証・PR の更新の待ち）は、作り直しに持ち越さない
      if (fromHeld) {
        task.stepReview = undefined;
        task.verification = undefined;
        task.verifyFeedback = undefined;
        resetVerifyFailures(task);
        task.unreadableReviews = undefined;
        task.publishPending = undefined;
        task.pullRequestCi = undefined;
      }
      // 統合レビューの承認待ちで差し戻したら、修正の子タスクを追加して、統合レビューの回数を数え直す（PBI-31）
      if (event.payload.step === "integrate") task.integrationFailures = 0;
      // PR の指摘は、この差し戻しに反映した。ゴールガーディアンの判断で戻したなら、戻し先と理由を残す（PBI-58）。
      // 判断の後に人間が別の差し戻しをした（再起動の前など）なら、ゴールガーディアンの判断としては残さない
      const judged = task.pendingReview?.judgement;
      // 判断できなければ、その工程をやり直す（実装の PR なら実装、要求要件・設計の PR ならその工程。PBI-57・PBI-110）
      const undecided = event.payload.step;
      if (
        judged &&
        target === (judged.target ?? undecided) &&
        JSON.stringify(event.payload.remarks.map((r) => r.text)) ===
          JSON.stringify(task.pendingReview?.remarks)
      ) {
        task.prRework = {
          target,
          decided: judged.target !== undefined,
          ...(event.payload.cause ? { cause: event.payload.cause } : {}),
          ...(event.payload.answer ? { answer: event.payload.answer } : {}),
          reason: judged.reason,
          at: event.at,
          round: event.payload.round,
          remarkIds: event.payload.remarks.map((r) => r.id),
        };
      }
      task.pendingReview = undefined;
      break;
    }

    case "RemarkVoided":
      if (!task.remarks.some((r) => r.id === event.payload.remarkId)) {
        throw new ActivityIntegrityError(event, "unknown remark");
      }
      task.remarks = task.remarks.map((r) =>
        r.id === event.payload.remarkId ? { ...r, voided: true } : r,
      );
      break;

    case "ChangeProposed":
      if (task.status !== "idle") throw new ActivityIntegrityError(event, `status ${task.status}`);
      if (task.proposals.some((p) => p.id === event.payload.proposalId)) {
        throw new ActivityIntegrityError(event, "proposal id is used twice");
      }
      if (!task.approved[event.payload.target]) {
        throw new ActivityIntegrityError(event, "only approved steps can be changed");
      }
      {
        const { proposalId, ...rest } = event.payload;
        task.proposals = [
          ...task.proposals,
          { ...rest, id: proposalId, proposedAt: event.at, applied: false },
        ];
      }
      break;

    case "ChangeJudged": {
      const proposal = findProposal(task, event, event.payload.proposalId);
      if (proposal.judgement) throw new ActivityIntegrityError(event, "already judged");
      updateProposal(task, proposal.id, {
        judgement: { verdict: event.payload.verdict, reason: event.payload.reason, at: event.at },
      });
      break;
    }

    case "ChangeDecided": {
      const proposal = findProposal(task, event, event.payload.proposalId);
      // 人の判断待ちの申し出：判定の無いもの（PBI-333）か、以前の版で AI が判定できなかったもの
      if (
        task.status !== "escalated" ||
        (proposal.judgement !== undefined && proposal.judgement.verdict !== "undecidable")
      ) {
        throw new ActivityIntegrityError(event, "the proposal is not waiting for a person");
      }
      if (proposal.decision) throw new ActivityIntegrityError(event, "already decided");
      updateProposal(task, proposal.id, {
        decision: { accept: event.payload.accept, at: event.at },
      });
      task.status = "idle";
      break;
    }

    case "ChangeApplied": {
      const proposal = findProposal(task, event, event.payload.proposalId);
      if (proposalAccepted(proposal) !== true || proposal.applied) {
        throw new ActivityIntegrityError(event, "the proposal is not accepted or already applied");
      }
      const approved = task.approved[proposal.target];
      if (!approved) throw new ActivityIntegrityError(event, "the target is no longer approved");
      if (proposal.target === "requirements") {
        // 要求要件の変更は、承認を取り消して人間の再承認に回す
        reopen(task, proposal.target);
      } else {
        task.approved = {
          ...task.approved,
          [proposal.target]: {
            ...approved,
            output: proposal.proposed,
            testViewpoints: proposal.testViewpoints ?? approved.testViewpoints,
            at: event.at,
          },
        };
      }
      task.outputs = { ...task.outputs, [proposal.target]: proposal.proposed };
      voidSubmissionChecks(task, proposal.target);
      // 承認済みの上流の成果物が変わったら、前の実装の説明・テストの対応は引き継がない（PBI-299）
      task.implementHistory = undefined;
      task.implementBase = undefined;
      if (proposal.target === "design" && proposal.testViewpoints) {
        task.testViewpoints = proposal.testViewpoints;
      }
      updateProposal(task, proposal.id, { applied: true });
      break;
    }

    case "RepositoryPrepared":
      task.repository = event.payload;
      // ベースブランチを選び直して用意し直した作業領域は、新しい起点のコードのまま（取り込みは無い）
      task.baseMerge = undefined;
      break;

    case "BaseBranchMerged":
      if (!task.repository) {
        throw new ActivityIntegrityError(event, "the repository is not prepared");
      }
      task.baseMerge = { ...event.payload, at: event.at };
      // 取り込みで作業領域の内容が変わったので、実装の工程が実行した検証の結果は、今の内容のものではない（PBI-305）
      task.implementVerification = undefined;
      // 検証の待ちで取り込んだなら、前の CI の結果は取り込む前のコードのものなので、PR を作り直して CI を待ち直す
      if (task.verification !== undefined) task.pullRequestCi = undefined;
      break;

    case "BaseConflictsRemained":
      // 提出の前の検証の待ちで、競合の目印が残っていたので、検証に進まず実装をやり直す
      if (task.status !== "idle" || task.verification === undefined) {
        throw new ActivityIntegrityError(
          event,
          "the implementation is not waiting for verification",
        );
      }
      if (event.payload.fresh) {
        // 取り込みで新しく競合した（エージェントの誤りではない）ので、検証に通らなかった回数には数えない
        task.verification = undefined;
        task.verifyFeedback = { kind: "merge", files: event.payload.files };
        task.status = "queued";
      } else {
        failVerification(task, { kind: "merge", files: event.payload.files });
      }
      break;

    case "TestsRun": {
      if (task.status !== "idle" || task.verification !== "pending") {
        throw new ActivityIntegrityError(event, "tests are not pending");
      }
      const tests = { ...event.payload, at: event.at };
      task.lastTests = tests;
      task.testsSkippedAt = undefined;
      if (event.payload.passed) {
        task.verification = "tests_passed";
      } else {
        failVerification(task, { kind: "tests", tests });
      }
      break;
    }

    case "TestsSkipped":
      // テストの仕組みが無いタスクだけが、テストを飛ばせる（PBI-94）
      if (task.status !== "idle" || task.verification !== "pending" || !task.noTestsReason) {
        throw new ActivityIntegrityError(event, "tests cannot be skipped");
      }
      // 前の回のテストの結果（実装が用意したテスト）を、今回の結果に見せない
      task.lastTests = undefined;
      task.testsSkippedAt = event.at;
      task.verification = "tests_passed";
      break;

    case "FinalReviewed": {
      if (task.status !== "idle" || task.verification === undefined) {
        throw new ActivityIntegrityError(event, "final review is not pending");
      }
      const review = { ...event.payload, at: event.at };
      task.lastReview = review;
      task.unreadableReviews = undefined;
      // lastReview は回ごとに置き換わるので、認めた不安定な失敗は全部の回の分を残す（台帳に使う。PBI-312）。
      // テストのコマンドが無いタスクで CI の結果から認めた分（ciFlakyFailures）も入れる
      const sightings = reviewFlakyFailures(event.payload).map((f) => ({
        name: f.name,
        file: f.file,
        reason: f.reason,
        at: event.at,
      }));
      if (sightings.length > 0) {
        task.flakySightings = [...(task.flakySightings ?? []), ...sightings];
      }
      // テストが通っていれば、不合格の理由は別にあるので、失敗の記憶に入れない（PBI-308）
      const tests = event.payload.tests;
      const failedTests = tests && !guardianTestsPassed(tests) ? tests.failedTests : undefined;
      if (!event.payload.passed) {
        const previous = task.failedTests;
        const stalled = testsMadeNoProgress(previous, failedTests);
        failVerification(task, { kind: "review", review });
        task.failedTests = failedTests?.length ? failedTests : undefined;
        task.verifyStalled = stalled ? previous : undefined;
        // CI を待たずに不合格にした（PBI-314）。待っている CI は、やり直した実装で新しい PR のコミットになるので捨てる
        if (awaitingPullRequestCi(task)) task.pullRequestCi = undefined;
        break;
      }
      const before = event.payload.beforeCi;
      if (before) {
        // CI の結果を待たずに合格した（PBI-314）。CI が通っていれば（無ければ）確定し、まだなら待つ。落ちた・時間内に終わら
        // なかったなら、CI の結果を見て最終レビューし直す。待っていた CI でなければ（取り込みで PR を作り直したなど）、
        // 確定せずに最終レビューし直す
        const ci = task.pullRequestCi;
        if (ci?.commit === before.commit && ciConfirmsReview(ci)) {
          passVerification(task);
        } else if (ci?.commit === before.commit) {
          task.pullRequestCi = { ...ci, reviewedBeforeResult: true };
        }
        break;
      }
      passVerification(task);
      break;
    }

    case "ContextResolved":
      task.context = { ...event.payload, at: event.at };
      break;

    case "TaskCancelled":
      if (task.status === "running") {
        throw new ActivityIntegrityError(event, "stop the run before cancelling");
      }
      task.status = "cancelled";
      task.cancelled = { at: event.at, ...event.payload };
      task.gate = undefined;
      task.escalation = undefined;
      task.verification = undefined;
      task.publishPending = undefined;
      task.pullRequestCi = undefined;
      task.pausedReason = undefined;
      task.pausedMessage = undefined;
      task.unstoppedRuns = undefined;
      task.resumeTo = undefined;
      task.pausedCancelledChildren = undefined;
      break;

    case "PullRequestPublished":
      // 最終レビューの前に、実装の PR を作った（更新した）。CI を待たずに、並べて最終レビューに進む（承認待ちにはしない。PBI-314）
      if (event.payload.verifying) {
        if (
          task.status !== "idle" ||
          activeStep(task) !== "implement" ||
          task.verification === undefined ||
          task.publishPending ||
          task.pullRequestCi
        ) {
          throw new ActivityIntegrityError(
            event,
            "the implementation is not waiting for a pull request before the final review",
          );
        }
        task.pullRequest = event.payload;
        task.pullRequestState = event.payload.number ? "open" : undefined;
        task.pullRequestMerge = undefined;
        task.pullRequestConflict = undefined;
        task.pullRequestCi = {
          commit: event.payload.commit,
          startedAt: event.at,
          ...restoredCiRerun(task, event.payload.commit),
        };
        break;
      }
      // 実装の工程の中で、検証に通った実装の PR を作った（PBI-110）
      if (task.status !== "queued" || activeStep(task) !== "implement" || !task.publishPending) {
        throw new ActivityIntegrityError(
          event,
          "the implementation is not waiting for a pull request",
        );
      }
      task.publishPending = undefined;
      task.pullRequest = event.payload;
      // 作り直した・更新した PR は、開いているものとして見守り直す
      task.pullRequestState = event.payload.number ? "open" : undefined;
      task.pullRequestMerge = undefined;
      task.pullRequestConflict = undefined;
      task.status = "idle";
      break;

    case "PullRequestRetargeted": {
      // 重ねた子タスクの承認待ちの PR の向き先を、GitHub で付け替えた（PBI-317）
      const pr = task.pullRequest;
      if (!pr || pr.number !== event.payload.number) {
        throw new ActivityIntegrityError(event, "not the pull request of the task");
      }
      const { draft: _draft, ...rest } = pr;
      task.pullRequest = {
        ...(event.payload.ready ? rest : pr),
        baseBranch: event.payload.baseBranch,
      };
      break;
    }

    case "PullRequestCiFinished": {
      const ci = task.pullRequestCi;
      if (!ci || ci.result !== undefined || task.verification === undefined) {
        throw new ActivityIntegrityError(event, "the pull request CI is not awaited");
      }
      if (ci.commit !== event.payload.commit) {
        throw new ActivityIntegrityError(event, "not the commit of the pull request");
      }
      task.pullRequestCi = { ...ci, ...event.payload, finishedAt: event.at };
      if (event.payload.rerunSkipped) {
        task.pullRequestCiReruns = task.pullRequestCiReruns?.map((r) =>
          r.commit === ci.commit ? { ...r, skipped: true } : r,
        );
      }
      // 最終レビューは、CI の結果を待たずに合格している（PBI-314）。CI が通った（無い）なら確定する。落ちた・時間内に
      // 終わらなかったなら、検証を待つままにし、CI の結果を見て最終レビューし直す
      if (ci.reviewedBeforeResult && ciConfirmsReview(task.pullRequestCi)) passVerification(task);
      break;
    }

    case "PullRequestCiRerunRequested": {
      const ci = task.pullRequestCi;
      if (!ci || ci.result !== undefined || task.verification === undefined) {
        throw new ActivityIntegrityError(event, "the pull request CI is not awaited");
      }
      const { commit, ...rerun } = event.payload;
      if (ci.commit !== commit) {
        throw new ActivityIntegrityError(event, "not the commit of the pull request");
      }
      if (task.pullRequestCiReruns?.some((r) => r.commit === commit)) {
        throw new ActivityIntegrityError(event, "the commit was already rerun");
      }
      task.pullRequestCi = { ...ci, rerun: { ...rerun, at: event.at } };
      task.pullRequestCiReruns = [
        ...(task.pullRequestCiReruns ?? []),
        { commit, ...rerun, at: event.at },
      ];
      break;
    }

    case "FinalReviewSkipped":
      // 最終レビューと CI の待ちをせずに、PR の作成へ進める（PBI-331）
      if (
        task.status !== "idle" ||
        activeStep(task) !== "implement" ||
        task.verification === undefined
      ) {
        throw new ActivityIntegrityError(event, "final review is not pending");
      }
      passVerification(task);
      task.pullRequestCi = undefined;
      task.securityScopeCheck = event.payload.securityScope;
      break;

    case "PullRequestMarkedReady": {
      const pr = task.pullRequest;
      // 指摘なしで外した後に人がコミットを足してドラフトにし、その先頭を指摘なしにして外したときは、記録し直す（PBI-331）
      if (
        !pr ||
        pr.number !== event.payload.number ||
        (!pr.awaitingReview && pr.reviewedCommit === undefined)
      ) {
        throw new ActivityIntegrityError(event, "the pull request is not waiting for the review");
      }
      const { draft: _draft, awaitingReview: _awaiting, ...rest } = pr;
      task.pullRequest = { ...rest, reviewedCommit: event.payload.commit };
      break;
    }

    case "VerificationOverridden":
      // 検証が続けて通らずに止まった実装を、人がゴールガーディアンの不合格のまま実装の承認へ進めた。sacty が PR のドラフトを
      // 外して承認待ちにする（検証に通ったときと同じく、PR の作成の待ちにする）
      if (!canOverrideVerification(task) || task.unstoppedRuns?.length) {
        throw new ActivityIntegrityError(event, "the verification cannot be overridden");
      }
      task.verification = undefined;
      resetVerifyFailures(task);
      task.verifyFeedback = undefined;
      task.publishPending = true;
      task.verificationOverride = {
        at: event.at,
        submission: (task.submissions.implement ?? 0) + 1,
      };
      task.status = "queued";
      task.pausedReason = undefined;
      task.pausedMessage = undefined;
      task.resumeTo = undefined;
      break;

    case "ContinuedFeedbackPassed":
      if (task.currentRunId !== event.payload.runId) {
        throw new ActivityIntegrityError(event, "run id does not match the running run");
      }
      task.handedOverFeedback = [
        ...new Set([...(task.handedOverFeedback ?? []), ...event.payload.keys]),
      ];
      break;

    case "NoChangesFound":
      // 実装に変更が無く、PR を作らなかった（PBI-90）。実装の承認で人間が確かめる（PBI-110）
      if (task.status !== "queued" || activeStep(task) !== "implement" || !task.publishPending) {
        throw new ActivityIntegrityError(
          event,
          "the implementation is not waiting for a pull request",
        );
      }
      if (task.pullRequest) {
        throw new ActivityIntegrityError(event, "a pull request is already published");
      }
      task.publishPending = undefined;
      task.noChanges = { submission: event.payload.submission };
      task.status = "idle";
      break;

    case "ReviewTaskCreated": {
      // sacty がこのタスクのために作った PR だけ。同じ子タスクは1回（PR を開き直したときは、新しい子タスクを足す。PBI-330）
      const p = event.payload;
      const same = (repo: string | undefined, number: number | undefined) =>
        number === p.number && (repo ?? "").toLowerCase() === p.repo.toLowerCase();
      const made =
        p.step === "implement"
          ? same(task.pullRequest?.repo, task.pullRequest?.number) ||
            same(task.continuedPullRequest?.repo, task.continuedPullRequest?.number)
          : task.stepPullRequests.some((x) => x.step === p.step && same(x.repo, x.number));
      if (!made) {
        throw new ActivityIntegrityError(event, "not a pull request sacty created for the task");
      }
      if ((task.reviewTasks ?? []).some((x) => x.taskId === p.taskId)) {
        throw new ActivityIntegrityError(event, "the review task is already recorded");
      }
      task.reviewTasks = [...(task.reviewTasks ?? []), p];
      break;
    }

    case "PullRequestLabeled":
    case "PullRequestLabelFailed": {
      // sacty が作った PR（実装の PR と、要求要件・設計の PR）だけ（PBI-88）
      const p = event.payload;
      const same = (repo: string | undefined, number: number | undefined) =>
        number === p.number && (repo ?? "").toLowerCase() === p.repo.toLowerCase();
      if (
        !same(task.pullRequest?.repo, task.pullRequest?.number) &&
        !task.stepPullRequests.some((x) => same(x.repo, x.number))
      ) {
        throw new ActivityIntegrityError(event, "not a pull request sacty created for the task");
      }
      if ((task.pullRequestLabels ?? []).some((x) => same(x.repo, x.number))) {
        throw new ActivityIntegrityError(event, "the pull request is already labeled");
      }
      task.pullRequestLabels = [
        ...(task.pullRequestLabels ?? []),
        event.type === "PullRequestLabeled"
          ? {
              repo: p.repo,
              number: p.number,
              label: p.label,
              ...(event.payload.created ? { created: true } : {}),
            }
          : { repo: p.repo, number: p.number, label: p.label, failed: event.payload.message },
      ];
      break;
    }

    case "PullRequestReviewImported": {
      // 一時停止の間（と、再開した直後の、止まった工程を走り直す前）に届いた指摘は、未反映として残す（PBI-279）。
      // 差し戻しにはしない。何回かに分けて届いた指摘は続けて足す
      if (event.payload.held) {
        const reworking = reworkingPullRequest(task);
        if (!reworking || task.status === "running") {
          throw new ActivityIntegrityError(
            event,
            "the implementation is not waiting to be reworked",
          );
        }
        if (reworking.number !== event.payload.number) {
          throw new ActivityIntegrityError(event, "not the pull request of the task");
        }
        if (task.pendingReview?.judgement) {
          throw new ActivityIntegrityError(event, "the pending review is already judged");
        }
        const heldKeys = event.payload.items.map((i) => i.key);
        if (heldKeys.some((key) => task.importedFeedback.includes(key))) {
          throw new ActivityIntegrityError(event, "the feedback is already imported");
        }
        task.importedFeedback = [...task.importedFeedback, ...heldKeys];
        const before = task.pendingReview?.remarks.length ?? 0;
        const heldAi = [
          ...(task.pendingReview?.aiReview ?? []),
          ...event.payload.items.flatMap((item, i) =>
            item.source === "sacty_review" ? [before + i] : [],
          ),
        ];
        const heldFrom = {
          ...(task.pendingReview?.aiReviewFrom ?? {}),
          ...reviewFromOf(event.payload.items, before),
        };
        task.pendingReview = {
          keys: [...(task.pendingReview?.keys ?? []), ...heldKeys],
          remarks: [...(task.pendingReview?.remarks ?? []), ...event.payload.remarks],
          ...(heldAi.length > 0 ? { aiReview: heldAi } : {}),
          ...(Object.keys(heldFrom).length > 0 ? { aiReviewFrom: heldFrom } : {}),
        };
        break;
      }
      // 実装の PR と、要求要件・設計の PR（PBI-57）の指摘
      const watched = gatePullRequest(task);
      if (!watched || task.status !== "awaiting_approval") {
        throw new ActivityIntegrityError(event, "the deliverable review is not open");
      }
      if (watched.number !== event.payload.number) {
        throw new ActivityIntegrityError(event, "not the pull request of the task");
      }
      if (task.pendingReview) throw new ActivityIntegrityError(event, "a review is pending");
      const keys = event.payload.items.map((i) => i.key);
      if (keys.some((key) => task.importedFeedback.includes(key))) {
        throw new ActivityIntegrityError(event, "the feedback is already imported");
      }
      task.importedFeedback = [...task.importedFeedback, ...keys];
      const aiReview = event.payload.items.flatMap((item, i) =>
        item.source === "sacty_review" ? [i] : [],
      );
      const aiReviewFrom = reviewFromOf(event.payload.items, 0);
      task.pendingReview = {
        keys,
        remarks: event.payload.remarks,
        ...(aiReview.length > 0 ? { aiReview } : {}),
        ...(Object.keys(aiReviewFrom).length > 0 ? { aiReviewFrom } : {}),
      };
      break;
    }

    // 古い head へのレビューを捨てた。取り込み済みにして、取り込み直さない（指摘にも差し戻しにもならない）
    case "PullRequestReviewDiscarded": {
      // 承認待ちの PR のほか、一時停止の間に指摘を残している実装の PR（PBI-279）も対象
      const watched = gatePullRequest(task) ?? reworkingPullRequest(task);
      if (!watched || watched.number !== event.payload.number) {
        throw new ActivityIntegrityError(event, "not the pull request of the task");
      }
      const keys = event.payload.items.map((i) => i.key);
      if (keys.some((key) => task.importedFeedback.includes(key))) {
        throw new ActivityIntegrityError(event, "the feedback is already imported");
      }
      task.importedFeedback = [...task.importedFeedback, ...keys];
      task.discardedReviews = [
        ...(task.discardedReviews ?? []),
        {
          number: event.payload.number,
          head: event.payload.head,
          at: event.at,
          items: event.payload.items,
        },
      ];
      break;
    }

    case "ReworkJudged": {
      // 判断を採用しなかった（一時停止を求められて実行を止めた・中止された・指摘や状態が変わった）。費用だけを残し
      // （費用は下で足す）、指摘は未判断のまま保つ（PBI-279）
      if (event.payload.runResult === "interrupted") break;
      if (!task.pendingReview || task.pendingReview.judgement) {
        throw new ActivityIntegrityError(event, "no review is waiting for a judgement");
      }
      task.pendingReview = {
        ...task.pendingReview,
        judgement: {
          ...(event.payload.target ? { target: event.payload.target } : {}),
          ...(event.payload.cause ? { cause: event.payload.cause } : {}),
          ...(event.payload.answer ? { answer: event.payload.answer } : {}),
          reason: event.payload.reason,
        },
      };
      break;
    }

    case "ReviewTargetResolved":
      if (activeStep(task) !== "review") {
        throw new ActivityIntegrityError(event, "the review step is not active");
      }
      if (task.reviewTarget) throw new ActivityIntegrityError(event, "already resolved");
      task.reviewTarget = event.payload;
      break;

    case "ReviewGitHubRetried":
      // 記録だけ（GitHub の一時的な失敗で、間を置いてやり直した。PBI-301）
      break;

    case "PullRequestReviewPosted": {
      // 書いたレビューを投稿すると、レビューの工程（人間の承認は無い）が終わり、タスクは完了する。
      // 行へのコメントだけのレビューもあるので、本文が空でも書き終えたものとして扱う
      if (
        activeStep(task) !== "review" ||
        task.status !== "idle" ||
        task.outputs.review === undefined
      ) {
        throw new ActivityIntegrityError(event, "no review is waiting to be posted");
      }
      if (task.reviewPost) throw new ActivityIntegrityError(event, "already posted");
      task.steps = task.steps.map((s) =>
        s.key === "review" ? { ...s, state: "done" as const } : s,
      );
      task.reviewPost = {
        url: event.payload.url,
        at: event.at,
        ...(event.payload.latestCommit ? { latestCommit: event.payload.latestCommit } : {}),
      };
      break;
    }

    case "ReviewRestarted":
      // レビューを投稿して完了したタスクだけ。前回の対象・行へのコメント・投稿は持ち越さない（PBI-44）。前回の指摘は、
      // 再レビューで対応を確かめるために残す（PBI-111）
      if (!canRereview(task)) throw new ActivityIntegrityError(event, "no posted review to redo");
      if (task.reviewPost && task.reviewTarget) {
        task.previousReview = {
          round: task.reviewRound ?? 1,
          url: task.reviewPost.url,
          at: task.reviewPost.at,
          headCommit: task.reviewTarget.headCommit,
          body: task.outputs.review ?? "",
          comments: task.reviewComments,
        };
      }
      task.steps = task.steps.map((s) =>
        s.key === "review" ? { ...s, state: "active" as const } : s,
      );
      task.status = "queued";
      task.reviewTarget = undefined;
      task.reviewComments = [];
      task.reviewPost = undefined;
      task.outputs = Object.fromEntries(
        Object.entries(task.outputs).filter(([key]) => key !== "review"),
      );
      task.reviewRound = (task.reviewRound ?? 1) + 1;
      if (event.payload.commit) task.reviewRestartCommit = event.payload.commit;
      break;

    case "IssueCommented":
    case "IssueCommentFailed":
      // Issue・PR から取り込んだタスク（PR も Issue のコメントの API で返す。PBI-26）
      // チケットから取り込んだタスクも、調査の結果をチケットにコメントする（PBI-52）
      if (!isCompleted(task) || (!task.source && !task.ticket)) {
        throw new ActivityIntegrityError(event, "the task is not a completed issue task");
      }
      if (task.issueComment) throw new ActivityIntegrityError(event, "already commented");
      task.issueComment =
        event.type === "IssueCommented"
          ? { url: event.payload.url }
          : { failed: event.payload.message };
      break;

    case "GitHubCommentsPosted": {
      const p = event.payload;
      if (p.submission !== undefined) {
        // 承認を待つ提出の頼みを、承認の前に投稿した（PBI-301）
        if (task.gate?.step !== p.step || task.gate.submission !== p.submission) {
          throw new ActivityIntegrityError(event, "not the submission awaiting approval");
        }
        if (task.githubComments?.[p.step]?.submission === p.submission) {
          throw new ActivityIntegrityError(event, "already posted");
        }
      } else {
        if (task.approved[p.step]?.at !== p.approvedAt) {
          throw new ActivityIntegrityError(event, "not the approved output of the step");
        }
        if (task.githubComments?.[p.step]?.approvedAt === p.approvedAt) {
          throw new ActivityIntegrityError(event, "already posted");
        }
      }
      task.githubComments = { ...task.githubComments, [p.step]: { ...p, at: event.at } };
      break;
    }

    case "PullRequestMerged":
    case "PullRequestClosed":
    case "PullRequestReopened": {
      // 見守るのは、承認ゲートで待っている、sacty が作った PR だけ（実装と、要求要件・設計。PBI-57・PBI-110）
      const watched = gatePullRequest(task);
      if (!watched || (task.status !== "awaiting_approval" && task.status !== "escalated")) {
        throw new ActivityIntegrityError(event, "the deliverable review is not open");
      }
      if (watched.number !== event.payload.number) {
        throw new ActivityIntegrityError(event, "not the pull request of the task");
      }
      const state =
        event.type === "PullRequestMerged"
          ? event.payload.outdated
            ? ("merged_outdated" as const)
            : ("merged" as const)
          : event.type === "PullRequestClosed"
            ? ("closed" as const)
            : ("open" as const);
      // 承認にしたマージ（PBI-63 より前の版の、古い内容でのマージは除く）は、監査のために記録する
      let merge: PullRequestMerge | undefined;
      if (event.type === "PullRequestMerged" && !event.payload.outdated) {
        const { number: _number, outdated: _outdated, ...rest } = event.payload;
        merge = { ...rest, at: event.at };
      }
      if (watched.step === "implement") {
        task.pullRequestState = state;
        if (merge) task.pullRequestMerge = merge;
        // マージ・クローズ・開き直しで、競合の表示は消す（開き直したなら、次の確認で確かめ直す）
        task.pullRequestConflict = undefined;
      } else {
        task.stepPullRequests = task.stepPullRequests.map((p) =>
          p.number === watched.number ? { ...p, state, ...(merge ? { merge } : {}) } : p,
        );
      }
      break;
    }

    case "ReworkStoppedByMerge": {
      // 実装の作り直しの間に、実装の PR がマージされた（PBI-276）。作り直しの途中経過を捨てて、実装の承認待ちに戻す
      // （同じ追記で、続けて PullRequestMerged・StepApproved を記録する）
      const reworking = reworkingPullRequest(task);
      if (!reworking || reworking.number !== event.payload.number) {
        throw new ActivityIntegrityError(event, "the implementation is not being reworked");
      }
      if (task.status === "running") {
        throw new ActivityIntegrityError(event, "stop the run before stopping the rework");
      }
      // 初めて提出する前に引き継いだ PR がマージされたときは、その PR を実装の PR として記録する（続く PullRequestMerged が見る）
      const continued = task.continuedPullRequest;
      if (!task.pullRequest && continued) {
        task.pullRequest = {
          branch: continued.branch,
          commit: reworking.commit || continued.branch,
          url: continued.url,
          number: continued.number,
          repo: continued.repo,
        };
        task.pullRequestState = "open";
      }
      const submission = Math.max(task.submissions.implement ?? 0, 1);
      task.submissions = { ...task.submissions, implement: submission };
      task.status = "awaiting_approval";
      task.gate = { step: "implement", submission };
      const discarded = new Set(event.payload.discardedRemarks.map((r) => r.id));
      task.remarks = task.remarks.map((r) => (discarded.has(r.id) ? { ...r, voided: true } : r));
      task.currentRunId = undefined;
      task.verification = undefined;
      resetVerifyFailures(task);
      task.verifyFeedback = undefined;
      task.publishPending = undefined;
      task.pullRequestCi = undefined;
      task.pullRequestConflict = undefined;
      task.stepReview = undefined;
      task.pendingReview = undefined;
      task.escalation = undefined;
      task.pausedReason = undefined;
      task.pausedMessage = undefined;
      task.unstoppedRuns = undefined;
      task.resumeTo = undefined;
      task.pausedCancelledChildren = undefined;
      break;
    }

    case "PullRequestConflicted":
    case "PullRequestConflictResolved": {
      // 競合を出すのは、承認待ちで見守っている実装の PR だけ（要求要件・設計の PR は、タスクブランチへの PR）
      const watched = gatePullRequest(task);
      if (
        watched?.step !== "implement" ||
        watched.state !== "open" ||
        task.status !== "awaiting_approval"
      ) {
        throw new ActivityIntegrityError(event, "the implementation pull request is not watched");
      }
      if (watched.number !== event.payload.number) {
        throw new ActivityIntegrityError(event, "not the pull request of the task");
      }
      task.pullRequestConflict =
        event.type === "PullRequestConflicted"
          ? { number: watched.number, commit: watched.commit, at: event.at }
          : undefined;
      break;
    }

    case "TaskBranchCreated":
      if (task.taskBranch) throw new ActivityIntegrityError(event, "the task branch exists");
      if (!task.repository) throw new ActivityIntegrityError(event, "no repository");
      task.taskBranch = event.payload;
      break;

    case "StepBranchPushed":
      if (!task.taskBranch || activeStep(task) !== event.payload.step) {
        throw new ActivityIntegrityError(event, "the step is not active");
      }
      if (!task.stepBranches.includes(event.payload.branch)) {
        task.stepBranches = [...task.stepBranches, event.payload.branch];
      }
      break;

    case "StepPullRequestPublished": {
      const p = event.payload;
      if (
        !task.taskBranch ||
        task.status !== "idle" ||
        activeStep(task) !== p.step ||
        task.outputs[p.step] === undefined
      ) {
        throw new ActivityIntegrityError(event, "the step is not waiting for a pull request");
      }
      const entry: StepPullRequest = {
        ...p,
        submission: (task.submissions[p.step] ?? 0) + 1,
        state: "open",
      };
      const known = task.stepPullRequests.some((x) => x.number === p.number);
      task.stepPullRequests = [
        ...task.stepPullRequests.map((x) =>
          x.number === p.number
            ? entry
            : x.number === p.supersedes
              ? { ...x, state: "closed" as const, superseded: true }
              : x,
        ),
        ...(known ? [] : [entry]),
      ];
      if (!task.stepBranches.includes(p.branch)) {
        task.stepBranches = [...task.stepBranches, p.branch];
      }
      break;
    }

    case "BranchPushed":
      // 検証に通った後と、最終レビューの前（CI を待つための PR を作る。検証の待ちで、まだ PR の CI を待っていない）
      if (
        activeStep(task) !== "implement" ||
        !(task.publishPending || (task.verification !== undefined && !task.pullRequestCi))
      ) {
        throw new ActivityIntegrityError(
          event,
          "the implementation is not waiting for a pull request",
        );
      }
      task.pushedBranch = event.payload;
      break;

    case "AiRequestsRetried":
      // 記録だけ（作業履歴で確かめる。PBI-37）
      break;

    case "RunCostRecorded":
      // 記録だけ（費用の出どころ。費用そのものは、実行の結果のイベントが持つ。PBI-301）
      break;

    case "AgentFellBack":
      // 記録だけ（代わりのエージェントでやり直す。状態は、失敗の記録が戻している）
      break;

    case "WorkspaceFilesSkipped":
      // 記録だけ（作業領域の写しで、読めないファイルを写さなかった。PBI-278）
      break;

    case "AgentSessionArchived":
      // 記録だけ（写したファイルのハッシュを、画面と API で確かめる。PBI-66）。中止したタスクの状態は変えない
      if (current.status === "cancelled") return next;
      break;

    case "AgentRunTimedOut":
    case "AgentRunContinued":
      // 記録だけ（時間切れで止めた実行と、その次の実行がセッションを続けたか。PBI-280）
      break;

    case "OrchestratorSessionUsed": {
      // 中止したタスクの状態は変えない（記録だけ）。質問への答え（複製）は、元のセッションを変えない
      if (current.status === "cancelled") return next;
      const p = event.payload;
      if (p.role !== "orchestrator") break;
      const prev = task.orchestratorSession;
      task.orchestratorSession =
        p.mode === "resumed" && prev
          ? {
              ...prev,
              ...(p.sessionId ? { sessionId: p.sessionId } : {}),
              uses: prev.uses + 1,
              saved: p.saved ?? false,
              lastUsedAt: event.at,
            }
          : {
              agentId: p.agentId,
              runtime: p.runtime,
              ...(p.sessionId ? { sessionId: p.sessionId } : {}),
              uses: 1,
              ...(p.reason ? { reason: p.reason } : {}),
              saved: p.saved ?? false,
              startedAt: event.at,
              lastUsedAt: event.at,
            };
      break;
    }

    case "GuardianMissed":
      task.misses = [...task.misses, { ...event.payload, at: event.at }];
      break;

    // 情報収集のまとめ。工程を選ぶ前に1回だけ
    case "InformationGathered":
      if (task.steps.length > 0 || task.gathered) {
        throw new ActivityIntegrityError(event, "information is not being gathered");
      }
      task.gathered = { brief: event.payload.brief, sources: event.payload.sources, at: event.at };
      break;

    // チケットから作業するリポジトリ・題・概要を決めた（PBI-52）。工程を選ぶ前だけ
    case "TicketTriaged":
      if (!task.ticket || task.steps.length > 0) {
        throw new ActivityIntegrityError(event, "not a ticket task waiting for triage");
      }
      task.repo = event.payload.repo;
      // 人がタスクの題を変えていれば（PBI-323）、トリアージで決めた題で書き換えない（人の変更を優先する）
      if (event.payload.title && !task.titleChange) task.title = event.payload.title;
      if (event.payload.body !== undefined) {
        // 再開のときに人が足した補足は、トリアージで書いた概要に置き換えず、後ろに残す（後の工程に届くように）。補足は
        // 作業履歴の TaskResumed から貯めたものを使い、説明の見出しからは読み直さない。概要（チケットから書いたもの）に
        // 補足の見出しの行があれば除く（チケットの文を、人の補足に見せかけないため）
        const summary = withoutResumeNoteHeadings(event.payload.body);
        task.body = [summary.trimEnd(), resumeNoteSections(task.resumeNotes ?? [])]
          .filter(Boolean)
          .join("\n\n");
      }
      task.ticketTriage = {
        reason: event.payload.reason,
        by: event.actor === "person" ? "person" : "orchestrator",
      };
      break;

    // リポジトリを指定せずに作ったタスクの、作業するリポジトリを決めた（PBI-73）。工程を選ぶ前だけ
    case "RepositoryChosen":
      if (!awaitingRepository(task)) {
        throw new ActivityIntegrityError(event, "not a task without a repository before planning");
      }
      task.repo = event.payload.repo;
      task.repoChoice = {
        reason: event.payload.reason,
        by: event.actor === "person" ? "person" : "orchestrator",
      };
      break;

    case "TicketPullRequestCommented":
      if (!task.ticket || task.ticketPrComment) {
        throw new ActivityIntegrityError(event, "already commented or not a ticket task");
      }
      task.ticketPrComment = event.payload.url
        ? { url: event.payload.url }
        : { failed: event.payload.failed ?? "" };
      break;

    // 質問と答え（PBI-54）。タスクの状態・工程・承認済みの内容は変えない（作業中でも受け付ける）。
    // 答えを待つ質問は1件まで。答えの費用は予算に入れる
    case "QuestionAsked":
      if (pendingQuestion(task)) throw new ActivityIntegrityError(event, "a question is pending");
      if (task.questions.some((q) => q.id === event.payload.questionId)) {
        throw new ActivityIntegrityError(event, "question id is used twice");
      }
      task.questions = [
        ...task.questions,
        { id: event.payload.questionId, text: event.payload.text, askedAt: event.at },
      ];
      break;

    case "QuestionAnswered": {
      if (pendingQuestion(task)?.id !== event.payload.questionId) {
        throw new ActivityIntegrityError(event, "the question is not waiting for an answer");
      }
      const answer = {
        ...(event.payload.answer !== undefined ? { text: event.payload.answer } : {}),
        ...(event.payload.failed !== undefined ? { failed: event.payload.failed } : {}),
        at: event.at,
      };
      task.questions = task.questions.map((q) =>
        q.id === event.payload.questionId ? { ...q, answer } : q,
      );
      break;
    }

    // エラーの分析。タスクの状態・工程・承認済みの内容は変えない（作業中でも受け付ける）。
    // 分析を待つ求めは1件まで。分析の費用は予算に入れる
    case "ErrorAnalysisRequested":
      if (pendingErrorAnalysis(task)) {
        throw new ActivityIntegrityError(event, "an error analysis is pending");
      }
      if (task.errorAnalyses.some((a) => a.id === event.payload.analysisId)) {
        throw new ActivityIntegrityError(event, "analysis id is used twice");
      }
      task.errorAnalyses = [
        ...task.errorAnalyses,
        { id: event.payload.analysisId, requestedAt: event.at },
      ];
      break;

    case "ErrorAnalyzed": {
      if (pendingErrorAnalysis(task)?.id !== event.payload.analysisId) {
        throw new ActivityIntegrityError(event, "the error analysis is not pending");
      }
      const result = {
        ...(event.payload.analysis !== undefined ? { text: event.payload.analysis } : {}),
        ...(event.payload.failed !== undefined ? { failed: event.payload.failed } : {}),
        ...(event.payload.runId !== undefined ? { runId: event.payload.runId } : {}),
        at: event.at,
      };
      task.errorAnalyses = task.errorAnalyses.map((a) =>
        a.id === event.payload.analysisId ? { ...a, result } : a,
      );
      break;
    }

    // 成果の書き出し（PBI-56）。タスクの状態・工程は変えない（書き出せなくても、タスクは止めない）
    case "ExportStarted": {
      const { step, runId, approvedAt } = event.payload;
      if (!task.exportPlans?.[step]?.to || task.approved[step]?.at !== approvedAt) {
        throw new ActivityIntegrityError(
          event,
          "the approved output is not waiting to be exported",
        );
      }
      task.exports = {
        ...task.exports,
        [step]: { ...task.exports[step], started: { approvedAt, runId, at: event.at } },
      };
      break;
    }

    case "OutputExported": {
      const p = event.payload;
      if (!EXPORT_STEPS.includes(p.step)) {
        throw new ActivityIntegrityError(event, "the step is not exported");
      }
      const previous = task.exports[p.step] ?? {};
      // 人間が止めた・中止したので結果が分からない。始めた記録を残して、次の書き出しで目印を探させる
      if (p.runResult === "interrupted") break;
      const { started: _started, retry: _retry, ...rest } = previous;
      task.exports = {
        ...task.exports,
        [p.step]: {
          ...rest,
          ...(p.url ? { url: p.url } : {}),
          last: {
            approvedAt: p.approvedAt,
            submission: p.submission,
            via: p.via,
            name: p.name,
            ...(p.url ? { url: p.url } : {}),
            ...(p.failed !== undefined ? { failed: p.failed } : {}),
            at: event.at,
          },
        },
      };
      break;
    }

    case "ExportRequested":
      if (!canRetryExport(task, event.payload.step)) {
        throw new ActivityIntegrityError(event, "the export cannot be retried");
      }
      task.exports = {
        ...task.exports,
        [event.payload.step]: { ...task.exports[event.payload.step], retry: true },
      };
      break;

    // サービスの起動は記録だけ（タスクの状態は変えない。PBI-47）
    case "ServicesStarted":
      break;

    case "OrchestratorFailed":
      if (task.status !== "queued" || task.steps.length > 0) {
        throw new ActivityIntegrityError(event, "the steps are not being chosen");
      }
      break;

    case "FinalReviewFailed":
      if (task.status !== "idle" || task.verification === undefined) {
        throw new ActivityIntegrityError(event, "final review is not pending");
      }
      // 判定を読み取れなかった回は、不合格にも再発にも数えない（lastReview も変えない）。続けた回数だけ数える
      if (event.payload.verdictUnreadable)
        task.unreadableReviews = (task.unreadableReviews ?? 0) + 1;
      break;

    case "TaskEscalated":
      // 変更の申し出を、AI の判定を挟まずに人の判断待ちにする（PBI-333）
      if (event.payload.reason === "change_proposed") {
        if (task.status !== "idle")
          throw new ActivityIntegrityError(event, `status ${task.status}`);
        const proposal = findProposal(task, event, event.payload.proposalId ?? "");
        if (proposal.judgement || proposal.decision) {
          throw new ActivityIntegrityError(event, "the proposal is already judged");
        }
        task.status = "escalated";
        break;
      }
      if (event.payload.reason === "change_undecidable") {
        if (task.status !== "idle")
          throw new ActivityIntegrityError(event, `status ${task.status}`);
        const proposal = findProposal(task, event, event.payload.proposalId ?? "");
        if (proposal.judgement?.verdict !== "undecidable") {
          throw new ActivityIntegrityError(event, "the proposal is not undecidable");
        }
        task.status = "escalated";
        break;
      }
      if (task.status !== "awaiting_approval") {
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      }
      task.status = "escalated";
      task.escalation = {
        step: event.payload.step,
        target: event.payload.target ?? event.payload.step,
        pendingRemarks: event.payload.pendingRemarks,
        reason: event.payload.reason,
        ...(event.payload.note ? { note: event.payload.note } : {}),
      };
      // PR の指摘は、エスカレーションの書きかけの指摘として引き継ぐ（戻し先の確認・上限）
      task.pendingReview = undefined;
      break;

    case "BudgetWarned":
      task.budget = { ...task.budget, warned: true };
      break;

    case "TaskPaused":
      // PR のマージで作り直しを止めるとき、実行の費用で先に一時停止していた（予算など）なら、止めたと確かめられなかった実行を
      // 足す（PBI-276。一時停止の理由・説明はそのまま）
      if (task.status === "paused" && event.payload.unstoppedRuns?.length) {
        task.unstoppedRuns = [
          ...new Set([...(task.unstoppedRuns ?? []), ...event.payload.unstoppedRuns]),
        ];
        break;
      }
      // 承認待ち（マージ待ち）でも止められる（PBI-301）。承認ゲート（gate）はそのまま残し、再開すると承認待ちに戻る
      if (
        task.status !== "queued" &&
        task.status !== "idle" &&
        task.status !== "waiting_children" &&
        task.status !== "awaiting_approval"
      ) {
        throw new ActivityIntegrityError(event, `pause while ${task.status}`);
      }
      task.resumeTo = task.status;
      task.status = "paused";
      task.pausedReason = event.payload.reason;
      task.pausedMessage = event.payload.message;
      task.unstoppedRuns = event.payload.unstoppedRuns;
      task.pausedCancelledChildren = event.payload.cancelledChildren;
      break;

    case "TaskSplit": {
      if (task.status !== "idle" || activeStep(task) !== "split") {
        throw new ActivityIntegrityError(event, "the split step is not running");
      }
      // 2回目からは、統合レビューの後に追加する修正の子タスク。既存の子タスクはそのまま（PBI-31）
      const known = new Set(task.split?.children.map((c) => c.taskId));
      if (event.payload.children.some((c) => known.has(c.taskId))) {
        throw new ActivityIntegrityError(event, "the subtask already exists");
      }
      const round = (task.split?.rounds ?? 0) + 1;
      task.split = {
        children: [
          ...(task.split?.children ?? []),
          ...event.payload.children.map((c) => ({ ...c, round })),
        ],
        rounds: round,
        reason: event.payload.reason,
        at: event.at,
        acceptedCancellations: task.split?.acceptedCancellations ?? [],
      };
      task.status = "waiting_children";
      break;
    }

    case "ReproductionChecked": {
      if (task.status !== "idle" || activeStep(task) !== "reproduce" || !task.reproductionPending) {
        throw new ActivityIntegrityError(event, "the reproduce step is not waiting for a check");
      }
      const submission = (task.submissions.reproduce ?? 0) + 1;
      task.submissions = { ...task.submissions, reproduce: submission };
      task.reproduction = { ...event.payload, at: event.at };
      task.reproductionPending = undefined;
      if (event.payload.reproduced) {
        // 再現できたら、人間の承認なしに次の工程（実装）へ進む
        advance(
          task,
          task.steps.findIndex((s) => s.key === "reproduce"),
        );
        task.approved = {
          ...task.approved,
          reproduce: {
            submission,
            output: task.outputs.reproduce ?? "",
            testViewpoints: [],
            at: event.at,
          },
        };
        task.status = "queued";
      } else {
        // 再現できなかったら、人間の判断を待つ（差し戻すと再現をやり直す）
        task.status = "awaiting_approval";
        task.gate = { step: "reproduce", submission };
      }
      break;
    }

    case "TaskUnblocked":
      if (task.status !== "blocked")
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      task.status = "queued";
      // 依存先の PR に重ねて始める（PBI-317）
      if (event.payload.stackedOn) task.stack = event.payload.stackedOn;
      break;

    case "StackedDependencyMerged": {
      // 重ねていた依存先の PR がマージされたので、起点のブランチを付け替える（PBI-317）。作業領域の起点のコミット・取り込みは
      // そのまま（次の取り込みで、付け替えた先の最新を取り込む）
      const stack = task.stack;
      if (!stack || stack.taskId !== event.payload.taskId) {
        throw new ActivityIntegrityError(event, "the task is not stacked on the dependency");
      }
      const { baseBranch } = event.payload;
      task.stack = undefined;
      // 作業領域をまだ用意していなければ、初めて用意するときの起点のブランチとして持つ
      task.stackedBase = baseBranch;
      if (task.repository) task.repository = { ...task.repository, baseBranch };
      break;
    }

    case "SplitCompleted":
      if (task.status !== "waiting_children" || activeStep(task) !== "split") {
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      }
      {
        const following = nextStep(task, "split");
        advance(
          task,
          task.steps.findIndex((s) => s.key === "split"),
        );
        // 統合レビュー（PBI-31）へ進む。それより前に分割したタスクは、これで完了する
        task.status = following ? "queued" : "idle";
      }
      break;

    case "IntegrationReviewed": {
      if (task.status !== "idle" || activeStep(task) !== "integrate") {
        throw new ActivityIntegrityError(event, "the integration review is not running");
      }
      task.integration = { ...event.payload, at: event.at };
      if (event.payload.passed) {
        task.integrationFailures = 0;
        break;
      }
      task.integrationFailures += 1;
      // 上限までは、タスク分割の工程をやり直して修正の子タスクを追加する。上限に達したら、
      // 不合格のまま人間の承認待ちにする（続く StepSubmitted）
      if (task.integrationFailures < MAX_INTEGRATION_ATTEMPTS) {
        reopen(task, "split");
        task.status = "queued";
      }
      break;
    }

    // 古い版の作業履歴：人が工程のイメージを変えた（PBI-106）。工程の状態は問わず、変えず、その工程を次に実行するときから使う
    case "StepImageChanged": {
      const { step, from, to } = event.payload;
      if (!task.steps.some((s) => s.key === step)) {
        throw new ActivityIntegrityError(event, `step ${step} is not chosen`);
      }
      task.images = { ...task.images, [step]: to };
      task.imageChanges = { ...task.imageChanges, [step]: { from, to, at: event.at } };
      break;
    }

    // 人がタスクのイメージを変えた（PBI-318）。工程の状態は問わず、変えず、すべての工程の次の実行から使う。古い版の工程ごとの
    // イメージ（images）は、どの工程がどのイメージで動いたかとして残す（使うのはタスクのイメージ）
    case "TaskImageChanged": {
      if (task.steps.length === 0) {
        throw new ActivityIntegrityError(event, "steps are not chosen");
      }
      const { from, to } = event.payload;
      task.image = to;
      task.imageChange = { ...(from ? { from } : {}), to, at: event.at };
      break;
    }

    // 人がタスクの題を変えた（PBI-323）。中止したタスクのほかは状態を問わず、この後に題を使うもの（指示・コミット・通知など）から使う
    case "TaskRenamed":
      task.title = event.payload.to;
      task.titleChange = { from: event.payload.from, to: event.payload.to, at: event.at };
      break;

    // 人が工程のエージェントを変えた（PBI-121）。工程の状態は問わず、その工程を次に実行するときから使う
    case "StepAgentChanged": {
      const { step, from, to } = event.payload;
      if (!task.steps.some((s) => s.key === step)) {
        throw new ActivityIntegrityError(event, `step ${step} is not chosen`);
      }
      task.agents = { ...task.agents, [step]: to };
      task.agentChanges = { ...task.agentChanges, [step]: { from, to, at: event.at } };
      break;
    }

    case "BudgetCapRaised":
      if (event.payload.capUsd <= task.budget.usedUsd) {
        throw new ActivityIntegrityError(event, "new cap must exceed the amount spent");
      }
      task.budget = { ...task.budget, capUsd: event.payload.capUsd, raised: true };
      break;

    // マージの後の監視（PBI-89）。PBI-116 からは、マージの後の監視の工程の中身で、監視が終わると工程を終える
    // （settleDeploymentStep）。工程の無い PBI-116 より前のタスクは、完了したタスクのまま、状態・工程を変えない
    case "DeploymentWatchStarted": {
      if (task.deployment) throw new ActivityIntegrityError(event, "the watch has started");
      const step = task.steps.some((s) => s.key === "deployment");
      if (
        task.pullRequestState !== "merged" ||
        (step ? activeStep(task) !== "deployment" : !isCompleted(task))
      ) {
        throw new ActivityIntegrityError(event, "the pull request is not merged");
      }
      task.deployment = event.payload.commit
        ? { ...event.payload, startedAt: event.at, state: "waiting", phase: "ci" }
        : {
            ...event.payload,
            startedAt: event.at,
            state: "skipped",
            reason: "no_commit",
            finishedAt: event.at,
          };
      break;
    }

    case "DeploymentCiFinished": {
      const watch = task.deployment;
      if (watch?.state !== "waiting" || watch.phase !== "ci") {
        throw new ActivityIntegrityError(event, "the watch is not waiting for CI");
      }
      const { skipCheck, ...ci } = event.payload;
      const next: DeploymentWatch = { ...watch, ci: { ...ci, at: event.at } };
      const finish = (state: DeploymentWatchState, reason?: DeploymentWatchReason) => {
        next.state = state;
        next.phase = undefined;
        next.finishedAt = event.at;
        if (reason) next.reason = reason;
      };
      if (ci.result === "passed") {
        if (ci.skill) next.phase = "check";
        else {
          finish("passed", "no_skill");
          if (skipCheck !== undefined) next.detail = skipCheck;
        }
      } else if (ci.result === "failed") finish("failed");
      else if (ci.result === "none") finish("skipped", "no_ci");
      else finish("timed_out");
      task.deployment = next;
      break;
    }

    case "DeploymentCheckStarted": {
      const watch = task.deployment;
      if (!awaitingDeploymentCheck(task) || !watch) {
        throw new ActivityIntegrityError(event, "the watch is not waiting for the check");
      }
      task.deployment = {
        ...watch,
        check: { runId: event.payload.runId, skill: event.payload.skill, startedAt: event.at },
      };
      break;
    }

    case "DeploymentChecked": {
      const watch = task.deployment;
      const check = watch?.check;
      if (
        watch?.state !== "waiting" ||
        watch.phase !== "check" ||
        !check ||
        check.result !== undefined ||
        (event.payload.runId !== undefined && event.payload.runId !== check.runId)
      ) {
        throw new ActivityIntegrityError(event, "the check is not running");
      }
      const p = event.payload;
      // 人が止めた・デーモンが止まった確認は、結果にせず、確かめ直す（PBI-116。工程の再開で、もう一度実行する）
      if (p.retry) {
        task.deployment = { ...watch, check: undefined };
        break;
      }
      const state: DeploymentWatchState =
        p.result === "healthy" ? "passed" : p.result === "unhealthy" ? "failed" : "skipped";
      task.deployment = {
        ...watch,
        state,
        phase: undefined,
        finishedAt: event.at,
        ...(p.result === "unknown" ? { reason: "check_unknown" as const } : {}),
        ...(p.result === "unknown" && p.failed !== undefined ? { detail: p.failed } : {}),
        check: {
          ...check,
          result: p.result,
          ...(p.summary !== undefined ? { summary: p.summary } : {}),
          evidence: p.evidence,
          ...(p.failed !== undefined ? { failed: p.failed } : {}),
          ...(p.ci ? { ci: p.ci } : {}),
          ...(p.deployment ? { deployment: p.deployment } : {}),
          at: event.at,
        },
      };
      break;
    }

    case "DeploymentWatchSkipped": {
      const watch = task.deployment;
      if (!awaitingDeploymentCheck(task) || !watch) {
        throw new ActivityIntegrityError(event, "the watch is not waiting for the check");
      }
      task.deployment = {
        ...watch,
        state: "skipped",
        phase: undefined,
        reason: event.payload.reason,
        ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
        finishedAt: event.at,
      };
      break;
    }

    case "DeploymentFixRegistered":
    case "DeploymentFixSuppressed": {
      const watch = task.deployment;
      if (!watch || !fixDecisionPending(task)) {
        throw new ActivityIntegrityError(event, "no failure is waiting for a fix task");
      }
      task.deployment =
        event.type === "DeploymentFixRegistered"
          ? { ...watch, fix: { ...event.payload, at: event.at } }
          : { ...watch, suppressed: { ...event.payload, at: event.at } };
      break;
    }

    case "SecurityFixRequested": {
      if (!canRequestSecurityFix(task)) {
        throw new ActivityIntegrityError(event, "the task is not a completed security check");
      }
      if (task.securityFixes?.[event.payload.category]) {
        throw new ActivityIntegrityError(event, "the category already has a fix task");
      }
      task.securityFixes = {
        ...task.securityFixes,
        [event.payload.category]: { ...event.payload, at: event.at },
      };
      break;
    }

    case "TestsDecided":
      if (!canDecideTests(task)) {
        throw new ActivityIntegrityError(event, "the tests are not undecided");
      }
      if (event.payload.testCommand !== undefined) {
        task.testCommand = event.payload.testCommand;
        // 文書だけの依頼（PBI-284）で noTests を答えていたタスクの、テストなしの理由は使わない（残すと、指定したコマンドが
        // あるのにテストなしの扱いになり、そのコマンドのツール不足で止まっても、テストの扱いを決め直せない）
        task.noTestsReason = undefined;
      } else {
        if (task.steps.some((s) => s.key === "reproduce")) {
          throw new ActivityIntegrityError(event, "a bug fix needs a test command");
        }
        task.noTestsReason = event.payload.noTestsReason;
        // ツールが無くて止まったタスク（PBI-158）の、決まっていたテストのコマンドは使わない（残すと、テストなしと決めても
        // 同じコマンドを実行して、また止まる）
        task.testCommand = undefined;
      }
      task.testsDecidedBy = "person";
      // 人がテストの扱いを決めたので、依頼を文書だけとしたオーケストレーターの判断は使わない（決めた扱いで検証する）
      task.documentsOnly = undefined;
      break;

    case "TaskResumed":
      if (task.status !== "paused")
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      if (event.payload.rechooseSteps) {
        if (!canRechooseSteps(task)) {
          throw new ActivityIntegrityError(event, "the steps cannot be chosen again");
        }
        clearChosenSteps(task);
      }
      task.status =
        task.resumeTo === "waiting_children" || task.resumeTo === "awaiting_approval"
          ? task.resumeTo
          : event.payload.retry
            ? "queued"
            : "idle";
      // 人間が再開したら、検証の失敗の回数を数え直す
      if (task.pausedReason === "verification") {
        // 回数は数え直すが、失敗の記憶は残す（再開の後に同じ失敗なら、回数に関係なく止める。PBI-308）
        task.verifyFailures = 0;
        task.verifyStalled = undefined;
      }
      task.unreadableReviews = undefined;
      // 中止された子タスクで止めた親を再開したら、その中止を認めたことにする（PBI-27）
      if (task.split && task.pausedCancelledChildren?.length) {
        task.split = {
          ...task.split,
          acceptedCancellations: [
            ...task.split.acceptedCancellations,
            ...task.pausedCancelledChildren,
          ],
        };
      }
      task.pausedCancelledChildren = undefined;
      task.pausedReason = undefined;
      task.pausedMessage = undefined;
      // 人が再開のときに足した補足は、説明の後に足す（後の工程とオーケストレーターは説明を読む）
      if (event.payload.note) {
        task.body = bodyWithResumeNote(task, event.payload.note);
        task.resumeNotes = [...(task.resumeNotes ?? []), event.payload.note];
      }
      task.unstoppedRuns = undefined;
      task.resumeTo = undefined;
      break;
  }

  // 完了したタスクの監査（PBI-125）。タスクの状態・工程は変えない
  if (event.type.startsWith("Audit")) applyAuditEvent(task, event);
  // マージの後の監視が終わったら、その工程を終える（PBI-116）
  if (event.type.startsWith("Deployment")) settleDeploymentStep(task);
  // 費用を持つイベント（CHARGED_EVENT_TYPES）の費用を、タスクの予算に入れる（PBI-86。画面の工程ごとの費用の表と同じ規則）。
  // 受け付けない並び（上の検査で投げる）の費用は入れない
  task.budget = chargeBudget(task.budget, event);
  next.set(event.taskId, task);
  return next;
}

/** 監査のイベントを、タスクの監査の状態に適用する（PBI-125）。並びの合わない記録は受け付けない。 */
function applyAuditEvent(task: Task, event: ActivityEvent): void {
  const integrity = (why: string) => new ActivityIntegrityError(event, why);
  if (event.type === "AuditQueued") {
    if (task.audit) throw integrity("the task is already audited");
    task.audit = {
      auditId: event.payload.auditId,
      queuedAt: event.at,
      capUsd: event.payload.capUsd,
      usedUsd: 0,
      estimated: false,
      dives: [],
      findings: [],
      memories: [],
    };
    return;
  }
  const audit = task.audit;
  if (event.type === "AuditMemoryDeleted") {
    const memory = audit?.memories.find((m) => m.id === event.payload.memoryId);
    if (!audit || !memory) throw integrity("unknown audit memory");
    if (memory.deleted) throw integrity("the audit memory is already deleted");
    const deleted = { at: event.at, reason: event.payload.reason };
    task.audit = {
      ...audit,
      memories: audit.memories.map((m) => (m === memory ? { ...m, deleted } : m)),
    };
    return;
  }
  if (event.type === "AuditProposalAdopted" || event.type === "AuditProposalRejected") {
    const id = event.payload.proposalId;
    const finding = audit?.findings.find((f) => f.proposals.some((p) => p.id === id));
    const proposal = finding?.proposals.find((p) => p.id === id);
    if (!audit || !finding || !proposal) throw integrity("unknown audit proposal");
    if (proposal.decision) throw integrity("the audit proposal is already decided");
    const decision =
      event.type === "AuditProposalAdopted"
        ? {
            kind: "adopted" as const,
            at: event.at,
            target: event.payload.target,
            ...(event.payload.fixTaskId ? { fixTaskId: event.payload.fixTaskId } : {}),
            ...(event.payload.note ? { note: event.payload.note } : {}),
          }
        : { kind: "rejected" as const, at: event.at, reason: event.payload.reason };
    task.audit = {
      ...audit,
      findings: audit.findings.map((f) =>
        f !== finding
          ? f
          : { ...f, proposals: f.proposals.map((p) => (p.id === id ? { ...p, decision } : p)) },
      ),
    };
    return;
  }
  if (!audit || !("auditId" in event.payload) || event.payload.auditId !== audit.auditId) {
    throw integrity("unknown audit");
  }
  const charge = (p: { auditCostUsd: number; estimated: boolean }) => ({
    usedUsd: audit.usedUsd + p.auditCostUsd,
    estimated: audit.estimated || (p.auditCostUsd > 0 && p.estimated),
  });
  const ended = audit.completedAt !== undefined || audit.failed !== undefined;
  switch (event.type) {
    case "AuditSurveyed": {
      if (ended || audit.survey) throw integrity("the audit is not waiting for a survey");
      // メモリーをコンテキストにする提案は、原因として持つ（採用・却下は、ほかの提案と同じ。PBI-128）
      const { auditId: _id, promotions, ...survey } = event.payload;
      task.audit = {
        ...audit,
        ...charge(event.payload),
        survey: { ...survey, at: event.at, seq: event.seq },
        findings: [...audit.findings, ...promotions.map((f) => ({ ...f, at: event.at }))],
      };
      return;
    }
    case "AuditDeepDived": {
      if (ended || nextAuditDive(audit) !== event.payload.step) {
        throw integrity("the step is not the next deep dive");
      }
      const { auditId: _id, findings, memories, ...dive } = event.payload;
      task.audit = {
        ...audit,
        ...charge(event.payload),
        dives: [...audit.dives, { ...dive, at: event.at }],
        findings: [...audit.findings, ...findings.map((f) => ({ ...f, at: event.at }))],
        memories: [
          ...audit.memories,
          ...memories.map((m) => ({ ...m, at: event.at, step: event.payload.step })),
        ],
      };
      return;
    }
    case "AuditCompleted":
      if (ended || !audit.survey || nextAuditDive(audit) !== undefined) {
        throw integrity("the audit is not finished");
      }
      task.audit = { ...audit, completedAt: event.at };
      return;
    case "AuditFailed":
      if (ended) throw integrity("the audit has ended");
      task.audit = {
        ...audit,
        ...charge(event.payload),
        failed: {
          at: event.at,
          reason: event.payload.reason,
          ...(event.payload.step ? { step: event.payload.step } : {}),
        },
      };
      return;
    case "AuditBudgetWarned":
      task.audit = { ...audit, warnedCapUsd: event.payload.capUsd };
      return;
    case "AuditBudgetPaused":
      if (ended) throw integrity("the audit has ended");
      task.audit = { ...audit, paused: { at: event.at } };
      return;
    case "AuditCapRaised":
      if (!audit.paused) throw integrity("the audit is not paused");
      if (event.payload.capUsd <= audit.usedUsd)
        throw integrity("the new cap is not above the used amount");
      task.audit = { ...audit, capUsd: event.payload.capUsd, paused: undefined };
      return;
  }
}

/**
 * 作業履歴のイベント列から、すべてのタスクの状態を復元する。applied を渡せば、イベントを1つ適用するごとに、その前後のタスクと
 * 一緒に呼ぶ（デーモンがダッシュボードの集計を同じ読み込みで作る。PBI-118）。
 */
export function project(
  events: Iterable<ActivityEvent>,
  applied?: (event: ActivityEvent, before: Task | undefined, after: Task) => void,
): Map<string, Task> {
  let tasks = new Map<string, Task>();
  let lastSeq = 0;
  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new Error(`activity is out of order at seq ${event.seq}`);
    }
    lastSeq = event.seq;
    const before = tasks.get(event.taskId);
    tasks = applyEvent(tasks, event);
    const after = tasks.get(event.taskId);
    if (applied && after) applied(event, before, after);
  }
  return tasks;
}

/**
 * 実装の作り直しの間（実装・最終レビュー・PR の更新が走っている・待っている。一時停止中も）に、開いた（または閉じられた）実装の PR
 * （PBI-276）。人がこの PR をマージしたら、作り直しを止めて、マージを承認として進める（ReworkStoppedByMerge）。
 * 承認待ち・エスカレーション中は、ゲートの PR として見守る（gatePullRequest）ので、ここには含めない。実装より前の工程を
 * やり直している間（要求要件・設計への差し戻し）も含めない。
 */
export function reworkingPullRequest(
  task: Task,
): { number: number; repo?: string; commit: string } | undefined {
  if (
    task.status !== "queued" &&
    task.status !== "running" &&
    task.status !== "idle" &&
    task.status !== "paused"
  ) {
    return undefined;
  }
  if (activeStep(task) !== "implement") return undefined;
  const pr = task.pullRequest;
  // 引き継いだ既存の PR は、初めて提出するまで Task.pullRequest が無い。その間（最初の最終レビューに通らず作り直している間など）も、
  // 引き継いだ PR を見守る（コミットは、引き継いだ時点の PR の先頭）
  const continued = task.continuedPullRequest;
  if (!pr && continued) {
    return {
      number: continued.number,
      repo: continued.repo,
      commit: task.repository?.baseCommit ?? "",
    };
  }
  // 閉じられた PR も含める（承認待ちで閉じられて差し戻した後、GitHub で開き直してマージされることがある）
  if (!pr?.number || (task.pullRequestState !== "open" && task.pullRequestState !== "closed")) {
    return undefined;
  }
  return { number: pr.number, ...(pr.repo ? { repo: pr.repo } : {}), commit: pr.commit };
}

/**
 * 一時停止の間（と、再開した直後の、止まった工程を走り直す前）に届いて、まだ反映していない実装の PR の指摘（PBI-279）。
 * 承認待ちで取り込んだ指摘（pendingReview）とは、承認ゲートが無いことで区別する。再開したあと、止まった工程を走り直す前に、
 * ゴールガーディアンに戻し先を判断させて、その工程に差し戻す。
 */
export function heldReview(task: Task): NonNullable<Task["pendingReview"]> | undefined {
  if (task.status !== "paused" && task.status !== "queued" && task.status !== "idle") {
    return undefined;
  }
  return reworkingPullRequest(task) ? task.pendingReview : undefined;
}

/**
 * 実装の PR にまだ反映していない指摘（PBI-276）。最後の差し戻し（実装の PR の指摘の取り込みを含む）で足された指摘のうち、
 * 無効にしておらず、提出済みの PR の内容に渡していないもの（作り直しの実行が見たが、まだ提出していないものを含む）。
 * 前の差し戻しの指摘は、前の提出に反映済みなので含めない。
 */
export function unreflectedImplementRemarks(task: Task): TaskRemark[] {
  const submitted = task.submissions.implement ?? 0;
  const latest = lastChangeRound(task, "implement");
  return task.remarks.filter(
    (r) =>
      r.step === "implement" &&
      !r.voided &&
      r.round === latest &&
      (r.submittedIn === undefined || r.submittedIn > submitted),
  );
}

/**
 * 承認ゲートで見守っている、sacty が作った PR（PBI-14a・PBI-57）。実装なら実装の PR（PBI-110）、要求要件・設計なら
 * その提出の PR。PR を作っていないゲートなら undefined。
 */
export function gatePullRequest(task: Task):
  | {
      step: StepKey;
      number: number;
      url?: string;
      repo?: string;
      commit: string;
      state: "open" | "closed" | "merged" | "merged_outdated";
    }
  | undefined {
  const gate = task.gate;
  if (!gate) return undefined;
  if (gate.step === "implement") {
    const pr = task.pullRequest;
    if (!pr?.number) return undefined;
    return {
      step: "implement",
      number: pr.number,
      ...(pr.url ? { url: pr.url } : {}),
      ...(pr.repo ? { repo: pr.repo } : {}),
      commit: pr.commit,
      state: task.pullRequestState ?? "open",
    };
  }
  // 作業履歴から復元したタスクには必ずある（部分的に作ったタスクでも読めるようにする）
  const found = (task.stepPullRequests ?? []).findLast(
    (p) => p.step === gate.step && p.submission === gate.submission && !p.superseded,
  );
  if (!found) return undefined;
  return {
    step: found.step,
    number: found.number,
    url: found.url,
    repo: found.repo,
    commit: found.commit,
    state: found.state,
  };
}

/**
 * 承認待ちで見守っている実装の PR が、ベースブランチと競合しているなら、その記録（画面に出す）。人の出番（承認待ち）で、
 * 今の提出の開いている PR のものだけ。PR を更新した・閉じた・マージした、ゴールガーディアンが PR の指摘を判断している（その
 * 指摘の取り込みでベースブランチを取り込む）間は無い。
 */
export function pullRequestConflict(
  task: Task,
): NonNullable<Task["pullRequestConflict"]> | undefined {
  const conflict = task.pullRequestConflict;
  if (!conflict || task.status !== "awaiting_approval" || task.pendingReview) return undefined;
  const watched = gatePullRequest(task);
  if (
    watched?.step !== "implement" ||
    watched.state !== "open" ||
    watched.number !== conflict.number ||
    watched.commit !== conflict.commit
  ) {
    return undefined;
  }
  return conflict;
}

/**
 * 古い head へのレビューとして取り込まずに捨てた、AI のレビューの指摘のうち、いま見守っている PR（承認ゲートの PR、または
 * 実装の作り直しの間の実装の PR）へのもの（PBI-291）。人が PR を承認・マージする前に、捨てた指摘に気づけるよう、画面に出す。
 * 古い順に並べる。無ければ undefined。マージされた PR のものは出さない（承認はもう済んでいる）。
 * 捨てた指摘を作り直しに取り込むことはしない。新しい head に当てはまると人が判断したら、差し戻しの指摘として伝える。
 */
export function discardedAiReviews(task: Task):
  | {
      number: number;
      /** 捨てたときの PR の head のうち、最後のもの。 */
      head: string;
      items: (DiscardedReview["items"][number] & { head: string })[];
    }
  | undefined {
  const discarded = task.discardedReviews;
  if (!discarded?.length) return undefined;
  const gate = gatePullRequest(task);
  if (gate && (gate.state === "merged" || gate.state === "merged_outdated")) return undefined;
  const number = (gate ?? reworkingPullRequest(task))?.number;
  if (number === undefined) return undefined;
  const mine = discarded.filter((d) => d.number === number);
  const last = mine.at(-1);
  if (!last) return undefined;
  return {
    number,
    head: last.head,
    items: mine.flatMap((d) => d.items.map((item) => ({ ...item, head: d.head }))),
  };
}

/**
 * 承認の画面と PR のコメントで、人に気づいてほしいこと（PBI-301）。今の承認待ちの提出に対する、次の2つ。
 * - undecided：PR の指摘の戻し先を、ゴールガーディアンが判断できなかった（`prRework.decided` が偽）。実装をやり直しているが、
 *   指摘の意図を読み取れていないので、直した結果が意図と合うかを指摘した人が確かめる。理由はゴールガーディアンが書いた文。
 * - confirms：工程エージェントが、指摘への対応と一緒に挙げた「人に確かめたいこと」（聞き返し・推測で決めたこと）。
 * 今の提出が受けた指摘（無効にしたものを除く）についてだけ。承認待ちでなければ、どちらも無い。
 */
export function humanAsks(task: Task): {
  undecided?: { step: StepKey; reason: string; remarkIds: string[] };
  confirms: { remarkId: string; step: StepKey; text: string }[];
} {
  const gate = task.gate;
  if (task.status !== "awaiting_approval" || !gate) return { confirms: [] };
  const mine = task.remarks.filter(
    (r) => r.step === gate.step && !r.voided && r.submittedIn === gate.submission,
  );
  const confirms = mine.flatMap((r) =>
    r.confirm?.trim() && r.respondedIn === gate.submission
      ? [{ remarkId: r.id, step: r.step, text: r.confirm.trim() }]
      : [],
  );
  const rework = task.prRework;
  // 実行に失敗した・出力を読めなかったとき（理由が sacty の文言）は、指摘の読み方ではないので出さない
  const reason = typeof rework?.reason === "string" ? rework.reason.trim() : "";
  // 判断した指摘のうち、今の提出が受けたもの。その後に別の差し戻しがあれば（指摘の回が進んでいれば）、古い判断は出さない
  const latestRound = Math.max(0, ...mine.map((r) => r.round));
  const judged =
    rework && !rework.decided && rework.target === gate.step && rework.round === latestRound
      ? rework
      : undefined;
  const remarkIds =
    judged && reason !== ""
      ? mine.filter((r) => judged.remarkIds.includes(r.id)).map((r) => r.id)
      : [];
  return {
    ...(judged && remarkIds.length > 0
      ? { undecided: { step: gate.step, reason, remarkIds } }
      : {}),
    confirms,
  };
}

/** 承認ゲートで見守っている PR の、マージの記録（PBI-63）。マージされていなければ undefined。 */
function gateMerge(task: Task): PullRequestMerge | undefined {
  const watched = gatePullRequest(task);
  if (!watched) return undefined;
  if (watched.step === "implement") return task.pullRequestMerge;
  return task.stepPullRequests.find((p) => p.number === watched.number)?.merge;
}

/** sacty が成果のファイルの先頭に書く、目印の行（PBI-57）。 */
const DOCUMENT_HEADER = /^<!-- sacty task [^\r\n]* -->\r?\n(?:\r?\n)?/;

/**
 * 成果のファイルの本文から、承認済みの成果にする本文を取り出す（PBI-63）。sacty が書いた先頭の目印の行を除く
 * （人が消していれば、そのまま）。
 */
export function documentOutput(content: string): string {
  return content.replace(DOCUMENT_HEADER, "").trimEnd();
}

/** 工程の、最後に作った PR（PBI-57）。 */
export function latestStepPullRequest(
  task: Task,
  step: StepPullRequestKey,
): StepPullRequest | undefined {
  return task.stepPullRequests.findLast((p) => p.step === step);
}

/**
 * 要求要件・設計の成果のファイルの、リポジトリの根からの相対パス（PBI-57）。オーケストレーターが決めたディレクトリ
 * （無い・使えない形なら既定）の下の、タスクの短い ID のディレクトリに置く。
 */
export function stepDocumentPath(task: Task, step: StepPullRequestKey): string {
  const dir =
    task.documentsDir && isDocumentsDir(task.documentsDir)
      ? task.documentsDir
      : DEFAULT_DOCUMENTS_DIR;
  return `${dir}/${task.id.slice(0, 8)}/${step}.md`;
}

/** 答えを待っている、オーケストレーターへの質問（PBI-54）。 */
export function pendingQuestion(task: Task): TaskQuestion | undefined {
  return task.questions.find((q) => !q.answer);
}

/**
 * オーケストレーターに質問できない理由（PBI-54）。中止したタスク・答えを待つ質問があるタスク・予算の上限に
 * 達したタスクでは質問できない。質問できるなら undefined。
 */
export function questionBlocked(task: Task): DaemonMessage | undefined {
  if (task.status === "cancelled") return message("task.cancelled");
  if (pendingQuestion(task)) return message("chat.answering");
  if (budgetState(task.budget) === "exceeded") {
    return message("chat.budgetExceeded", {
      usedUsd: task.budget.usedUsd,
      capUsd: task.budget.capUsd,
    });
  }
  return undefined;
}

/** 結果を待っている、オーケストレーターのエラーの分析。 */
export function pendingErrorAnalysis(task: Task): TaskErrorAnalysis | undefined {
  return task.errorAnalyses.find((a) => !a.result);
}

/**
 * オーケストレーターにエラーを分析させられない理由。中止したタスク・分析を待っているタスク・予算の上限に達した
 * タスクでは分析させない。分析させられるなら undefined。
 */
export function errorAnalysisBlocked(task: Task): DaemonMessage | undefined {
  if (task.status === "cancelled") return message("task.cancelled");
  if (pendingErrorAnalysis(task)) return message("errorReport.analyzing");
  if (budgetState(task.budget) === "exceeded") {
    return message("errorReport.budgetExceeded", {
      usedUsd: task.budget.usedUsd,
      capUsd: task.budget.capUsd,
    });
  }
  return undefined;
}

/**
 * 承認した版をまだ書き出していない（人間が書き出し直しを求めた）工程（PBI-56）。決めた書き出し先がある、書き出せる
 * 工程だけ。タスクの状態は見ない（取り込み元へのコメントを、書き出しの後にするため）。
 */
export function exportDue(task: Task): StepKey | undefined {
  if (task.status === "cancelled") return undefined;
  return exportSteps(task.steps.map((s) => s.key)).find((step) => {
    const approved = task.approved[step];
    if (!task.exportPlans?.[step]?.to || !approved) return false;
    // 文書作成で、エージェントが外部に直接書いたページが成果物なら、書き出さない（sacty の原稿を別のページとして出さない）
    if (step === "document" && (task.documentPages?.length ?? 0) > 0) return false;
    const exported = task.exports[step];
    return exported?.retry === true || exported?.last?.approvedAt !== approved.at;
  });
}

/** 書き出せなかった成果を、画面から書き出し直せるか（PBI-56）。 */
export function canRetryExport(task: Task, step: StepKey): boolean {
  const last = task.exports[step]?.last;
  return (
    task.status !== "cancelled" &&
    Boolean(task.exportPlans?.[step]?.to) &&
    last?.failed !== undefined &&
    task.approved[step]?.at === last.approvedAt &&
    exportDue(task) === undefined
  );
}

/** 現在実行対象の工程（active な工程）。 */
export function activeStep(task: Task): StepKey | undefined {
  return task.steps.find((s) => s.state === "active")?.key;
}

/** AI のレビュー（sacty のレビューのタスクの投稿）の指摘か（PBI-275）。 */
export function isAiReviewRemark(remark: { source?: RemarkSource }): boolean {
  return remark.source === "sacty_review";
}

/**
 * その工程で、人が差し戻した回数（同じ工程への差し戻しの上限 MAX_CHANGE_REQUESTS に数える回数）。AI のレビューの指摘だけの
 * 回は数えない（人の指摘が1件でもあれば数える。PBI-275）。
 */
export function changeRounds(task: Task, step: StepKey): number {
  const rounds = new Set<number>();
  for (const r of task.remarks) {
    if (r.step === step && !isAiReviewRemark(r)) rounds.add(r.round);
  }
  return rounds.size;
}

/** その工程への、最後の差し戻しの回（AI のレビューだけの回も含む。次の回の番号と、指摘の ID に使う）。 */
export function lastChangeRound(task: Task, step: StepKey): number {
  return task.remarks.filter((r) => r.step === step).reduce((max, r) => Math.max(max, r.round), 0);
}

/**
 * 人間の判断待ちの変更の申し出（PBI-333 から、申し出はすべて人が判断する）。以前の版の作業履歴では、AI（ゴールガーディアン）が
 * 判定中のもの・判定できなかったもの。
 */
export function openProposal(task: Task): TaskProposal | undefined {
  return task.proposals.find(
    (p) => !p.decision && (!p.judgement || p.judgement.verdict === "undecidable"),
  );
}

/** その工程の最新の出力が、反映された変更の申し出によるものなら、その申し出。 */
export function appliedProposalFor(task: Task, step: StepKey): TaskProposal | undefined {
  const last = task.proposals.findLast((p) => p.applied && p.target === step);
  return last && task.outputs[step] === last.proposed ? last : undefined;
}

/**
 * 承認ゲートで差し戻すときに選べる、やり直す工程（ゲートに近い順）。
 * ゲートの工程か、それより前の、工程エージェントが作る工程。
 */
export function reworkTargets(task: Task, gateStep: StepKey): StepKey[] {
  if (task.operationAttempted) return [];
  // 統合レビューの承認待ちで差し戻すと、タスク分割をやり直して修正の子タスクを追加する（PBI-31）。
  // 親の要求要件・設計は、子タスクが作られた後なので戻さない
  if (gateStep === "integrate") return task.steps.some((s) => s.key === "split") ? ["split"] : [];
  const index = task.steps.findIndex((s) => s.key === gateStep);
  return (
    task.steps
      // 飛ばした工程（工程の見直し）には戻さない
      .filter((s, i) => i <= index && s.state !== "skip" && REWORK_STEPS.includes(s.key))
      // 再現は、実装した後のコードでは再現できないので、再現の判断待ちのときだけやり直せる。
      // 前段の調査は人間が承認しない工程なので、調査そのものが目的のとき（調査の承認待ち）だけ（PBI-29）
      .filter((s) => (s.key !== "reproduce" && s.key !== "investigate") || gateStep === s.key)
      .map((s) => s.key)
      .reverse()
  );
}

/**
 * PR のレビューの子タスクが指摘ごとに示した戻し先から、差し戻す工程を決める（PBI-332）。承認済みの前の工程の決定を変える指摘が
 * 1つでもあればその工程、複数の工程にまたがれば前の工程。戻し先の候補（targets。ゲートに近い順）に無い・読めない値の指摘は、
 * その PR の工程（gateStep）で直す。候補が無ければ（工程を戻せないタスク）undefined。
 */
export function reviewReworkTarget(
  rework: ReviewRework | undefined,
  targets: readonly StepKey[],
  gateStep: StepKey,
): StepKey | undefined {
  if (!targets.includes(gateStep)) return targets[0];
  let index = targets.indexOf(gateStep);
  for (const finding of rework?.findings ?? []) {
    const i = finding.target ? targets.indexOf(finding.target) : -1;
    if (i > index) index = i;
  }
  return targets[index];
}

/**
 * 調査そのものがタスクの目的か（調査だけの組み合わせ。PBI-18）。実装する組み合わせの先頭の調査は、
 * 後の工程のための前段の調査で、人間は承認しない（PBI-29）。
 */
export function investigationIsGoal(task: Task): boolean {
  return task.steps.at(-1)?.key === "investigate";
}

/** すべての工程が終わったか。 */
/** 「再レビュー」できるか（レビューを PR に投稿して完了したタスク。PBI-44）。 */
export function canRereview(task: Task): boolean {
  return (
    task.status !== "cancelled" &&
    task.reviewPost !== undefined &&
    task.steps.some((s) => s.key === "review") &&
    isCompleted(task)
  );
}

/** マージの後の監視で、CI/CD の結果を待っているか（PBI-89）。 */
export function awaitingDeploymentCi(task: Task): boolean {
  return (
    task.status !== "cancelled" &&
    task.deployment?.state === "waiting" &&
    task.deployment.phase === "ci"
  );
}

/** マージの後の監視で、デプロイの確認の実行を待っているか（まだ始めていない。PBI-89）。 */
export function awaitingDeploymentCheck(task: Task): boolean {
  return (
    task.status !== "cancelled" &&
    task.deployment?.state === "waiting" &&
    task.deployment.phase === "check" &&
    task.deployment.check === undefined
  );
}

/** デプロイの確認を始めて、まだ結果を記録していないか（PBI-89）。 */
export function deploymentCheckRunning(task: Task): boolean {
  const watch = task.deployment;
  return (
    task.status !== "cancelled" &&
    watch?.state === "waiting" &&
    watch.phase === "check" &&
    watch.check !== undefined &&
    watch.check.result === undefined
  );
}

/** 監視で失敗を見つけ、修正のタスクを登録するかをまだ決めていないか（PBI-89）。 */
export function fixDecisionPending(task: Task): boolean {
  return (
    task.status !== "cancelled" &&
    task.deployment?.state === "failed" &&
    !task.deployment.fix &&
    !task.deployment.suppressed
  );
}

/**
 * 修正のタスクが、まだ終わっていないか（PBI-89。同じ失敗の修正のタスクを二重に作らないため）。中止していなくて、完了して
 * いないか、完了してもそのマージの監視を待っているもの。
 */
export function fixTaskOpen(task: Task): boolean {
  if (!task.fix || task.status === "cancelled") return false;
  return !isCompleted(task) || task.deployment?.state === "waiting";
}

/**
 * 工程が今実行中か（PBI-106。工程のイメージをいつから使うかの表示に使う）。エージェントの実行中、実装の検証（テスト・最終
 * レビュー）の間、再現の確かめの間。
 */
export function stepRunning(task: Task, step: StepKey): boolean {
  if (activeStep(task) !== step) return false;
  return (
    task.status === "running" ||
    // マージの後の監視の工程で、デプロイの確認を実行している（PBI-116）
    (step === "deployment" && deploymentCheckRunning(task)) ||
    (task.status === "idle" &&
      (task.verification !== undefined || task.reproductionPending === true))
  );
}

/** タスクの工程の組み合わせ（工程を選んだ後は選んだもの、選ぶ前は人が指定したもの）。 */
export function taskPlan(task: Task): StepPlan | undefined {
  return task.stepsChoice?.plan ?? task.requestedPlan;
}

/** セキュリティの組み合わせ（チェック・対応）のタスクか。レポート・対応の範囲を公開の場所に出さない。 */
export function isSecurityTask(task: Task): boolean {
  const plan = taskPlan(task);
  return plan === "security-check" || plan === "security-fix";
}

/**
 * セキュリティチェックのレポートの区分から、対応のタスクを頼めるか。レポートを人間が承認して完了した、中止していない
 * セキュリティチェックのタスクだけ。
 */
export function canRequestSecurityFix(task: Task): boolean {
  return (
    task.status !== "cancelled" &&
    taskPlan(task) === "security-check" &&
    investigationIsGoal(task) &&
    isCompleted(task)
  );
}

export function isCompleted(task: Task): boolean {
  return task.steps.length > 0 && task.steps.every((s) => s.state === "done" || s.state === "skip");
}

/**
 * 終わったタスクか（中止したか、工程をすべて終えて止まっている。PBI-114）。画面の状態の「完了」「中止」と同じ。承認待ち・
 * 一時停止・エスカレーション・テストや最終レビューの途中は、終わっていない。
 */
export function isFinished(task: Task): boolean {
  return task.status === "cancelled" || (task.status === "idle" && isCompleted(task));
}

/**
 * 対象リポジトリの無いタスクか（PBI-73）。リポジトリを指定せずに作り、まだリポジトリを決めていない（決めたら、ふつうの
 * リポジトリのあるタスクとして進む）。対象リポジトリを選ぶ前の版（PBI-21 より前）のタスクは含めない（理由を示して止める）。
 */
export function isRepoless(task: Task): boolean {
  return (
    task.noRepo === true &&
    !task.repo &&
    !task.source &&
    // チケットのタスクの再実行は、リポジトリを指定しないこともできる（チケットを読み直してリポジトリを選ばない）
    (!task.ticket || task.rerun !== undefined) &&
    task.repository === undefined
  );
}

/**
 * リポジトリを指定せずに作ったタスクで、作業するリポジトリを決められるか（PBI-73）。工程を決める前・リポジトリを用意する前
 * だけ。決めたリポジトリを用意できなかった（clone に失敗したなど）ときも、選び直せる。中止したタスクは含めない。
 */
export function awaitingRepository(task: Task): boolean {
  return (
    task.noRepo === true &&
    !task.source &&
    (!task.ticket || task.rerun !== undefined) &&
    task.steps.length === 0 &&
    task.repository === undefined &&
    task.status !== "cancelled"
  );
}

/**
 * 実装（不具合の修正では再現も）を含む工程を選んだのに、テストのコマンドも、テストの仕組みが無いという判断
 * （noTestsReason。PBI-94）も無いタスクか。検証できないので、工程を選んだ直後・検証の前に止まる。
 */
export function testsUndecided(task: Task): boolean {
  return (
    task.steps.some((s) => s.key === "implement" || s.key === "reproduce") &&
    !task.testCommand &&
    !task.noTestsReason
  );
}

/**
 * 最終レビューで、テストのコマンドに書いたツールがテストを実行するイメージに無くて止まったタスクか（PBI-158。
 * `verify.commandMissing`）。決まっているテストのコマンドが、このイメージでは実行できない。テストのコマンドが決まっている
 * （テストの仕組みが無いタスクの、実装が申告したコマンドは含めない）タスクだけ。
 */
export function testToolsMissing(task: Task): boolean {
  const stopped = task.pausedMessage;
  return (
    task.status === "paused" &&
    task.pausedReason === "error" &&
    typeof stopped === "object" &&
    stopped.code === "verify.commandMissing" &&
    Boolean(task.testCommand) &&
    !task.noTestsReason &&
    task.steps.some((s) => s.key === "implement" || s.key === "reproduce")
  );
}

/**
 * 最終レビューの前に、オーケストレーターが文書だけの依頼と判断した（documentsOnly。PBI-284）のに、実装の差分に文書でない
 * ファイルがあって止まったタスクか（`verify.documentsOnlyContradicted`）。コードの検証がテストのコマンドに入っていないので、
 * 人がテストの扱いを決めるまでは、再開しても同じ理由で止まる。
 */
export function documentsOnlyContradicted(task: Task): boolean {
  const stopped = task.pausedMessage;
  return (
    task.status === "paused" &&
    task.pausedReason === "error" &&
    typeof stopped === "object" &&
    stopped.code === "verify.documentsOnlyContradicted" &&
    task.documentsOnly === true &&
    task.steps.some((s) => s.key === "implement")
  );
}

/**
 * 人が再開のときにテストのコマンドかテストなしを決められるか（TestsDecided）。テストが決まらずに止まったタスクと、
 * 決まっているテストのコマンドのツールがイメージに無くて止まったタスク（PBI-158）、文書だけの依頼と判断したのに差分に
 * 文書でないファイルがあって止まったタスク（PBI-284）。
 */
export function canDecideTests(task: Task): boolean {
  return (
    task.status === "paused" &&
    (testsUndecided(task) || testToolsMissing(task) || documentsOnlyContradicted(task))
  );
}

/**
 * テストが決まらずに止まったタスクを、工程の選択からやり直せるか。工程を選んだ直後に止まり、まだどの工程の成果も無い
 * （実行中でもない）ときだけ。人がテストを決めずに再開したら、同じ工程のまま進めずに選び直す（TaskResumed の rechooseSteps）。
 */
export function canRechooseSteps(task: Task): boolean {
  return (
    canDecideTests(task) &&
    // ツールが無くて止まったタスク（PBI-158）は、工程の選択をやり直しても同じテストのコマンドになりうる。決め直すか、そのまま再開する
    !testToolsMissing(task) &&
    !documentsOnlyContradicted(task) &&
    task.resumeTo === "queued" &&
    task.currentRunId === undefined &&
    !task.operationAttempted &&
    task.steps.every((s) => s.state !== "done") &&
    Object.keys(task.outputs).length === 0 &&
    Object.keys(task.submissions).length === 0
  );
}

/**
 * 工程を実行するイメージの名前（PBI-318）。タスクのイメージ。無ければ、古い版の作業履歴の工程ごとのイメージ。どちらも
 * 無ければ undefined（既定のイメージ）。
 */
export function stepImageOf(
  task: Pick<Task, "image" | "images">,
  step: StepKey,
): string | undefined {
  return task.image ?? task.images?.[step];
}

/**
 * テストと最終レビューを実行するイメージの名前（PBI-318）。タスクのイメージ。無ければ、古い版の作業履歴の確かめる工程
 * （実装。無ければ再現）のイメージ。どちらも無ければ undefined（既定のイメージ）。
 */
export function verificationImageOf(task: Pick<Task, "image" | "images">): string | undefined {
  return task.image ?? task.images?.implement ?? task.images?.reproduce;
}

/** 工程の選択（StepsChosen）で決めたものを消す（工程の選択からやり直す）。予算の上限は残す。 */
function clearChosenSteps(task: Task): void {
  task.steps = [];
  task.stepsChoice = undefined;
  task.deploymentChoice = undefined;
  task.testCommand = undefined;
  task.noTestsReason = undefined;
  task.documentsOnly = undefined;
  task.testsDecidedBy = undefined;
  task.operation = undefined;
  task.investigation = undefined;
  task.image = undefined;
  task.images = undefined;
  // 人が変えたイメージ・工程ごとに変えたエージェントも、選んだ工程に結びつくので消す（作成時の指定は、選び直しで入れ直す）
  task.imageChange = undefined;
  task.imageChanges = undefined;
  // 作成時に指定したエージェントは、選び直した工程でも使う（イメージは、工程を選んだときに入れ直す）
  task.agents = task.requestedAgents;
  task.agentChanges = undefined;
  task.imageSource = undefined;
  task.defaultImageReason = undefined;
  task.imageUnexplained = undefined;
  task.defaultImageReasons = undefined;
  task.imagesUnexplained = undefined;
  task.services = undefined;
  task.servicesReason = undefined;
  task.exportPlans = undefined;
  task.documentsDir = undefined;
  task.continuedPullRequest = undefined;
}

/**
 * 再開で足せる補足の長さ（文字数。RESUME_NOTE_MAX まで）。補足のせいで、再実行の画面で直す説明（rerunEditableBody）が
 * TASK_BODY_MAX を新たに超えないようにする。再実行できない種類のタスク（子タスク・PR のタスク）と、補足を足す前から
 * 上限を超える説明（取り込んだ長い Issue など）は、補足が原因で直すことにはならないので、補足の上限だけにする。
 * 0 以下なら、補足を足せない。
 */
export function resumeNoteRoom(task: Task): number {
  if (!rerunnableKind(task)) return RESUME_NOTE_MAX;
  if (rerunEditableBody(task).length > TASK_BODY_MAX) return RESUME_NOTE_MAX;
  // 1文字の補足を足して測り、その分を引く（空の補足で測ると、記録の前の区切りが切り詰められて長さがずれる）
  const editable = rerunEditableBody({ ...task, body: bodyWithResumeNote(task, "x") }).length - 1;
  return Math.min(RESUME_NOTE_MAX, TASK_BODY_MAX - editable);
}

/**
 * 中止したタスクを再実行できるか。中止して、まだ再実行していないタスクだけ。分割で作った子タスク（親が進め方を決める）・
 * PR のレビューのタスク（PR で依頼し直す。PBI-44）は除く。
 */
export function canRerun(task: Task): boolean {
  return task.status === "cancelled" && task.rerunBy === undefined && rerunnableKind(task);
}

/**
 * 再実行できる種類のタスクか（状態は見ない）。分割で作った子タスク（親が進め方を決める）・PR のレビューのタスク（PR で
 * 依頼し直す。PBI-44）は再実行できない。canRerun と、再開の補足の長さ（resumeNoteRoom）で同じ判定を使う。
 */
export function rerunnableKind(task: Pick<Task, "parent" | "start">): boolean {
  return task.parent === undefined && task.start !== "github_pull_request";
}

/**
 * 完了したタスクから、続きの作業のタスクを作れるか（派生）。工程をすべて終えて止まっている（中止していない）タスクだけ。
 * 何度でも作れる。
 */
export function canDerive(task: Task): boolean {
  return task.status === "idle" && isCompleted(task);
}

/**
 * タスクの開始時の情報収集を待っているか。工程を選ぶ前で、まだ集めていないタスク。分割の子タスクは親のまとめを内容に
 * 持つので集めない。
 */
export function awaitingGathering(task: Task): boolean {
  return task.steps.length === 0 && task.gathered === undefined && task.parent === undefined;
}

/**
 * チケットから取り込んだタスクで、オーケストレーターがチケットを読む（リポジトリ・題・概要を決める）のを待っているか
 * （PBI-52）。人がリポジトリを選んだ後も、そのリポジトリで題と概要を書くために、もう一度読む。
 */
export function awaitingTicketTriage(task: Task): boolean {
  return (
    task.ticket !== undefined &&
    // 再実行で作ったタスクは、人が作業するリポジトリ・題・説明を決めた（チケットを読み直さない）
    task.rerun === undefined &&
    task.steps.length === 0 &&
    task.repository === undefined &&
    (!task.repo || task.ticketTriage?.by === "person")
  );
}

/**
 * 実装の提出が、実装に変更が無く PR を作らなかった提出回か（PBI-90・PBI-110）。承認待ちなら人間が変更なしで完了にするかを
 * 判断し、完了していれば変更なしで完了した。
 */
export function deliveredWithoutChanges(task: Task): boolean {
  const submission = task.noChanges?.submission;
  if (submission === undefined || task.pullRequest) return false;
  return task.submissions.implement === submission;
}

/**
 * 取り込んだ指摘の項目のうち、AI のレビューの指摘の位置（offset から数える）ごとの、投稿したレビューのタスクと回（PBI-332）。
 */
function reviewFromOf(
  items: readonly { source?: "sacty_review"; review?: string }[],
  offset: number,
): Record<string, string> {
  return Object.fromEntries(
    items.flatMap((item, i) =>
      item.source === "sacty_review" && item.review ? [[String(offset + i), item.review]] : [],
    ),
  );
}
