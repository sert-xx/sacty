/** 画面の文言：チケットの作成・プロジェクトのインポート。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  ticket: {
    create: "チケットを作成",
    description: (project: string) =>
      `プロジェクト「${project}」に作成します。作成すると、オーケストレーターがチケットと対象リポジトリを読んで工程を選び、台帳に記録します。`,
    title: "タイトル",
    body: "内容",
    bodyPlaceholder: "背景や、満たしてほしい条件",
    close: "閉じる",
    creating: "作成中…",
    submit: "作成する",
  },
  import: {
    label:
      "sacty からエクスポートしたプロジェクトの定義（JSON）を選んでください。新しいプロジェクトとして作ります。取り込み元がほかのプロジェクトと重複していれば、インポートしません。",
    submit: "インポートする",
  },
};

export type FormsMessages = typeof ja;

const en: FormsMessages = {
  ticket: {
    create: "Create ticket",
    description: (project) =>
      `Creates the ticket in the project "${project}". The Orchestrator then reads the ticket and the target repository, chooses the steps, and records them in the Ledger.`,
    title: "Title",
    body: "Description",
    bodyPlaceholder: "Background and the conditions it should meet",
    close: "Close",
    creating: "Creating…",
    submit: "Create",
  },
  import: {
    label:
      "Choose a project definition (JSON) exported from sacty. It is created as a new project. If an intake source overlaps with another project, nothing is imported.",
    submit: "Import",
  },
};

export const forms = { ja, en };
