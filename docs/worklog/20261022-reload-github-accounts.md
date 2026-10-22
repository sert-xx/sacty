# プロジェクトの設定の画面で、gh のアカウントの一覧を読み直せるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-96c16d5d-32lk0d
- 関係する ADR: なし

## 目的

`gh` にログインし直したりアカウントを足したりしたあと、プロジェクトの設定の画面で、`gh auth status` の確認をやり直して（アカウントの一覧を読み直して）選べるようにする。
これまでは画面ごと読み込み直すしかなく、編集中の入力が消えた。

## したこと

- `apps/web/src/app/actions.ts` に `reloadGitHubAccountsAction` を足した。`GET /api/github/accounts` をもう一度呼ぶ（デーモンは呼ばれるたびに `gh auth status --json hosts` を実行する）。デーモンに届かなければ、共通の文言（`common.action.daemonDown`）を `error` で返す。
- `apps/web/src/components/project-editor.tsx` で、アカウントの一覧を props から状態に移し、「GitHub アカウント」の区画の見出しの横に「アカウントを読み直す」ボタンを置いた。押すと一覧を置き換える。ほかの入力の状態はそのまま残る。読み直しているあいだはボタンを止め、アイコンを回す。
- 文言 `githubReload`・`githubReloading` を日英で足した（`apps/web/src/i18n/messages/projects.ts`）。
- `docs/spec/intake.md`・`docs/user/project-settings.md` と英語の版に書き足した。

## 確かめたこと

- `npm run lint`：指摘なし。
- `npm run typecheck`：エラーなし。
- `npx vitest run apps/web/src/components/project-editor.test.ts`：2 件が通った（足したテストは、設定画面に読み直すボタンが日英で出ることを確かめる）。
- `npx vitest run apps/web tests/docs`：すべて通った。
- 実際の画面でボタンを押して一覧が変わることは、この環境にデーモンと `gh` のログインが無いため確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |

## 残したこと

なし
