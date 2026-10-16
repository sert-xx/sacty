/** 画面の文言：ダッシュボード（app/dashboard/page.tsx。PBI-114）。英語の用語は labels.ts の用語集に合わせる。 */
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
};

export const dashboard = { ja, en };
