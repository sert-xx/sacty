/** 画面の文言：sacty の設定（settings。プロジェクトとは別の、sacty 全体の設定。PBI-26）。 */
const ja = {
  title: "sacty の設定",
  note: "すべてのプロジェクトに共通する設定です。",
  loading: "読み込み中…",
  intakeTitle: "Issue・PR の取り込み",
  intakeNote: "ラベルの付いた、開いている Issue と PR をタスクにします",
  intakeLabel: "取り込むラベル",
  intakePlaceholder: "例：sacty",
  intakeHelp: "すべてのプロジェクトの対象で取り込みます。",
  intakeOff: "ラベルを設定していないので、取り込みは止まっています。",
  intakeOn: (label: string) => `ラベル「${label}」の付いた Issue と PR を取り込みます。`,
  parallelTitle: "タスクの並行実行",
  parallelNote: "実行待ちのタスクを、古い順にこの数まで同時に実行します",
  parallelLabel: "同時に実行するタスクの数",
  parallelHelp: (fallback: number, max: number) =>
    `1〜${max}。空なら ${fallback}。\n増やすほど、マシンの負荷と AI の利用上限の消費が増えます。`,
  parallelCurrent: (n: number, byDefault: boolean) =>
    `いまは ${n} 件まで同時に実行します${byDefault ? "（既定）" : ""}。`,
  save: "保存する",
  saved: "保存しました。",
};

export type SettingsMessages = typeof ja;

const en: SettingsMessages = {
  title: "sacty settings",
  note: "Settings shared by all projects.",
  loading: "Loading…",
  intakeTitle: "Issue and PR intake",
  intakeNote: "Open issues and PRs with the label become tasks",
  intakeLabel: "Label to import",
  intakePlaceholder: "e.g. sacty",
  intakeHelp: "Applies to the targets of every project.",
  intakeOff: "No label is set, so intake is stopped.",
  intakeOn: (label) => `Issues and PRs labeled "${label}" are imported.`,
  parallelTitle: "Running tasks in parallel",
  parallelNote: "Queued tasks run at the same time, oldest first, up to this number",
  parallelLabel: "Tasks to run at the same time",
  parallelHelp: (fallback, max) =>
    `1 to ${max}. ${fallback} if empty.\nA larger number uses more of your machine and of the AI usage limit.`,
  parallelCurrent: (n, byDefault) =>
    `Up to ${n} task${n === 1 ? "" : "s"} run at the same time now${byDefault ? " (default)" : ""}.`,
  save: "Save",
  saved: "Saved.",
};

export const settings = { ja, en };
