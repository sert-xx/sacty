# PR のレビューの集約が、対応済み・却下済みの指摘と重なる指摘を投稿しない

- 日付: 2026-11-21（UTC）
- タスク: PBI-445
- PR: なし
- ブランチ: sacty/task-pbi-445
- 関係する ADR: [20261121-1600-drop-findings-overlapping-addressed-or-rejected.md](../adr/20261121-1600-drop-findings-overlapping-addressed-or-rejected.md)

## 目的

往復を重ねるレビューが、直った指摘の出し直しと、却下された指摘の蒸し返しをしないようにする。集約の決まり（既定のスキル）と、材料を確実に渡すデーモンの変更を含む。

## したこと

- 既定のスキル `review-dispatch` の `aggregation.md`・`pr-review.md` に、対応済み・却下済みとの重なりを落とす決まり・順・件数の行・弾かないものを足した。
- `github.ts`：`feedback` が、各件の `author_association` と、目印のタスク ID が一致する返信の `bySacty` を返す（`sactyReplyTasks`）。
- `remark-reply.ts`：返信の状態を、返信を作る側と同じ定数で読む `readRemarkReply` を足した。
- `review-comments.ts`（新）：各件に `by`・`reply` を付ける `annotateReviewComments` と、人が画面で無効にした指摘を選ぶ `voidedByPersonOf`。
- `projection.ts`：`RemarkVoided`（人の操作）で `voidedBy: person` を残す。イベントは変えない。
- `service.ts`：`reviewFeedback` が `by`・`reply` を付け、PR を作ったタスクの `voidedByPerson` を渡す。
- `prompts.ts`：既存のレビューを全体で 50 件・優先の選び方・`omitted`、「前回の指摘」に「取り下げた」、同じ先頭の判定し直しの例外、弾く決まりの節（`overlapLines`）、実装の指示の AI のレビューの指摘の説明。
- 仕様書・利用者向け文書（日英）・ADR を足した・直した。

## 確かめたこと

- 足したテスト：`review-overlap.test.ts`（返信の状態の読み取り・`by` の区別・50 件の選び方・4 回目の指示・無効にした指摘・取り込んだ PR・再レビューの指示）、`daemon-suggestion-triage.test.ts`（結合）、`projection.test.ts`（`voidedBy`）、`prompts.test.ts`。
- 集約の段を、サブエージェントの実際の AI で実行した。対応済みと重なる提案・人が却下した指摘と重なる `must` は落ち、対応済みと返されたが直っていない `must` は前回の指摘の未対応として残り、新しい別の問題は採用され、総評に落とした件数（`must` 1 件を含む 2 件）の行が出た。
- 実行したコマンドと結果は、PR の本文に書いた。

## 残したこと

- `earlierReviews` の上限（新しい 5 件）は変えていない。8 回目以降は、最初の回の指摘がデータから消える。
- 実際の AI での確かめは 1 回の実行で、毎回の結果が同じになることは確かめていない。
