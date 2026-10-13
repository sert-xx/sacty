import {
  type Actor,
  type AuthMode,
  type CleanupTarget,
  type DaemonText,
  type PauseReason,
  renderMessage,
  type StepKey,
  type Task,
  type Verdict,
} from "@sacty/core";

/**
 * 工程・状態・作業履歴などの用語。英語は構想ドキュメントの用語集に従う
 * （要求要件 Requirements、設計 Design、テスト観点 Test viewpoints、成果物チェック Deliverable review、
 * 差し戻し Request changes、一時停止 Pause、中止 Cancel、エスカレーション Escalation、
 * ゴールガーディアン Goal Guardian、オーケストレーター Orchestrator、作業履歴 Activity、人間の対応待ち Needs you）。
 */
const ja = {
  /** デーモンが作った文（コードと引数）を、この言語の文にする。古い文や外から来た文はそのまま（PBI-11）。 */
  text: (value: DaemonText): string => renderMessage(value, "ja"),
  step: {
    investigate: "調査",
    review: "レビュー",
    requirements: "要求要件",
    design: "設計",
    split: "タスク分割",
    integrate: "統合レビュー",
    reproduce: "再現",
    implement: "実装",
    pr: "PR作成",
  } satisfies Record<StepKey, string>,
  start: {
    sacty: "sacty",
    github_issue: "GitHub Issue",
    github_pull_request: "GitHub PR",
    split: "タスク分割",
    jira: "JIRA",
  } satisfies Record<Task["start"], string>,
  status: {
    blocked: "依存待ち",
    waiting_children: "子タスクの完了待ち",
    queued: "実行待ち",
    running: "実行中",
    idle: "待機中",
    paused: "一時停止",
    awaiting_approval: "承認待ち",
    escalated: "エスカレーション",
    cancelled: "中止",
  } satisfies Record<Task["status"], string>,
  pause: {
    budget: "予算上限で一時停止",
    usage_limit: "利用上限で一時停止",
    auth: "認証エラーで一時停止",
    error: "エラーで一時停止",
    verification: "実装の検証に通らないため一時停止",
    manual: "一時停止中",
    child_cancelled: "子タスクの中止で一時停止",
  } satisfies Record<PauseReason, string>,
  pauseHelp: {
    budget: "予算の上限に達したため止まっています。作業中のものは残っています。",
    usage_limit:
      "AI の利用上限（サブスクリプションの上限や、API のレート制限）に達したため止まっています。上限が戻ってから再開すると、止まった工程を実行し直します。",
    auth: "認証に失敗したため止まっています。トークンやAPIキーを確認してから再開してください。",
    error: "エラーで止まっています。原因を確認してから再開すると、止まった工程を実行し直します。",
    verification:
      "実装がテストか最終レビューに続けて通らないため止まっています。結果を確認し、必要なら設計を見直してから再開すると、実装をやり直します。",
    manual:
      "人間が一時停止しました。作業中のものは残っています。再開すると、止めたところから続けます（実行中だった工程は実行し直します）。",
    child_cancelled:
      "子タスクが中止されたため止まっています。再開すると、中止した子タスクを除いて進めます（中止した子タスクに依存する子タスクも始めます）。中止すると、終わっていない子タスクも中止します。",
  } satisfies Record<PauseReason, string>,
  auth: {
    subscription: "サブスクリプション",
    "api-key": "APIキー",
    bedrock: "Amazon Bedrock",
    provider: "接続先（providers）",
    stub: "スタブ",
  } satisfies Record<AuthMode, string>,
  actor: {
    person: "人間",
    sacty: "sacty",
    orchestrator: "オーケストレーター",
    guardian: "ゴールガーディアン",
    agent: "工程エージェント",
  } satisfies Record<Actor, string>,
  verdict: {
    approved: "承認",
    rejected: "却下",
    undecidable: "判定できない",
  } satisfies Record<Verdict, string>,
  state: {
    guardianJudging: "ゴールガーディアンが判定中",
    completed: "完了",
    testsRunning: "テストを実行中",
    finalReviewing: "ゴールガーディアンが最終レビュー中",
    changeUndecided: "変更の申し出の判断待ち",
    reworkConfirmation: "PR の指摘の戻し先の確認待ち",
    reworkJudging: "ゴールガーディアンが PR の指摘を判断中",
    deliverableReview: (n: number) => `成果物チェック待ち${n > 1 ? `（${n}回目）` : ""}`,
    prAwaitingMerge: (n: number) => `PR のマージ待ち${n > 1 ? `（${n}回目）` : ""}`,
    prClosed: "PR が閉じられた（判断待ち）",
    prMergedOutdated: "古い提出がマージされた（判断待ち）",
    notReproduced: "再現できなかった（判断待ち）",
    integrationFailed: "統合レビューに通らない（判断待ち）",
    stepApproval: (step: string, n: number) => `${step}の承認待ち${n > 1 ? `（${n}回目）` : ""}`,
  },
  action: { decide: "判断する", review: "チェックする" },
  cleanupTarget: {
    container: "実行中のコンテナ",
    workspace: "作業領域（タスクの clone）",
    session: "エージェントのセッション",
    branch: "sacty が作ったブランチ",
    pull_request: "sacty が作ったPR（閉じる）",
  } satisfies Record<CleanupTarget, string>,
  cleanupResult: { done: "片付けた", skipped: "対象なし", failed: "失敗" },
  /** 作業履歴の1行。 */
  event: {
    estimated: "・換算値",
    withCost: (actor: string, cost: string) => `${actor}・${cost}`,
    TaskCreated: (actor: string) => `タスクを作成（${actor}）`,
    StepsChosen: (steps: string, reason?: string) =>
      `工程を決定：${steps}${reason ? `（${reason}）` : ""}`,
    stepsJoin: " → ",
    stepsImages: (images: string, source: "project" | "orchestrator", reason?: string) =>
      ` / イメージ：${images}（${source === "project" ? "プロジェクトの対象の指定" : reason ? `オーケストレーター：${reason}` : "オーケストレーター"}）`,
    stepImage: (step: string, image: string) => `${step}＝${image}`,
    imagesJoin: "、",
    stepsExports: (exports: string) => ` / 書き出し：${exports}`,
    stepExport: (
      step: string,
      to: { name: string; location: string } | undefined,
      reason: string,
    ) =>
      `${step}＝${to ? `${to.name}${to.location ? `：${to.location}` : ""}` : "書き出さない"}${reason ? `（${reason}）` : ""}`,
    TicketTriaged: (repo: string, reason: string, byPerson: boolean) =>
      byPerson
        ? `作業するリポジトリを選んだ：${repo}（人間）`
        : `チケットを読んで、作業するリポジトリを決めた：${repo}（${reason}）`,
    TicketPullRequestCommented: (url?: string) =>
      url
        ? `PR の URL をチケットにコメントした（${url}）`
        : "PR の URL をチケットにコメントできなかった",
    ServicesStarted: (step: string, file: string, services: string, forTests: boolean) =>
      `${forTests ? `${step}のテスト` : step}のためにサービスを起動：${services}（${file}。実行の後に消す）`,
    AgentRunStarted: (step: string, agent: string, auth: string) =>
      `${step}の実行を開始（${agent}・${auth}）`,
    AgentRunCompleted: (step: string, cost: string, viewpoints?: number) =>
      `${step}の実行が完了（${cost}${viewpoints === undefined ? "" : `・テスト観点${viewpoints}件`}）`,
    AgentRunFailed: (step: string, message: string) => `${step}の実行が失敗：${message}`,
    BudgetWarned: (used: string, cap: string) => `予算の80%に到達（${used} / ${cap}）`,
    BudgetCapRaised: (cap: string, actor: string) => `予算の上限を${cap}に変更（${actor}）`,
    TaskResumed: (actor: string) => `再開（${actor}）`,
    TaskPausedManual: (actor: string) => `一時停止（${actor}）`,
    submittedDeliverable: (n: number) => `成果物チェックに提出（${n}回目）→ 承認待ち`,
    submittedStep: (step: string, n: number) => `${step}を提出（${n}回目）→ 承認待ち`,
    approvedDeliverable: (actor: string) => `成果物チェックで承認（${actor}）`,
    approvedStep: (step: string, actor: string) => `${step}を承認・凍結（${actor}）`,
    ChangeProposed: (from: string, target: string, id: string) =>
      `${from}の工程が、${target}の変更を申し出（${id}）`,
    ChangeJudged: (id: string, verdict: string, reason: string, tail: string) =>
      `${id}を${verdict}：${reason}（${tail}）`,
    ChangeDecided: (id: string, accept: boolean, actor: string) =>
      `${id}を${accept ? "認めた" : "認めなかった"}（${actor}）`,
    ChangeApplied: (id: string) => `${id}の変更を反映`,
    RepositoryPrepared: (url: string, branch: string, commit: string) =>
      `対象リポジトリを用意（${url}・${branch}・${commit}）`,
    TestsRun: (passed: boolean, exitCode: number, unmapped: string[]) =>
      `テストを実行：${passed ? "合格" : "不合格"}（終了コード ${exitCode}${unmapped.length > 0 ? `・テストの無い観点 ${unmapped.join(", ")}` : ""}）`,
    FinalReviewed: (passed: boolean, failures: number, tail: string) =>
      `最終レビュー：${passed ? "合格" : `不合格（${failures}件）`}（${tail}）`,
    prPublished: (number: number | undefined, branch: string, commit: string) =>
      `PRを作成・更新（#${number}・${branch}・${commit}）`,
    branchPushed: (branch: string, commit: string) =>
      `PRは作らない設定のため、ブランチまで（${branch}・${commit}）`,
    BranchPushed: (branch: string, commit: string) =>
      `sacty のブランチにプッシュ（${branch}・${commit}）`,
    PullRequestMerged: (number: number, by?: string) =>
      `PR #${number} がマージされた${by ? `（${by}）` : ""}→ 成果物チェックを承認`,
    PullRequestMergedOutdated: (number: number, by?: string) =>
      `PR #${number} が最新の提出より前の内容でマージされた${by ? `（${by}）` : ""}→ 人間の判断待ち`,
    PullRequestClosed: (number: number) =>
      `PR #${number} がマージされずに閉じられた → 人間の判断待ち`,
    PullRequestReopened: (number: number) => `PR #${number} が開き直された → マージ待ち`,
    IssueCommented: (url: string) => `調査の結果を Issue にコメントした（${url}）`,
    IssueCommentFailed: (message: string) => `調査の結果を Issue に返せなかった：${message}`,
    ReviewTargetResolved: (url: string, commit: string) =>
      `レビューの対象の PR を確認（${url}・${commit}）`,
    PullRequestReviewPosted: (url: string) => `レビューを PR に投稿した（${url}）`,
    ReviewRestarted: (actor: string) =>
      `再レビューを始めた（PR の最新のコミットをレビューする。${actor}）`,
    cancelledBecause: (text: string, reason: "pull_request_merged" | "pull_request_closed") =>
      `${text}（${reason === "pull_request_merged" ? "PR がマージされたため" : "PR が閉じられたため"}）`,
    GuardianMissed:
      "最終レビューで合格にした成果物が差し戻されたため、ゴールガーディアンの見逃しとして記録",
    FinalReviewFailed: (message: string, cost: string) => `${message}（${cost}）`,
    OrchestratorFailed: (message: string, cost: string) => `${message}（${cost}）`,
    AiRequestsRetried: (retries: number, seconds: number, statuses: string, gaveUp: boolean) =>
      `ゲートウェイが AI の呼び出しを${retries}回リトライ（${statuses}・合計${seconds}秒待った）${gaveUp ? "→ 上限に達したため、あきらめた" : ""}`,
    StepQueued: (step: string) => `${step}を実行待ちにした（実行できるようになったため）`,
    TaskSplit: (count: number, reason: string) =>
      `子タスク${count}件に分割${reason ? `（${reason}）` : ""}`,
    TaskUnblocked: "依存先の子タスクが完了したため、実行待ちにした",
    SplitCompleted: "子タスクがすべて完了したため、タスク分割を完了",
    IntegrationReviewed: (passed: boolean, branch: string, commit: string, findings: number) =>
      `統合レビュー（${branch}・${commit}）：${passed ? "合格 → 人間の承認待ち" : `不合格（足りないこと${findings}件）`}`,
    StepCompleted: (step: string) => `${step}を完了（前段の${step}のため承認なし）→ 次の工程へ`,
    reproduced: (exitCode: number | undefined) =>
      `再現を確認：再現のテストが失敗した（終了コード ${exitCode ?? "?"}）→ 実装へ`,
    notReproduced: (detail: string) => `再現できなかった（${detail}）→ 人間の判断待ち`,
    testsPassed: (exitCode: number | undefined) => `テストが通った・終了コード ${exitCode ?? "?"}`,
    changesAtDeliverable: "成果物チェックで差し戻し",
    changesAtStep: (step: string) => `${step}を差し戻し`,
    changesTarget: (where: string, target: string, revoke: boolean) =>
      `${where}、${target}からやり直し${revoke ? `（${target}の承認を取り消し）` : ""}`,
    changesTail: (count: number, overLimit: boolean, actor: string) =>
      `：指摘${count}件${overLimit ? "（上限を超えて）" : ""}（${actor}）`,
    RemarkVoided: (id: string, actor: string) => `指摘 ${id} を無効にした（${actor}）`,
    ContextResolved: (layers: string[], warnings: string[]) =>
      `コンテキストを用意：${layers.join(" → ")}${warnings.length > 0 ? `（注意：${warnings.join(" ")}）` : ""}`,
    TaskCancelled: (done: string[], failed: string[], actor: string) =>
      `中止（${actor}）：${done.length > 0 ? `${done.join("・")}を片付けた` : "片付ける対象なし"}${failed.length > 0 ? `／失敗：${failed.join("・")}` : ""}`,
    escalatedUndecidable: (id: string | undefined) =>
      `ゴールガーディアンが${id ?? "変更の申し出"}を判定できなかったため、エスカレーション`,
    escalatedTooMany: (step: string) => `${step}への差し戻しが上限に達したため、エスカレーション`,
    escalatedRework: (step: string) =>
      `PR の指摘で${step}まで戻すかを、人間が確かめる（エスカレーション）`,
    PullRequestReviewImported: (number: number, authors: string, count: number) =>
      `PR #${number} への指摘（${authors}）→ ${count}件を取り込み`,
    QuestionAsked: (id: string, actor: string) => `オーケストレーターに質問した（${id}・${actor}）`,
    ExportStarted: (step: string) => `${step}の書き出しを始めた`,
    OutputExported: (
      step: string,
      name: string,
      result: { url: string } | { failed: string } | { interrupted: string },
      cost: string,
    ) =>
      "url" in result
        ? `${step}を ${name} に書き出した（${result.url}・${cost}）`
        : "failed" in result
          ? `${step}を ${name} に書き出せなかった（${cost}）：${result.failed}`
          : `${step}の ${name} への書き出しを中断した（${cost}）：${result.interrupted}`,
    ExportRequested: (step: string, actor: string) => `${step}の書き出し直しを求めた（${actor}）`,
    QuestionAnswered: (id: string, failed: string | undefined, cost: string) =>
      failed === undefined
        ? `オーケストレーターが質問に答えた（${id}・${cost}）`
        : `オーケストレーターが質問に答えられなかった（${id}・${cost}）：${failed}`,
    ReworkJudged: (target: string | undefined, reason: string, tail: string) =>
      `ゴールガーディアンが戻し先を判断：${target ?? "判断できない"}（${reason}）（${tail}）`,
  },
};

export type LabelMessages = typeof ja;

const en: LabelMessages = {
  text: (value) => renderMessage(value, "en"),
  step: {
    investigate: "Investigate",
    review: "Review",
    requirements: "Requirements",
    design: "Design",
    split: "Task split",
    integrate: "Integration review",
    reproduce: "Reproduce",
    implement: "Implement",
    pr: "Open PR",
  },
  start: {
    sacty: "sacty",
    github_issue: "GitHub Issue",
    github_pull_request: "GitHub PR",
    split: "Task split",
    jira: "JIRA",
  },
  status: {
    blocked: "Blocked",
    waiting_children: "Waiting for subtasks",
    queued: "Queued",
    running: "Running",
    idle: "Waiting",
    paused: "Paused",
    awaiting_approval: "Awaiting approval",
    escalated: "Escalated",
    cancelled: "Cancelled",
  },
  pause: {
    budget: "Paused at budget cap",
    usage_limit: "Paused at usage limit",
    auth: "Paused: authentication failed",
    error: "Paused: error",
    verification: "Paused: implementation keeps failing verification",
    manual: "Paused",
    child_cancelled: "Paused: a subtask was cancelled",
  },
  pauseHelp: {
    budget: "The task reached its budget cap and is paused. Its work is kept.",
    usage_limit:
      "The AI reached its usage limit (a subscription limit or an API rate limit). Resume once the limit resets to rerun the stopped step.",
    auth: "Authentication failed. Check the token or API key, then resume.",
    error: "The task stopped on an error. Check the cause, then resume to rerun the stopped step.",
    verification:
      "The implementation keeps failing the tests or the final review. Check the results, revisit the design if needed, then resume to implement again.",
    manual:
      "A person paused this task. Its work is kept. Resume to continue from where it stopped (a step that was running runs again).",
    child_cancelled:
      "A subtask was cancelled, so this task is paused. Resume to continue without the cancelled subtasks (subtasks that depend on them also start). Cancel to also cancel the unfinished subtasks.",
  },
  auth: {
    subscription: "Subscription",
    "api-key": "API key",
    bedrock: "Amazon Bedrock",
    provider: "Provider (providers)",
    stub: "Stub",
  },
  actor: {
    person: "person",
    sacty: "sacty",
    orchestrator: "Orchestrator",
    guardian: "Goal Guardian",
    agent: "step agent",
  },
  verdict: {
    approved: "Approved",
    rejected: "Rejected",
    undecidable: "Undecidable",
  },
  state: {
    guardianJudging: "Goal Guardian is judging",
    completed: "Done",
    testsRunning: "Running tests",
    finalReviewing: "Goal Guardian is doing the final review",
    changeUndecided: "Change request needs you",
    reworkConfirmation: "Step to redo for PR comments needs you",
    reworkJudging: "Goal Guardian is judging PR comments",
    deliverableReview: (n) => `Awaiting deliverable review${n > 1 ? ` (submission ${n})` : ""}`,
    prAwaitingMerge: (n) => `Awaiting PR merge${n > 1 ? ` (submission ${n})` : ""}`,
    prClosed: "PR closed (needs you)",
    prMergedOutdated: "An older submission was merged (needs you)",
    notReproduced: "Not reproduced (needs your decision)",
    integrationFailed: "Integration review failed (needs your decision)",
    stepApproval: (step, n) => `${step} awaiting approval${n > 1 ? ` (submission ${n})` : ""}`,
  },
  action: { decide: "Decide", review: "Review" },
  cleanupTarget: {
    container: "Running container",
    workspace: "Workspace (the task's clone)",
    session: "Agent sessions",
    branch: "Branch created by sacty",
    pull_request: "PR opened by sacty (closed)",
  },
  cleanupResult: { done: "Cleaned up", skipped: "Nothing to clean", failed: "Failed" },
  event: {
    estimated: " · estimate",
    withCost: (actor, cost) => `${actor} · ${cost}`,
    TaskCreated: (actor) => `Task created (${actor})`,
    StepsChosen: (steps, reason) => `Steps chosen: ${steps}${reason ? ` (${reason})` : ""}`,
    stepsImages: (images, source, reason) =>
      ` / images: ${images} (${source === "project" ? "set on the project target" : reason ? `Orchestrator: ${reason}` : "Orchestrator"})`,
    stepImage: (step, image) => `${step}=${image}`,
    imagesJoin: ", ",
    stepsExports: (exports) => ` / Export: ${exports}`,
    stepExport: (step, to, reason) =>
      `${step}=${to ? `${to.name}${to.location ? `: ${to.location}` : ""}` : "not exported"}${reason ? ` (${reason})` : ""}`,
    TicketTriaged: (repo, reason, byPerson) =>
      byPerson
        ? `Chose the repository: ${repo} (person)`
        : `Read the ticket and decided the repository: ${repo} (${reason})`,
    TicketPullRequestCommented: (url) =>
      url
        ? `Commented the PR URL on the ticket (${url})`
        : "Could not comment the PR URL on the ticket",
    ServicesStarted: (step, file, services, forTests) =>
      `Started services for ${forTests ? `the ${step} tests` : step}: ${services} (${file}; removed after the run)`,
    stepsJoin: " → ",
    AgentRunStarted: (step, agent, auth) => `${step} started (${agent} · ${auth})`,
    AgentRunCompleted: (step, cost, viewpoints) =>
      `${step} finished (${cost}${viewpoints === undefined ? "" : ` · ${viewpoints} test viewpoint${viewpoints === 1 ? "" : "s"}`})`,
    AgentRunFailed: (step, message) => `${step} failed: ${message}`,
    BudgetWarned: (used, cap) => `Reached 80% of budget (${used} / ${cap})`,
    BudgetCapRaised: (cap, actor) => `Budget cap changed to ${cap} (${actor})`,
    TaskResumed: (actor) => `Resumed (${actor})`,
    TaskPausedManual: (actor) => `Paused (${actor})`,
    submittedDeliverable: (n) =>
      `Submitted for deliverable review (submission ${n}) → awaiting approval`,
    submittedStep: (step, n) => `${step} submitted (submission ${n}) → awaiting approval`,
    approvedDeliverable: (actor) => `Approved in deliverable review (${actor})`,
    approvedStep: (step, actor) => `${step} approved and frozen (${actor})`,
    ChangeProposed: (from, target, id) =>
      `The ${from} step requested a change to ${target} (${id})`,
    ChangeJudged: (id, verdict, reason, tail) =>
      `${id} ${verdict.toLowerCase()}: ${reason} (${tail})`,
    ChangeDecided: (id, accept, actor) =>
      `${id} ${accept ? "accepted" : "not accepted"} (${actor})`,
    ChangeApplied: (id) => `${id} applied`,
    RepositoryPrepared: (url, branch, commit) =>
      `Target repository prepared (${url} · ${branch} · ${commit})`,
    TestsRun: (passed, exitCode, unmapped) =>
      `Tests run: ${passed ? "passed" : "failed"} (exit code ${exitCode}${unmapped.length > 0 ? ` · viewpoints without tests: ${unmapped.join(", ")}` : ""})`,
    FinalReviewed: (passed, failures, tail) =>
      `Final review: ${passed ? "passed" : `failed (${failures})`} (${tail})`,
    prPublished: (number, branch, commit) =>
      `PR opened or updated (#${number} · ${branch} · ${commit})`,
    branchPushed: (branch, commit) => `No PR configured; branch only (${branch} · ${commit})`,
    BranchPushed: (branch, commit) => `Pushed to sacty branch (${branch} · ${commit})`,
    PullRequestMerged: (number, by) =>
      `PR #${number} merged${by ? ` (${by})` : ""} → deliverable review approved`,
    PullRequestMergedOutdated: (number, by) =>
      `PR #${number} was merged with content older than the latest submission${by ? ` (${by})` : ""} → needs you`,
    PullRequestClosed: (number) => `PR #${number} closed without merging → needs you`,
    PullRequestReopened: (number) => `PR #${number} reopened → awaiting merge`,
    IssueCommented: (url) => `Posted the investigation result to the issue (${url})`,
    ReviewTargetResolved: (url, commit) => `Confirmed the PR to review (${url} · ${commit})`,
    PullRequestReviewPosted: (url) => `Posted the review to the PR (${url})`,
    ReviewRestarted: (actor) =>
      `Started a re-review (reviews the latest commit of the PR; ${actor})`,
    cancelledBecause: (text, reason) =>
      `${text} (${reason === "pull_request_merged" ? "the PR was merged" : "the PR was closed"})`,
    IssueCommentFailed: (message) =>
      `Could not post the investigation result to the issue: ${message}`,
    GuardianMissed:
      "A deliverable that passed the final review was sent back; recorded as a Goal Guardian miss",
    FinalReviewFailed: (message, cost) => `${message} (${cost})`,
    OrchestratorFailed: (message, cost) => `${message} (${cost})`,
    AiRequestsRetried: (retries, seconds, statuses, gaveUp) =>
      `The gateway retried the AI call ${retries} time${retries === 1 ? "" : "s"} (${statuses}; waited ${seconds}s in total)${gaveUp ? " → gave up at the limit" : ""}`,
    StepQueued: (step) => `${step} queued (it can run now)`,
    TaskSplit: (count, reason) =>
      `Split into ${count} subtask${count === 1 ? "" : "s"}${reason ? ` (${reason})` : ""}`,
    TaskUnblocked: "Queued because the subtasks it depends on are done",
    SplitCompleted: "All subtasks are done, so the task split is complete",
    IntegrationReviewed: (passed, branch, commit, findings) =>
      `Integration review (${branch} · ${commit}): ${passed ? "passed → needs your approval" : `failed (${findings} missing item${findings === 1 ? "" : "s"})`}`,
    StepCompleted: (step) => `${step} done (preliminary, no approval needed) → next step`,
    reproduced: (exitCode) =>
      `Reproduced: the reproduction test failed (exit code ${exitCode ?? "?"}) → implement`,
    notReproduced: (detail) => `Not reproduced (${detail}) → needs your decision`,
    testsPassed: (exitCode) => `the tests passed, exit code ${exitCode ?? "?"}`,
    changesAtDeliverable: "Changes requested in deliverable review",
    changesAtStep: (step) => `Changes requested on ${step}`,
    changesTarget: (where, target, revoke) =>
      `${where}; redo from ${target}${revoke ? ` (${target} approval revoked)` : ""}`,
    changesTail: (count, overLimit, actor) =>
      `: ${count} comment${count === 1 ? "" : "s"}${overLimit ? " (over the limit)" : ""} (${actor})`,
    RemarkVoided: (id, actor) => `Comment ${id} voided (${actor})`,
    ContextResolved: (layers, warnings) =>
      `Context prepared: ${layers.join(" → ")}${warnings.length > 0 ? ` (notes: ${warnings.join(" ")})` : ""}`,
    TaskCancelled: (done, failed, actor) =>
      `Cancelled (${actor}): ${done.length > 0 ? `cleaned up ${done.join(", ")}` : "nothing to clean up"}${failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""}`,
    escalatedUndecidable: (id) =>
      `Escalated: the Goal Guardian could not decide ${id ?? "the change request"}`,
    escalatedTooMany: (step) => `Escalated: changes to ${step} reached the limit`,
    escalatedRework: (step) =>
      `Escalated: confirm whether to redo from ${step} for the PR comments`,
    PullRequestReviewImported: (number, authors, count) =>
      `PR #${number} feedback (${authors}) → ${count} comment${count === 1 ? "" : "s"} imported`,
    QuestionAsked: (id, actor) => `Asked the Orchestrator a question (${id}, ${actor})`,
    ExportStarted: (step) => `Started exporting the ${step}`,
    OutputExported: (step, name, result, cost) =>
      "url" in result
        ? `Exported the ${step} to ${name} (${result.url}, ${cost})`
        : "failed" in result
          ? `Could not export the ${step} to ${name} (${cost}): ${result.failed}`
          : `Interrupted exporting the ${step} to ${name} (${cost}): ${result.interrupted}`,
    ExportRequested: (step, actor) => `Asked to export the ${step} again (${actor})`,
    QuestionAnswered: (id, failed, cost) =>
      failed === undefined
        ? `The Orchestrator answered the question (${id}, ${cost})`
        : `The Orchestrator could not answer the question (${id}, ${cost}): ${failed}`,
    ReworkJudged: (target, reason, tail) =>
      `Goal Guardian chose the step to redo: ${target ?? "undecided"} (${reason}) (${tail})`,
  },
};

export const labels = { ja, en };
