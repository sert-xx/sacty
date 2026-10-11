/** 画面の文言：タスクの作成・プロジェクトのインポート。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  task: {
    create: "タスクを作成",
    description: (project: string) =>
      `プロジェクト「${project}」に作成します。作成すると、オーケストレーターがタスクの内容と対象リポジトリを読んで工程を選び、作業履歴に記録します。`,
    title: "タイトル",
    body: "内容",
    bodyPlaceholder: "背景や、満たしてほしい条件",
    repository: "対象リポジトリ",
    repositoryPlaceholder: "owner/name（入力すると絞り込めます）",
    listFailed: (owner: string, reason: string) =>
      `${owner} のリポジトリを読めませんでした：${reason}`,
    noRepository:
      "タスクの対象にできるリポジトリがありません。プロジェクトの設定で、対象（Org・リポジトリ）を追加してください。",
    projectSettings: "プロジェクトの設定を開く",
    close: "閉じる",
    creating: "作成中…",
    submit: "作成する",
  },
  import: {
    label:
      "sacty からエクスポートしたプロジェクトの定義（JSON）を選んでください。新しいプロジェクトとして作ります。対象がほかのプロジェクトと重複していれば、インポートしません。",
    submit: "インポートする",
  },
};

export type FormsMessages = typeof ja;

const en: FormsMessages = {
  task: {
    create: "Create task",
    description: (project) =>
      `Creates the task in the project "${project}". The Orchestrator then reads the task and the target repository, chooses the steps, and records them in the Activity.`,
    title: "Title",
    body: "Description",
    bodyPlaceholder: "Background and the conditions it should meet",
    repository: "Target repository",
    repositoryPlaceholder: "owner/name (type to filter)",
    listFailed: (owner: string, reason: string) =>
      `Could not list the repositories of ${owner}: ${reason}`,
    noRepository:
      "No repository can be a task target. Add targets (orgs or repositories) in the project settings.",
    projectSettings: "Open project settings",
    close: "Close",
    creating: "Creating…",
    submit: "Create",
  },
  import: {
    label:
      "Choose a project definition (JSON) exported from sacty. It is created as a new project. If a target overlaps with another project, nothing is imported.",
    submit: "Import",
  },
};

export const forms = { ja, en };
