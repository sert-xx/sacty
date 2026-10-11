/** 画面の文言：プロジェクトの画面と設定（projects・project-editor・export）。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  loading: "読み込み中…",
  title: "プロジェクト",
  breadcrumb: "パンくず",
  importTitle: "プロジェクトをインポートする",
  newTitle: "プロジェクトを作る",
  first: {
    title: "最初のプロジェクトを作る",
    note: "sacty を使うには、プロジェクトが必要です。プロジェクトを作るか、エクスポートしたプロジェクトの定義をインポートすると、タスクを作れるようになります。",
  },
  intake: {
    title: "GitHub Issue の取り込み",
    stopped:
      "取り込みは止まっています。config.yaml に github: を設定すると、定期的に取り込みます。",
    lastRun: (at: string, n: number) => `最後の取り込み：${at}（${n}件のタスクを作成）`,
    never: "まだ取り込んでいません。",
    errors: "取り込めなかった取り込み元があります（ほかの取り込み元は取り込みました）：",
    runNow: "今すぐ取り込む",
  },
  summary: (sources: number, repos: number) =>
    `取り込み元 ${sources}件・リポジトリの設定 ${repos}件`,
  scope: { org: "Org", repo: "リポジトリ" },
  sourceScope: (scope: string) => `${scope}：`,
  sourceLabel: (label: string) => `（ラベル ${label}）`,
  settingsTitle: (name: string) => `${name} の設定`,
  export: "エクスポート",
  exportNote:
    "エクスポートには、名前・取り込み元・リポジトリの設定・コンテキストリポジトリだけを含めます（個人の設定やトークンは含めません）。",
  exportNotFound: "プロジェクトが見つかりません。",
  editor: {
    name: "名前",
    sourcesTitle: "GitHub Issue の取り込み元",
    sourcesNote: "ラベルの付いた、開いている Issue をタスクにします",
    sourcesHelp:
      "同じ Org・同じリポジトリは、ほかのプロジェクトに登録できません。Org とその中のリポジトリが別のプロジェクトに登録されていれば、リポジトリの指定が優先します。",
    noSources: "取り込み元はありません。",
    scope: "単位",
    repoTarget: "リポジトリ（owner/name）",
    label: "ラベル",
    remove: "削除",
    removeSource: (target: string) => `取り込み元「${target || "（未入力）"}」を削除`,
    removeRepo: (repo: string) => `リポジトリの設定「${repo || "（未入力）"}」を削除`,
    excluded: "除外されるリポジトリ（ほかのプロジェクトが担当）：",
    excludedBy: (project: string) => `（${project}）`,
    addSource: "取り込み元を追加",
    contextTitle: "コンテキストリポジトリ（任意）",
    contextNote: "工程エージェントに渡す規約とスキル（extends で上位のリポジトリを継承できます）",
    contextRepo: "リポジトリ（git の URL かローカルのパス）",
    contextRef: "ブランチ・タグ（省略すると既定のブランチ）",
    contextRepoPlaceholder: "例：git@github.com:acme/sacty-context.git",
    contextRefPlaceholder: "例：main",
    contextHelp:
      "sacty-context.yaml・rules.md（または rules/*.md）・skills/<名前>/SKILL.md を置いたリポジトリです。設定しなければ、コンテキストを渡さずに工程を実行します。設定済みのものは、リポジトリの欄を空にして保存すると外れます。",
    githubTitle: "GitHub アカウント",
    githubNote: "Issue の取り込み・clone・プッシュ・PR に使う、gh にログイン済みのアカウント",
    githubAccount: "アカウント",
    githubChoose: "選んでください",
    githubNotLoggedIn: (login: string) => `${login}（gh にログインしていません）`,
    githubRequired: "GitHub アカウントを選んでください。",
    githubHelp:
      "gh auth login でログインしたアカウントから選びます（最初は gh のアクティブなアカウントが選ばれています）。gh でアカウントを切り替えても、ここで選んだアカウントを使います。個人の設定なので、エクスポートには含めません。",
    reposTitle: "リポジトリの設定",
    reposNote:
      "画面で作るタスクは、ここから対象リポジトリを選びます。Issue から作ったタスクは、その Issue のリポジトリが対象です",
    noRepos: "リポジトリの設定はありません。",
    baseBranch: "ベースブランチ",
    testCommand: "テストのコマンド",
    pullRequest: "PR作成許可",
    pullRequestHelp:
      "PR作成許可：オンにすると、実装が終わった成果物をベースブランチに向けた PR として出し、PR の上で確認します（マージで承認、レビューやコメントで差し戻し）。オフにすると、sacty のブランチへのプッシュまでにして、sacty の画面で承認・差し戻しします。",
    addRepo: "リポジトリの設定を追加",
    saved: "保存しました。",
    save: "保存する",
    create: "作成する",
  },
};

export type ProjectsMessages = typeof ja;

const en: ProjectsMessages = {
  loading: "Loading…",
  title: "Projects",
  breadcrumb: "Breadcrumb",
  importTitle: "Import a project",
  newTitle: "Create a project",
  first: {
    title: "Create your first project",
    note: "sacty needs a project. Create one, or import an exported project definition, to start creating tasks.",
  },
  intake: {
    title: "GitHub Issue intake",
    stopped: "Intake is stopped. Add github: to config.yaml to import issues periodically.",
    lastRun: (at, n) => `Last intake: ${at} (${n} task${n === 1 ? "" : "s"} created)`,
    never: "Nothing imported yet.",
    errors: "Some intake sources could not be imported (the others were imported):",
    runNow: "Import now",
  },
  summary: (sources, repos) =>
    `${sources} intake source${sources === 1 ? "" : "s"} · ${repos} repository setting${repos === 1 ? "" : "s"}`,
  scope: { org: "Org", repo: "Repository" },
  sourceScope: (scope) => `${scope}: `,
  sourceLabel: (label) => ` (label ${label})`,
  settingsTitle: (name) => `${name} settings`,
  export: "Export",
  exportNote:
    "The export contains only the name, intake sources, repository settings, and context repository (no personal settings or tokens).",
  exportNotFound: "Project not found.",
  editor: {
    name: "Name",
    sourcesTitle: "GitHub Issue intake sources",
    sourcesNote: "Open issues with the label become tasks",
    sourcesHelp:
      "An org or repository can't be registered in more than one project. If an org and a repository in it are registered in different projects, the repository takes precedence.",
    noSources: "No intake sources.",
    scope: "Scope",
    repoTarget: "Repository (owner/name)",
    label: "Label",
    remove: "Remove",
    removeSource: (target) => `Remove intake source "${target || "(empty)"}"`,
    removeRepo: (repo) => `Remove repository settings "${repo || "(empty)"}"`,
    excluded: "Excluded repositories (handled by other projects):",
    excludedBy: (project) => ` (${project})`,
    addSource: "Add intake source",
    contextTitle: "Context repository (optional)",
    contextNote:
      "Rules and skills for step agents (use extends to inherit from a parent repository)",
    contextRepo: "Repository (git URL or local path)",
    contextRef: "Branch or tag (default branch if empty)",
    contextRepoPlaceholder: "e.g. git@github.com:acme/sacty-context.git",
    contextRefPlaceholder: "e.g. main",
    contextHelp:
      "A repository with sacty-context.yaml, rules.md (or rules/*.md), and skills/<name>/SKILL.md. If not set, steps run without context. To remove one, clear the repository field and save.",
    githubTitle: "GitHub account",
    githubNote: "The gh account used for issue intake, clone, push, and PRs",
    githubAccount: "Account",
    githubChoose: "Choose an account",
    githubNotLoggedIn: (login) => `${login} (not signed in to gh)`,
    githubRequired: "Choose a GitHub account.",
    githubHelp:
      "Choose from the accounts signed in with gh auth login (gh's active account is selected at first). This account is used even if you switch accounts in gh. It is a personal setting and is not exported.",
    reposTitle: "Repository settings",
    reposNote:
      "Tasks created on screen choose their target repository from here. Tasks from an issue target that issue's repository",
    noRepos: "No repository settings.",
    baseBranch: "Base branch",
    testCommand: "Test command",
    pullRequest: "Allow PRs",
    pullRequestHelp:
      "Allow PRs: when on, the finished deliverable is opened as a PR to the base branch and reviewed there (merging approves, reviews and comments request changes). When off, sacty only pushes its branch, and you approve or request changes on the sacty screen.",
    addRepo: "Add repository setting",
    saved: "Saved.",
    save: "Save",
    create: "Create",
  },
};

export const projects = { ja, en };
