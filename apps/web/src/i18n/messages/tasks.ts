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
    none: "No tasks match the filters.",
  },
};

export const tasks = { ja, en };
