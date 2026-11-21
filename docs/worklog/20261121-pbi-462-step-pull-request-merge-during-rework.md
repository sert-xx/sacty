# 要求要件・設計の自動の直しの間に工程の PR がマージされたら、承認として進め、直しを捨てる

- 日付: 2026-11-21（UTC）
- タスク: PBI-462
- PR: なし
- ブランチ: sacty/task-1c5e5380
- 関係する ADR: [要求要件・設計の自動の直しの間の PR のマージを承認にし、直しを捨てる](../adr/20261121-1619-step-pull-request-merge-during-rework.md)

## 目的

要求要件・設計の自動の直し（差し戻し・PR の指摘や提案の取り込み）の間に人がその工程の PR をマージしたら、マージを承認として扱う。
直しの結果で新しい PR を作り、人がマージの前に直した箇所を黙って戻すことを防ぐ。
要求要件へ戻している間の元の設計の PR のマージは承認にせず、PR に知らせる。

## したこと

- 投影（`packages/core/src/projection.ts`）
  - 直しを始めたときの承認待ちの PR（`reworkOf`）と、前の工程へ戻している間の元の PR（`sentBackFrom`）を、差し戻しの記録から覚える。
  - 提出ごとの成果とテスト観点の写し（`stepSubmitted`）と、工程のブランチごとのコミット（`stepBranchCommits`）を持つ。
  - `reworkingStepPullRequest` で、見守る PR を決める。承認待ちの一時停止と、人の判断待ちの一時停止は除く。
  - `step` 付きの `ReworkStoppedByMerge` で、直しの成果を捨てて提出の版に戻し、その工程の承認待ちに戻す。セルフレビューと出典の分類は、直しの完了が置き換えていたときだけ「記録なし」にする（実行待ち・実行中で止めたときは、提出の版の記録を残す。提出の時点の値を `stepSubmitted` に持って比べる）。
- デーモン（`apps/daemon/src/service.ts`）
  - `checkReworkMerges` が工程の直しも見守る。PR を更新・作成している最中のタスクは止めず、`publishStepPullRequest` が更新・作成の直前に読み直して記録する。
  - 新しい PR を作る経路で直しの PR を閉じられなければ、`pr.supersededNotClosed` で一時停止する（マージ後の文書を読めないときは `pr.mergedDocumentUnreadable`）。承認済みの設計は `pr.failed` と書いているが、実際のキーに置き換えた。仕様書もこのキーで書く。
  - 新しいブランチは、コミットを先に作り、記録済みの名前のコミットと比べて回を決める。
  - `checkSentBackMerges` が、要求要件へ戻している間の設計の PR のマージを PR に知らせる。
  - 承認にした知らせを、工程の PR と実装の PR の作り直しの停止（人の判断待ちを除く）に書く（`apps/daemon/src/merge-approval-notice.ts`）。指摘の取り込みと再レビューの返信からは外す。
  - 起動時の回復は、工程の直しの実行も `unstoppedRuns` 付きで残す。
- 画面：作業履歴の行を「PR #N がマージされたため、設計の直しを止めた」（日英）にする。
- docs
  - 仕様書：[承認と差し戻し](../spec/approval.md#工程の-pr-の直しの間のマージ)に節を足し、作り直すかの決まり・PR の確認・承認待ちでの一時停止・実装の作り直しの節を直した。[タスクと工程](../spec/tasks-and-steps.md#要求要件設計の差し戻しの直し方)にも同じ扱いを書いた（日英）。
  - ユーザードキュメント：[タスクを任せる](../user/tasks.md#直してからマージしたとき作り直しの間にマージしたとき)に、工程の PR のマージ・承認にならないマージ・閉じられなかったときの一時停止を書いた。[はじめに](../user/getting-started.md#更新前のバックアップと旧版への復帰)に、旧版で読めない記録の例を足した（日英）。
  - ADR を足した。

## 確かめたこと

- `npx vitest run apps/daemon/src/daemon-step-pull-requests.test.ts packages/core/src/projection.test.ts apps/web/src/lib/labels.test.ts apps/daemon/src/repository.test.ts apps/daemon/src/github.test.ts` などで、足したテストが通ることを確かめた。
  - 工程の PR の直しの間（実行待ち・実行中・一時停止・PR の更新と作成の最中）のマージを承認にすること、人が直してからマージしたときの人の版、知らせの1回だけの投稿、要求要件へ戻している間の設計の PR のマージの知らせ、閉じられなかったときの一時停止、ブランチの回の決め方、作業履歴の文言、`skipPush`、目印付きのコメントの探し方。
- 修正を戻すと、足したテストが落ちることを確かめた。
  - `reworkingStepPullRequest` を常に `undefined` にする。
  - `publishStepPullRequest` のマージの分岐・閉じられなかったときの分岐を外す。
  - ブランチの回のコミットの比較を外す。
  - `ReworkStoppedByMerge` で成果を提出の版に戻すのを外す。
  - `sentBackFrom` の知らせを外す。
- `npx vitest run tests/docs` で、docs の規則（リンク・作業履歴と ADR の欄・日英のそろい）が通ることを確かめた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| design-3-1 の 1：承認にしないマージ（要求要件へ戻している間の設計の PR）を、人に知らせる | PR に、目印付きのコメントを1回だけ書くようにした。 |
| design-3-1 の 2：ADR を書く | [ADR](../adr/20261121-1619-step-pull-request-merge-during-rework.md) を足した。 |
| design-3-1 の 3：前の版に戻せなくなることを、ユーザー文書に書く | [はじめに](../user/getting-started.md#更新前のバックアップと旧版への復帰)の、旧版で読めない記録の例に足した。 |

## 残したこと

- `step` 付きの `ReworkStoppedByMerge` を記録した後は、前の版のデーモンに戻せない（作業履歴を投影できず、起動できない）。
- この版へ入れ替えた時点で、マージ済みの PR の上で直しが走っているタスクは、入れ替えの後の最初の見守りが同じ扱いにする。
- 承認にならなかった設計の PR のマージは、作業履歴に記録せず、PR の目印で知らせを1回にしている。
- 要求要件へ戻している間にマージされた設計の PR は、設計の PR を作り直した後も、ローカルの状態が `open` のままになりうる（この PBI の前と同じ）。
