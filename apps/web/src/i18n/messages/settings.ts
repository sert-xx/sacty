/** 画面の文言：sacty の設定（settings。プロジェクトとは別の、sacty 全体の設定。PBI-26）。 */
const ja = {
  title: "sacty の設定",
  note: "すべてのプロジェクトに共通する設定です。プロジェクトごとの設定は、プロジェクトの画面で変えます。",
  loading: "読み込み中…",
  intakeTitle: "Issue・PR の取り込み",
  intakeNote: "ラベルの付いた、開いている Issue と PR をタスクにします",
  intakeLabel: "取り込むラベル",
  intakePlaceholder: "例：sacty",
  intakeHelp:
    "すべてのプロジェクトの対象（Org・リポジトリ）で、このラベルの付いた開いている Issue と PR を取り込みます。PR から作ったタスクは、オーケストレーターが工程を選びます（例：レビュー）。",
  intakeOff: "ラベルを設定していないので、取り込みは止まっています。",
  intakeOn: (label: string) => `ラベル「${label}」の付いた Issue と PR を取り込みます。`,
  save: "保存する",
  saved: "保存しました。",
};

export type SettingsMessages = typeof ja;

const en: SettingsMessages = {
  title: "sacty settings",
  note: "Settings shared by all projects. Change project-specific settings on each project's page.",
  loading: "Loading…",
  intakeTitle: "Issue and PR intake",
  intakeNote: "Open issues and PRs with the label become tasks",
  intakeLabel: "Label to import",
  intakePlaceholder: "e.g. sacty",
  intakeHelp:
    "Open issues and PRs with this label in the targets (orgs and repositories) of every project are imported. For tasks from a PR, the Orchestrator chooses the steps (e.g. review).",
  intakeOff: "No label is set, so intake is stopped.",
  intakeOn: (label) => `Issues and PRs labeled "${label}" are imported.`,
  save: "Save",
  saved: "Saved.",
};

export const settings = { ja, en };
