import type { PauseReason } from "@sacty/core";

/**
 * 画面の文言：ダッシュボード（app/dashboard/page.tsx。PBI-114・PBI-118）。英語の用語は labels.ts の用語集に合わせる。
 * 本文は「いま何が起きているか・次に何をするか」だけにし、仕組み・数字の定義・期間の境は補足（hint・*Hint）に書く（PBI-117）。
 */
const ja = {
  title: "ダッシュボード",
  loading: "読み込み中…",
  openTasks: {
    title: "終わっていないタスク",
    summary: (n: number) => `すべてのプロジェクト・${n}件`,
    list: "終わっていないタスクの一覧",
    project: "プロジェクト：",
    status: "状態：",
    noProjects: "プロジェクトがありません。",
    createProject: "プロジェクトを作る",
    empty: "終わっていないタスクはありません。",
  },
  notification: {
    openSettings: "Sacty の設定で Slack の通知を確かめる",
  },
  /** あなたの出番（PBI-118）。 */
  attention: {
    title: "あなたの出番",
    hint: "承認待ち・一時停止・エスカレーションのタスクを、待っている時間が長い順に出します。待ち始めは、その状態になった作業履歴の記録の時刻です。",
    summary: (n: number) => `${n}件`,
    list: "対応待ちのタスクの一覧",
    waiting: "待っている時間：",
    empty: "対応待ちはありません。",
  },
  /** 待っている時間・期間の表示（PBI-118）。 */
  duration: {
    underMinute: "1分未満",
    minutes: (n: number) => `${n}分`,
    hours: (n: number) => `${n}時間`,
    days: (n: number) => `${n}日`,
  },
  /** 止まっているタスクの理由（PBI-118）。 */
  paused: {
    title: "止まっているタスクの理由",
    hint: "一時停止の理由ごとの件数です。件数を押すと、その理由のタスクが出ます。利用上限と認証は、1か所直して再開するとまとめて動くことが多いので目立たせます。",
    summary: (n: number) => `${n}件`,
    empty: "止まっているタスクはありません。",
    count: (n: number) => `${n}件`,
    fixOnce: "1か所直せば動きます",
    reasons: {
      budget: "予算の上限",
      usage_limit: "利用上限",
      auth: "認証",
      error: "エラー",
      verification: "検証の不合格",
      manual: "人が止めた",
      child_cancelled: "子タスクの中止",
    } satisfies Record<PauseReason, string>,
  },
  /** 費用と予算（PBI-118）。 */
  costs: {
    title: "費用と予算",
    hint: (timeZone: string) =>
      `今日と、今日を含む直近7日の費用です。完了・中止したタスクの分も含みます。期間の境は、Sacty を動かしているマシンの日付（${timeZone}）です。`,
    today: "今日",
    days7: "直近7日",
    estimated: "概算",
    estimatedHint:
      "Sacty が使用量と単価から計算した値です（サブスクリプションなどの換算値も含みます）。実際の請求額とは異なることがあります。",
    table: "期間ごとの費用",
    nearBudget: "予算に近いタスク",
    nearBudgetHint: "終わっていないタスクのうち、予算の 80% 以上を使ったか、上限に達したものです。",
    nearBudgetList: "予算に近いタスクの一覧",
    nearBudgetEmpty: "予算に近いタスクはありません。",
    used: "使用済み / 上限：",
    exceeded: "上限に達した",
  },
  /** 取り込みの状況（PBI-118）。文は projects.intake と同じものを使う。 */
  intake: {
    title: "取り込みの状況",
    hint: "Issue・PR のレビュー・チケットの、最後の取り込みの時刻、作ったタスクの数、取り込めなかった対象です。",
  },
  /** 流量（PBI-118）。 */
  flow: {
    title: "流量",
    hint: "完了・中止の件数と、完了したタスクの作成から完了までの時間の中央値です。期間は今日を含み、境は Sacty を動かしているマシンの日付です。",
    table: "期間ごとの完了・中止",
    period: "期間",
    days7: "直近7日",
    days30: "直近30日",
    completed: "完了",
    cancelled: "中止",
    lead: "作成から完了まで",
    leadHint: "その期間に完了したタスクの、作成から完了までの時間の中央値です。",
    none: "—",
  },
  /** 品質の信号（PBI-118）。 */
  quality: {
    title: "品質の信号",
    hint: "今日を含む直近30日の回数です。境は Sacty を動かしているマシンの日付です。",
    counts: "品質の信号の回数",
    changesRequested: "人の差し戻し",
    changesRequestedHint: "承認の画面で、人が成果物を差し戻した回数です。",
    pullRequestRework: "PR の指摘の差し戻し",
    pullRequestReworkHint: "取り込んだ PR の指摘で、工程をやり直した回数です。",
    guardianMissed: "ゴールガーディアンの見逃し",
    guardianMissedHint:
      "最終レビューで合格にした成果物を、見逃しが原因として人が実装の承認で差し戻した回数です。競合や新しい要望による差し戻しは数えません。",
    integrationFailed: "統合レビューの不合格",
    integrationFailedHint: "子タスクの成果を組み合わせた統合レビューで、不合格になった回数です。",
    fixTask: "監視で作った修正のタスク",
    fixTaskHint:
      "マージの後の監視で CI/CD やデプロイの失敗を見つけ、修正のタスクを作った回数です。",
    bySteps: "工程ごとの差し戻し",
    byStepsHint: "人の差し戻しと PR の指摘の差し戻しを、差し戻された成果物の工程ごとに数えます。",
    byCause: "差し戻しの原因",
    byCauseHint:
      "人の差し戻しと PR の指摘の差し戻しを、原因ごとに数えます。見逃しは、ゴールガーディアンの見逃しの欄に数えます。原因は差し戻すときに選ぶか、PR の指摘ならゴールガーディアンが判断します。",
    causes: {
      new_request: "新しい要望・方針の変更",
      base_changed: "ベースの変化による競合",
      unspecified: "原因を決めていない",
    },
    times: (n: number) => `${n}回`,
  },
  /** 工程の待ち行列（PBI-118）。 */
  queue: {
    title: "工程の待ち行列",
    hint: "実行中の件数と同時に実行する数の上限、実行待ちの件数です。実行待ちが上限より多い状態が10分続くと目立たせます。",
    running: "実行中",
    queued: "実行待ち",
    ratio: (running: number, max: number) => `${running} / ${max}`,
    over: "実行待ちが上限より多い状態が続いています。",
    openSettings: "Sacty の設定で上限を変える",
  },
};

export type DashboardMessages = typeof ja;

const en: DashboardMessages = {
  title: "Dashboard",
  loading: "Loading…",
  openTasks: {
    title: "Open tasks",
    summary: (n) => `All projects · ${n} task${n === 1 ? "" : "s"}`,
    list: "List of open tasks",
    project: "Project: ",
    status: "Status: ",
    noProjects: "There are no projects.",
    createProject: "Create a project",
    empty: "There are no open tasks.",
  },
  notification: {
    openSettings: "Check Slack notifications in Sacty settings",
  },
  attention: {
    title: "Needs you",
    hint: "Tasks awaiting approval, paused, or escalated, longest wait first. The wait starts at the activity record that put the task in that state.",
    summary: (n) => `${n} task${n === 1 ? "" : "s"}`,
    list: "List of tasks that need you",
    waiting: "Waiting: ",
    empty: "Nothing needs you right now.",
  },
  duration: {
    underMinute: "under a minute",
    minutes: (n) => `${n} min`,
    hours: (n) => `${n} h`,
    days: (n) => `${n} day${n === 1 ? "" : "s"}`,
  },
  paused: {
    title: "Why tasks are paused",
    hint: "Paused tasks counted by reason. Press a count to see those tasks. Usage limit and authentication are highlighted because one fix and a resume usually move all of them.",
    summary: (n) => `${n} task${n === 1 ? "" : "s"}`,
    empty: "No tasks are paused.",
    count: (n) => `${n} task${n === 1 ? "" : "s"}`,
    fixOnce: "One fix resumes them",
    reasons: {
      budget: "Budget cap",
      usage_limit: "Usage limit",
      auth: "Authentication",
      error: "Error",
      verification: "Verification failed",
      manual: "Paused by a person",
      child_cancelled: "Subtask cancelled",
    },
  },
  costs: {
    title: "Cost and budget",
    hint: (timeZone) =>
      `Cost for today and the last 7 days including today, including completed and cancelled tasks. Days are split by the date of the machine running Sacty (${timeZone}).`,
    today: "Today",
    days7: "Last 7 days",
    estimated: "Estimate",
    estimatedHint:
      "Calculated by Sacty from usage and prices (including converted values such as subscriptions). It may differ from what you are actually billed.",
    table: "Cost by period",
    nearBudget: "Tasks near their budget",
    nearBudgetHint: "Open tasks that used 80% or more of their budget, or reached the cap.",
    nearBudgetList: "List of tasks near their budget",
    nearBudgetEmpty: "No task is near its budget.",
    used: "Used / cap: ",
    exceeded: "Cap reached",
  },
  intake: {
    title: "Intake",
    hint: "For issues, PR reviews, and tickets: the last intake, how many tasks it created, and what could not be imported.",
  },
  flow: {
    title: "Throughput",
    hint: "Completed and cancelled counts, and the median time from creation to completion. Periods include today and are split by the date of the machine running Sacty.",
    table: "Completed and cancelled by period",
    period: "Period",
    days7: "Last 7 days",
    days30: "Last 30 days",
    completed: "Completed",
    cancelled: "Cancelled",
    lead: "Creation to completion",
    leadHint: "Median time from creation to completion for tasks completed in the period.",
    none: "—",
  },
  quality: {
    title: "Quality signals",
    hint: "Counts for the last 30 days including today, split by the date of the machine running Sacty.",
    counts: "Quality signal counts",
    changesRequested: "Changes requested by a person",
    changesRequestedHint: "How many times a person sent a deliverable back on the review screen.",
    pullRequestRework: "Rework from PR feedback",
    pullRequestReworkHint: "How many times imported PR feedback sent a step back for rework.",
    guardianMissed: "Goal guardian misses",
    guardianMissedHint:
      "How many times a person sent back, at implementation approval, a deliverable the final review had passed, with a miss as the cause. Rework caused by conflicts or new requests is not counted.",
    integrationFailed: "Integration review failures",
    integrationFailedHint:
      "How many times the integration review of combined subtask results did not pass.",
    fixTask: "Fix tasks from the post-merge watch",
    fixTaskHint:
      "How many times the post-merge watch found a CI/CD or deployment failure and created a fix task.",
    bySteps: "Rework by step",
    byStepsHint:
      "Changes requested by a person and rework from PR feedback, counted by the step whose deliverable was sent back.",
    byCause: "Rework by cause",
    byCauseHint:
      "Changes requested by a person and rework from PR feedback, counted by cause. Misses are counted under Goal guardian misses. The cause is chosen when requesting changes, or judged by the Goal Guardian for PR feedback.",
    causes: {
      new_request: "New request or change of direction",
      base_changed: "Conflict from base changes",
      unspecified: "Cause not decided",
    },
    times: (n) => `${n} time${n === 1 ? "" : "s"}`,
  },
  queue: {
    title: "Step queue",
    hint: "Running tasks against the parallel limit, and tasks waiting to run. Highlighted when more tasks than the limit have been waiting for 10 minutes.",
    running: "Running",
    queued: "Waiting",
    ratio: (running, max) => `${running} / ${max}`,
    over: "More tasks than the limit have been waiting to run.",
    openSettings: "Change the limit in Sacty settings",
  },
};

export const dashboard = { ja, en };
