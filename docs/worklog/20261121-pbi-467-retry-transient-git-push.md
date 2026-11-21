# 一時的な git push の失敗をやり直す

- 日付: 2026-11-21（UTC）
- タスク: PBI-467
- PR: なし
- ブランチ: sacty/task-6245471d
- 関係する ADR: [PR の push の一時的な失敗は、15 秒・1 分・3 分の最大 3 回、push だけをやり直す](../adr/20261121-1840-retry-transient-git-push-failures.md)

## 目的

PR を作る・直しを積む `git push` が、GitHub 側の一時的な失敗で拒まれても、人の再開を待たずに自動でやり直す。
停止の理由の文で、失敗の行が先に読めるようにする。

## したこと

- git の操作（`apps/daemon/src/repository.ts`）
  - PR の push（`publish`・`pushCommit`・`commitFiles`）を `LC_ALL=C` で実行し、失敗を `PushFailedError`（一時的か・コミット・ブランチを持つ）にする。
  - 失敗の分類（`classifyPushFailure`）と、停止の理由の文の整形（`formatPushFailure`）を足す。
- デーモン（`apps/daemon/src/service.ts`）
  - `retryPush`・`pushRetrying` で、一時的な失敗なら同じコミットを最大 3 回 push し直す。待ちと、やめる判定は `retryTransient` と共通にした。
  - 実装の PR・引き継いだ PR・要求要件と設計の PR の 3 経路に使う。引き継いだ PR は、一時的な失敗が上限まで続いたら `pr.failed` で止める。
- 記録・画面：`PushRetried`・`PushRetryEnded`（記録だけ）と、作業履歴の表示名（日英）。
- テストの偽物に、呼び出しごとの git の標準エラーと「通ったが応答が失われた」状態を返させる指定を足した。
- docs：仕様書（日英）・ユーザー文書（日英）・ADR を書いた。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npx vitest run`（全件）・`npm run build` を、最後の変更の後に実行した（結果は PR の本文に書く）。
- 紹介のページ（`introduction.md`）と図（`intro.mjs`）には push の失敗の記述が無く、合わなくならないことを確かめた。

## 残したこと

- 2 回目の事例で、直しの実行からやり直した原因は切り分けていない（その作業履歴を読めない）。再開の直前に PR へ指摘が届いていたときは、今までどおり指摘を読んで差し戻す。
- この記録を残した後は、前の版のデーモンに戻せない（ADR・作業履歴の仕様書に、戻せる期限・戻す前の確認・復旧を書いた）。
- 紹介のページ（`introduction.md`）と図には push の失敗の記述が無く、変えていない。
