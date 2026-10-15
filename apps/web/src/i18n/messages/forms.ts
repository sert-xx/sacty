/** 画面の文言：タスクの作成・プロジェクトのインポート。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  task: {
    create: "タスクを作成",
    description: (project: string) =>
      `プロジェクト「${project}」に作成します。作成すると、オーケストレーターがタスクの内容と対象リポジトリを読んで工程を選び、作業履歴に記録します。`,
    title: "タイトル",
    body: "内容",
    bodyPlaceholder: "背景や、満たしてほしい条件",
    template: "テンプレート",
    templateNone: "なし（自由に書く）",
    templateSetup: "Sacty セットアップ",
    templateSetupHint:
      "選んだリポジトリを sacty で扱うためのエージェントの設定（エージェント向けの指示・テストの実行の仕方・テストに要るサービス・デプロイの確認のスキル）を検査し、足りないものを整える PR を作ります。題と内容は sacty が決めます。\n整っていて変更が要らなければ、PR を作らずに検査の結果を残して終えます。",
    repository: "対象リポジトリ（任意）",
    repositoryRequired: "対象リポジトリ",
    templateRepositoryHint: "検査して整えるリポジトリを、プロジェクトの対象から選んでください。",
    repositoryPlaceholder: "リポジトリの URL（入力すると絞り込めます）",
    repositoryHint:
      "空欄にすると、リポジトリを指定せずに作ります。調べもの・全体の設計はリポジトリ無しで進め、コードの変更が要るときは、オーケストレーターがプロジェクトの対象からリポジトリを選びます（分割するタスクは、子タスクごとに選びます）。",
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
      "sacty からエクスポートしたプロジェクトの定義（JSON）を選んでください。新しいプロジェクトとして作ります。対象がほかのプロジェクトと重複していれば、インポートしません。Slack のメンション（相手と種類）は含まないので、インポートの後に、プロジェクトの設定で相手と種類の両方を必要に応じて設定し直してください（種類は既定に戻ります）。",
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
    template: "Template",
    templateNone: "None (write your own)",
    templateSetup: "Sacty setup",
    templateSetupHint:
      "Checks the agent setup that sacty needs in the chosen repository (instructions for agents, how to run the tests, services the tests need, and the deployment check skill) and opens a PR that fills in what is missing. sacty writes the title and description.\nIf nothing needs to change, it finishes without a PR and keeps the results of the check.",
    repository: "Target repository (optional)",
    repositoryRequired: "Target repository",
    templateRepositoryHint: "Choose the repository to check and set up from the project's targets.",
    repositoryPlaceholder: "Repository URL (type to filter)",
    repositoryHint:
      "Leave it empty to create the task without a repository. Research and overall design proceed without one; when code must change, the Orchestrator chooses a repository from the project's targets (for a split task, one per subtask).",
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
      "Choose a project definition (JSON) exported from sacty. It is created as a new project. If a target overlaps with another project, nothing is imported. Slack mentions (targets and kinds) are not included. After importing, set both the targets and the kinds again in the project settings as needed (the kinds return to the default).",
    submit: "Import",
  },
};

export const forms = { ja, en };
