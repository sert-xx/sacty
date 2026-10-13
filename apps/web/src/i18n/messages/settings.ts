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
  intakeOff:
    "ラベルを設定していないか、Issue と PR の両方を Off にしているので、取り込みは止まっています。",
  intakeOn: (label: string, issues: boolean, pullRequests: boolean) =>
    `ラベル「${label}」の付いた ${[issues ? "Issue" : "", pullRequests ? "PR" : ""].filter(Boolean).join(" と ")} を取り込みます。`,
  triageIssues: "Issue を取り込む",
  triagePullRequests: "PR を取り込む",
  triageReviewLabel: "レビュー用のラベルの PR を取り込む",
  triageTickets: "チケットを取り込む",
  ticketsTitle: "チケットの取り込み",
  ticketsNote: "JIRA などのチケットをタスクにします",
  ticketsHelp:
    "取り込み先（接続先と JIRA のプロジェクトのキー）は、プロジェクトの設定に書きます。\nラベルは、すべての取り込み先で共通です。",
  ticketLabel: "取り込むラベル",
  ticketsOn: (label: string) => `ラベル「${label}」の付いたチケットを取り込みます。`,
  ticketsOff: "ラベルを設定していないか Off にしているので、チケットの取り込みは止まっています。",
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
  secretsTitle: "秘密情報",
  secretsNote: "sacty up の起動のときに、使う秘密情報をまとめて取り出します",
  secretsHelp:
    "1Password の認証は、起動のときの1回だけです。\n1Password にサインインし直したときや、参照を直したときは、取り出し直してください。",
  secretsFetch: "秘密情報を取り出し直す",
  secretsFetching: "取り出しています…",
  secretsResult: (ok: number, total: number) =>
    total === 0 ? "使う秘密情報はありません。" : `${total} 件のうち ${ok} 件を取り出しました。`,
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
  intakeOff: "No label is set, or both issues and PRs are off, so intake is stopped.",
  intakeOn: (label, issues, pullRequests) =>
    `${[issues ? "Issues" : "", pullRequests ? "PRs" : ""].filter(Boolean).join(" and ")} labeled "${label}" are imported.`,
  triageIssues: "Import issues",
  triagePullRequests: "Import PRs",
  triageReviewLabel: "Import PRs with the review label",
  triageTickets: "Import tickets",
  ticketsTitle: "Ticket intake",
  ticketsNote: "Tickets in JIRA and similar services become tasks",
  ticketsHelp:
    "Write the ticket sources (connection and JIRA project keys) in the project settings.\nThe label is shared by all ticket sources.",
  ticketLabel: "Label to import",
  ticketsOn: (label) => `Tickets labeled "${label}" are imported.`,
  ticketsOff: "No label is set or it is off, so ticket intake is stopped.",
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
  secretsTitle: "Secrets",
  secretsNote: "sacty up gets the secrets it uses all at once at startup",
  secretsHelp:
    "1Password asks for authentication only once, at startup.\nGet the secrets again after you sign in to 1Password again or fix a reference.",
  secretsFetch: "Get secrets again",
  secretsFetching: "Getting…",
  secretsResult: (ok, total) =>
    total === 0 ? "No secrets are used." : `Got ${ok} of ${total} secrets.`,
};

export const settings = { ja, en };
