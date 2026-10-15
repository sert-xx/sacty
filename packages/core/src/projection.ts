import { budgetState, chargeBudget } from "./cost.js";
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
  TaskTemplate,
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

export type Task = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  start: "sacty" | "github_issue" | "github_pull_request" | "split" | "jira" | "deployment";
  /** マージの後の監視で見つけた失敗の、修正のタスク（PBI-89）。元のタスクと、何段目か。 */
  fix?: PayloadOf<"TaskCreated">["fix"];
  /** 実装の PR のマージの後の、CI/CD とデプロイの監視（PBI-89）。 */
  deployment?: DeploymentWatch;
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
  /**
   * 実装が検証（テストと最終レビュー）に通り、sacty が実装の PR を作るのを待っている（PBI-110）。実行待ちのまま、実装の工程の
   * 中で PR を作り、実装の承認待ちにする。PR を作る（変更が無いと分かる）か、前の工程からやり直すと無くなる。
   */
  publishPending?: true;
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
  /** 実装の承認待ちの間に見守っている、実装の PR の状態（PBI-14a・PBI-110）。PR を作っていなければ無い。 */
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
  /**
   * sacty が作った PR に、取り込むラベルを付けた・付けられなかった記録（PR ごとに1件。PBI-88）。記録のある PR には、
   * 更新しても付け直さない。
   */
  pullRequestLabels?: PullRequestLabel[];
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
  /**
   * レビューの工程の、回ごとの評価（PBI-88）。changesRequested が true：直すべき指摘がある（評価か、行についての指摘）、
   * false：そのままマージしてよい、無い：評価を読めなかった。
   */
  reviewVerdicts?: { round: number; changesRequested?: boolean }[];
  /** 何回目のレビューか（「再レビュー」で2回目から。最初のレビューでは無い。PBI-44）。 */
  reviewRound?: number;
  /** オーケストレーターが決めた、テストのコマンド（PBI-25）。 */
  testCommand?: string;
  /**
   * オーケストレーターが、対象リポジトリにテストの仕組みが無いと判断した根拠（PBI-94）。これがあるタスクは、テストの
   * コマンドが無くても進め、実装の検証でテストを飛ばして、ゴールガーディアンがタスクの目的から判定する。
   */
  noTestsReason?: string;
  /** テストの仕組みが無いタスクで、実装の最新の提出が用意して申告した、テストのコマンド（PBI-94）。 */
  addedTestCommand?: string;
  /** 最新の検証で、テストのコマンドが無いのでテストを飛ばした時刻（PBI-94）。テストを実行すると無くなる。 */
  testsSkippedAt?: string;
  /** オーケストレーターが判断した、調査の工程の性質（PBI-43）。無ければ内容の調査として扱う。 */
  investigation?: InvestigationKind;
  /** 工程ごとに使うイメージの名前（PBI-41）。書いていない工程は既定のイメージ。人が変えたら、変えた名前（PBI-106）。 */
  images?: Partial<Record<StepKey, string>>;
  /** 工程を選んだときにイメージを決めたのが、プロジェクトの対象の指定か、オーケストレーターか（PBI-41）。 */
  imageSource?: "project" | "orchestrator";
  /** オーケストレーターが既定のイメージにした工程と、images のどれも合わない理由（PBI-105）。 */
  defaultImageReasons?: Partial<Record<StepKey, string>>;
  /** images の候補を見せたのに、理由が無いまま既定のイメージにした工程（PBI-105）。 */
  imagesUnexplained?: StepKey[];
  /** 人がタスクの詳細で変えた、工程のイメージ（PBI-106）。工程ごとに最後の変更。 */
  imageChanges?: Partial<Record<StepKey, { from: string; to: string; at: string }>>;
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
  task.publishPending = undefined;
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
      ...(event.payload.noRepo ? { noRepo: true as const } : {}),
      ...(event.payload.repo && event.payload.repoReason
        ? { repoChoice: { reason: event.payload.repoReason, by: "orchestrator" as const } }
        : {}),
      ...(event.payload.parent ? { parent: event.payload.parent } : {}),
      ...(event.payload.template ? { template: event.payload.template } : {}),
      ...(event.payload.fix ? { fix: event.payload.fix } : {}),
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
      if (event.payload.testCommand) task.testCommand = event.payload.testCommand;
      if (event.payload.noTestsReason && !event.payload.testCommand) {
        task.noTestsReason = event.payload.noTestsReason;
      }
      if (event.payload.investigation) task.investigation = event.payload.investigation;
      if (event.payload.images) task.images = event.payload.images;
      if (event.payload.images && event.payload.imageSource) {
        task.imageSource = event.payload.imageSource;
      }
      if (event.payload.defaultImageReasons) {
        task.defaultImageReasons = event.payload.defaultImageReasons;
      }
      if (event.payload.imagesUnexplained) task.imagesUnexplained = event.payload.imagesUnexplained;
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
      if (event.type === "AgentRunCompleted") {
        // 承認済みの成果物は凍結されている。変えるには、人間が差し戻して承認を取り消す必要がある
        if (task.approved[event.payload.step]) {
          throw new ActivityIntegrityError(event, "the step is already approved (frozen)");
        }
        if (event.payload.step === "design") task.testViewpoints = event.payload.testViewpoints;
        if (event.payload.step === "review") {
          task.reviewComments = event.payload.reviewComments;
          // 回ごとの評価（PBI-88）。同じ回をやり直したら置き換える
          const round = task.reviewRound ?? 1;
          task.reviewVerdicts = [
            ...(task.reviewVerdicts ?? []).filter((v) => v.round !== round),
            {
              round,
              ...(event.payload.reviewChangesRequested !== undefined
                ? { changesRequested: event.payload.reviewChangesRequested }
                : {}),
            },
          ];
        }
        if (event.payload.step === "reproduce") {
          task.reproductionTests = event.payload.reproductionTests;
          task.reproductionPending = true;
        }
        if (event.payload.step === "implement") {
          task.testMap = event.payload.testMap;
          task.addedTestCommand = event.payload.testCommand;
          task.verification = "pending";
        }
        task.outputs = { ...task.outputs, [event.payload.step]: event.payload.output };
        // その工程の有効な指摘は、今回の提出で回答がなければ未回答に戻す
        // （前回の対応文が残ると、最新の成果物への対応だと誤認して承認してしまうため）
        const step = event.payload.step;
        const submission = (task.submissions[step] ?? 0) + 1;
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
      if (task.status !== "idle" || task.verification !== "tests_passed") {
        throw new ActivityIntegrityError(event, "final review is not pending");
      }
      const review = { ...event.payload, at: event.at };
      task.lastReview = review;
      if (!event.payload.passed) {
        failVerification(task, { kind: "review", review });
        break;
      }
      // 検証に通った。実装の工程の中で、sacty が実装の PR を作るので、実行待ちにする（PBI-110。工程は進めない。
      // PR を作ったら実装の承認待ちになり、PR のマージで実装を承認する）
      task.verification = undefined;
      task.verifyFailures = 0;
      task.verifyFeedback = undefined;
      task.publishPending = true;
      task.status = "queued";
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
      task.pausedReason = undefined;
      task.pausedMessage = undefined;
      task.unstoppedRuns = undefined;
      task.resumeTo = undefined;
      task.pausedCancelledChildren = undefined;
      break;

    case "PullRequestPublished":
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
      task.status = "idle";
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
      task.pendingReview = { keys, remarks: event.payload.remarks };
      break;
    }

    case "ReworkJudged": {
      if (!task.pendingReview || task.pendingReview.judgement) {
        throw new ActivityIntegrityError(event, "no review is waiting for a judgement");
      }
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
      if (activeStep(task) !== "implement" || !task.publishPending) {
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
      if (task.status !== "idle" || task.verification !== "tests_passed") {
        throw new ActivityIntegrityError(event, "final review is not pending");
      }
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

    // 人が工程のイメージを変えた（PBI-106）。工程の状態は問わず、変えず、その工程を次に実行するときから使う
    case "StepImageChanged": {
      const { step, from, to } = event.payload;
      if (!task.steps.some((s) => s.key === step)) {
        throw new ActivityIntegrityError(event, `step ${step} is not chosen`);
      }
      task.images = { ...task.images, [step]: to };
      task.imageChanges = { ...task.imageChanges, [step]: { from, to, at: event.at } };
      break;
    }

    case "BudgetCapRaised":
      if (event.payload.capUsd <= task.budget.usedUsd) {
        throw new ActivityIntegrityError(event, "new cap must exceed the amount spent");
      }
      task.budget = { ...task.budget, capUsd: event.payload.capUsd };
      break;

    // マージの後の監視（PBI-89）。タスクの状態・工程は変えない
    case "DeploymentWatchStarted": {
      if (task.deployment) throw new ActivityIntegrityError(event, "the watch has started");
      if (task.pullRequestState !== "merged" || !isCompleted(task)) {
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

  // 費用を持つイベント（CHARGED_EVENT_TYPES）の費用を、タスクの予算に入れる（PBI-86。画面の工程ごとの費用の表と同じ規則）。
  // 受け付けない並び（上の検査で投げる）の費用は入れない
  task.budget = chargeBudget(task.budget, event);
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
    (task.status === "idle" &&
      (task.verification !== undefined || task.reproductionPending === true))
  );
}

export function isCompleted(task: Task): boolean {
  return task.steps.length > 0 && task.steps.every((s) => s.state === "done" || s.state === "skip");
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
    !task.ticket &&
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
    !task.ticket &&
    task.steps.length === 0 &&
    task.repository === undefined &&
    task.status !== "cancelled"
  );
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

/**
 * 実装の提出が、実装に変更が無く PR を作らなかった提出回か（PBI-90・PBI-110）。承認待ちなら人間が変更なしで完了にするかを
 * 判断し、完了していれば変更なしで完了した。
 */
export function deliveredWithoutChanges(task: Task): boolean {
  const submission = task.noChanges?.submission;
  if (submission === undefined || task.pullRequest) return false;
  return task.submissions.implement === submission;
}
