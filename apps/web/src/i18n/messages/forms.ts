/**
 * 画面の文言：タスクの作成・プロジェクトのインポート。英語の用語は labels.ts の用語集に合わせる。
 * 仕組みの説明は *Hint に書き、補足の印で出す（PBI-117）。
 */
const ja = {
  task: {
    create: "タスクを作成",
    description: (project: string) => `プロジェクト：${project}`,
    descriptionHint:
      "進め方を自動にすると、タスクの内容と対象リポジトリを読んでオーケストレーターが工程を選び、作業履歴に記録します。",
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
    templateSecurityCheck: "セキュリティチェック",
    templateSecurityCheckNote:
      "リポジトリを点検し、区分ごとの指摘のレポートを作ります。題と内容は Sacty が決めます。",
    templateSecurityCheckHint:
      "点検する区分：依存の脆弱性・サプライチェーン・コードの脆弱性・秘密情報の混入・設定。コードは変えません。承認したレポートの区分ごとに、対応のタスクを作れます。",
    plan: "進め方",
    planAuto: "自動",
    planAutoNote: "タスクの内容からオーケストレーターが選択",
    planHint:
      "指定すると、オーケストレーターは組み合わせを選び直さず、途中で工程を省きません。ベースブランチ・テストのコマンドはオーケストレーターが決めます。イメージとエージェントは「工程ごとに設定」で指定でき、指定しなければいつもどおり決めます。",
    // 進め方の工程ごとのイメージ・エージェント。ダイアログの中の別の画面（工程ごとの設定）で選ぶ
    steps: "工程ごとに設定",
    stepsSummaryDefault: "イメージとエージェントは、いつもどおり決めます",
    stepsSummaryCustomized: (count: number) => `${count}つの工程で、イメージかエージェントを指定`,
    stepsTitle: "工程ごとの設定",
    stepsPlan: (plan: string) => `進め方：${plan}`,
    stepsHint:
      "指定しない項目は、いつもどおり決めます（イメージはプロジェクトの対象の指定かオーケストレーター、エージェントは config.yaml の step_agents）。作成の後も、タスクの詳細の「工程のイメージ」「工程のエージェント」で変えられます。",
    stepsLegend: "「自動」「既定」のままの項目は、いつもどおり決めます。",
    stepsBack: "基本の入力に戻る",
    stepsDone: "完了",
    stepsResetAll: "すべて既定に戻す",
    stepReset: "既定に戻す",
    stepCustomized: "指定あり",
    stepImage: "イメージ",
    stepAgent: "エージェント",
    stepImageAuto: "自動",
    stepAgentDefault: (name?: string) => (name ? `既定：${name}` : "既定"),
    stepAgentGuardian: "ゴールガーディアンが実行",
    stepOptionsLoading: "候補を読み込み中…",
    stepOptionsFailed: (reason: string) => `候補を読めませんでした：${reason}`,
    stepOptionsFailedNote: "工程ごとの指定をせず、既定のまま作成できます。",
    stepOptionsUnavailable: "config.yaml を読めないため、候補を確かめられません",
    repository: "対象リポジトリ（任意）",
    repositoryRequired: "対象リポジトリ",
    templateRepositoryHint: "テンプレートで扱うリポジトリを、プロジェクトの対象から選びます。",
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
      "With the automatic plan, the Orchestrator reads the task and the target repository, chooses the steps, and records them in the Activity.",
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
    templateSecurityCheck: "Security check",
    templateSecurityCheckNote:
      "Checks the repository and writes a report of findings by category. Sacty writes the title and description.",
    templateSecurityCheckHint:
      "Categories: dependency vulnerabilities, supply chain, code vulnerabilities, leaked secrets, and configuration. It does not change the code. From an approved report, you can create a fix task for each category.",
    plan: "Plan",
    planAuto: "Automatic",
    planAutoNote: "The Orchestrator chooses from the task",
    planHint:
      'When you choose one, the Orchestrator keeps it and does not skip steps along the way. It still decides the base branch and the test command. You can set the images and agents in "Set per step"; anything unset is decided as usual.',
    steps: "Set per step",
    stepsSummaryDefault: "Images and agents are decided as usual",
    stepsSummaryCustomized: (count) =>
      `Image or agent set for ${count} ${count === 1 ? "step" : "steps"}`,
    stepsTitle: "Step settings",
    stepsPlan: (plan) => `Plan: ${plan}`,
    stepsHint:
      "Anything you leave unset is decided as usual (images by the project target or the Orchestrator, agents by step_agents in config.yaml). After creating the task, you can still change them in Step images and Step agents on the task page.",
    stepsLegend: "Items left as Automatic or Default are decided as usual.",
    stepsBack: "Back to the main form",
    stepsDone: "Done",
    stepsResetAll: "Reset all to default",
    stepReset: "Reset to default",
    stepCustomized: "set",
    stepImage: "Image",
    stepAgent: "Agent",
    stepImageAuto: "Automatic",
    stepAgentDefault: (name) => (name ? `Default: ${name}` : "Default"),
    stepAgentGuardian: "Run by the Goal Guardian",
    stepOptionsLoading: "Loading choices…",
    stepOptionsFailed: (reason) => `Could not load the choices: ${reason}`,
    stepOptionsFailedNote: "You can still create the task with the defaults.",
    stepOptionsUnavailable: "The choices can't be checked because config.yaml can't be read",
    repository: "Target repository (optional)",
    repositoryRequired: "Target repository",
    templateRepositoryHint: "The repository the template works on, from the project's targets.",
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
