/** 画面の文言：タスクの一覧（app/page.tsx）。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  title: "タスク",
  allTasks: "すべてのタスク",
  loading: "読み込み中…",
  project: (name: string | undefined) => `プロジェクト：${name ?? ""}`,
  cannotRun: "工程を実行できません。",
  agent: "工程を実行するAI：",
  agentAuth: (auth: string) => `（${auth}）`,
  needsYou: "あなたの出番",
  empty: "タスクはまだありません。「タスクを作成」から最初のタスクを作ってください。",
  column: {
    task: "タスク",
    start: "開始地点",
    steps: "工程（オーケストレーターが選択）",
    status: "状態",
  },
};

export type TasksMessages = typeof ja;

const en: TasksMessages = {
  title: "Tasks",
  allTasks: "All tasks",
  loading: "Loading…",
  project: (name) => `Project: ${name ?? ""}`,
  cannotRun: "Steps cannot run. ",
  agent: "AI running the steps: ",
  agentAuth: (auth) => ` (${auth})`,
  needsYou: "Needs you",
  empty: "No tasks yet. Use “Create task” to make the first one.",
  column: {
    task: "Task",
    start: "Started from",
    steps: "Steps (chosen by the Orchestrator)",
    status: "Status",
  },
};

export const tasks = { ja, en };
