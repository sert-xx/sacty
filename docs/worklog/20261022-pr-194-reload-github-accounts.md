# プロジェクトの設定の画面で、gh のアカウントの一覧を読み直せるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #194
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
- `npx vitest run apps/web/src/components/project-editor.test.ts`：2 件が通った（このときは、設定画面に読み直すボタンが日英で出ることだけを確かめていた）。
- `npx vitest run apps/web tests/docs`：すべて通った。
- 実際の画面でボタンを押して一覧が変わることは、この環境にデーモンと `gh` のログインが無いため確かめていない。
- レビューの対応の後
  - `npm run lint`：指摘なし。`npm run typecheck`：エラーなし。
  - `npx vitest run apps/web tests/docs`：61 ファイル・537 件が通った。
  - `setGithub` を外した実装で `project-editor-reload.test.ts` を実行すると、2 件とも落ちることを確かめた（戻して通ることも確かめた）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 読み直しの問い合わせに期限が無く、デーモンが応答しないとボタンが止まったままになる（`daemonFetch` の既定の中断は `/live` の `withDaemonSignal` の中でだけ効く） | `getGitHubAccounts` に `signal` を渡せるようにし、`reloadGitHubAccountsAction` で `AbortSignal.timeout(30_000)` を渡した（本文を読み終えるまで効く）。時間切れなら `githubReloadTimeout`（日英）を `error` で返し、既存の理由の表示に戻ってもう一度押せる。期限は、`gh auth status` が届かない GitHub Enterprise Server を待つことがあるので長めにした |
| テストが静的な HTML のボタンの文言しか見ておらず、`onClick`・`setGithub` を外しても通る | 静的なテストをやめ、jsdom で操作するテスト（`apps/web/src/components/project-editor-reload.test.ts`）を足した。名前を編集してから読み直しを押し、待たせられる Action のモックで、読み直すあいだのボタンの無効・文言、結果での選択肢と認識済みの一覧の置き換え、編集中の入力が残ること、`error` のときの理由の表示ともう一度押せることを確かめる。Action の時間切れと、届かないときの理由は `apps/web/src/app/actions.test.ts` で確かめる |

## 残したこと

なし
