# イメージの説明や長い URL で、プロジェクトの設定とタスクの作成の画面が崩れないようにする

- 日付: 2026-10-27（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/fervent-hypatia-b1p8de
- 関係する ADR: なし

## 目的

- プロジェクトの設定の対象の「イメージ」で、選択肢に `名前（説明）` を出していたため、説明が長いとプルダウンが広がり、行からはみ出していた。
- タスクを作成するモーダルの「内容」に、途中で折り返せない長い URL を入れると、テキストエリアがモーダルの右端を突き抜けていた。

## したこと

- `apps/web/src/components/project-editor.tsx`：イメージの選択肢は名前だけにし（説明は `title`）、選んだイメージの説明は対象の行の下に折り返して出す。
  イメージの欄は、行の残りの幅に収まるようにした（`flex-1`・`min-w-0`）。文言 `imageDescription` を `apps/web/src/i18n/messages/projects.ts` に足した。
- `apps/web/src/components/ui/textarea.tsx`：`min-w-0` と `wrap-anywhere` を足し、長い URL でもテキストエリアの幅が親を超えないようにした（すべてのテキストエリアに効く）。
- ユーザードキュメント（`docs/user/project-settings.md` と英語の版）に、選択肢と説明の出し方を書いた。

## 確かめたこと

- 同じクラスを当てた再現ページを Chromium で開き、幅 512px のモーダルで、変更前はテキストエリアが 610px に広がり、変更後は 478px に収まることを確かめた。
  イメージの長い説明が行の下で折り返し、行がはみ出さないことも確かめた。
- `npm run typecheck`・`npx biome check`・`npx vitest run apps/web tests/docs`：`question-form.browser` 以外は通った。
  `question-form.browser` は、作業した環境（コンテナ）に Playwright の版に合うブラウザーが無いために失敗し、変更前のコミットでも同じく失敗する。

## レビューの指摘と対応

なし
