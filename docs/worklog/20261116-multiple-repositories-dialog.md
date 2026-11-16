# 作成画面で複数のリポジトリを指定する

- 日付: 2026-11-16（UTC）
- タスク: なし
- PR: なし
- ブランチ: 作業ブランチ
- 関係する ADR: なし

## 目的

作成時に対象のリポジトリを複数選び、一覧と詳細で確認できるようにする。

## したこと

作成欄の追加と削除、作成入力の送信、一覧と詳細および再開候補の表示を変更した。
利用者向けの手順と仕様を更新した。

## 確かめたこと

`npx vitest run apps/web/src/components/repository-fields.test.ts apps/web/src/app/actions.test.ts`：41件成功。
`npx vitest run apps/web/src/components/derive-dialog.test.ts tests/docs`：98件成功。
`npm run lint`・`npm run typecheck`・`npx vitest run`・`npm run build`・`npx vitest run tests/docs`：成功。
`npm run docs:screenshots -- docs`：日本語と英語の作成ダイアログを撮り直した。

## レビューの指摘と対応

なし。

## 残したこと

なし。
