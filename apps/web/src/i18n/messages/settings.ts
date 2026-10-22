/**
 * 画面の文言：sacty の設定（settings。プロジェクトとは別の、sacty 全体の設定。PBI-26）。
 * 仕組みの説明は *Hint に書き、補足の印で出す（PBI-117）。
 */
const ja = {
  title: "Sacty の設定",
  hint: "すべてのプロジェクトに共通の設定です。",
  loading: "読み込み中…",
  intakeTitle: "Issue の取り込み",
  intakeHint:
    "開いている Issue にこのラベルが付いていればタスクにします。すべてのプロジェクトの対象で取り込みます。PR はこのラベルでは取り込まず、「PR のレビューの取り込み」で扱います。",
  intakeLabel: "取り込むラベル",
  intakePlaceholder: "例：sacty",
  intakeOff: "止まっています。ラベルが無いか、Off です。",
  intakeOn: (label: string) => `ラベル「${label}」の Issue を取り込んでいます。`,
  triageIssues: "Issue を取り込む",
  triageReviewLabel: "レビュー用のラベルの PR を取り込む",
  triageTickets: "チケットを取り込む",
  ticketsTitle: "チケットの取り込み",
  ticketsHint:
    "JIRA などのチケットにこのラベルが付いていればタスクにします。取り込み先（接続先とキー）はプロジェクトの設定にあり、ラベルはすべての取り込み先で共通です。",
  ticketLabel: "取り込むラベル",
  ticketsOn: (label: string) => `ラベル「${label}」のチケットを取り込んでいます。`,
  ticketsOff: "止まっています。ラベルが無いか、Off です。",
  reviewTitle: "PR のレビューの取り込み",
  reviewHint:
    "取り込んだ PR はレビューだけを行い、結果を PR に投稿します。実装や PR の作成はしません。レビューの依頼は、プロジェクトで選んだ GitHub アカウントへの個人の依頼だけです。",
  reviewLabelHint:
    "レビュー用のラベルを設定していると、Sacty が作る PR にもこのラベルを付け、別のタスクでレビューします（取り込みが Off の間も付けます）。直す点があれば、PR を作ったタスクが直します。取り込むラベルと同じ名前にもできます。",
  reviewRequested: "自分にレビューが依頼された PR を取り込む",
  reviewMentionSelf: "レビューの投稿で、PR の作者ではなく自分にメンションする",
  reviewMentionSelfHint:
    "Off（既定）なら、投稿するレビューの先頭で PR の作者にメンションします。On にすると、作者の代わりに、プロジェクトで選んだ GitHub アカウント（投稿する自分）にメンションします。変わるのは本文の @ メンションの相手だけです。レビューはこれまでどおり PR に公開され、PR を購読している作者には GitHub の通常の通知が届くことがあります。",
  reviewLabel: "PR のレビュー用のラベル",
  reviewPlaceholder: "例：sacty-review",
  reviewOff: "止まっています。",
  reviewOn: (requested: boolean, label: string) =>
    `${[requested ? "自分にレビューが依頼された PR" : "", label ? `ラベル「${label}」の PR` : ""].filter(Boolean).join("と、")}を取り込んでいます。`,
  intervalLabel: "取り込みの間隔（秒）",
  intervalHelp: (min: number, fallback: number) => `${min} 以上。空なら ${fallback}。`,
  intervalCurrent: (sec: number, byDefault: boolean) =>
    `いまは ${sec} 秒ごと${byDefault ? "（既定）" : ""}。`,
  intervalWhenOn: (sec: number, byDefault: boolean) =>
    `始めると ${sec} 秒ごと${byDefault ? "（既定）" : ""}。`,
  parallelTitle: "並行実行",
  parallelHint:
    "実行待ちのタスクを、古い順にこの数まで同時に実行します。増やすほど、マシンの負荷と AI の利用上限の消費が増えます。",
  parallelLabel: "同時に実行するタスクの数",
  parallelHelp: (fallback: number, max: number) => `1〜${max}。空なら ${fallback}。`,
  parallelCurrent: (n: number, byDefault: boolean) =>
    `いまは ${n} 件まで${byDefault ? "（既定）" : ""}。`,
  memoryTitle: "メモリー",
  memoryHint:
    "監査が登録したメモリーは、タスクで役に立つたびに有効な最終利用日が新しくなります。有効な最終利用日からこの日数を過ぎたメモリーは、自動で消します。",
  memoryLabel: "メモリーを残す日数",
  memoryHelp: (fallback: number, max: number) => `1〜${max}。空なら ${fallback}。`,
  memoryCurrent: (n: number, byDefault: boolean) =>
    `いまは ${n} 日${byDefault ? "（既定）" : ""}。`,
  notifyTitle: "Slack の通知（任意）",
  notifyHint:
    "承認待ち・エスカレーション・一時停止・完了を Slack に知らせます。本文の題名の前に [プロジェクトの名前] を付けます。人が自分で一時停止したときは知らせません。",
  notifyAudience: "すべてのプロジェクトの通知が、この送り先に届きます。",
  notifyAudienceHint:
    "プロジェクトの名前・タスクの題名とリンク・工程の名前が、送り先を見る人に届きます。送り先はプロジェクトごとに分けられません。",
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
  notifySecretHint: "秘密情報の名前か、1Password の参照（op://…）で書きます。",
  notifyTest: "テストの通知を送る",
  notifySaveFirst: "保存してから送れます",
  notifySent: "送りました。Slack を確かめてください。",
  mentionTitle: "メンション（任意）",
  mentionTargets: "メンションする相手",
  mentionHint:
    "メンバー ID（U…）・ユーザーグループの ID（S…）・@here・@channel を、カンマか空白で区切ります。@表示名では届きません。メンバー ID は Slack のプロフィールの「その他」→「メンバー ID をコピー」で調べられます。",
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
  secretsHint:
    "sacty up の起動時と、Sacty やプロジェクトの設定を保存したときに、使う秘密情報をまとめて取り出します。1Password にサインインし直したときや参照を直したときは、取り出し直してください。コンテキストリポジトリに後から足した秘密情報は、使うときに取り出します。",
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
  title: "Sacty settings",
  hint: "Shared by all projects.",
  loading: "Loading…",
  intakeTitle: "Issue intake",
  intakeHint:
    'Open issues with this label become tasks, in the targets of every project. PRs are not imported with this label; see "PR review intake".',
  intakeLabel: "Label to import",
  intakePlaceholder: "e.g. sacty",
  intakeOff: "Stopped. No label is set, or it is off.",
  intakeOn: (label) => `Importing issues labeled "${label}".`,
  triageIssues: "Import issues",
  triageReviewLabel: "Import PRs with the review label",
  triageTickets: "Import tickets",
  ticketsTitle: "Ticket intake",
  ticketsHint:
    "Tickets in JIRA and similar services with this label become tasks. The ticket sources (connection and keys) are in the project settings; the label is shared by all of them.",
  ticketLabel: "Label to import",
  ticketsOn: (label) => `Importing tickets labeled "${label}".`,
  ticketsOff: "Stopped. No label is set, or it is off.",
  reviewTitle: "PR review intake",
  reviewHint:
    "Imported PRs are only reviewed, and the review is posted to the PR. No implementation and no PR. Only reviews requested from you personally (the GitHub account chosen in the project) count.",
  reviewLabelHint:
    "When the review label is set, Sacty also adds this label to the PRs it creates (even while importing them is off), so another task reviews them. If changes are needed, the task that created the PR makes them. The review label can be the same as the label to import.",
  reviewRequested: "Import PRs that request my review",
  reviewMentionSelf: "Mention me instead of the PR author in posted reviews",
  reviewMentionSelfHint:
    "When off (the default), a posted review starts by mentioning the PR author. When on, it mentions the GitHub account chosen in the project (you, the poster) instead. Only the @ mention in the body changes. The review is still posted publicly on the PR, and the author, who usually follows the PR, may still get GitHub's usual notification.",
  reviewLabel: "Label for PR reviews",
  reviewPlaceholder: "e.g. sacty-review",
  reviewOff: "Stopped.",
  reviewOn: (requested, label) =>
    `Importing ${[requested ? "PRs that request your review" : "", label ? `PRs labeled "${label}"` : ""].filter(Boolean).join(" and ")}.`,
  intervalLabel: "Intake interval (seconds)",
  intervalHelp: (min, fallback) => `${min} or more. ${fallback} if empty.`,
  intervalCurrent: (sec, byDefault) => `Every ${sec} seconds now${byDefault ? " (default)" : ""}.`,
  intervalWhenOn: (sec, byDefault) =>
    `Every ${sec} seconds once started${byDefault ? " (default)" : ""}.`,
  parallelTitle: "Parallel tasks",
  parallelHint:
    "Queued tasks run at the same time, oldest first, up to this number. A larger number uses more of your machine and of the AI usage limit.",
  parallelLabel: "Tasks to run at the same time",
  parallelHelp: (fallback, max) => `1 to ${max}. ${fallback} if empty.`,
  parallelCurrent: (n, byDefault) =>
    `Up to ${n} task${n === 1 ? "" : "s"} now${byDefault ? " (default)" : ""}.`,
  memoryTitle: "Memory",
  memoryHint:
    "Each time a memory the audit registered helps a task, its last useful date moves forward. Memories whose last useful date is older than this many days are deleted automatically.",
  memoryLabel: "Days to keep memories",
  memoryHelp: (fallback, max) => `1 to ${max}. ${fallback} if empty.`,
  memoryCurrent: (n, byDefault) =>
    `${n} day${n === 1 ? "" : "s"} now${byDefault ? " (default)" : ""}.`,
  notifyTitle: "Slack notifications (optional)",
  notifyHint:
    "Tells Slack about approvals, escalations, pauses, and completions. The message puts [project name] before the task title. Pausing a task yourself is not notified.",
  notifyAudience: "Notifications from every project go to this destination.",
  notifyAudienceHint:
    "Everyone who can see it receives project names, task titles and links, and step names. You cannot use a different destination per project.",
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
  notifySecretHint: "Write a secret name or a 1Password reference (op://…).",
  notifyTest: "Send a test notification",
  notifySaveFirst: "Save first to send",
  notifySent: "Sent. Check Slack.",
  mentionTitle: "Mentions (optional)",
  mentionTargets: "Who to mention",
  mentionHint:
    "Write Slack member IDs (U…), user group IDs (S…), @here, or @channel, separated by commas or spaces. Display names don't notify anyone. Copy a member ID from the person's profile (More → Copy member ID); a user group ID is at the end of the group page's URL.",
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
  secretsHint:
    "sacty up gets the secrets it uses all at once at startup and when you save the Sacty or project settings. Get them again after you sign in to 1Password again or fix a reference. Secrets added to a context repository later are fetched when they are used.",
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
