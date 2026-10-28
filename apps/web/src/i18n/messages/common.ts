/**
 * 画面の文言：共通（読み込み中・デーモンとの通信・actions の結果・補足の印）。英語の用語は labels.ts の用語集に合わせる。
 * 書き方の規則は docs/README.md の「画面の文言の書き方」（PBI-117）。
 */
const ja = {
  loading: "読み込み中…",
  /** 補足（ツールチップ）の印の名前。 */
  hint: "補足",
  /** 取り直しで更新できない間に出す（PR #119 レビュー指摘）。 */
  live: {
    stale: "デーモンに届きません。表示は最後に取得した内容です。",
    staleShort: "更新が止まっています",
    /** 画面の認証が無い（sacty を起動し直した。PBI-129）。 */
    signedOut: "Sacty が起動し直されました。端末に表示された新しい URL を開いてください。",
    signedOutShort: "入り直してください",
  },
  daemon: {
    notConfigured: "デーモンの接続先が設定されていません。`sacty up` で起動してください。",
    unreachable: "デーモンに接続できません。`sacty up` が動いているか確認してください。",
    checkInput: "入力を確認してください。",
    checkFile: "ファイルの内容を確認してください。",
    invalidAmount: "金額を正しく入力してください。",
    atPath: (text: string, path: string) => `${text}（${path}）`,
  },
  /** 画面の認証（PBI-129）。認証が無いときは、画面の部品を使わずにこの文だけを出す。 */
  auth: {
    title: "Sacty に入る",
    signIn: "`sacty up` が端末に表示した URL を、このブラウザーで開いてください。",
    notConfigured: "画面の認証が設定されていません。`sacty up` で起動してください。",
    wrongHost: "この画面は http://127.0.0.1 か localhost で開いてください。",
  },
  action: {
    daemonDown: "操作できませんでした。デーモンが動いているか確認してください。",
    createFailed: "タスクを作成できませんでした。デーモンが動いているか確認してください。",
    createNoProject: "作成先のプロジェクトが分かりません。画面を更新してください。",
    titleRequired: "タイトルを入力してください。",
    titleTooLong: (max: number) => `タイトルは${max}文字以内で入力してください。`,
    bodyTooLong: (max: number) =>
      `内容は${max.toLocaleString("ja-JP")}文字以内で入力してください。`,
    stepSettingsInvalid:
      "工程ごとのイメージ・エージェントの指定が正しくありません。選び直してください。",
    capPositive: "新しい上限は、0 より大きい金額にしてください。",
    resumeFailed: "再開できませんでした。デーモンが動いているか確認してください。",
    toReviewFailed: "レビューへ進められませんでした。デーモンが動いているか確認してください。",
    testCommandInvalid: "テストのコマンドを 1000 文字以内で入力してください。",
    noTestsReasonInvalid: "テストなしで進める理由を 2000 文字以内で入力してください。",
    resumeNoteTooLong: (max: number) =>
      `補足は${max.toLocaleString("ja-JP")}文字以内で入力してください。`,
    invalidStep: "工程が不正です。",
    invalidTarget: "宛先が不正です。",
    invalidCategory: "区分が不正です。画面を更新してください。",
    invalidAdoptNote: "手入れの種類（補足・差し替え）を選んでください。",
    adoptNoteRequired:
      "手入れの中身を入力してください。手を入れないなら、種類を選ばないでください。",
    invalidSubmission: "提出回が不正です。画面を更新してください。",
    unreadableInput: "入力を読み取れませんでした。画面を更新してください。",
    chooseFile: "インポートするファイルを選んでください。",
    fileTooLarge: "ファイルが大きすぎます。Sacty からエクスポートしたファイルを選んでください。",
    notJson: "JSON として読めません。Sacty からエクスポートしたファイルを選んでください。",
  },
};

export type CommonMessages = typeof ja;

const en: CommonMessages = {
  loading: "Loading…",
  hint: "Details",
  live: {
    stale: "The daemon cannot be reached. This shows what was last fetched.",
    staleShort: "Updates paused",
    signedOut: "Sacty was restarted. Open the new URL printed in the terminal.",
    signedOutShort: "Sign in again",
  },
  daemon: {
    notConfigured: "The daemon address is not set. Start Sacty with `sacty up`.",
    unreachable: "Cannot reach the daemon. Check that `sacty up` is running.",
    checkInput: "Check your input.",
    checkFile: "Check the contents of the file.",
    invalidAmount: "Enter a valid amount.",
    atPath: (text, path) => `${text} (${path})`,
  },
  auth: {
    title: "Sign in to Sacty",
    signIn: "Open the URL that `sacty up` printed in the terminal in this browser.",
    notConfigured: "Web UI sign-in is not set up. Start Sacty with `sacty up`.",
    wrongHost: "Open this page at http://127.0.0.1 or localhost.",
  },
  action: {
    daemonDown: "Could not complete the action. Check that the daemon is running.",
    createFailed: "Could not create the task. Check that the daemon is running.",
    createNoProject: "The target project is unknown. Reload the page.",
    titleRequired: "Enter a title.",
    titleTooLong: (max) => `Keep the title within ${max} characters.`,
    bodyTooLong: (max) => `Keep the details within ${max.toLocaleString("en-US")} characters.`,
    stepSettingsInvalid: "The image or agent set for a step is not valid. Choose it again.",
    capPositive: "Enter a new cap greater than 0.",
    resumeFailed: "Could not resume. Check that the daemon is running.",
    toReviewFailed: "Could not move to review. Check that the daemon is running.",
    testCommandInvalid: "Enter a test command of up to 1000 characters.",
    noTestsReasonInvalid: "Enter why to proceed without tests in up to 2000 characters.",
    resumeNoteTooLong: (max) =>
      `Keep the additional notes within ${max.toLocaleString("en-US")} characters.`,
    invalidStep: "Invalid step.",
    invalidTarget: "Invalid target.",
    invalidCategory: "The category is not valid. Reload the page.",
    invalidAdoptNote: "Choose the kind of note (supplement or replacement).",
    adoptNoteRequired: "Enter the note. To adopt the proposal as it is, choose no kind.",
    invalidSubmission: "Invalid submission. Reload the page.",
    unreadableInput: "Could not read the input. Reload the page.",
    chooseFile: "Choose a file to import.",
    fileTooLarge: "The file is too large. Choose a file exported from Sacty.",
    notJson: "Not valid JSON. Choose a file exported from Sacty.",
  },
};

export const common = { ja, en };
