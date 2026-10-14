import { budgetState } from "./cost.js";
import type {
  ActivityEvent,
  ExportPlan,
  InvestigationKind,
  OrchestratorSessionReason,
  ParsedEventInput,
  PauseReason,
  Remark,
  ReviewComment,
  StepKey,
  StepPlan,
  StepPullRequestKey,
  TaskSource,
  TestMapping,
  TestViewpoint,
  Verdict,
} from "./events.js";
import {
  DEFAULT_DOCUMENTS_DIR,
  EXPORT_STEPS,
  exportSteps,
  isDocumentsDir,
  MAX_INTEGRATION_ATTEMPTS,
  REWORK_STEPS,
} from "./events.js";
import { type DaemonText, message } from "./message-code.js";
import type { DaemonMessage } from "./messages.js";

type PayloadOf<T extends ParsedEventInput["type"]> = Extract<
  ParsedEventInput,
  { type: T }
>["payload"];

export type TestsRunResult = PayloadOf<"TestsRun"> & { at: string };
export type FinalReview = PayloadOf<"FinalReviewed"> & { at: string };
export type IntegrationReview = PayloadOf<"IntegrationReviewed"> & { at: string };

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
  /** 工程エージェントの、最新の提出での対応。最新の提出で回答がなければ未回答（undefined）。 */
  response?: string;
  /** 対応を書いた提出回。 */
  respondedIn?: number;
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

export type Task = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  start: "sacty" | "github_issue" | "github_pull_request" | "split" | "jira";
  /** 取り込み元（GitHub Issue）。 */
  source?: TaskSource;
  /** 取り込み元のチケット（JIRA など。PBI-52）。 */
  ticket?: { platform: string; service: "jira-cloud" | "jira-server"; key: string; url: string };
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
  status: TaskStatus;
  /** 分割で作った子タスクの親と、依存先の子タスク（PBI-27）。 */
  parent?: { taskId: string; dependsOn: string[] };
  /** タスク分割で決めた子タスク（PBI-27）。 */
  split?: {
    /**
     * 子タスク（内容は、デーモンが止まって作れなかった子タスクを作り直すために持つ）。round は何回目の
     * 分割で作ったか（1 が最初の分割、2 以降は統合レビューの後に追加した修正の子タスク。PBI-31）。
     */
    children: { taskId: string; title: string; body: string; dependsOn: string[]; round: number }[];
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
  resumeTo?: "queued" | "idle" | "waiting_children";
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
  };
  currentRunId?: string;
  /** 承認ゲートで止まっている工程と、何回目の提出か。 */
  gate?: { step: StepKey; submission: number };
  /** 工程ごとの提出回数。 */
  submissions: Partial<Record<StepKey, number>>;
  remarks: TaskRemark[];
  /** 変更の申し出（古い順）。 */
  proposals: TaskProposal[];
  /** 実装の対象リポジトリ。 */
  repository?: PayloadOf<"RepositoryPrepared">;
  /** 実装の最新の提出が申告した、観点とテストの対応。 */
  testMap: TestMapping[];
  /**
   * 実装の検証の進み具合。pending：テストの実行待ち、tests_passed：最終レビュー待ち。
   * 検証が終わる（合格・不合格）と undefined に戻る。
   */
  verification?: "pending" | "tests_passed";
  /** 検証が続けて通らなかった回数。人間が再開するか、検証に通ると0に戻る。 */
  verifyFailures: number;
  /** 最新のテストの実行結果と、最終レビュー。 */
  lastTests?: TestsRunResult;
  lastReview?: FinalReview;
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
  pullRequest?: PayloadOf<"PullRequestPublished">;
  /** 成果物チェックの間に見守っている PR の状態（PBI-14a）。PR を作っていなければ無い。 */
  pullRequestState?: "open" | "closed" | "merged" | "merged_outdated";
  /** 実装の PR のマージの記録（PBI-63）。 */
  pullRequestMerge?: PullRequestMerge;
  /**
   * タスクブランチ（PBI-57）。これがあるタスクは、要求要件・設計をタスクブランチへの PR のマージで承認し、実装の PR を
   * タスクブランチからベースブランチに向けて作る。
   */
  taskBranch?: PayloadOf<"TaskBranchCreated">;
  /** 要求要件・設計の PR（作った順。同じ PR を更新したら、その PR を置き換える。PBI-57）。 */
  stepPullRequests: StepPullRequest[];
  /** sacty がプッシュした、要求要件・設計のブランチ（中止で消す。PBI-57）。 */
  stepBranches: string[];
  /** 要求要件・設計の成果のファイルを置くディレクトリ（オーケストレーターが決めた。無ければ既定。PBI-57）。 */
  documentsDir?: string;
  /** ゴールガーディアンの見逃し（最終レビューで合格にした成果物を、人間が差し戻した）。 */
  misses: (PayloadOf<"GuardianMissed"> & { at: string })[];
  /** やり直しの実装に渡す、直前の検証で通らなかった内容。 */
  verifyFeedback?:
    | { kind: "tests"; tests: TestsRunResult }
    | { kind: "review"; review: FinalReview };
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
  /** レビューの工程の対象の PR（PBI-19）。 */
  reviewTarget?: PayloadOf<"ReviewTargetResolved">;
  /** レビューの工程が書いた、PR の行へのコメント（PBI-19）。 */
  reviewComments: ReviewComment[];
  /** 再現の工程が申告した、再現のテスト（PBI-29）。 */
  reproductionTests: string[];
  /** 再現の工程の後、sacty がテストで再現を確かめる前（PBI-29）。 */
  reproductionPending?: boolean;
  /** 最新の、再現の確かめの結果（PBI-29）。 */
  reproduction?: PayloadOf<"ReproductionChecked"> & { at: string };
  /** レビューの結果を投稿した、PR のレビューの URL（PBI-19）。 */
  reviewPost?: { url: string };
  /** 何回目のレビューか（「再レビュー」で2回目から。最初のレビューでは無い。PBI-44）。 */
  reviewRound?: number;
  /** オーケストレーターが決めた、テストのコマンド（PBI-25）。 */
  testCommand?: string;
  /** オーケストレーターが判断した、調査の工程の性質（PBI-43）。無ければ内容の調査として扱う。 */
  investigation?: InvestigationKind;
  /** 工程ごとに使うイメージの名前（PBI-41）。書いていない工程は既定のイメージ。 */
  images?: Partial<Record<StepKey, string>>;
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
  /** オーケストレーターへの質問と答え（古い順。PBI-54）。 */
  questions: TaskQuestion[];
  /** 取り込んで、まだ差し戻しに反映していない PR の指摘と、ゴールガーディアンの戻し先の判断。 */
  pendingReview?: {
    keys: string[];
    remarks: string[];
    judgement?: { target?: StepKey; reason: DaemonText };
  };
  /**
   * 最後に PR の指摘で差し戻した戻し先と、ゴールガーディアンの判断の理由（PBI-58）。decided が false なら、
   * 戻し先を判断できなかったので実装をやり直した。人間が戻し先を確かめた作業履歴（PBI-14b）には無い。
   */
  prRework?: { target: StepKey; decided: boolean; reason: DaemonText; at: string };
  createdAt: string;
  updatedAt: string;
};

/** 前の工程からやり直す。その工程を実行対象にし、その工程から先の承認は取り消す。 */
function reopen(task: Task, target: StepKey) {
  const to = task.steps.findIndex((s) => s.key === target);
  task.steps = task.steps.map((s, i) => {
    if (i === to) return { ...s, state: "active" as const };
    if (i > to) return { ...s, state: "todo" as const };
    return s;
  });
  // 前の工程からやり直すので、実装の検証の途中経過と失敗の回数は持ち越さない
  task.verification = undefined;
  task.verifyFeedback = undefined;
  task.verifyFailures = 0;
  const keep = new Set(task.steps.slice(0, to).map((s) => s.key));
  task.approved = Object.fromEntries(
    Object.entries(task.approved).filter(([key]) => keep.has(key as StepKey)),
  );
}

class ActivityIntegrityError extends Error {
  constructor(event: ActivityEvent, detail: string) {
    super(`${event.type} (seq ${event.seq}) on task ${event.taskId}: ${detail}`);
  }
}

/** 検証に通らなかった。失敗の内容を渡して、実装をやり直す（実行待ちに戻す）。 */
function failVerification(task: Task, feedback: NonNullable<Task["verifyFeedback"]>) {
  task.verification = undefined;
  task.verifyFailures += 1;
  task.verifyFeedback = feedback;
  task.status = "queued";
}

function findProposal(task: Task, event: ActivityEvent, id: string): TaskProposal {
  const proposal = task.proposals.find((p) => p.id === id);
  if (!proposal) throw new ActivityIntegrityError(event, `unknown proposal ${id}`);
  return proposal;
}

function updateProposal(task: Task, id: string, patch: Partial<TaskProposal>) {
  task.proposals = task.proposals.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

/** 浮動小数の誤差を、費用の表示や比較に影響しない桁で丸める。 */
function addUsd(a: number, b: number): number {
  return Math.round((a + b) * 1e6) / 1e6;
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
    next.set(event.taskId, {
      id: event.taskId,
      projectId: event.projectId,
      title: event.payload.title,
      body: event.payload.body,
      start: event.payload.start,
      ...(event.payload.source ? { source: event.payload.source } : {}),
      ...(event.payload.ticket ? { ticket: event.payload.ticket } : {}),
      ...(event.payload.repo ? { repo: event.payload.repo } : {}),
      ...(event.payload.parent ? { parent: event.payload.parent } : {}),
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
      task.steps = event.payload.steps.map((key, i) => ({
        key,
        state: i === 0 ? ("active" as const) : ("todo" as const),
      }));
      // オーケストレーターの判断の費用は、タスクの予算に入れる（PBI-17）
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      if (event.payload.testCommand) task.testCommand = event.payload.testCommand;
      if (event.payload.investigation) task.investigation = event.payload.investigation;
      if (event.payload.images) task.images = event.payload.images;
      if (event.payload.services) task.services = event.payload.services;
      if (event.payload.servicesReason) task.servicesReason = event.payload.servicesReason;
      if (event.payload.exports) task.exportPlans = event.payload.exports;
      if (event.payload.documentsDir) task.documentsDir = event.payload.documentsDir;
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
      task.status = "running";
      task.currentRunId = event.payload.runId;
      break;

    case "AgentRunCompleted":
    case "AgentRunFailed": {
      if (task.currentRunId !== event.payload.runId) {
        throw new ActivityIntegrityError(event, "run id does not match the running run");
      }
      // 失敗した実行は、再開したときにやり直すので実行待ちに戻す
      task.status = event.type === "AgentRunCompleted" ? "idle" : "queued";
      task.currentRunId = undefined;
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      if (event.type === "AgentRunCompleted") {
        // 承認済みの成果物は凍結されている。変えるには、人間が差し戻して承認を取り消す必要がある
        if (task.approved[event.payload.step]) {
          throw new ActivityIntegrityError(event, "the step is already approved (frozen)");
        }
        if (event.payload.step === "design") task.testViewpoints = event.payload.testViewpoints;
        if (event.payload.step === "review") task.reviewComments = event.payload.reviewComments;
        if (event.payload.step === "reproduce") {
          task.reproductionTests = event.payload.reproductionTests;
          task.reproductionPending = true;
        }
        if (event.payload.step === "implement") {
          task.testMap = event.payload.testMap;
          task.verification = "pending";
        }
        task.outputs = { ...task.outputs, [event.payload.step]: event.payload.output };
        // その工程の有効な指摘は、今回の提出で回答がなければ未回答に戻す
        // （前回の対応文が残ると、最新の成果物への対応だと誤認して承認してしまうため）
        const step = event.payload.step;
        // 実装は、成果物チェック（PR作成のゲート）の提出として人間に示す
        const shownAt = step === "implement" ? "pr" : step;
        const submission = (task.submissions[shownAt] ?? 0) + 1;
        const responses = new Map(event.payload.responses.map((r) => [r.remarkId, r.text]));
        task.remarks = task.remarks.map((r) => {
          if (r.step !== step || r.voided) return r;
          const text = responses.get(r.id);
          return text === undefined
            ? { ...r, response: undefined, respondedIn: undefined }
            : { ...r, response: text, respondedIn: submission };
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
      const index = task.steps.findIndex((s) => s.key === event.payload.step);
      task.steps = task.steps.map((s, i) => {
        if (i === index) return { ...s, state: "done" as const };
        if (i === index + 1) return { ...s, state: "active" as const };
        return s;
      });
      const step = event.payload.step;
      const submitted = task.outputs[step] ?? "";
      // 人が PR の中で直してからマージした（PBI-63）。要求要件・設計は、人が直したファイルの内容を承認済みの成果にする
      // （後の工程は、人が直した版を読む。差し戻されたときも、人が直した版から作り直す）
      const merge = gateMerge(task);
      const final = merge?.document?.final;
      const output = final !== undefined ? documentOutput(final) : submitted;
      if (final !== undefined) task.outputs = { ...task.outputs, [step]: output };
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
      break;
    }

    case "StepCompleted": {
      if (task.status !== "idle" || activeStep(task) !== event.payload.step) {
        throw new ActivityIntegrityError(event, "the completed step is not the active step");
      }
      const index = task.steps.findIndex((s) => s.key === event.payload.step);
      task.steps = task.steps.map((s, i) => {
        if (i === index) return { ...s, state: "done" as const };
        if (i === index + 1) return { ...s, state: "active" as const };
        return s;
      });
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
      if (task.status !== "awaiting_approval" && task.status !== "escalated") {
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
          voided: false,
        })),
      ];
      task.status = "queued";
      task.gate = undefined;
      task.escalation = undefined;
      // 統合レビューの承認待ちで差し戻したら、修正の子タスクを追加して、統合レビューの回数を数え直す（PBI-31）
      if (event.payload.step === "integrate") task.integrationFailures = 0;
      // PR の指摘は、この差し戻しに反映した。ゴールガーディアンの判断で戻したなら、戻し先と理由を残す（PBI-58）。
      // 判断の後に人間が別の差し戻しをした（再起動の前など）なら、ゴールガーディアンの判断としては残さない
      const judged = task.pendingReview?.judgement;
      // 判断できなければ、その工程をやり直す（成果物チェックなら実装、要求要件・設計の PR ならその工程。PBI-57）
      const undecided = event.payload.step === "pr" ? "implement" : event.payload.step;
      if (
        judged &&
        target === (judged.target ?? undecided) &&
        JSON.stringify(event.payload.remarks.map((r) => r.text)) ===
          JSON.stringify(task.pendingReview?.remarks)
      ) {
        task.prRework = {
          target,
          decided: judged.target !== undefined,
          reason: judged.reason,
          at: event.at,
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
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      updateProposal(task, proposal.id, {
        judgement: { verdict: event.payload.verdict, reason: event.payload.reason, at: event.at },
      });
      break;
    }

    case "ChangeDecided": {
      const proposal = findProposal(task, event, event.payload.proposalId);
      if (task.status !== "escalated" || proposal.judgement?.verdict !== "undecidable") {
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
      if (proposal.target === "design" && proposal.testViewpoints) {
        task.testViewpoints = proposal.testViewpoints;
      }
      updateProposal(task, proposal.id, { applied: true });
      break;
    }

    case "RepositoryPrepared":
      task.repository = event.payload;
      break;

    case "TestsRun": {
      if (task.status !== "idle" || task.verification !== "pending") {
        throw new ActivityIntegrityError(event, "tests are not pending");
      }
      const tests = { ...event.payload, at: event.at };
      task.lastTests = tests;
      if (event.payload.passed) {
        task.verification = "tests_passed";
      } else {
        failVerification(task, { kind: "tests", tests });
      }
      break;
    }

    case "FinalReviewed": {
      if (task.status !== "idle" || task.verification !== "tests_passed") {
        throw new ActivityIntegrityError(event, "final review is not pending");
      }
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      const review = { ...event.payload, at: event.at };
      task.lastReview = review;
      if (!event.payload.passed) {
        failVerification(task, { kind: "review", review });
        break;
      }
      // 検証に通った。実装の工程を完了にし、次の工程へ進む
      const index = task.steps.findIndex((s) => s.key === "implement");
      task.steps = task.steps.map((s, i) => {
        if (i === index) return { ...s, state: "done" as const };
        if (i === index + 1) return { ...s, state: "active" as const };
        return s;
      });
      task.verification = undefined;
      task.verifyFailures = 0;
      task.verifyFeedback = undefined;
      // 次の工程（PR作成）は sacty が実行するので、実行待ちにする
      if (task.steps[index + 1]) task.status = "queued";
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
      task.pausedReason = undefined;
      task.pausedMessage = undefined;
      task.unstoppedRuns = undefined;
      task.resumeTo = undefined;
      task.pausedCancelledChildren = undefined;
      break;

    case "PullRequestPublished":
      if (task.status !== "queued" || activeStep(task) !== "pr") {
        throw new ActivityIntegrityError(event, "the pr step is not running");
      }
      task.pullRequest = event.payload;
      // 作り直した・更新した PR は、開いているものとして見守り直す
      task.pullRequestState = event.payload.number ? "open" : undefined;
      task.pullRequestMerge = undefined;
      task.status = "idle";
      break;

    case "PullRequestReviewImported": {
      // 成果物チェックの PR と、要求要件・設計の PR（PBI-57）の指摘
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
      task.pendingReview = { keys, remarks: event.payload.remarks };
      break;
    }

    case "ReworkJudged": {
      if (!task.pendingReview || task.pendingReview.judgement) {
        throw new ActivityIntegrityError(event, "no review is waiting for a judgement");
      }
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      task.pendingReview = {
        ...task.pendingReview,
        judgement: {
          ...(event.payload.target ? { target: event.payload.target } : {}),
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
      task.reviewPost = { url: event.payload.url };
      break;
    }

    case "ReviewRestarted":
      // レビューを投稿して完了したタスクだけ。前回の対象・行へのコメント・投稿は持ち越さない（PBI-44）
      if (!canRereview(task)) throw new ActivityIntegrityError(event, "no posted review to redo");
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

    case "PullRequestMerged":
    case "PullRequestClosed":
    case "PullRequestReopened": {
      // 見守るのは、承認ゲートで待っている、sacty が作った PR だけ（成果物チェックと、要求要件・設計。PBI-57）
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
      if (watched.step === "pr") {
        task.pullRequestState = state;
        if (merge) task.pullRequestMerge = merge;
      } else {
        task.stepPullRequests = task.stepPullRequests.map((p) =>
          p.number === watched.number ? { ...p, state, ...(merge ? { merge } : {}) } : p,
        );
      }
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
      if (activeStep(task) !== "pr")
        throw new ActivityIntegrityError(event, "the pr step is not active");
      task.pushedBranch = event.payload;
      break;

    case "AiRequestsRetried":
      // 記録だけ（作業履歴で確かめる。PBI-37）
      break;

    case "AgentSessionArchived":
      // 記録だけ（写したファイルのハッシュを、画面と API で確かめる。PBI-66）。中止したタスクの状態は変えない
      if (current.status === "cancelled") return next;
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

    // チケットから作業するリポジトリ・題・概要を決めた（PBI-52）。工程を選ぶ前だけ
    case "TicketTriaged":
      if (!task.ticket || task.steps.length > 0) {
        throw new ActivityIntegrityError(event, "not a ticket task waiting for triage");
      }
      task.repo = event.payload.repo;
      if (event.payload.title) task.title = event.payload.title;
      if (event.payload.body !== undefined) task.body = event.payload.body;
      task.ticketTriage = {
        reason: event.payload.reason,
        by: event.actor === "person" ? "person" : "orchestrator",
      };
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
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
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
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
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, p.costUsd),
        estimated: task.budget.estimated || p.estimated,
      };
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
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      break;

    case "FinalReviewFailed":
      if (task.status !== "idle" || task.verification !== "tests_passed") {
        throw new ActivityIntegrityError(event, "final review is not pending");
      }
      task.budget = {
        ...task.budget,
        usedUsd: addUsd(task.budget.usedUsd, event.payload.costUsd),
        estimated: task.budget.estimated || event.payload.estimated,
      };
      break;

    case "TaskEscalated":
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
      if (
        task.status !== "queued" &&
        task.status !== "idle" &&
        task.status !== "waiting_children"
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
        const index = task.steps.findIndex((s) => s.key === "reproduce");
        task.steps = task.steps.map((s, i) => {
          if (i === index) return { ...s, state: "done" as const };
          if (i === index + 1) return { ...s, state: "active" as const };
          return s;
        });
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
      break;

    case "SplitCompleted":
      if (task.status !== "waiting_children" || activeStep(task) !== "split") {
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      }
      {
        const index = task.steps.findIndex((s) => s.key === "split");
        task.steps = task.steps.map((s, i) => {
          if (i === index) return { ...s, state: "done" as const };
          if (i === index + 1) return { ...s, state: "active" as const };
          return s;
        });
        // 統合レビュー（PBI-31）へ進む。それより前に分割したタスクは、これで完了する
        task.status = task.steps[index + 1] ? "queued" : "idle";
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

    case "BudgetCapRaised":
      if (event.payload.capUsd <= task.budget.usedUsd) {
        throw new ActivityIntegrityError(event, "new cap must exceed the amount spent");
      }
      task.budget = { ...task.budget, capUsd: event.payload.capUsd };
      break;

    case "TaskResumed":
      if (task.status !== "paused")
        throw new ActivityIntegrityError(event, `status ${task.status}`);
      task.status =
        task.resumeTo === "waiting_children"
          ? "waiting_children"
          : event.payload.retry
            ? "queued"
            : "idle";
      // 人間が再開したら、検証の失敗の回数を数え直す
      if (task.pausedReason === "verification") task.verifyFailures = 0;
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
      task.unstoppedRuns = undefined;
      task.resumeTo = undefined;
      break;
  }

  next.set(event.taskId, task);
  return next;
}

/** 作業履歴のイベント列から、すべてのタスクの状態を復元する。 */
export function project(events: Iterable<ActivityEvent>): Map<string, Task> {
  let tasks = new Map<string, Task>();
  let lastSeq = 0;
  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new Error(`activity is out of order at seq ${event.seq}`);
    }
    lastSeq = event.seq;
    tasks = applyEvent(tasks, event);
  }
  return tasks;
}

/**
 * 承認ゲートで見守っている、sacty が作った PR（PBI-14a・PBI-57）。成果物チェックなら実装の PR、要求要件・設計なら
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
  if (gate.step === "pr") {
    const pr = task.pullRequest;
    if (!pr?.number) return undefined;
    return {
      step: "pr",
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

/** 承認ゲートで見守っている PR の、マージの記録（PBI-63）。マージされていなければ undefined。 */
function gateMerge(task: Task): PullRequestMerge | undefined {
  const watched = gatePullRequest(task);
  if (!watched) return undefined;
  if (watched.step === "pr") return task.pullRequestMerge;
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

/**
 * 承認した版をまだ書き出していない（人間が書き出し直しを求めた）工程（PBI-56）。決めた書き出し先がある、書き出せる
 * 工程だけ。タスクの状態は見ない（取り込み元へのコメントを、書き出しの後にするため）。
 */
export function exportDue(task: Task): StepKey | undefined {
  if (task.status === "cancelled") return undefined;
  return exportSteps(task.steps.map((s) => s.key)).find((step) => {
    const approved = task.approved[step];
    if (!task.exportPlans?.[step]?.to || !approved) return false;
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

/** その工程で、これまでに何回差し戻されたか。 */
export function changeRounds(task: Task, step: StepKey): number {
  return task.remarks.filter((r) => r.step === step).reduce((max, r) => Math.max(max, r.round), 0);
}

/** 判定中、または人間の判断待ちの変更の申し出。 */
export function openProposal(task: Task): TaskProposal | undefined {
  return task.proposals.find(
    (p) => !p.judgement || (p.judgement.verdict === "undecidable" && !p.decision),
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
  // 統合レビューの承認待ちで差し戻すと、タスク分割をやり直して修正の子タスクを追加する（PBI-31）。
  // 親の要求要件・設計は、子タスクが作られた後なので戻さない
  if (gateStep === "integrate") return task.steps.some((s) => s.key === "split") ? ["split"] : [];
  const index = task.steps.findIndex((s) => s.key === gateStep);
  return (
    task.steps
      .filter((s, i) => i <= index && REWORK_STEPS.includes(s.key))
      // 再現は、実装した後のコードでは再現できないので、再現の判断待ちのときだけやり直せる。
      // 前段の調査は人間が承認しない工程なので、調査そのものが目的のとき（調査の承認待ち）だけ（PBI-29）
      .filter((s) => (s.key !== "reproduce" && s.key !== "investigate") || gateStep === s.key)
      .map((s) => s.key)
      .reverse()
  );
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

export function isCompleted(task: Task): boolean {
  return task.steps.length > 0 && task.steps.every((s) => s.state === "done" || s.state === "skip");
}

/**
 * チケットから取り込んだタスクで、オーケストレーターがチケットを読む（リポジトリ・題・概要を決める）のを待っているか
 * （PBI-52）。人がリポジトリを選んだ後も、そのリポジトリで題と概要を書くために、もう一度読む。
 */
export function awaitingTicketTriage(task: Task): boolean {
  return (
    task.ticket !== undefined &&
    task.steps.length === 0 &&
    task.repository === undefined &&
    (!task.repo || task.ticketTriage?.by === "person")
  );
}
