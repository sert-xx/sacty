<!-- sacty task 1c5e5380-6165-4198-b337-d3bc57c38a56 の設計。sacty が作成しました。 -->

# 設計：自動の直しの間に人がマージした工程の PR を、承認として扱う

## スコープ

要求要件・設計の自動の直しが終わる前（push の前）に、人がその工程の開いた PR をマージしたら、sacty は直しを止めて結果を捨て、マージを承認として次の工程へ進める。
実装の PR の仕組み（PBI-276）を、工程の PR に広げる。

- 対象
  - 直しの間（実行待ち・実行中・待機・一時停止）に工程の PR がマージされたことの検知と、実行の停止・承認の記録
  - `publishStepPullRequest` が、マージ済みの PR から新しいブランチ・PR を作らないこと
  - 作業履歴の表示と、PR への1回だけの知らせ
  - 仕様書・ユーザー文書（日英）、テスト、作業履歴
- 対象外
  - 実装の PR の扱い（PBI-276 のまま。知らせも足さない）
  - 後の工程から前の工程へ戻したときに、承認済み（マージを記録済み）の前の工程の PR から直しの PR を新しく作る振る舞い
  - 戻し先が前の工程のとき（設計の PR の指摘で要求要件に戻している間）に、開いたままの設計の PR がマージされた場合
  - 閉じた PR、「提案あり」の回を遅らせる仕組み、レビューの子の見守り

## 確認したいこと

### must

1. 一時停止中（予算・手動など）の直しの間のマージも、承認にするか。
   - 推奨：する（実装の PR と同じく、待機・一時停止の間も見守る）。人の判断待ち（PBI-452）の一時停止は、今の仕組みのままにする。
   - 懸念：受け入れ条件は「実行中（実行待ちも含む）」だけを挙げている。そのため、一時停止で手を止めて考えていた人の側では、再開しないうちに次の工程が始まる。承認にしなければ、再開した人の前に #497 と同じ新しい PR ができる。

### should

1. 戻し先が前の工程のとき（設計の PR の指摘で要求要件に戻している間）に、開いたままの設計の PR がマージされたら、設計の承認にするか。
   - 推奨：今回はしない（対象外）。今までどおり、要求要件の承認の後に設計の PR を作り直す。要求要件の直しと合わない設計を、承認済みにしないため。
   - 懸念：この経路では、設計をマージした人が、新しい設計の PR をもう一度マージする必要がある。

### 確認しないと決めたこと

- 受け入れ条件 5 の境目
  - 直しのコミットの push より前のマージは、新しい扱いにする。
  - push の後のマージは、今までどおり記録の後に `checkPullRequests` が承認する。
  - 人に聞かない理由：マージの時点の PR の先頭が直しのコミットかどうかで見分けられる。どちらの場合も、承認する成果はマージの時点のファイルになる。
- 知らせの件数
  - `ReworkStoppedByMerge` の `discardedRemarks` の件数にする。その工程の最後の回の指摘のうち、無効にしておらず、まだ提出していないものを数える。
  - 人に聞かない理由：作業履歴と PR の件数がそろい、PBI-276 の数え方とも同じになる。
- 人の直しの版
  - マージの時点の PR の先頭が、提出したコミットと違えば、今の承認と同じく `readMergedDocument` で人の版を承認済みにする。
  - 読めなければ何も記録せず、次の確認でやり直す。
  - 人に聞かない理由：受け入れ条件 1「今の『マージで承認』と同じ結果」から決まる。

## 既定で決めたこと

- 記録は新しいイベントを足さず、`ReworkStoppedByMerge` に任意の `step`（`requirements`・`design`）を足す。`step` が無い記録は実装として読む。
- 知らせには新しい目印 `<!-- sacty-merge-approval:<タスク ID>:<PR 番号> -->` を付けて1件だけ書き、sacty の知らせとして指摘の取り込みから外す。
- ADR は足さない。今の「マージで承認」の決まりを当てはめるだけで、PBI-276 と同じ扱いにする。

## 構成

| 場所 | 変更 |
| --- | --- |
| `packages/core/src/projection.ts` | `reworkingStepPullRequest(task)` を足す。次の条件をすべて満たすときに、その工程の最後の PR を返す：状態が実行待ち・実行中・待機・一時停止（`needs_decision` を除く）、実行中の工程が要求要件か設計、その PR がローカルで `open` かつ `superseded` でない。`ReworkStoppedByMerge` の投影は、`step` があればその工程の承認待ちに戻し（ゲートはその PR の提出）、捨てた指摘を無効にする |
| `packages/core/src/events.ts` | `ReworkStoppedByMerge` に任意の `step` を足す |
| `apps/daemon/src/service.ts` | `checkReworkMerges`・`stopReworkForMerge`・`endReworkByMerge` を、`reworkingStepPullRequest` の PR にも当てる。`publishStepPullRequest` に、マージを見つけたときの分岐を足す |
| `apps/daemon/src/merge-approval-notice.ts`（新規）・`github.ts` | 知らせの本文と目印、`isMergeApprovalNotice` を足す。`isReworkNotice` を使っている2か所に、この判定も足す |
| `apps/web/src/lib/labels.ts` | `step` があれば「PR #N がマージされたため、<工程>の直しを止めた」と出す（日英） |

## 処理の流れ

1. `checkPullRequests` の最初の見守り（60 秒ごと）で、`reworkingStepPullRequest` の PR が GitHub でマージ済みなら、次の順に処理する。
   - 必要なら人の版を読む。
   - 実行を止めて、終わるのを待つ（`mergeStopping`）。
   - 1回の追記で `ReworkStoppedByMerge`（`step` 付き）・`PullRequestMerged`・`StepApproved` を記録する。
2. `publishStepPullRequest` で、前の PR がローカルで `open`、GitHub で `merged` なら、新しいブランチ・PR を作らず、1 と同じ記録をする。
3. push の後、PR を更新する前に状態を読み直す。
   - マージ済みで、先頭が直しのコミットでなければ（push より前のマージ）、PR を更新せず、1 と同じ記録をする。
   - 先頭が直しのコミットなら、今までどおり記録して承認待ちにする。
4. 記録の後に知らせを送り、送信の結果は待たない。
   - GitHub のアカウントが無いプロジェクトと、セキュリティのタスクには書かない。
   - 本文には、マージを承認として扱ったこと、自動の直しを取り込まなかったこと、捨てた指摘があればその件数を書く。

## エラー時の振る舞い

- 止めたコンテナが無くなったことを確かめられなければ、PBI-276 と同じく一時停止にして、人の確認を待つ。
- 知らせを書けなくても、タスクは変えない。目印の付いたコメントがすでにあれば書かない。

## 影響範囲

- `step` 付きの `ReworkStoppedByMerge` を記録した後は、前の版のデーモンが作業履歴を投影できない（実装の作り直しとして読み、整合性のエラーになる）。作業履歴に「版を戻せない」と書く。
- 仕様書
  - `docs/spec/approval.md`（日英）の「要求要件・設計の PR を作り直すか」にある「PR がマージ済み」を、承認済みのマージに限る。
  - 同じファイルの「実装の作り直しの間のマージ」の隣に、工程の PR の節を足す。
  - `docs/spec/tasks-and-steps.md`（日英）の同じ記述もそろえる。
- ユーザー文書：`docs/user/tasks.md`（日英）の「直してからマージしたとき・作り直しの間にマージしたとき」に、工程の PR のことを足す。
- テスト
  - `apps/daemon/src/daemon-step-pull-requests.test.ts` で、次を確かめる：処理の流れの 1〜3、知らせ、push の後のマージ、閉じた PR、前の工程への差し戻しで新しい PR を作ること。
  - ほかに `projection.test.ts`・`labels.test.ts`・`imitated-notices.test.ts`。
- 作業履歴 `docs/worklog/20261121-pbi-462-<スラッグ>.md` を足す。

## テスト観点

- [TV-1] 実行中の設計の直しの間のマージを、承認として進める
  - 入力：設計の PR #N の「提案あり」を取り込み、設計の直しを実行している間に、GitHub で #N がマージ済みになり、PR の確認が走る
  - 期待結果：実行が止まり、1回の追記で ReworkStoppedByMerge（step: design、number: N）・PullRequestMerged（number: N）・StepApproved（step: design）が記録され、タスクは次の工程へ進み、直しの結果は PR に push されない
- [TV-2] 実行待ち・一時停止の直しの間のマージも承認にする
  - 入力：要求要件の直しが実行待ちのタスクと、設計の直しの間に手動で一時停止したタスクで、それぞれの開いた工程の PR がマージされ、PR の確認が走る
  - 期待結果：どちらも ReworkStoppedByMerge（was が queued・paused）・PullRequestMerged・StepApproved が記録され、新しいブランチ・PR は作られない
- [TV-3] PR を作る時点でマージ済みなら、新しいブランチ・PR を作らない
  - 入力：設計の直しの実行が終わり、publishStepPullRequest が前の設計の PR #N（ローカルで open）を読むと、GitHub で merged になっている
  - 期待結果：<タスクブランチ>-design-2 のブランチの push・PR の作成・StepPullRequestPublished の記録が無く、#N のマージが承認として記録される
- [TV-4] push の後・PR の更新の前に、push より前のマージを見つける
  - 入力：publishStepPullRequest の最初の読み込みでは #N が open で、直しのコミットを push した後に読み直すと、先頭が直しのコミットでない状態で merged になっている
  - 期待結果：PR の更新（upsert）と StepPullRequestPublished の記録が無く、ReworkStoppedByMerge（step: design）・PullRequestMerged・StepApproved が記録される
- [TV-5] 人が直してからマージしたら、人の版を承認済みの成果にする
  - 入力：直しの間に、人が #N に直接コミットしてからマージし、マージのコミットの設計のファイルが sacty の提出した版と違う
  - 期待結果：PullRequestMerged が edited: true と、マージのコミットの document を持ち、承認済みの設計は人の版になる。設計のファイルを読めないときは何も記録されず、次の確認で記録される
- [TV-6] get_task と画面で、マージした PR が open のまま残らない
  - 入力：観点1の承認の後に get_task を呼び、タスクの画面を開く
  - 期待結果：pullRequests の #N の state が merged になり、画面も #N をマージ済みとして出す
- [TV-7] 作業履歴に、直しを捨てたことを工程の名前で出す
  - 入力：step: design の ReworkStoppedByMerge を、作業履歴の表示の文言にする（日英）
  - 期待結果：「PR #N がマージされたため、設計の直しを止めた」と、それに対応する英語の文になる。step の無い記録は、今までの「実装の作り直し」の文言のままになる
- [TV-8] PR に1回だけ知らせる
  - 入力：観点1の承認の後に PR の確認が2回走り、捨てた指摘が3件ある。別に、セキュリティのタスクと、GitHub のアカウントの無いプロジェクトでも同じことが起きる
  - 期待結果：#N に、目印 <!-- sacty-merge-approval:<タスク ID>:N --> の付いたコメントが1件だけあり、マージを承認として扱ったこと・自動の直しを取り込まなかったこと・残っていた提案が 3 件であることが書かれている。セキュリティのタスクとアカウントの無いプロジェクトには書かれない
- [TV-9] 知らせを PR の指摘として取り込まない
  - 入力：目印 <!-- sacty-merge-approval: で始まるコメントが、工程の PR と実装の PR に付いている
  - 期待結果：isMergeApprovalNotice が真を返し、そのコメントは指摘として取り込まれない
- [TV-10] push の後のマージは今までどおり
  - 入力：直しのコミットを #N に push し、PR を更新して StepPullRequestPublished を記録した後に、人が #N をマージする
  - 期待結果：ReworkStoppedByMerge は記録されず、PR の確認が PullRequestMerged（edited: false）・StepApproved を記録し、知らせは書かれない
- [TV-11] 直しの間に閉じた PR は今までどおり
  - 入力：設計の直しの間に、#N がマージされずに閉じられる
  - 期待結果：ReworkStoppedByMerge と承認は記録されず、直しの後に新しいブランチ・PR が作られ、#N が superseded になる
- [TV-12] 前の工程への差し戻しでは、承認済みの PR から直しの PR を作る
  - 入力：設計の PR の指摘で要求要件に戻し、要求要件の PR はマージ済み（承認済み）と記録されている
  - 期待結果：要求要件の直しの後に -requirements-2 のブランチと新しい PR が作られ、ReworkStoppedByMerge は記録されない
- [TV-13] 修正を戻すと落ちる
  - 入力：reworkingStepPullRequest が常に undefined を返すようにし、publishStepPullRequest のマージの分岐を外して、観点1〜5・8 のテストを動かす
  - 期待結果：それらのテストが落ちる
- [TV-14] 仕様書・ユーザー文書に、工程の PR の直しの間のマージが書かれている
  - 入力：docs/spec/approval.md・tasks-and-steps.md・docs/user/tasks.md とその英語版の差分
  - 期待結果：要求要件・設計の直しの間（push の前）にマージされたら、承認として進み、直しを捨て、新しい PR を作らず、PR に1回知らせることが日英で書かれている。push の後と閉じたときは今までどおりであることも書かれ、「マージ済みなら新しい PR を作る」は承認済みのマージ（前の工程への差し戻し）に限られている
