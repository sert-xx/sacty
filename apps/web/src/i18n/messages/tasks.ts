/** 画面の文言：タスクの一覧（app/projects/[id]/tasks/page.tsx）。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  title: "タスク",
  allTasks: "すべてのタスク",
  loading: "読み込み中…",
  project: (name: string | undefined) => `プロジェクト：${name ?? ""}`,
  cannotRun: "工程を実行できません。",
  agent: "実行する AI：",
  agentAuth: (auth: string) => `（${auth}）`,
  needsYou: "あなたの出番",
  empty: "タスクはまだありません。",
  noRepository: "リポジトリ無し",
  column: {
    task: "タスク",
    start: "開始地点",
    steps: "工程",
    status: "状態",
  },
  /** 工程の列の補足。 */
  stepsHint: "タスクの内容と対象リポジトリを読んで、オーケストレーターが選びます。",
  /** 状態の列に添える印：承認待ちの実装の PR の CI が、Sacty が読んだ時点で失敗していた（PBI-371）。 */
  ciFailed: "CI 失敗",
  ciFailedHint:
    "Sacty が PR の CI を読んだ時点の結果です。読み直す間に通れば消えます。読み直すのは、PR の先頭のコミットごとに12回まで（ふつうは、最初に読んでから1時間ほどの間）で、その後の結果は反映されません。失敗していたチェックは、タスクの詳細に出ます。",
  /** 子タスクの行で、読み上げに親を伝える（字下げは見た目だけなので。PBI-341）。 */
  specifiedRepositories: "指定したリポジトリ",
  workingRepository: "作業するリポジトリ",
  childOf: (parent: string) => `（${parent} の子タスク）`,
  /** 一覧の絞り込み。 */
  filter: {
    label: "タスクを絞り込む",
    query: "検索",
    queryPlaceholder: "題に含む文字",
    from: "開始時期（から）",
    to: "開始時期（まで）",
    start: "開始地点",
    repo: "リポジトリ",
    status: "状態",
    all: "すべて",
    noRepo: "未定・リポジトリ無し",
    tone: {
      active: "終わっていない",
      working: "進行中",
      waiting: "待ち",
      person: "あなたの出番",
      completed: "完了",
      cancelled: "中止",
    },
    clear: "条件をクリア",
    count: (shown: number, total: number) => `${total}件中 ${shown}件`,
    /** 絞り込みに合う行が、一度に出す行数より多いとき（出している件数も伝える）。 */
    countPartial: (shown: number, total: number, displayed: number) =>
      `${total}件中 ${shown}件（${displayed}件を表示）`,
    /** 続きを足すボタン。残りの件数を出す。 */
    more: (remaining: number) => `さらに表示（残り${remaining}件）`,
    none: "条件に合うタスクはありません。",
  },
};

export type TasksMessages = typeof ja;

const en: TasksMessages = {
  title: "Tasks",
  allTasks: "All tasks",
  loading: "Loading…",
  project: (name) => `Project: ${name ?? ""}`,
  cannotRun: "Steps cannot run. ",
  agent: "AI: ",
  agentAuth: (auth) => ` (${auth})`,
  needsYou: "Needs you",
  empty: "No tasks yet.",
  noRepository: "No repository",
  column: {
    task: "Task",
    start: "Started from",
    steps: "Steps",
    status: "Status",
  },
  stepsHint: "The Orchestrator chooses them from the task and the target repository.",
  ciFailed: "CI failed",
  ciFailedHint:
    "The result when Sacty read the PR's CI. It clears if CI passes while Sacty is still re-reading it. Sacty re-reads up to 12 times per head commit of the PR (usually within about an hour of its first read); later results are not reflected. The task details list the checks that were failing.",
  specifiedRepositories: "Specified repositories",
  workingRepository: "Working repository",
  childOf: (parent) => ` (child task of ${parent})`,
  filter: {
    label: "Filter tasks",
    query: "Search",
    queryPlaceholder: "Text in the title",
    from: "Start date (from)",
    to: "Start date (to)",
    start: "Started from",
    repo: "Repository",
    status: "Status",
    all: "All",
    noRepo: "Not decided / No repository",
    tone: {
      active: "Not finished",
      working: "In progress",
      waiting: "Waiting",
      person: "Needs you",
      completed: "Completed",
      cancelled: "Cancelled",
    },
    clear: "Clear filters",
    count: (shown, total) => `${shown} of ${total}`,
    countPartial: (shown, total, displayed) => `${shown} of ${total} (showing ${displayed})`,
    more: (remaining) => `Show more (${remaining} left)`,
    none: "No tasks match the filters.",
  },
};

export const tasks = { ja, en };
