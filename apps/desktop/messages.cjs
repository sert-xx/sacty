const messages = {
  ja: {
    title: "Sacty の準備",
    preview: "試作版",
    welcome: "起動の準備",
    language: "言語",
    prerequisites: "Docker を起動し、GitHub CLI にログインしてください。",
    setupHint: "既存の設定と作業履歴を使います。Node.js と既定イメージはアプリに同梱しています。",
    keyTitle: "OpenAI API キー",
    keyHelp: "初回はキーを保存してください。認証済みなら省略できます。",
    keyLabel: "API キー",
    saveKey: "キーチェーンに保存",
    keySaved: "保存しました。",
    keyFailed: "保存できません。入力とキーチェーンを確認してください。",
    keyInvalid: "API キーの形式を確認してください。",
    startTitle: "起動",
    start: "Sacty を開く",
    help: "設定の手順を見る",
    detailsLabel: "補足",
    imageHint: "初回は同梱イメージを Docker に読み込みます。数分かかる場合があります。",
    ready: "起動してください。",
    checking: "接続の確認中",
    creatingConfig: "設定の作成中",
    loadingImage: "イメージの読み込み中",
    starting: "起動中",
    dockerFailed: "Docker が使えません。起動してからやり直してください。",
    githubFailed: "GitHub に接続できません。gh auth login でログインしてください。",
    configFailed: "設定を読み込めません。設定ファイルを確認してください。",
    authRequired: "画面の認証が無効です。web.auth を有効にしてください。",
    missingImage: "イメージ {image} がありません。設定を確認してください。",
    imageFailed: "イメージを読み込めません。Docker を確認してください。",
    nodeMissing: "Node.js がありません。アプリを作り直してください。",
    startFailed: "起動できません。設定を確認してください。",
    timeout: "時間内に起動できません。やり直してください。",
    busy: "起動中です。完了を待ってください。",
    exited: "Sacty が終了しました。アプリを開き直してください。",
    invalidOperation: "操作できません。アプリを開き直してください。",
    linkFailed: "リンクを開けません。ブラウザーを確認してください。",
    updateTitle: "イメージ設定の更新",
    updateHelp: "{from} から {to} に切り替えますか？",
    updateHint:
      "既存の設定をバックアップしてから、標準イメージの名前だけを変更します。独自のイメージ設定は変更しません。",
    updateConfirm: "更新する",
    cancel: "取り消す",
    updateCancelled: "更新を取り消しました。",
    configChanged: "設定が変更されています。もう一度起動してください。",
    configSharedImage: "イメージ名の参照が共有されています。設定を分けて再試行してください。",
    updateFailed: "設定を更新できません。設定ファイルを確認してください。",
  },
  en: {
    title: "Set up Sacty",
    preview: "Desktop preview",
    welcome: "Get started",
    language: "Language",
    prerequisites: "Start Docker and sign in with GitHub CLI.",
    setupHint:
      "Your existing settings and history are reused. Node.js and the default image are included in the app.",
    keyTitle: "OpenAI API key",
    keyHelp: "Save a key for a new setup. Skip this if authentication is already configured.",
    keyLabel: "API key",
    saveKey: "Save to Keychain",
    keySaved: "Saved.",
    keyFailed: "Could not save the key. Check your input and Keychain.",
    keyInvalid: "Check the API key format.",
    startTitle: "Start",
    start: "Open Sacty",
    help: "View setup instructions",
    detailsLabel: "Details",
    imageHint:
      "The bundled image is imported into Docker on first use. This may take several minutes.",
    ready: "Open Sacty when ready.",
    checking: "Checking connections",
    creatingConfig: "Creating settings",
    loadingImage: "Importing image",
    starting: "Starting",
    dockerFailed: "Docker is unavailable. Start it and try again.",
    githubFailed: "Could not connect to GitHub. Sign in with gh auth login.",
    configFailed: "Could not read settings. Check the configuration file.",
    authRequired: "Screen authentication is disabled. Enable web.auth.",
    missingImage: "Image {image} is missing. Check your settings.",
    imageFailed: "Could not import the image. Check Docker.",
    nodeMissing: "Node.js is missing. Rebuild the application.",
    startFailed: "Could not start Sacty. Check your settings.",
    timeout: "Sacty did not start in time. Try again.",
    busy: "Startup is in progress. Please wait.",
    exited: "Sacty has stopped. Reopen the application.",
    invalidOperation: "This action is unavailable. Reopen the application.",
    linkFailed: "Could not open the link. Check your browser.",
    updateTitle: "Update image settings",
    updateHelp: "Switch from {from} to {to}?",
    updateHint:
      "Your settings are backed up before changing only the standard image name. Custom images are left unchanged.",
    updateConfirm: "Update",
    cancel: "Cancel",
    updateCancelled: "Update cancelled.",
    configChanged: "Your settings have changed. Start again.",
    configSharedImage:
      "The image name is shared by YAML aliases. Separate the settings and try again.",
    updateFailed: "Could not update settings. Check the configuration file.",
  },
};

function pickLocale(value) {
  return String(value || "ja")
    .toLowerCase()
    .startsWith("ja")
    ? "ja"
    : "en";
}
function messagesFor(locale) {
  return messages[pickLocale(locale)];
}
function text(locale, key, values = {}) {
  return messagesFor(locale)[key].replace(/\{(\w+)\}/g, (placeholder, name) =>
    String(values[name] ?? placeholder),
  );
}
module.exports = { messages, pickLocale, messagesFor, text };
