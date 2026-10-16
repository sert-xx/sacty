/** 画面の文言：共通（読み込み中・デーモンとの通信・actions の結果）。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  loading: "読み込み中…",
  /** 補足（ツールチップ）の印の名前（PBI-117）。 */
  hint: "補足",
  /** 取り直しで更新できない間に出す（PR #119 レビュー指摘）。 */
  live: {
    stale:
      "いま更新できません（デーモンに届きません）。表示は最後に取得した内容です。届くようになったら、自動で更新します。",
    staleShort: "更新が止まっています",
  },
  daemon: {
    notConfigured: "デーモンの接続先が設定されていません。`sacty up` で起動してください。",
    unreachable: "デーモンに接続できません。`sacty up` が動いているか確認してください。",
    checkInput: "入力を確認してください。",
    checkFile: "ファイルの内容を確認してください。",
    invalidAmount: "金額を正しく入力してください。",
    atPath: (text: string, path: string) => `${text}（${path}）`,
  },
  action: {
    daemonDown: "操作できませんでした。sactyのデーモンが動いているか確認してください。",
    createFailed: "タスクを作成できませんでした。sactyのデーモンが動いているか確認してください。",
    createNoProject: "作成先のプロジェクトが分かりません。画面を更新してください。",
    titleRequired: "タイトルを入力してください。",
    titleTooLong: (max: number) => `タイトルは${max}文字以内で入力してください。`,
    bodyTooLong: (max: number) =>
      `内容は${max.toLocaleString("ja-JP")}文字以内で入力してください。`,
    capPositive: "新しい上限は、0より大きい金額で入力してください。",
    resumeFailed: "再開できませんでした。sactyのデーモンが動いているか確認してください。",
    invalidStep: "工程が不正です。",
    invalidSubmission: "提出回が不正です。画面を更新してください。",
    unreadableInput: "入力を読み取れませんでした。画面を更新してください。",
    chooseFile: "インポートするファイルを選んでください。",
    fileTooLarge: "ファイルが大きすぎます。sacty からエクスポートしたファイルを選んでください。",
    notJson:
      "ファイルを JSON として読めません。sacty からエクスポートしたファイルを選んでください。",
  },
};

export type CommonMessages = typeof ja;

const en: CommonMessages = {
  loading: "Loading…",
  hint: "Details",
  live: {
    stale:
      "Cannot update right now (the daemon cannot be reached). This shows what was last fetched. It updates automatically when the daemon can be reached again.",
    staleShort: "Updates paused",
  },
  daemon: {
    notConfigured: "The daemon address is not set. Start sacty with `sacty up`.",
    unreachable: "Cannot reach the daemon. Check that `sacty up` is running.",
    checkInput: "Check your input.",
    checkFile: "Check the contents of the file.",
    invalidAmount: "Enter a valid amount.",
    atPath: (text, path) => `${text} (${path})`,
  },
  action: {
    daemonDown: "Could not complete the action. Check that the sacty daemon is running.",
    createFailed: "Could not create the task. Check that the sacty daemon is running.",
    createNoProject: "The target project is unknown. Reload the page.",
    titleRequired: "Enter a title.",
    titleTooLong: (max) => `Keep the title within ${max} characters.`,
    bodyTooLong: (max) => `Keep the details within ${max.toLocaleString("en-US")} characters.`,
    capPositive: "Enter a new cap greater than 0.",
    resumeFailed: "Could not resume. Check that the sacty daemon is running.",
    invalidStep: "Invalid step.",
    invalidSubmission: "Invalid submission. Reload the page.",
    unreadableInput: "Could not read the input. Reload the page.",
    chooseFile: "Choose a file to import.",
    fileTooLarge: "The file is too large. Choose a file exported from sacty.",
    notJson: "The file is not valid JSON. Choose a file exported from sacty.",
  },
};

export const common = { ja, en };
