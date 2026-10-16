/**
 * 画面の文言：ヘッダー・メニュー・サイドメニュー。サイドメニューの名称は幅が狭いので、折り返す位置に幅の無い空白（\u200b）
 * を入れる。英語の用語は labels.ts の用語集に合わせる。
 */
const ja = {
  nav: { main: "メイン", dashboard: "ダッシュ\u200bボード", tasks: "タスク", settings: "設定" },
  project: {
    label: "プロジェクト",
    trigger: (name: string) => `プロジェクト：${name}（切り替える）`,
    switch: "プロジェクトを切り替える",
    all: "すべてのプロジェクト",
    needsYou: (n: number) => `対応待ち ${n}`,
    manage: "プロジェクトを管理する",
    fallbackName: "デフォルト",
  },
  notices: {
    label: "お知らせ",
    labelWithCount: (n: number) => `お知らせ（人間の対応待ち ${n}件）`,
    title: "人間の対応待ち",
    total: (n: number) => `全${n}件`,
    none: "対応待ちはありません。",
    others: "ほかのプロジェクト",
    here: (name: string) => `このプロジェクト（${name}）`,
    hint: "開くと、そのプロジェクトに切り替えてタスクを表示します。",
  },
  user: {
    label: "ユーザー設定",
    settings: "sacty の設定",
    theme: "テーマ",
    themes: { system: "システムに従う", light: "ライト", dark: "ダーク" },
    language: "言語",
    languages: { system: "システムに従う", ja: "日本語", en: "English" },
    languageNote: "エージェントの成果物は、書かれた言語のまま表示します。",
  },
};

export type ShellMessages = typeof ja;

const en: ShellMessages = {
  nav: { main: "Main", dashboard: "Dashboard", tasks: "Tasks", settings: "Settings" },
  project: {
    label: "Project",
    trigger: (name) => `Project: ${name} (switch)`,
    switch: "Switch project",
    all: "All projects",
    needsYou: (n) => `${n} need${n === 1 ? "s" : ""} you`,
    manage: "Manage projects",
    fallbackName: "Default",
  },
  notices: {
    label: "Notifications",
    labelWithCount: (n) => `Notifications (${n} need${n === 1 ? "s" : ""} you)`,
    title: "Needs you",
    total: (n) => `${n} total`,
    none: "Nothing needs you.",
    others: "Other projects",
    here: (name) => `This project (${name})`,
    hint: "Opens the task in its own project.",
  },
  user: {
    label: "Preferences",
    settings: "sacty settings",
    theme: "Theme",
    themes: { system: "System", light: "Light", dark: "Dark" },
    language: "Language",
    languages: { system: "System", ja: "日本語", en: "English" },
    languageNote: "Deliverables are shown in the language they were written in.",
  },
};

export const shell = { ja, en };
