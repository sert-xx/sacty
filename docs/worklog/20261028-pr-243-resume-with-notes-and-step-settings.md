# 一時停止したタスクの再開のときに、補足を足し、工程のイメージ・エージェントを変えられるようにする

- 日付: 2026-10-28（UTC）
- タスク: なし
- PR: #243
- ブランチ: ccr-98b90f80-bl3gz2
- 関係する ADR: [一時停止したタスクの再開のときに、補足を足し、工程のイメージ・エージェントを一緒に変えられる](../adr/20261028-0342-resume-with-notes-and-step-settings.md)

## 目的

タスクが失敗して一時停止したときに、「再開する」を押すだけでなく、イメージ・エージェントを変えたり、情報を足したりしてから再開できるようにする。

## したこと

- コア：`ResumeTaskInput` に `note`・`images`・`agents`、`TaskResumed` に `note` を足した。投影は、`note` があればタスクの説明の後に
  `RESUME_NOTE_HEADING` の見出しを付けて足す。文言 `resume.stepSettingsRechoose` を足した。
- デーモン：`changeStepImage`・`changeStepAgent` の確かめを `stepImageChange`・`stepAgentChange` に分け、`resume` からも使うようにした。
  `resume` は、工程の設定の変更（今と同じ名前は除く）を `TaskResumed` の前に同じ書き込みで記録する。工程の選択からやり直すときは断る。
- 画面：
  - 再開の欄（`resume-form.tsx`）に、補足の入力欄と、まだ終わっていない工程のイメージ・エージェントの選択（折りたたみ）を足した。
    選択は非制御のまま、今の名前を初めに選んでおく（候補から消えた名前は空の選択にして送らない）。テストを決めずに再開するとき
    （工程の選択からやり直す）は、変えられないことだけを出す。候補は、タスクの詳細の工程の設定と同じもの（`imageStatus`・`agentStatus`）を使う。
  - Server Action（`resumeTaskAction`）で、`note` と `image:<工程>`・`agent:<工程>` を読み、デーモンへ渡す。
  - 作業履歴の再開の行に、補足を足したことと、補足の本文（詳細）を出す。
- ドキュメント：仕様書（工程とタスク）・ユーザードキュメント（タスク）を日英で直し、ADR を足した。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通った。
- `npx vitest run apps/daemon packages/core apps/web`：今回足した・直したテスト（再開と一緒の工程の設定と補足・誤った設定で何も記録しない・
  工程の選択からやり直すときに断る・再開の欄の送信・Server Action）を含めて通った。
  9件（`agent-sessions`・`context-mcp`・`host-mcp-processes`・`question-form.browser`）が落ちたが、変更を外した状態（`git stash`）でも同じく落ちるので、
  この環境（root で動かす・プロセス・ブラウザーの版）の都合で、今回の変更とは関係ない。
- `npx vitest run tests/docs`：通った。
- `npm run build` の後、スクリーンショットの仕組み（架空のデータ）で、日英の `task-budget-paused` を撮り直し、再開の欄に補足の入力欄と
  工程の設定の折りたたみが出ること、折りたたみを開くと工程ごとのイメージ・エージェントの選択が出ることを確かめた。この環境の Playwright の
  ブラウザーの版がリポジトリの指定と違うので、ブラウザーの場所を指定した一時的な写しで撮った（写しは残していない）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 承認ゲート・エスカレーションの待ちのときに、補足を足す手段は足していない。
