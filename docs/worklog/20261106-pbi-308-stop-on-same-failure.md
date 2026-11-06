# 実装をやり直しても前回の失敗が直らなければ、回数を待たずに止める

- 日付: 2026-11-06（UTC）
- タスク: PBI-308
- PR: なし
- ブランチ: feat/issue-308-stop-on-same-failure
- 関係する ADR: [実装をやり直しても前回のテストの失敗が1つも直らなければ、回数を待たずに止める](../adr/20261106-1045-pause-when-redo-fixes-no-test-failure.md)

## 目的

差分と無関係な失敗で、実装と最終レビューを上限まで繰り返し、再開でさらに繰り返すのを止める。

## したこと

- `GuardianTests.failedTests` を足し、最終レビューの指示と読み取り（`extractFinalReview`）に入れた。理由は混ぜず、名前だけを読む。
- `testsMadeNoProgress` で前回と比べ、`Task.verifyStalled` があれば `pauseIfVerificationKeepsFailing` が回数を待たずに止める。
- 再開では `Task.failedTests` を残す。検証の回数を数え直すほかの場面は `resetVerifyFailures` でまとめて消す。
- 文言 `verify.sameFailureRemains`（日英）、仕様書（日英）、ADR。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通った。
- `npx vitest run`：4187 件が通り、5 件が失敗。失敗はどれも処理時間を測るテストで、別の作業の検証と同時に実行していた。該当の4ファイルを `--no-file-parallelism` で実行し直すと 396 件すべて通った。
- 修正を戻して確かめた：再開で失敗の記憶を消すと「再開の後も…1回で止まる」が失敗する。`every` を `some` にすると「1つでも直ったら止めない」が失敗する。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

差分と無関係な失敗を止めずに先へ進める分類は、別の PBI で行う。
