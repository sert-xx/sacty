/**
 * 画面の文言：ヘッダー・メニュー・サイドメニュー。サイドメニューの名称は幅が狭いので、折り返す位置に幅の無い空白（​）
 * を入れる。英語の用語は labels.ts の用語集に合わせる。
 */
const ja = {
  nav: {
    main: "メイン",
    tasks: "タスク",
    audit: "監査",
    settings: "設定",
  },
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
    labelWithCount: (n: number) => `お知らせ（対応待ち ${n}件）`,
    title: "あなたの出番",
    total: (n: number) => `全${n}件`,
    none: "対応待ちはありません。",
    others: "ほかのプロジェクト",
    here: (name: string) => `このプロジェクト（${name}）`,
  },
  /** sacty の新しい版（PBI-135）。 */
  update: {
    title: "sacty の新しい版があります",
    behind: (n: number) =>
      `sacty の main に、動いている版に無い変更が ${n} 件あります。更新すると推奨のモデルや修正が入ります。`,
    compare: "変更を見る",
    steps: "動いている sacty up を Ctrl+C で止めてから、sacty のリポジトリで次を実行してください。",
  },
  user: {
    label: "ユーザー設定",
    settings: "sacty の設定",
    theme: "テーマ",
    themes: { system: "システムに従う", light: "ライト", dark: "ダーク" },
    language: "言語",
    languages: { system: "システムに従う", ja: "日本語", en: "English" },
    languageNote: "エージェントの成果物は訳しません。",
  },
};

export type ShellMessages = typeof ja;

const en: ShellMessages = {
  nav: {
    main: "Main",
    tasks: "Tasks",
    audit: "Audit",
    settings: "Settings",
  },
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
  },
  update: {
    title: "A new version of sacty is available",
    behind: (n) =>
      `sacty main has ${n} change${n === 1 ? "" : "s"} not in the running version. Updating brings the recommended models and fixes.`,
    compare: "See the changes",
    steps: "Stop the running sacty up with Ctrl+C, then run these in the sacty repository.",
  },
  user: {
    label: "Preferences",
    settings: "sacty settings",
    theme: "Theme",
    themes: { system: "System", light: "Light", dark: "Dark" },
    language: "Language",
    languages: { system: "System", ja: "日本語", en: "English" },
    languageNote: "Agent deliverables are not translated.",
  },
};

export const shell = { ja, en };
