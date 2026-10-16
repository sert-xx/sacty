/** 画面の文言：sacty の設定（settings。プロジェクトとは別の、sacty 全体の設定。PBI-26）。 */
const ja = {
  title: "sacty の設定",
  note: "すべてのプロジェクトに共通する設定です。",
  loading: "読み込み中…",
  intakeTitle: "Issue の取り込み",
  intakeNote: "ラベルの付いた、開いている Issue をタスクにします",
  intakeLabel: "取り込むラベル",
  intakePlaceholder: "例：sacty",
  intakeHelp:
    "すべてのプロジェクトの対象で取り込みます。\nPR は、このラベルが付いていても取り込みません（PR は「PR のレビューの取り込み」で取り込みます）。",
  intakeOff: "ラベルを設定していないか Off にしているので、Issue の取り込みは止まっています。",
  intakeOn: (label: string) => `ラベル「${label}」の付いた Issue を取り込みます。`,
  triageIssues: "Issue を取り込む",
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
    "実装や PR の作成はしません。\nレビューの依頼は、プロジェクトで選んだ GitHub のアカウントへの個人の依頼だけです（チームへの依頼は除く）。\nレビュー用のラベルを設定し、その PR の取り込みを On にしているときは、sacty が作る PR にもそのラベルを付け、別のタスクでレビューします。直す点があれば、PR を作ったタスクが直します。\nレビュー用のラベルは、取り込むラベルと同じ名前にもできます（Issue は「Issue の取り込み」で取り込み、PR はここでレビューだけのタスクとして取り込みます）。",
  reviewRequested: "自分にレビューが依頼された PR を取り込む",
  reviewLabel: "PR のレビュー用のラベル",
  reviewPlaceholder: "例：sacty-review",
  reviewOff: "PR のレビューの取り込みは止まっています。",
  reviewOn: (requested: boolean, label: string) =>
    `${[requested ? "自分にレビューが依頼された PR" : "", label ? `ラベル「${label}」の付いた PR` : ""].filter(Boolean).join("と、")}を取り込み、レビューだけを行います。`,
  intervalLabel: "取り込みの間隔（秒）",
  intervalHelp: (min: number, fallback: number) => `${min} 以上。空なら ${fallback}。`,
  intervalCurrent: (sec: number, byDefault: boolean) =>
    `いまは ${sec} 秒ごとに取り込みます${byDefault ? "（既定）" : ""}。`,
  intervalWhenOn: (sec: number, byDefault: boolean) =>
    `取り込みを始めると、${sec} 秒ごとに取り込みます${byDefault ? "（既定）" : ""}。`,
  parallelTitle: "タスクの並行実行",
  parallelNote: "実行待ちのタスクを、古い順にこの数まで同時に実行します",
  parallelLabel: "同時に実行するタスクの数",
  parallelHelp: (fallback: number, max: number) =>
    `1〜${max}。空なら ${fallback}。\n増やすほど、マシンの負荷と AI の利用上限の消費が増えます。`,
  parallelCurrent: (n: number, byDefault: boolean) =>
    `いまは ${n} 件まで同時に実行します${byDefault ? "（既定）" : ""}。`,
  notifyTitle: "Slack の通知（任意）",
  notifyNote: "承認待ち・エスカレーション・一時停止・完了を知らせる",
  notifyKind: "送り方",
  notifyNone: "通知しない",
  notifyApi: "Slack API（chat.postMessage・Slack Proxy）",
  notifyWebhook: "Incoming Webhook",
  notifyLanguage: "言語",
  notifyUrl: "送り先の URL",
  notifyChannel: "チャンネル",
  notifyToken: "トークン（任意）",
  notifyTokenPlaceholder: "Proxy なら空",
  notifyWebhookSecret: "Webhook の URL",
  notifyHelp:
    "すべてのプロジェクトのタスクを、この送り先に通知します。本文の題名の前に、[プロジェクトの名前] を付けます。\nトークンと Webhook の URL は、秘密情報の名前か 1Password の参照（op://…）で書きます。\n人が自分で一時停止したときは通知しません。",
  notifyTest: "テストの通知を送る",
  notifySaveFirst: "保存してから送れます",
  notifySent: "送りました。Slack を確かめてください。",
  mentionTitle: "メンション（任意）",
  mentionTargets: "メンションする相手",
  mentionHelp:
    "Slack のメンバー ID（U…）、ユーザーグループの ID（S…）、@here、@channel を、カンマか空白で区切って書きます。@表示名では届きません。\nメンバー ID は、Slack のプロフィールの「その他」→「メンバー ID をコピー」で、ユーザーグループの ID は、グループのページの URL の末尾（S…）で調べられます。\nメンションは本文の先頭に付けます（テストの通知にも付けます）。",
  mentionKinds: "メンションする通知",
  mentionKind: {
    approval: "承認待ち",
    escalation: "エスカレーション",
    paused: "一時停止",
    completed: "完了",
  },
  save: "保存する",
  saved: "保存しました。",
  secretsTitle: "秘密情報",
  secretsNote: "sacty up の起動のときに、使う秘密情報をまとめて取り出します",
  secretsHelp:
    "1Password の認証は、起動のときと、sacty の設定（Slack の通知先）やプロジェクトの設定を保存したとき（まだ取り出していない秘密情報があるとき）だけです。プロジェクトのコンテキストの秘密情報も含みます。\n1Password にサインインし直したときや、参照を直したときは、取り出し直してください。\nコンテキストリポジトリに後から足した秘密情報は、使うときに取り出します（そのときに認証を求めます）。前もって取り出すには、取り出し直すか、プロジェクトの設定を保存し直してください。",
  secretsFetch: "秘密情報を取り出し直す",
  secretsFetching: "取り出しています…",
  /** unread は、読めなかったプロジェクトのコンテキストの数（その中の秘密情報は数に入らず、確かめていない。PBI-107）。 */
  secretsResult: (ok: number, total: number, unread = 0) => {
    const unchecked =
      unread > 0
        ? `読めなかったコンテキストが ${unread} 件あり、その中の秘密情報は確かめていません（下の警告を見てください）。`
        : "";
    if (total === 0)
      return unread > 0
        ? `確かめられた秘密情報はありません。${unchecked}`
        : "使う秘密情報はありません。";
    return `${total} 件のうち ${ok} 件を取り出しました。${unchecked}`;
  },
};

export type SettingsMessages = typeof ja;

const en: SettingsMessages = {
  title: "sacty settings",
  note: "Settings shared by all projects.",
  loading: "Loading…",
  intakeTitle: "Issue intake",
  intakeNote: "Open issues with the label become tasks",
  intakeLabel: "Label to import",
  intakePlaceholder: "e.g. sacty",
  intakeHelp:
    'Applies to the targets of every project.\nPRs are not imported even with this label (PRs are imported by "PR review intake").',
  intakeOff: "No label is set or it is off, so issue intake is stopped.",
  intakeOn: (label) => `Issues labeled "${label}" are imported.`,
  triageIssues: "Import issues",
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
    'No implementation and no PR.\nOnly reviews requested from you personally (the GitHub account chosen in the project) count, not team requests.\nWhen the review label is set and importing PRs with it is on, sacty also adds the label to the PRs it creates, so another task reviews them. If changes are needed, the task that created the PR makes them.\nThe review label can be the same as the label to import (issues are imported by "Issue intake", and PRs here as review-only tasks).',
  reviewRequested: "Import PRs that request my review",
  reviewLabel: "Label for PR reviews",
  reviewPlaceholder: "e.g. sacty-review",
  reviewOff: "PR review intake is stopped.",
  reviewOn: (requested, label) =>
    `${[requested ? "PRs that request your review" : "", label ? `PRs labeled "${label}"` : ""].filter(Boolean).join(" and ")} are imported and only reviewed.`,
  intervalLabel: "Intake interval (seconds)",
  intervalHelp: (min, fallback) => `${min} or more. ${fallback} if empty.`,
  intervalCurrent: (sec, byDefault) =>
    `Imports every ${sec} seconds now${byDefault ? " (default)" : ""}.`,
  intervalWhenOn: (sec, byDefault) =>
    `Once intake starts, imports every ${sec} seconds${byDefault ? " (default)" : ""}.`,
  parallelTitle: "Running tasks in parallel",
  parallelNote: "Queued tasks run at the same time, oldest first, up to this number",
  parallelLabel: "Tasks to run at the same time",
  parallelHelp: (fallback, max) =>
    `1 to ${max}. ${fallback} if empty.\nA larger number uses more of your machine and of the AI usage limit.`,
  parallelCurrent: (n, byDefault) =>
    `Up to ${n} task${n === 1 ? "" : "s"} run at the same time now${byDefault ? " (default)" : ""}.`,
  notifyTitle: "Slack notifications (optional)",
  notifyNote: "Tell you about approvals, escalations, pauses, and completions",
  notifyKind: "Send via",
  notifyNone: "Don't notify",
  notifyApi: "Slack API (chat.postMessage, Slack Proxy)",
  notifyWebhook: "Incoming Webhook",
  notifyLanguage: "Language",
  notifyUrl: "URL to send to",
  notifyChannel: "Channel",
  notifyToken: "Token (optional)",
  notifyTokenPlaceholder: "Empty for a proxy",
  notifyWebhookSecret: "Webhook URL",
  notifyHelp:
    "Tasks in every project are notified to this destination. The message puts [project name] before the task title.\nWrite tokens and the webhook URL as a secret name or a 1Password reference (op://…).\nPausing a task yourself is not notified.",
  notifyTest: "Send a test notification",
  notifySaveFirst: "Save first to send",
  notifySent: "Sent. Check Slack.",
  mentionTitle: "Mentions (optional)",
  mentionTargets: "Who to mention",
  mentionHelp:
    "Write Slack member IDs (U…), user group IDs (S…), @here, or @channel, separated by commas or spaces. Display names don't notify anyone.\nCopy a member ID from the person's Slack profile (More → Copy member ID). A user group ID is at the end of the group page's URL (S…).\nMentions go at the start of the message (test notifications include them too).",
  mentionKinds: "Mention in",
  mentionKind: {
    approval: "Approvals",
    escalation: "Escalations",
    paused: "Pauses",
    completed: "Completions",
  },
  save: "Save",
  saved: "Saved.",
  secretsTitle: "Secrets",
  secretsNote: "sacty up gets the secrets it uses all at once at startup",
  secretsHelp:
    "1Password asks for authentication only at startup and when you save the sacty settings (the Slack notification destination) or project settings (if there are secrets not fetched yet). This includes the secrets in project contexts.\nGet the secrets again after you sign in to 1Password again or fix a reference.\nSecrets added to a context repository later are fetched when they are used (1Password asks for authentication then). To fetch them in advance, get the secrets again or save the project settings again.",
  secretsFetch: "Get secrets again",
  secretsFetching: "Getting…",
  secretsResult: (ok, total, unread = 0) => {
    const unchecked =
      unread > 0
        ? ` ${unread} context${unread === 1 ? "" : "s"} could not be read, so the secrets in ${unread === 1 ? "it were" : "them were"} not checked (see the warnings below).`
        : "";
    if (total === 0)
      return unread > 0 ? `No secrets could be checked.${unchecked}` : "No secrets are used.";
    return `Got ${ok} of ${total} secrets.${unchecked}`;
  },
};

export const settings = { ja, en };
