import {
  type Actor,
  type AuthMode,
  type CleanupTarget,
  type DaemonText,
  type OrchestratorSessionReason,
  type PauseReason,
  renderMessage,
  type StepKey,
  type Task,
  type Verdict,
} from "@sacty/core";

/**
 * 工程・状態・作業履歴などの用語。英語は構想ドキュメントの用語集に従う
 * （要求要件 Requirements、設計 Design、テスト観点 Test viewpoints、承認 Approval、
 * 差し戻し Request changes、一時停止 Pause、中止 Cancel、エスカレーション Escalation、
 * ゴールガーディアン Goal Guardian、オーケストレーター Orchestrator、作業履歴 Activity、人間の対応待ち Needs you）。
 * 作業履歴の1行は「何をした・何が起きた」だけにし、結果の矢印や言い訳の括弧を付けない（PBI-117）。
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
    deployment: "マージの後の監視",
    document: "文書作成",
    operation: "作業",
  } satisfies Record<StepKey, string>,
  start: {
    sacty: "Sacty",
    github_issue: "GitHub Issue",
    github_pull_request: "GitHub PR",
    split: "タスク分割",
    jira: "JIRA",
    deployment: "マージの後の監視",
    audit: "監査の改修の提案",
  } satisfies Record<Task["start"], string>,
  /** タスクのテンプレート（PBI-90）。 */
  template: { "sacty-setup": "Sacty セットアップ" } satisfies Record<
    NonNullable<Task["template"]>,
    string
  >,
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
    budget: "予算の上限に達しました。作業中のものは残っています。",
    usage_limit:
      "AI の利用上限に達しました。上限が戻ってから再開すると、止まった工程を実行し直します。",
    auth: "認証に失敗しました。トークンや API キーを確かめてから再開してください。",
    error: "エラーで止まりました。原因を確かめてから再開すると、止まった工程を実行し直します。",
    verification:
      "実装がテストか最終レビューに続けて通りません。結果を確かめ、必要なら設計を見直してから再開すると、実装をやり直します。",
    manual: "人が一時停止しました。再開すると、止めたところから続けます。",
    child_cancelled:
      "子タスクが中止されました。再開すると中止した子タスクを除いて進め、中止すると終わっていない子タスクも中止します。",
  } satisfies Record<PauseReason, string>,
  auth: {
    subscription: "サブスクリプション",
    "api-key": "APIキー",
    bedrock: "Amazon Bedrock",
    provider: "接続先",
    stub: "スタブ",
  } satisfies Record<AuthMode, string>,
  actor: {
    person: "人間",
    sacty: "Sacty",
    orchestrator: "オーケストレーター",
    guardian: "ゴールガーディアン",
    agent: "工程エージェント",
    auditor: "監査",
  } satisfies Record<Actor, string>,
  verdict: {
    approved: "承認",
    rejected: "却下",
    undecidable: "判定できない",
  } satisfies Record<Verdict, string>,
  state: {
    guardianJudging: "ゴールガーディアンが判定中",
    completed: "完了",
    completedNoChanges: "完了（変更なし）",
    testsRunning: "テストを実行中",
    watchingCi: "マージの後の監視・CI/CD 待ち",
    watchingCheck: "マージの後の監視・確認中",
    finalReviewing: "ゴールガーディアンが最終レビュー中",
    changeUndecided: "変更の申し出の判断待ち",
    reworkConfirmation: "PR の指摘の戻し先の確認待ち",
    reworkJudging: "ゴールガーディアンが PR の指摘を判断中",
    noChangesReview: (n: number) => `変更なしの実装の承認待ち${n > 1 ? `（${n}回目）` : ""}`,
    stepPrAwaitingMerge: (step: string, n: number) =>
      `${step}の PR のマージ待ち${n > 1 ? `（${n}回目）` : ""}`,
    prClosed: "PR が閉じられた・判断待ち",
    prMergedOutdated: "別の内容でマージ・承認へ",
    notReproduced: "再現できなかった・判断待ち",
    integrationFailed: "統合レビュー不合格・判断待ち",
    stepApproval: (step: string, n: number) => `${step}の承認待ち${n > 1 ? `（${n}回目）` : ""}`,
  },
  action: {
    decide: "判断する",
    review: "チェックする",
    /** PR で確かめる工程の承認待ち（PBI-136）。GitHub の PR を新しいタブで開く。 */
    reviewOnPr: "PR でチェックする",
    newTab: "（新しいタブで開く）",
  },
  cleanupTarget: {
    container: "実行中のコンテナ",
    workspace: "作業領域",
    session: "エージェントのセッション",
    branch: "Sacty が作ったブランチ",
    pull_request: "Sacty が作った PR",
  } satisfies Record<CleanupTarget, string>,
  /** オーケストレーターのセッション（PBI-67）。 */
  orchestratorSession: {
    reason: {
      first: "このタスクで初めて",
      agent_changed: "エージェントを変えたため",
      truncated: "保存したセッションが上限で省かれていたため",
      files_broken: "保存したセッションのファイルが無い・壊れていたため",
      resume_failed: "AI が再開を受け付けなかったため",
    } satisfies Record<OrchestratorSessionReason, string>,
    notSaved: {
      not_archived: "元のファイルを写せなかった",
      no_session: "セッションの ID が分からない",
      session_missing: "セッションの本体のファイルが無い",
      copy_failed: "保存の場所に書けなかった",
    },
  },
  cleanupResult: { done: "片付けた", skipped: "対象なし", failed: "失敗" },
  /** 作業履歴の1行。 */
  event: {
    estimated: "・概算",
    withCost: (actor: string, cost: string) => `${actor}・${cost}`,
    TaskCreated: (actor: string, template?: string, rerun?: boolean) =>
      `タスクを作成（${actor}${template ? `・テンプレート：${template}` : ""}${rerun ? "・中止したタスクの再実行" : ""}）`,
    StepsChosen: (steps: string, reason?: string) =>
      `工程を決定：${steps}${reason ? `（${reason}）` : ""}`,
    stepsJoin: " → ",
    stepsImages: (images: string, source: "project" | "orchestrator" | "rerun", reason?: string) =>
      ` / イメージ：${images}（${source === "project" ? "プロジェクトの対象の指定" : source === "rerun" ? "再実行で人が指定" : reason ? `オーケストレーター：${reason}` : "オーケストレーター"}）`,
    stepImage: (step: string, image: string) => `${step}＝${image}`,
    /** 既定のイメージで動かす工程と、images のどれも合わない理由（PBI-105）。 */
    stepsDefaultImages: (reasons: string) => ` / 既定のイメージ：${reasons}`,
    stepDefaultImage: (step: string, reason: string) => `${step}＝${reason}`,
    /** images の候補があるのに、理由が無いまま既定のイメージで動かす工程（PBI-105）。 */
    stepsImagesUnexplained: (steps: string) => ` / 理由なく既定のイメージ：${steps}`,
    imagesJoin: "、",
    stepsExports: (exports: string) => ` / 書き出し：${exports}`,
    /** テストの仕組みが無いと判断した根拠（PBI-94）。 */
    stepsNoTests: (reason: string) => ` / テストの仕組みが無い：${reason}`,
    stepsDeployment: (skill: string) => ` / マージの後の監視：する（スキル ${skill}）`,
    stepsDeploymentSkipped: (reason: string) => ` / マージの後の監視：飛ばす（${reason}）`,
    /** オーケストレーターが決めたサービス（PBI-47・PBI-70）。 */
    stepsServices: (names: string, source: string, steps: string, reason?: string) =>
      ` / サービス：${names || "すべて"}（${source}。${steps}で使う）${reason ? `：${reason}` : ""}`,
    /** サービスを使わないと判断した（PBI-70）。shared は選ばせた共用の compose の名前。 */
    stepsNoServices: (shared: string, reason?: string) =>
      ` / ${shared ? `共用の compose（${shared}）` : "サービス"}：使わない${reason ? `（${reason}）` : ""}`,
    /** 共用の compose の compose ファイル（PBI-70）。 */
    sharedComposeFile: (name: string, file: string, where?: string) =>
      `共用の compose「${name}」の ${file}${where ? `（${where}）` : ""}`,
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
    RepositoryChosen: (repo: string, reason: string, byPerson: boolean) =>
      byPerson
        ? `作業するリポジトリを選んだ：${repo}（人間）`
        : `プロジェクトの対象から、作業するリポジトリを選んだ：${repo}（${reason}）`,
    TicketPullRequestCommented: (url?: string) =>
      url
        ? `PR の URL をチケットにコメントした（${url}）`
        : "PR の URL をチケットにコメントできなかった",
    ServicesStarted: (
      step: string,
      file: string,
      services: string,
      forTests: boolean,
      sharedPorts: string,
    ) =>
      `${forTests ? `${step}のテスト` : step}のためにサービスを起動：${services}（${file}）${sharedPorts ? ` / localhost に転送しないポート：${sharedPorts}` : ""}`,
    /** ホストに出すポートからも localhost に転送するサービス（PBI-60）。 */
    serviceHostPorts: (name: string, ports: string) => `${name}（${ports}）`,
    AgentRunStarted: (step: string, agent: string, auth: string) =>
      `${step}の実行を開始（${agent}・${auth}）`,
    AgentRunCompleted: (
      step: string,
      cost: string,
      viewpoints?: number,
      /** 提出の前のセルフレビュー（PBI-120）。null は記録なし。 */
      selfReview?: { passed: boolean; rounds: number } | null,
    ) =>
      `${step}の実行が完了（${cost}${viewpoints === undefined ? "" : `・テスト観点${viewpoints}件`}${selfReview === undefined ? "" : selfReview === null ? "・セルフレビューの記録なし" : `・セルフレビュー${selfReview.passed ? "パス" : "未パス"}（${selfReview.rounds}回）`}）`,
    AgentRunFailed: (step: string, message: string) => `${step}の実行が失敗：${message}`,
    BudgetWarned: (used: string, cap: string) => `予算の80%に到達（${used} / ${cap}）`,
    BudgetCapRaised: (cap: string, actor: string) => `予算の上限を${cap}に変更（${actor}）`,
    /** 人が工程のイメージを変えた（PBI-106）。 */
    /** 人が工程のエージェントを変えた（PBI-121）。 */
    StepAgentChanged: (step: string, from: string, to: string, actor: string) =>
      `${step}のエージェントを ${from} から ${to} に変更（${actor}）`,
    StepImageChanged: (step: string, from: string, to: string, actor: string) =>
      `${step}のイメージを ${from} から ${to} に変更（${actor}）`,
    TaskResumed: (actor: string) => `再開（${actor}）`,
    TaskPausedManual: (actor: string) => `一時停止（${actor}）`,
    submittedStep: (step: string, n: number) => `${step}を提出（${n}回目）`,
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
    TestsSkipped: "テストのコマンドが無いため、テストを飛ばして最終レビューへ",
    FinalReviewed: (passed: boolean, failures: number, tail: string) =>
      `最終レビュー：${passed ? "合格" : `不合格（${failures}件）`}（${tail}）`,
    prPublished: (number: number | undefined, branch: string, commit: string) =>
      `PR を作成・更新（#${number}・${branch}・${commit}）`,
    branchPushed: (branch: string, commit: string) =>
      `PR を作らず、ブランチまで（${branch}・${commit}）`,
    NoChangesFound: "実装に変更が無いため、PR を作らずに承認待ち",
    BranchPushed: (branch: string, commit: string) =>
      `Sacty のブランチにプッシュ（${branch}・${commit}）`,
    TaskBranchCreated: (branch: string, commit: string) =>
      `タスクブランチを作成（${branch}・${commit}）`,
    StepBranchPushed: (step: string, branch: string, commit: string) =>
      `${step}のファイルをブランチにプッシュ（${branch}・${commit}）`,
    PullRequestLabeled: (number: number, label: string, created: boolean) =>
      `PR #${number} にレビュー用のラベル「${label}」を付けた${created ? "（ラベルを作った）" : ""}`,
    PullRequestLabelFailed: (number: number, label: string, message: string) =>
      `PR #${number} にレビュー用のラベル「${label}」を付けられなかった：${message}`,
    StepPullRequestPublished: (step: string, number: number, path: string, supersedes?: number) =>
      `${step}の PR を作成・更新（#${number}・${path}）${supersedes ? `。PR #${supersedes} を閉じた` : ""}`,
    PullRequestMerged: (number: number, by?: string) =>
      `PR #${number} がマージされ、承認${by ? `（${by}）` : ""}`,
    PullRequestMergedOutdated: (number: number, by?: string) =>
      `PR #${number} が最新の提出より前の内容でマージされた${by ? `（${by}）` : ""}・判断待ち`,
    PullRequestMergedEdited: (
      number: number,
      by: string | undefined,
      submitted: string,
      final: string,
      fallback?: "deleted" | "unreadable",
    ) =>
      `PR #${number} が人の直した内容でマージされ、承認${by ? `（${by}）` : ""}（${submitted} → ${final}）${fallback === "deleted" ? "。成果のファイルが消されていたため、Sacty の版を承認済みにした" : fallback === "unreadable" ? "。成果のファイルを読めなかったため、Sacty の版を承認済みにした" : ""}`,
    PullRequestClosed: (number: number) => `PR #${number} がマージされずに閉じられた・判断待ち`,
    PullRequestReopened: (number: number) => `PR #${number} が開き直された・マージ待ち`,
    IssueCommented: (url: string) => `調査の結果を Issue にコメントした（${url}）`,
    IssueCommentFailed: (message: string) => `調査の結果を Issue に返せなかった：${message}`,
    GitHubCommentsPosted: (step: string, results: string[]) =>
      `${step}の成果で頼まれた GitHub へのコメントの投稿の結果：${results.join("、") || "なし"}`,
    GitHubCommentPosted: (url: string) => `投稿した（${url}）`,
    GitHubCommentFailed: (target: string, message: string) =>
      `${target} に投稿できなかった（${message}）`,
    ReviewTargetResolved: (url: string, commit: string) =>
      `レビューの対象の PR を確認（${url}・${commit}）`,
    PullRequestReviewPosted: (url: string) => `レビューを PR に投稿した（${url}）`,
    ReviewRestarted: (actor: string) => `再レビューを始めた（${actor}）`,
    ReviewRestartedByRequest: (actor: string) =>
      `PR でレビューが再依頼されたので、再レビューを始めた（${actor}）`,
    cancelledBecause: (text: string, reason: "pull_request_merged" | "pull_request_closed") =>
      `${text}（${reason === "pull_request_merged" ? "PR がマージされたため" : "PR が閉じられたため"}）`,
    GuardianMissed: "ゴールガーディアンの見逃し：合格にした成果物が差し戻された",
    FinalReviewFailed: (message: string, cost: string) => `${message}（${cost}）`,
    OrchestratorFailed: (message: string, cost: string) => `${message}（${cost}）`,
    AgentSessionArchived: (files: number, truncated: number) =>
      `エージェントの元のファイル${files}件を写した${truncated > 0 ? `（${truncated}件は間を省いた）` : ""}`,
    AgentSessionNotArchived:
      "コンテナの停止を確かめられず、エージェントの元のファイルを写さなかった",
    OrchestratorSessionResumed: (id: string) => `オーケストレーターのセッション（${id}）を再開した`,
    OrchestratorSessionStarted: (reason: string, id?: string) =>
      `オーケストレーターのセッションを新しく始めた（${reason}）${id ? `：${id}` : ""}`,
    ChatSessionForked: (from: string, id?: string) =>
      `質問のためにセッション（${from}）を複製した${id ? `：${id}` : ""}`,
    ChatSessionStarted: (reason: string) => `質問のために新しいセッションを始めた（${reason}）`,
    sessionNotSaved: (why: string) => `。セッションは保存できなかった（${why}）`,
    sessionHandoff: (from: string, id: string, truncated: boolean) =>
      `。前のエージェント（${from}）のセッション（${id}）のやり取りを引き継いだ${truncated ? "（古い部分は省いた）" : ""}`,
    AgentFellBack: (
      from: string,
      to: string,
      role: string,
      until: Date,
      reason: "usage_limit" | "auth" | "error",
    ) =>
      `${from} が${{ usage_limit: "利用制限に達した", auth: "認証に失敗した", error: "失敗した" }[reason]}ので、${to} に切り替えてやり直す（${role}。${until.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} まで${reason === "usage_limit" ? "" : "このタスクでは"} ${from} を使わない）`,
    AiRequestsRetried: (retries: number, seconds: number, statuses: string, gaveUp: boolean) =>
      `ゲートウェイが AI の呼び出しを${retries}回リトライ（${statuses}・計${seconds}秒）${gaveUp ? "・上限であきらめた" : ""}`,
    StepQueued: (step: string) => `${step}を実行待ちにした`,
    TaskSplit: (count: number, reason: string, repos: string[] = []) =>
      `子タスク${count}件に分割${reason ? `（${reason}）` : ""}${repos.length > 0 ? `・リポジトリ：${repos.join("・")}` : ""}`,
    TaskUnblocked: "依存先の子タスクが完了したため、実行待ちにした",
    SplitCompleted: "子タスクがすべて完了したため、タスク分割を完了",
    IntegrationReviewed: (passed: boolean, branch: string, commit: string, findings: number) =>
      `統合レビュー（${branch}・${commit}）：${passed ? "合格・承認待ち" : `不合格（${findings}件）`}`,
    StepCompleted: (step: string) => `${step}を完了（承認なし）`,
    reproduced: (exitCode: number | undefined) =>
      `再現を確認（終了コード ${exitCode ?? "?"}）・実装へ`,
    notReproduced: (detail: string) => `再現できなかった（${detail}）・判断待ち`,
    testsPassed: (exitCode: number | undefined) => `テストが通った・終了コード ${exitCode ?? "?"}`,
    changesAtStep: (step: string) => `${step}を差し戻し`,
    changesTarget: (where: string, target: string, revoke: boolean) =>
      `${where}、${target}からやり直し${revoke ? `（${target}の承認を取り消し）` : ""}`,
    changesTail: (count: number, overLimit: boolean, actor: string) =>
      `：指摘${count}件${overLimit ? "（上限を超えて）" : ""}（${actor}）`,
    RemarkVoided: (id: string, actor: string) => `指摘 ${id} を無効にした（${actor}）`,
    /** 長い行を展開する印（PR #127 レビュー指摘）。 */
    more: "詳細",
    /** コンテキストの用意。1行目は層と注意、詳細（展開）は使える外部 PF（PR #127 レビュー指摘）。 */
    ContextResolved: (layers: string[], warnings: string[]) =>
      `コンテキストを用意：${layers.join(" → ")}${warnings.length > 0 ? `／注意：${warnings.join(" ")}` : ""}`,
    ContextPlatforms: (
      platforms: { name: string; from?: string; description: string; allow: string[] }[],
    ) =>
      platforms.length > 0
        ? `使える外部 PF：${platforms.map((p) => `${p.name}（${p.from ?? "config.yaml"}${p.description ? `。${p.description}` : ""}。${p.allow.join("、")}）`).join("・")}`
        : "",
    /** 置いた段階のサブエージェントの定義（PBI-119）。詳細（展開）に出す。 */
    ContextTiers: (
      tiers: { tier: string; agentId: string; model?: string; reasoningEffort?: string }[],
    ) =>
      tiers.length > 0
        ? `段階のサブエージェント：${tiers.map((t) => `${t.tier}＝${t.agentId}${t.model || t.reasoningEffort ? `（${[t.model, t.reasoningEffort].filter(Boolean).join("・")}）` : ""}`).join("、")}`
        : "",
    TaskCancelled: (done: string[], failed: string[], actor: string) =>
      `中止（${actor}）：${done.length > 0 ? `${done.join("・")}を片付けた` : "片付ける対象なし"}${failed.length > 0 ? `／失敗：${failed.join("・")}` : ""}`,
    escalatedUndecidable: (id: string | undefined) =>
      `エスカレーション：${id ?? "変更の申し出"}を判定できなかった`,
    escalatedTooMany: (step: string) => `エスカレーション：${step}への差し戻しが上限`,
    escalatedRework: (step: string) => `エスカレーション：PR の指摘で${step}まで戻すかの確認`,
    PullRequestReviewImported: (number: number, authors: string, count: number) =>
      `PR #${number} の指摘（${authors}）を${count}件取り込んだ`,
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
    DeploymentWatchStarted: (number: number, commit: string | undefined) =>
      commit
        ? `PR #${number} のマージのコミット（${commit.slice(0, 7)}）の監視を始めた`
        : `PR #${number} のマージのコミットが分からないため、監視を飛ばした`,
    DeploymentCiFinished: (
      result: "passed" | "failed" | "none" | "timed_out",
      failed: string[],
      skill: string | undefined,
      skipCheck: string | undefined,
    ) =>
      result === "passed"
        ? skill
          ? `CI/CD が通った。スキル ${skill} で確かめる`
          : `CI/CD が通った。スキルの確認は飛ばした${skipCheck ? `：${skipCheck}` : ""}`
        : result === "failed"
          ? `CI/CD が失敗した：${failed.join("、")}`
          : result === "none"
            ? "CI/CD が無いため、監視を飛ばした"
            : "CI/CD が時間内に終わらなかった",
    DeploymentCheckStarted: (skill: string) => `スキルの確認を始めた（${skill}）`,
    DeploymentChecked: (
      result: "healthy" | "unhealthy" | "unknown",
      detail: string | undefined,
      cost: string,
    ) =>
      `スキルの確認：${result === "healthy" ? "問題なし" : result === "unhealthy" ? "失敗・エラーあり" : "判断できない"}（${cost}）${detail ? `：${detail}` : ""}`,
    DeploymentCheckStopped: (detail: string | undefined, cost: string) =>
      `スキルの確認を中断した。再開すると確かめ直す（${cost}）${detail ? `：${detail}` : ""}`,
    /** スキルに従った CI/CD の確認・デプロイの確認それぞれの結果（PBI-116）。 */
    deploymentPart: (kind: "ci" | "deployment", result: string, reason: string | undefined) =>
      ` / ${kind === "ci" ? "CI/CD の確認" : "デプロイの確認"}：${
        {
          passed: "通った",
          failed: "失敗",
          healthy: "正しく動いている",
          unhealthy: "エラーになっている",
          skipped: "飛ばした",
          unknown: "判断できない",
        }[result] ?? result
      }${reason ? `（${reason}）` : ""}`,
    DeploymentWatchSkipped: (detail: string) => `スキルの確認を飛ばした：${detail}`,
    DeploymentFixRegistered: (kind: "ci" | "deployment", title: string) =>
      `修正のタスクを登録した（${kind === "ci" ? "CI/CD" : "デプロイ後のアプリ"}）：${title}`,
    DeploymentFixSuppressed: (reason: "duplicate" | "chain_limit", max: number) =>
      reason === "duplicate"
        ? "同じ失敗の修正のタスクが終わっていないため、修正のタスクを作らなかった"
        : `修正の連鎖が上限（${max}段）に達したため、修正のタスクを作らなかった`,
    ReworkJudged: (target: string | undefined, reason: string, tail: string) =>
      `戻し先：${target ?? "判断できない"}（${reason}・${tail}）`,
    // 完了したタスクの監査（PBI-125）
    AuditQueued: (cap: string) => `監査を待つ（予算 ${cap}）`,
    AuditSurveyed: (concerns: number, tail: string) =>
      `大まかな監査を終えた（懸念のある工程 ${concerns}件・${tail}）`,
    AuditDeepDived: (step: string, findings: number, memories: number, tail: string) =>
      `${step}の深掘りを終えた（原因 ${findings}件・${memories > 0 ? `メモリーを ${memories}件登録・` : ""}${tail}）`,
    AuditCompleted: "監査を終えた",
    AuditFailed: (reason: string) => `監査を実行できなかった：${reason}`,
    AuditBudgetWarned: (used: string, cap: string) =>
      `監査の予算の 80% に達した（${used} / ${cap}）`,
    AuditBudgetPaused: (used: string, cap: string) =>
      `監査の予算の上限に達したため、監査を一時停止した（${used} / ${cap}）`,
    AuditCapRaised: (cap: string) => `監査の予算の上限を ${cap} に上げて再開した`,
    AuditProposalAdopted: (withTask: boolean): string =>
      withTask ? "改修の提案を採用し、改修のタスクを作った" : "改修の提案を採用した（Sacty 宛て）",
    AuditProposalRejected: (reason: string) => `改修の提案を却下した：${reason}`,
    AuditMemoryDeleted: (reason: "person" | "capacity" | "expired" | "promoted"): string =>
      reason === "person"
        ? "監査が登録したメモリーを消した"
        : reason === "capacity"
          ? "階層の件数の上限を超えたので、この監査が登録したメモリーを消した"
          : reason === "expired"
            ? "残す日数を過ぎたので、この監査が登録したメモリーを消した"
            : "コンテキストにする改修がマージされたので、この監査が登録したメモリーを消した",
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
    deployment: "After-merge watch",
    document: "Document",
    operation: "Operation",
  },
  start: {
    sacty: "Sacty",
    github_issue: "GitHub Issue",
    github_pull_request: "GitHub PR",
    split: "Task split",
    jira: "JIRA",
    deployment: "After-merge watch",
    audit: "Audit proposal",
  },
  template: { "sacty-setup": "Sacty setup" },
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
    budget: "The budget cap was reached. The work so far is kept.",
    usage_limit: "The AI usage limit was reached. Resume once it resets to rerun the stopped step.",
    auth: "Authentication failed. Check the token or API key, then resume.",
    error: "Stopped on an error. Check the cause, then resume to rerun the stopped step.",
    verification:
      "The implementation keeps failing the tests or the final review. Check the results, revisit the design if needed, then resume to implement again.",
    manual: "A person paused this task. Resume to continue from where it stopped.",
    child_cancelled:
      "A subtask was cancelled. Resume to continue without it, or cancel to also cancel the unfinished subtasks.",
  },
  auth: {
    subscription: "Subscription",
    "api-key": "API key",
    bedrock: "Amazon Bedrock",
    provider: "Provider",
    stub: "Stub",
  },
  actor: {
    person: "person",
    sacty: "Sacty",
    orchestrator: "Orchestrator",
    guardian: "Goal Guardian",
    agent: "step agent",
    auditor: "audit",
  },
  verdict: {
    approved: "Approved",
    rejected: "Rejected",
    undecidable: "Undecidable",
  },
  state: {
    guardianJudging: "Goal Guardian is judging",
    completed: "Done",
    completedNoChanges: "Done (no changes)",
    testsRunning: "Running tests",
    watchingCi: "After-merge watch · waiting for CI/CD",
    watchingCheck: "After-merge watch · checking",
    finalReviewing: "Goal Guardian is doing the final review",
    changeUndecided: "Change request needs you",
    reworkConfirmation: "Step to redo for PR comments needs you",
    reworkJudging: "Goal Guardian is judging PR comments",
    noChangesReview: (n) =>
      `Implement awaiting approval with no changes${n > 1 ? ` (submission ${n})` : ""}`,
    stepPrAwaitingMerge: (step, n) =>
      `${step} PR awaiting merge${n > 1 ? ` (submission ${n})` : ""}`,
    prClosed: "PR closed · needs you",
    prMergedOutdated: "Merged with different content · approving",
    notReproduced: "Not reproduced · needs you",
    integrationFailed: "Integration review failed · needs you",
    stepApproval: (step, n) => `${step} awaiting approval${n > 1 ? ` (submission ${n})` : ""}`,
  },
  action: {
    decide: "Decide",
    review: "Review",
    reviewOnPr: "Review on the PR",
    newTab: "(opens in a new tab)",
  },
  cleanupTarget: {
    container: "Running container",
    workspace: "Workspace",
    session: "Agent sessions",
    branch: "Branch created by Sacty",
    pull_request: "PR opened by Sacty",
  },
  orchestratorSession: {
    reason: {
      first: "first run in this task",
      agent_changed: "the agent was changed",
      truncated: "the saved session was cut at the size limit",
      files_broken: "the saved session files were missing or broken",
      resume_failed: "the AI did not accept the resume",
    },
    notSaved: {
      not_archived: "the original files could not be copied",
      no_session: "the session ID is unknown",
      session_missing: "the session file is missing",
      copy_failed: "could not write to the session store",
    },
  },
  cleanupResult: { done: "Cleaned up", skipped: "Nothing to clean", failed: "Failed" },
  event: {
    estimated: " · estimate",
    withCost: (actor, cost) => `${actor} · ${cost}`,
    TaskCreated: (actor, template, rerun) =>
      `Task created (${actor}${template ? ` · template: ${template}` : ""}${rerun ? " · rerun of a cancelled task" : ""})`,
    StepsChosen: (steps, reason) => `Steps chosen: ${steps}${reason ? ` (${reason})` : ""}`,
    stepsImages: (images, source, reason) =>
      ` / images: ${images} (${source === "project" ? "set on the project target" : source === "rerun" ? "set by a person on rerun" : reason ? `Orchestrator: ${reason}` : "Orchestrator"})`,
    stepImage: (step, image) => `${step}=${image}`,
    stepsDefaultImages: (reasons) => ` / Default image: ${reasons}`,
    stepDefaultImage: (step, reason) => `${step}: ${reason}`,
    stepsImagesUnexplained: (steps) => ` / Default image without a reason: ${steps}`,
    imagesJoin: ", ",
    stepsExports: (exports) => ` / Export: ${exports}`,
    stepsNoTests: (reason) => ` / No tests in the repository: ${reason}`,
    stepsDeployment: (skill) => ` / After-merge watch: yes (skill ${skill})`,
    stepsDeploymentSkipped: (reason) => ` / After-merge watch: skipped (${reason})`,
    stepsServices: (names, source, steps, reason) =>
      ` / Services: ${names || "all"} (${source}; used in ${steps})${reason ? `: ${reason}` : ""}`,
    stepsNoServices: (shared, reason) =>
      ` / ${shared ? `Shared compose (${shared})` : "Services"}: not used${reason ? ` (${reason})` : ""}`,
    sharedComposeFile: (name, file, where) =>
      `${file} of the shared compose "${name}"${where ? ` (${where})` : ""}`,
    stepExport: (step, to, reason) =>
      `${step}=${to ? `${to.name}${to.location ? `: ${to.location}` : ""}` : "not exported"}${reason ? ` (${reason})` : ""}`,
    TicketTriaged: (repo, reason, byPerson) =>
      byPerson
        ? `Chose the repository: ${repo} (person)`
        : `Read the ticket and decided the repository: ${repo} (${reason})`,
    RepositoryChosen: (repo, reason, byPerson) =>
      byPerson
        ? `Chose the repository: ${repo} (person)`
        : `Chose the repository from the project's targets: ${repo} (${reason})`,
    TicketPullRequestCommented: (url) =>
      url
        ? `Commented the PR URL on the ticket (${url})`
        : "Could not comment the PR URL on the ticket",
    ServicesStarted: (step, file, services, forTests, sharedPorts) =>
      `Started services for ${forTests ? `the ${step} tests` : step}: ${services} (${file})${sharedPorts ? ` / not forwarded to localhost: ${sharedPorts}` : ""}`,
    serviceHostPorts: (name, ports) => `${name} (${ports})`,
    stepsJoin: " → ",
    AgentRunStarted: (step, agent, auth) => `${step} started (${agent} · ${auth})`,
    AgentRunCompleted: (step, cost, viewpoints, selfReview) =>
      `${step} finished (${cost}${viewpoints === undefined ? "" : ` · ${viewpoints} test viewpoint${viewpoints === 1 ? "" : "s"}`}${selfReview === undefined ? "" : selfReview === null ? " · no self-review record" : ` · self-review ${selfReview.passed ? "passed" : "not passed"} (${selfReview.rounds} round${selfReview.rounds === 1 ? "" : "s"})`})`,
    AgentRunFailed: (step, message) => `${step} failed: ${message}`,
    BudgetWarned: (used, cap) => `Reached 80% of budget (${used} / ${cap})`,
    BudgetCapRaised: (cap, actor) => `Budget cap changed to ${cap} (${actor})`,
    StepAgentChanged: (step, from, to, actor) =>
      `Changed the agent for ${step} from ${from} to ${to} (${actor})`,
    StepImageChanged: (step, from, to, actor) =>
      `${step} image changed from ${from} to ${to} (${actor})`,
    TaskResumed: (actor) => `Resumed (${actor})`,
    TaskPausedManual: (actor) => `Paused (${actor})`,
    submittedStep: (step, n) => `${step} submitted (submission ${n})`,
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
    TestsSkipped: "No test command, so the tests were skipped; on to the final review",
    FinalReviewed: (passed, failures, tail) =>
      `Final review: ${passed ? "passed" : `failed (${failures})`} (${tail})`,
    prPublished: (number, branch, commit) =>
      `PR opened or updated (#${number} · ${branch} · ${commit})`,
    branchPushed: (branch, commit) => `No PR; branch only (${branch} · ${commit})`,
    NoChangesFound: "The implementation changed nothing, so no PR was opened; awaiting approval",
    BranchPushed: (branch, commit) => `Pushed to Sacty branch (${branch} · ${commit})`,
    TaskBranchCreated: (branch, commit) => `Created the task branch (${branch} · ${commit})`,
    StepBranchPushed: (step, branch, commit) =>
      `Pushed the ${step} file to a branch (${branch} · ${commit})`,
    PullRequestLabeled: (number, label, created) =>
      `Added the review label "${label}" to PR #${number}${created ? " (created the label)" : ""}`,
    PullRequestLabelFailed: (number, label, message) =>
      `Could not add the review label "${label}" to PR #${number}: ${message}`,
    StepPullRequestPublished: (step, number, path, supersedes) =>
      `Opened or updated the ${step} PR (#${number} · ${path})${supersedes ? `; closed PR #${supersedes}` : ""}`,
    PullRequestMerged: (number, by) => `PR #${number} merged and approved${by ? ` (${by})` : ""}`,
    PullRequestMergedOutdated: (number, by) =>
      `PR #${number} was merged with content older than the latest submission${by ? ` (${by})` : ""} · needs you`,
    PullRequestMergedEdited: (number, by, submitted, final, fallback) =>
      `PR #${number} was merged with a person's edits and approved${by ? ` (${by})` : ""} (${submitted} → ${final})${fallback === "deleted" ? ". The file was deleted, so Sacty's version was approved" : fallback === "unreadable" ? ". The file could not be read, so Sacty's version was approved" : ""}`,
    PullRequestClosed: (number) => `PR #${number} closed without merging · needs you`,
    PullRequestReopened: (number) => `PR #${number} reopened · awaiting merge`,
    IssueCommented: (url) => `Posted the investigation result to the issue (${url})`,
    ReviewTargetResolved: (url, commit) => `Confirmed the PR to review (${url} · ${commit})`,
    PullRequestReviewPosted: (url) => `Posted the review to the PR (${url})`,
    ReviewRestarted: (actor) => `Started a re-review (${actor})`,
    ReviewRestartedByRequest: (actor) =>
      `Started a re-review because a review was re-requested on the PR (${actor})`,
    cancelledBecause: (text, reason) =>
      `${text} (${reason === "pull_request_merged" ? "the PR was merged" : "the PR was closed"})`,
    IssueCommentFailed: (message) =>
      `Could not post the investigation result to the issue: ${message}`,
    GitHubCommentsPosted: (step, results) =>
      `Result of posting the GitHub comments requested in the ${step} output: ${results.join("; ") || "none"}`,
    GitHubCommentPosted: (url) => `posted (${url})`,
    GitHubCommentFailed: (target, message) => `could not post to ${target} (${message})`,
    GuardianMissed: "Goal Guardian miss: a deliverable that passed the final review was sent back",
    FinalReviewFailed: (message, cost) => `${message} (${cost})`,
    OrchestratorFailed: (message, cost) => `${message} (${cost})`,
    AgentSessionArchived: (files, truncated) =>
      `Copied ${files} original file${files === 1 ? "" : "s"} written by the agent${truncated > 0 ? ` (${truncated} with the middle omitted)` : ""}`,
    AgentSessionNotArchived:
      "Did not copy the agent's original files; the container could not be confirmed to have stopped",
    OrchestratorSessionResumed: (id) => `Resumed the orchestrator session (${id})`,
    OrchestratorSessionStarted: (reason, id) =>
      `Started a new orchestrator session (${reason})${id ? `: ${id}` : ""}`,
    ChatSessionForked: (from, id) =>
      `Forked the session (${from}) to answer the question${id ? `: ${id}` : ""}`,
    ChatSessionStarted: (reason) => `Started a new session to answer the question (${reason})`,
    sessionNotSaved: (why) => `. The session could not be saved (${why})`,
    sessionHandoff: (from, id, truncated) =>
      `. Handed over the conversation of the previous agent's (${from}) session (${id})${truncated ? " (older parts omitted)" : ""}`,
    AgentFellBack: (from, to, role, until, reason) =>
      `${from} ${{ usage_limit: "reached its usage limit", auth: "failed to authenticate", error: "failed" }[reason]}, so retrying with ${to} (${role}; ${from} is not used${reason === "usage_limit" ? "" : " for this task"} until ${until.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })})`,
    AiRequestsRetried: (retries, seconds, statuses, gaveUp) =>
      `The gateway retried the AI call ${retries} time${retries === 1 ? "" : "s"} (${statuses}; ${seconds}s in total)${gaveUp ? " · gave up at the limit" : ""}`,
    StepQueued: (step) => `${step} queued`,
    TaskSplit: (count, reason, repos = []) =>
      `Split into ${count} subtask${count === 1 ? "" : "s"}${reason ? ` (${reason})` : ""}${repos.length > 0 ? `; repositories: ${repos.join(", ")}` : ""}`,
    TaskUnblocked: "Queued because the subtasks it depends on are done",
    SplitCompleted: "All subtasks are done, so the task split is complete",
    IntegrationReviewed: (passed, branch, commit, findings) =>
      `Integration review (${branch} · ${commit}): ${passed ? "passed · awaiting approval" : `failed (${findings})`}`,
    StepCompleted: (step) => `${step} done (no approval)`,
    reproduced: (exitCode) => `Reproduced (exit code ${exitCode ?? "?"}) · on to Implement`,
    notReproduced: (detail) => `Not reproduced (${detail}) · needs you`,
    testsPassed: (exitCode) => `the tests passed, exit code ${exitCode ?? "?"}`,
    changesAtStep: (step) => `Changes requested on ${step}`,
    changesTarget: (where, target, revoke) =>
      `${where}; redo from ${target}${revoke ? ` (${target} approval revoked)` : ""}`,
    changesTail: (count, overLimit, actor) =>
      `: ${count} comment${count === 1 ? "" : "s"}${overLimit ? " (over the limit)" : ""} (${actor})`,
    RemarkVoided: (id, actor) => `Comment ${id} voided (${actor})`,
    more: "Details",
    ContextResolved: (layers, warnings) =>
      `Context prepared: ${layers.join(" → ")}${warnings.length > 0 ? `; notes: ${warnings.join(" ")}` : ""}`,
    ContextPlatforms: (platforms) =>
      platforms.length > 0
        ? `External platforms: ${platforms.map((p) => `${p.name} (${p.from ?? "config.yaml"}${p.description ? `; ${p.description}` : ""}; ${p.allow.join(", ")})`).join(", ")}`
        : "",
    ContextTiers: (tiers) =>
      tiers.length > 0
        ? `Tier subagents: ${tiers.map((t) => `${t.tier}=${t.agentId}${t.model || t.reasoningEffort ? ` (${[t.model, t.reasoningEffort].filter(Boolean).join(", ")})` : ""}`).join(", ")}`
        : "",
    TaskCancelled: (done, failed, actor) =>
      `Cancelled (${actor}): ${done.length > 0 ? `cleaned up ${done.join(", ")}` : "nothing to clean up"}${failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""}`,
    escalatedUndecidable: (id) =>
      `Escalated: the Goal Guardian could not decide ${id ?? "the change request"}`,
    escalatedTooMany: (step) => `Escalated: changes to ${step} reached the limit`,
    escalatedRework: (step) =>
      `Escalated: confirm whether to redo from ${step} for the PR comments`,
    PullRequestReviewImported: (number, authors, count) =>
      `Imported ${count} comment${count === 1 ? "" : "s"} on PR #${number} (${authors})`,
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
    DeploymentWatchStarted: (number, commit) =>
      commit
        ? `Started watching the merge commit of PR #${number} (${commit.slice(0, 7)})`
        : `Skipped the watch because the merge commit of PR #${number} is unknown`,
    DeploymentCiFinished: (result, failed, skill, skipCheck) =>
      result === "passed"
        ? skill
          ? `CI/CD passed. Checking with the skill ${skill}`
          : `CI/CD passed. Skipped the check by the skill${skipCheck ? `: ${skipCheck}` : ""}`
        : result === "failed"
          ? `CI/CD failed: ${failed.join(", ")}`
          : result === "none"
            ? "Skipped the watch because there is no CI/CD"
            : "CI/CD did not finish in time",
    DeploymentCheckStarted: (skill) => `Started the check by the skill (${skill})`,
    DeploymentChecked: (result, detail, cost) =>
      `Check by the skill: ${result === "healthy" ? "no problems" : result === "unhealthy" ? "failures or errors found" : "could not determine"} (${cost})${detail ? `: ${detail}` : ""}`,
    DeploymentCheckStopped: (detail, cost) =>
      `Stopped the check by the skill. It is checked again on resume (${cost})${detail ? `: ${detail}` : ""}`,
    deploymentPart: (kind, result, reason) =>
      ` / ${kind === "ci" ? "CI/CD check" : "Deployment check"}: ${
        {
          passed: "passed",
          failed: "failed",
          healthy: "working",
          unhealthy: "erroring",
          skipped: "skipped",
          unknown: "could not determine",
        }[result] ?? result
      }${reason ? ` (${reason})` : ""}`,
    DeploymentWatchSkipped: (detail) => `Skipped the check by the skill: ${detail}`,
    DeploymentFixRegistered: (kind, title) =>
      `Registered a fix task (${kind === "ci" ? "CI/CD" : "deployed app"}): ${title}`,
    DeploymentFixSuppressed: (reason, max) =>
      reason === "duplicate"
        ? "Did not create a fix task because one for the same failure is still open"
        : `Did not create a fix task because the chain reached the limit (${max})`,
    ReworkJudged: (target, reason, tail) =>
      `Step to redo: ${target ?? "undecided"} (${reason} · ${tail})`,
    AuditQueued: (cap) => `Waiting for the audit (budget ${cap})`,
    AuditSurveyed: (concerns, tail) =>
      `Finished the survey (${concerns} step${concerns === 1 ? "" : "s"} of concern · ${tail})`,
    AuditDeepDived: (step, findings, memories, tail) =>
      `Finished the deep dive into ${step} (${findings} cause${findings === 1 ? "" : "s"} · ${memories > 0 ? `registered ${memories} memor${memories === 1 ? "y" : "ies"} · ` : ""}${tail})`,
    AuditCompleted: "Finished the audit",
    AuditFailed: (reason) => `The audit could not run: ${reason}`,
    AuditBudgetWarned: (used, cap) => `The audit reached 80% of its budget (${used} / ${cap})`,
    AuditBudgetPaused: (used, cap) =>
      `Paused the audit because it reached its budget cap (${used} / ${cap})`,
    AuditCapRaised: (cap) => `Raised the audit budget cap to ${cap} and resumed`,
    AuditProposalAdopted: (withTask) =>
      withTask ? "Adopted a proposal and created a fix task" : "Adopted a proposal (for Sacty)",
    AuditProposalRejected: (reason) => `Rejected a proposal: ${reason}`,
    AuditMemoryDeleted: (reason) =>
      reason === "person"
        ? "Deleted a memory the audit registered"
        : reason === "capacity"
          ? "Deleted a memory this audit registered because the layer exceeded its limit"
          : reason === "expired"
            ? "Deleted a memory this audit registered because it passed the retention period"
            : "Deleted a memory this audit registered because the fix that made it context was merged",
  },
};

export const labels = { ja, en };
