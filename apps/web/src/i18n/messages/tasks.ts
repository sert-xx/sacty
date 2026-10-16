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
};

export const tasks = { ja, en };
