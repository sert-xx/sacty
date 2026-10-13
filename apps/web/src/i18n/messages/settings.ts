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
  reviewTitle: "PR のレビューの取り込み",
  reviewNote: "取り込んだ PR は、レビューだけを行って PR に投稿します",
  reviewHelp:
    "実装や PR の作成はしません。\nレビューの依頼は、プロジェクトで選んだ GitHub のアカウントへの個人の依頼だけです（チームへの依頼は除く）。",
  reviewRequested: "自分にレビューが依頼された PR を取り込む",
  reviewLabel: "PR のレビュー用のラベル",
  reviewPlaceholder: "例：sacty-review",
  reviewOff: "PR のレビューの取り込みは止まっています。",
  reviewOn: (requested: boolean, label: string) =>
    `${[requested ? "自分にレビューが依頼された PR" : "", label ? `ラベル「${label}」の付いた PR` : ""].filter(Boolean).join("と、")}を取り込み、レビューだけを行います。`,
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
  reviewTitle: "PR review intake",
  reviewNote: "Imported PRs are only reviewed, and the review is posted to the PR",
  reviewHelp:
    "No implementation and no PR.\nOnly reviews requested from you personally (the GitHub account chosen in the project) count, not team requests.",
  reviewRequested: "Import PRs that request my review",
  reviewLabel: "Label for PR reviews",
  reviewPlaceholder: "e.g. sacty-review",
  reviewOff: "PR review intake is stopped.",
  reviewOn: (requested, label) =>
    `${[requested ? "PRs that request your review" : "", label ? `PRs labeled "${label}"` : ""].filter(Boolean).join(" and ")} are imported and only reviewed.`,
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
