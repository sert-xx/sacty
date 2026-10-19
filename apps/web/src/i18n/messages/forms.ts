/**
 * 画面の文言：タスクの作成・プロジェクトのインポート。英語の用語は labels.ts の用語集に合わせる。
 * 仕組みの説明は *Hint に書き、補足の印で出す（PBI-117）。
 */
const ja = {
  task: {
    create: "タスクを作成",
    description: (project: string) => `プロジェクト：${project}`,
    descriptionHint:
      "工程は、タスクの内容と対象リポジトリを読んでオーケストレーターが選び、作業履歴に記録します。",
    title: "タイトル",
    body: "内容",
    bodyPlaceholder: "背景や、満たしてほしい条件",
    template: "テンプレート",
    templateNone: "なし",
    templateSetup: "Sacty セットアップ",
    templateSetupNote:
      "リポジトリのエージェントの設定を検査し、足りないものを整える PR を作ります。題と内容は Sacty が決めます。",
    templateSetupHint:
      "検査するもの：エージェント向けの指示・テストの実行の仕方・テストに要るサービス・デプロイの確認のスキル。整っていて変更が要らなければ、PR を作らずに検査の結果だけを残します。",
    repository: "対象リポジトリ（任意）",
    repositoryRequired: "対象リポジトリ",
    templateRepositoryHint: "検査して整えるリポジトリを、プロジェクトの対象から選びます。",
    repositoryPlaceholder: "リポジトリの URL",
    repositoryHint:
      "空欄なら、リポジトリを指定せずに作ります。調べものや全体の設計はリポジトリ無しで進み、コードの変更が要るときはオーケストレーターがプロジェクトの対象から選びます。入力すると候補を絞り込めます。",
    listFailed: (owner: string, reason: string) =>
      `${owner} のリポジトリを読めませんでした：${reason}`,
    // リポジトリの候補は、ダイアログを開いたときに読む（PBI-109）。待たずに URL を入力して作成できる
    repositoriesLoading: "候補を読み込み中…",
    repositoriesFailed: (reason: string) => `候補を読めませんでした：${reason}`,
    repositoriesEmpty: "候補はありません。",
    repositoriesNoAnswer: "応答を受け取れませんでした",
    noRepository:
      "対象のリポジトリがありません。プロジェクトの設定で対象（Org・リポジトリ）を追加してください。",
    projectSettings: "プロジェクトの設定を開く",
    close: "閉じる",
    creating: "作成中…",
    submit: "作成する",
  },
  import: {
    label: "Sacty からエクスポートした JSON を選んでください。",
    hint: "新しいプロジェクトとして作ります。対象がほかのプロジェクトと重なると、インポートしません。Slack の通知は Sacty の設定にあり、ファイルには含みません。",
    submit: "インポートする",
  },
};

export type FormsMessages = typeof ja;

const en: FormsMessages = {
  task: {
    create: "Create task",
    description: (project) => `Project: ${project}`,
    descriptionHint:
      "The Orchestrator reads the task and the target repository, chooses the steps, and records them in the Activity.",
    title: "Title",
    body: "Description",
    bodyPlaceholder: "Background and the conditions it should meet",
    template: "Template",
    templateNone: "None",
    templateSetup: "Sacty setup",
    templateSetupNote:
      "Checks the agent setup of the repository and opens a PR that fills in what is missing. Sacty writes the title and description.",
    templateSetupHint:
      "It checks the instructions for agents, how to run the tests, the services the tests need, and the deployment check skill. If nothing needs to change, it keeps the results of the check without a PR.",
    repository: "Target repository (optional)",
    repositoryRequired: "Target repository",
    templateRepositoryHint: "The repository to check and set up, from the project's targets.",
    repositoryPlaceholder: "Repository URL",
    repositoryHint:
      "Leave it empty to create the task without a repository. Research and overall design proceed without one; when code must change, the Orchestrator chooses a repository from the project's targets. Type to filter the suggestions.",
    listFailed: (owner: string, reason: string) =>
      `Could not list the repositories of ${owner}: ${reason}`,
    repositoriesLoading: "Loading suggestions…",
    repositoriesFailed: (reason: string) => `Could not load the suggestions: ${reason}`,
    repositoriesEmpty: "No suggestions.",
    repositoriesNoAnswer: "no answer was received",
    noRepository:
      "No target repository. Add targets (orgs or repositories) in the project settings.",
    projectSettings: "Open project settings",
    close: "Close",
    creating: "Creating…",
    submit: "Create",
  },
  import: {
    label: "Choose a JSON file exported from Sacty.",
    hint: "It is created as a new project. If a target overlaps with another project, nothing is imported. Slack notifications are in the Sacty settings and are not in the file.",
    submit: "Import",
  },
};

export const forms = { ja, en };
