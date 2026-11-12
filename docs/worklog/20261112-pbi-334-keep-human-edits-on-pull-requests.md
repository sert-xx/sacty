# sacty の PR に人が足したコミットと、人が直した PR の本文を、更新しても残す

- 日付: 2026-11-12（UTC）
- タスク: PBI-334
- PR: #354
- ブランチ: claude/kind-hawking-3yd1ju
- 関係する ADR: [人が sacty の PR に足したコミットを作業領域に取り込み、人が直した PR の本文を3方向でマージして残す](../adr/20261112-1553-keep-human-edits-on-sacty-pull-requests.md)

## 目的

sacty が作った PR をレビューの指摘で直して更新するとき、人が PR に手を入れていても壊さないようにする。

- 人が PR のブランチにコミットを足していても、プッシュに失敗せず、人の変更も消さない。
- 人が PR の本文を補足・整形していても、上書きで消さず、sacty の新しい内容も入れる。

## したこと

- 人が足したコミットの取り込み
  - `apps/daemon/src/repository.ts`：`mergeBase` に `exclude`（両側のツリーから外すパス）を足した。タスクブランチから引き継ぐ
    要求要件・設計のファイルを、取り込みから外すため。
  - `packages/core/src/events.ts`・`projection.ts`：`PullRequestHeadMerged` と `Task.headMerge`・`pendingHeadMerge` を足した。
    PR を出す直前（`publishPending`）に競合したら、PR を出さずに実装をやり直す。
  - `apps/daemon/src/service.ts`：`syncPullRequestHead` を足し、`syncBase`（実装の前・最終レビューの前）・
    `headSyncedBeforePublish`（最終レビューをしない流れの PR を出す前）・`publish`（PR を出す直前）から呼ぶ。`publish` は、
    まだ提出していない取り込みがあれば、その先頭を親にする。タスクブランチの変更の確認の起点も、その先頭にする。
    取り込みは、テスト用の設定 `mergeBase` とは関係なく行う（`mergesBase` から設定を外し、`syncBase` の中でベースブランチの部分だけを止める）。
  - `apps/daemon/src/prompts.ts`：実装の指示に「人が PR に足したコミット」の節（`headMergeLines`）、最終レビューの指示に
    `headMergeReviewLines` を足し、ベースブランチとの競合（`baseConflictLines`）と分けた。
- 人が直した本文
  - `apps/daemon/src/pr-body-merge.ts`（新規）：`git merge-file --diff3` で本文を3方向にマージする `mergePullRequestBody`、
    重なったときにエージェントへ渡す指示 `buildPullRequestBodyMergePrompt`、答えの取り出し `extractMergedPullRequestBody`。
  - `apps/daemon/src/github.ts`：PR の今の本文を読む `pullRequestBody` を足した。
  - `packages/core/src/events.ts`・`projection.ts`・`cost.ts`：`PullRequestBodyWritten`（sacty が組み立てた本文）・
    `PullRequestBodyResolved`（エージェントがまとめた・まとめられなかった。費用を予算に入れる）と `Task.pullRequestBodies`。
  - `apps/daemon/src/service.ts`：`reconcilePullRequestBody`・`recordPullRequestBody` を足し、実装の PR・要求要件・設計の PR の
    更新・重ねた PR の付け替えの3か所で使う。
  - `apps/daemon/src/server.ts`：タスクの一覧の API では `pullRequestBodies` を送らない。
  - `apps/web`：作業履歴の文言（日英）と、工程ごとの費用の表（オーケストレーターの行）。
- docs：仕様書（`tasks-and-steps`・`approval` の日英）、ユーザードキュメント（`tasks` の日英）、ADR。

決めたこと：本文の3方向のマージの共通の祖先は、GitHub に書いた本文ではなく sacty が組み立てた本文にした。GitHub に書いた
本文を祖先にすると、人が前に足した補足が次の更新で消えるため（ADR に書いた）。

## 確かめたこと

- `npx biome check .`：指摘なし。
- `npm run typecheck`：エラーなし。
- `npx vitest run apps packages`：4500 件中 18 件が失敗。変更の前（`git stash` した状態）も 18 件が失敗していて、増えたのは下の
  1 件だけ。どれもこの環境の原因：
  - この環境の git が 2.43 で、`git merge-tree --write-tree` の引数にツリーを渡せない（`unexpected output`）。ベースブランチの
    取り込みの既存の結合テストも同じ理由で失敗する。新しく足した `repository.test.ts` の取り込みの結合テスト1件も同じ理由で、
    ここでは確かめられない（CI で確かめる）。
  - Playwright のブラウザが無い。
- 足したテスト：
  - `apps/daemon/src/daemon.test.ts`：人のコミットを取り込んでその先頭に積む・競合を人の側として渡す・コミットが無ければ
    取り込まない・最終レビューをしない流れで実装の実行中に足されたコミットを PR を出す前に取り込む・その取り込みで競合したら
    数えずにやり直す・本文の重ならない直しを残す（CRLF も）・重なったらエージェントにまとめさせる・まとめられなければ人の本文の
    まま・今の本文を読めなければ上書き。
  - `apps/daemon/src/pr-body-merge.test.ts`：3方向のマージ・目印・答えの取り出し。
  - `packages/core/src/projection.test.ts`：`PullRequestHeadMerged`・`pendingHeadMerge`・`PullRequestBodyWritten`。
  - `apps/web/src/lib/step-costs-totals.test.ts`：無作為の作業履歴に `PullRequestBodyResolved` を足した。
- 既存のテストの直し：イベントの並びを比べるテストに `PullRequestBodyWritten` を足した。タスクブランチに人が積んだ後の
  やり直しのテストは、確かめて止める代わりに、取り込んで積むことを確かめるようにした。
- `npx vitest run tests/docs`：通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

- 要求要件・設計の PR のブランチに人が成果のファイルを直接直したコミットは、sacty が成果のファイルを書き直すので、その直しは
  残らない（これまでどおり。指摘として書くと、工程のエージェントが反映する）。
- この環境の git（2.43）で、ベースブランチの取り込みの結合テストが通らない。仕様書には「2.40 以上が必要」とあるが、
  `merge-tree` にツリーを渡すには、より新しい git が要るとみられる（未確認）。
