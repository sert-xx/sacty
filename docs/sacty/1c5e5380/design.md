<!-- sacty task 1c5e5380-6165-4198-b337-d3bc57c38a56 の設計。sacty が作成しました。 -->

# 設計：自動の直しの間に人がマージした工程の PR を、承認として扱う

## スコープ

要求要件・設計の自動の直しが終わる前（push の前）に、人がその工程の開いた PR をマージしたら、sacty は直しを止めて結果を捨て、マージを承認として次の工程へ進める。
実装の PR の仕組み（PBI-276）を、工程の PR に広げる。

- 対象
  - 直しの間（実行待ち・実行中・待機・一時停止）に工程の PR がマージされたことの検知と、実行の停止・承認の記録
  - `publishStepPullRequest` が、マージ済みの PR から新しいブランチ・PR を作らないこと
  - 作成の経路で、直しを始めたときの承認待ちの PR（`reworkingStepPullRequest` の PR）を閉じられなかったときに、新しい PR を作らないこと（ほかの PR の作り直しは、今までどおり警告だけで進む）
  - 作業履歴の表示と、PR への1回だけの知らせ（実装の PR の作り直しを止めたときも、同じ知らせを書く）
  - 要求要件へ戻している間にマージされた設計の PR への、承認として扱わなかったことの1回だけの知らせ
  - 起動時の回復で、工程の直しの実行も停止を確かめるまで残すこと
  - 仕様書・ユーザー文書（日英。旧版への復帰の説明を含む）、ADR、テスト、作業履歴
- 対象外
  - 実装の PR の止め方・記録（PBI-276 のまま）
  - 後の工程から前の工程へ戻したときに、承認済み（マージを記録済み）の前の工程の PR から直しの PR を新しく作る振る舞い
  - 戻し先が前の工程のとき（設計の PR の指摘で要求要件に戻している間）に、開いたままの設計の PR がマージされた場合の承認。今までどおり要求要件の承認の後に設計の PR を作り直し、要求要件の承認の後に設計が動いても、この PR は承認の対象にしない（知らせだけを書く）
  - 実装の PR の指摘で前の工程へ戻している間に、実装の PR がマージされた場合の知らせ
  - 承認待ちで人が一時停止している間の、工程の PR のマージ（今までどおり再開の後の確認が承認する。新しい PR はできない）
  - 閉じた PR、「提案あり」の回を遅らせる仕組み、レビューの子の見守り

## 確認したいこと

### should

- 作成の経路で、直しを始めたときの承認待ちの PR を閉じる操作が失敗したら（読み直しても `open`）、どうするか
  - 推奨：新しい PR を作らず、今の PR の作成の失敗と同じく一時停止（`pr.failed`）にする。止まっている間に人がマージすれば、見守りが再開を待たずに承認として進める。マージされないまま再開すると、`publishStepPullRequest` が読み直しからやり直し、開いていれば閉じ直す。ほかの PR の作り直しは今までどおり警告だけで進める。
  - 理由：前の PR が開いたまま新しい PR を作ると、人が前の PR をマージしても見守られず、#497 と同じく承認待ちに戻る。
  - 懸念：GitHub の一時的な失敗でも、タスクの持ち主が再開を押すかマージするまで止まり、その手間が増える。

### 確認しないと決めたこと

- 受け入れ条件 5 の境目
  - PR の更新・作成の直前の読み直しで見つけたマージ（直しのコミットが PR の先頭に無い）は、新しい扱いにする。
  - 直しのコミットが PR の先頭になった後のマージは、今までどおり記録の後に `checkPullRequests` が承認する。
  - 人に聞かない理由：マージの時点の PR の先頭が直しのコミットかどうかで見分けられる。
- 承認する成果
  - 工程の `ReworkStoppedByMerge` の投影で、`outputs[step]` と設計のテスト観点を、承認待ちだった提出の版に戻す。人が直さずにマージしたときは、この版が承認済みの成果になる。
  - 人に聞かない理由：受け入れ条件 2「直しの結果は使わない」から決まる。直しの完了で `outputs[step]` は直しの成果に置き換わっている（`projection.ts` の `AgentRunCompleted`）。
- 知らせの件数
  - `ReworkStoppedByMerge` の `discardedRemarks` の件数にする。その工程の最後の回の指摘のうち、無効にしておらず、まだ提出していないものを数える。
  - 人に聞かない理由：作業履歴と PR の件数がそろい、PBI-276 の数え方とも同じになる。
- 人の直しの版
  - マージの時点の PR の先頭が、提出したコミットと違えば、今の承認と同じく `readMergedDocument` で人の版を承認済みにする。
  - 読めなければ何も記録せず、次の確認でやり直す。
  - 人に聞かない理由：受け入れ条件 1「今の『マージで承認』と同じ結果」から決まる。

## 既定で決めたこと

- 知らせには新しい目印を付けて1件だけ書き、sacty の知らせとして指摘の取り込みから外す。承認にした知らせは `<!-- sacty-merge-approval:<タスク ID>:<PR 番号> -->`、承認にしなかった知らせは `<!-- sacty-merge-not-approved:<タスク ID>:<PR 番号> -->`。書き済みの確認と取り込みの除外は、どちらも sacty のアカウント（`noticeAccounts`）の投稿に限る。
- 再レビューの返信の絞り込み（`service.ts` の `isReworkNotice` などを並べた所）では、ほかの sacty の知らせと同じく、目印だけで返信から外す（アカウントを見ない今の決まりに合わせる）。
- 作成の経路で push した新しいブランチ（`StepBranchPushed` で記録済み）は、マージを見つけても閉じられなくても消さずに残し、ほかの工程のブランチと同じく、タスクの終わりの片づけで消す。次にその工程のブランチを作るときは、回の名前が `stepBranches` にあり、記録したコミットが今回のコミットと違うときだけ次の回へ進む。同じコミットなら、同じ名前へ push し直す（PR の作成の再試行・一時停止からの再開で、ブランチを増やさない）。今回のコミットは、push せずに先に作ってから比べる（コミットの中身はブランチの名前に依らない）。push の拒否は、次の回へ進む合図にしない。
- 承認にしなかった知らせは、作業履歴（イベント）に記録しない。PR の目印で1回だけにする。

## 構成

| 場所 | 変更 |
| --- | --- |
| `packages/core/src/projection.ts` | `reworkingStepPullRequest(task)` を足す。次の条件をすべて満たすときに、その工程の最後の PR を返す：状態が実行待ち・実行中・待機・一時停止（`needs_decision` と、再開の先が承認待ちのものを除く。直しの PR を閉じられずに止めた `pr.failed` の一時停止は含む）、実行中の工程が要求要件か設計、その PR がローカルで `open` かつ `superseded` でない、その PR が直しを始めたときの承認待ちの PR（投影に `reworkOf` として持ち、`StepApproved` で消す）。提出ごとに `outputs[step]` とテスト観点の写しを投影に持つ。`ReworkStoppedByMerge` の投影は、`step` があればその工程の承認待ちに戻し（ゲートはその PR の提出）、成果を写しに戻し、捨てた指摘を無効にする |
| 〃（新しい状態の導出） | `reworkOf` は、工程の PR の承認待ちから同じ工程へ戻す `ChangesRequested` で、ゲートの PR 番号を入れる。前の工程へ戻す `ChangesRequested` では入れない。写しは `StepSubmitted` で取る。起動時に作業履歴から投影し直すので、入れ替えの前から直しの途中のタスクにも入る。導けない履歴（この 2 つのイベントが無いもの）では `undefined` のままで、今までどおり見守らない |
| 〃（前の工程へ戻したとき） | 設計の PR の承認待ちから要求要件へ戻す `ChangesRequested` で、ゲートの PR 番号を `sentBackFrom` に入れ、設計の次の `StepPullRequestPublished` で消す |
| 〃（ブランチの回） | `StepBranchPushed` の `commit` を、ブランチの名前ごとに投影に持つ（回の決め方で、記録したコミットと比べるため） |
| `packages/core/src/events.ts` | `ReworkStoppedByMerge` に任意の `step` を足す |
| `apps/daemon/src/repository.ts` | `RepositoryWorkspace` の `commitFiles` に、push しない指定を足す。作ったコミットをブランチへ push する操作（強制しない）を `RepositoryWorkspace` に足す |
| `apps/daemon/src/service.ts` | `checkReworkMerges`・`stopReworkForMerge`・`endReworkByMerge` を、`reworkingStepPullRequest` の PR にも当てる。`publishStepPullRequest` に、マージを見つけたときの分岐と、直しの PR を閉じられなかったときの分岐を足し、新しいブランチの回の決め方を変える。起動時の回復で実行を残す条件に、`reworkingStepPullRequest(task)` を足す。`checkPullRequests` で `sentBackFrom` の PR も読み、承認にしなかった知らせを送る |
| `apps/daemon/src/merge-approval-notice.ts`（新規）・`github.ts`・`service.ts` | 2 つの知らせの本文と目印、`isMergeApprovalNotice`（両方の目印を判定する）を足す。`isReworkNotice` を使っている2か所に、この判定も足す。`github.ts` の取り込みの除外では、目印と sacty のアカウントの両方で判定する。`service.ts` の返信の絞り込みでは、目印だけで判定する |
| `apps/web/src/lib/labels.ts`・`apps/web/src/i18n/messages/labels.ts` | `step` があれば「PR #N がマージされたため、<工程>の直しを止めた」と出す（日英） |

## 処理の流れ

1. `checkPullRequests` の最初の見守り（60 秒ごと）で、`reworkingStepPullRequest` の PR が GitHub でマージ済みなら、次の順に処理する。
   - 必要なら人の版を読む。
   - 実行を止めて、終わるのを待つ（`mergeStopping`）。
   - 1回の追記で `ReworkStoppedByMerge`（`step` 付き）・`PullRequestMerged`・`StepApproved` を記録する。
   - `publishStepPullRequest` の実行中のタスクは止めず、記録は 3 の `publishStepPullRequest` に任せる。
2. `publishStepPullRequest` で、前の PR が `reworkingStepPullRequest` の PR で、GitHub で `merged` なら、新しいブランチ・PR を作らず、1 と同じ記録をする。
   - それ以外（前の工程への差し戻しの後の PR など）は、今までどおり新しいブランチ・PR を作る。
   - 新しいブランチを作るときは、push せずにコミットを作り、`stepBranches` の記録と比べて回の名前を決めてから push する（既定で決めたこと）。同じ PR を更新するときは、今までどおりその PR のブランチへ push する。
3. push の後、前の PR が `reworkingStepPullRequest` の PR なら、`upsert` の直前の 1 か所で前の PR の状態を読み直す。
   - 作成の経路では、前の PR を閉じる操作（戻り値は無い）の後に読み直す。閉じた後はマージできないので、読み直しから作成までの間にマージは起きない。
   - 作成の経路で、閉じる操作が失敗し、読み直しても `open` なら、新しい PR を作らず、`pr.failed` で一時停止にする（推奨の答え。確認したいことの should）。この一時停止は直しの PR を閉じるときだけで、`reworkingStepPullRequest` でない PR の作り直しは、今までどおり警告だけで新しい PR を作る。この一時停止の間も 1 の見守りは続け、マージされたら再開を待たずに承認にする。
   - マージ済みで、先頭が直しのコミットでなければ、PR の更新も作成もせず、1 と同じ記録をする。
   - 先頭が直しのコミットなら、今までどおり記録して承認待ちにする。
4. 記録の後に知らせを送り、送信の結果は待たない。
   - GitHub のアカウントが無いプロジェクトと、セキュリティのタスクには書かない。
   - 本文には、マージを承認として扱ったこと、自動の直しを取り込まなかったこと、捨てた指摘があればその件数を書く。
5. `sentBackFrom` の PR が GitHub でマージ済みと分かったら、何も記録せず、その PR に承認にしなかった知らせを送る（4 と同じ送り方・書かない先）。
   - 見つける所は、`checkPullRequests` の見守りと、設計の `publishStepPullRequest` で前の PR がマージ済みと分かった時点（どちらが先でも、目印で1件にする）。
   - 本文：要求要件の直しの最中だったため、このマージは設計の承認として扱っていないこと。要求要件の承認の後に、設計の PR を作り直すこと。

## エラー時の振る舞い

- 止めたコンテナが無くなったことを確かめられなければ、PBI-276 と同じく一時停止にして、人の確認を待つ。
- 知らせを書けなくても、タスクは変えない。目印の付いたコメントがすでにあれば書かない。
- 止めた後・記録の前にデーモンが再起動したら、回復が実行を残して一時停止にし、次の見守りが停止を確かめてから 1 の記録をする。
- 入れ替えの時点で、マージ済みの PR の上で直しが走っているタスクも、入れ替えの後の最初の見守りが 1 として扱う。
- 直しの PR を閉じられずに一時停止したタスクは、止まっている間にその PR がマージされると、見守りが再開を待たずに 1 の記録をする。マージされないまま再開すると、`publishStepPullRequest` をやり直す。push 済みのブランチは、同じコミットなら同じ名前へ push し直す。

## 影響範囲

- `step` 付きの `ReworkStoppedByMerge` を記録した後は、前の版のデーモンが作業履歴を投影できず、起動できない（履歴は追記のみで手では直せない）。作業履歴・ADR・ユーザー文書に書く。
- ADR を足す
  - 決めること：工程の PR の直しの間のマージを承認にし、直しを捨てる。要求要件へ戻している間の設計の PR のマージは承認にせず、PR に知らせる。保存するイベントの形を変え、前の版に戻せなくなる。
  - 理由：今の「人のマージで承認」の決まりにそろえる。人がマージ前に直した箇所が、自動の直しの版で黙って戻るのを防ぐ。
- 仕様書
  - `docs/spec/approval.md`（日英）の「要求要件・設計の PR を作り直すか」にある「PR がマージ済み」を、承認済みのマージに限る。直しの PR を閉じられなかったら新しい PR を作らず一時停止にすること（ほかの作り直しは警告で進むこと。止まっている間のマージは再開を待たずに承認になること）と、ブランチの回の決め方も書く。
  - 同じファイルの「実装の作り直しの間のマージ」の隣に、工程の PR の節を足す。要求要件へ戻している間の設計の PR のマージで知らせを書くことも、この節に書く。
  - 同じファイルの「PR の確認」の、確認の初めに見る「実装を作り直している間」に、工程の直しの間を足す。
  - 同じファイルの「承認待ちでの一時停止」の「要求要件・設計の PR：止めている間は見守らない」は、承認待ちの一時停止だけの話だと書き分ける。直しの間の一時停止は見守ることも書く。
  - `docs/spec/tasks-and-steps.md`（日英）の同じ記述もそろえる。
- ユーザー文書
  - `docs/user/tasks.md`（日英）の「直してからマージしたとき・作り直しの間にマージしたとき」に、工程の PR のことと、要求要件へ戻している間の設計の PR のマージ（承認にならず、PR に知らせが出て、設計の PR が作り直される）を足す。
  - 同じ節に、直しの PR を閉じられなかったときは一時停止すること、再開すればやり直すこと、止まっている間に人がマージすると再開を待たずに承認として進むことを 1〜2 文で足す（`pr.failed` の一時停止を説明した所は、今のユーザー文書に無い）。
  - `docs/user/getting-started.md`（日英）の「更新前のバックアップと旧版への復帰」の、旧版で読み込めない新しい種類の記録の例に、マージで止めた要求要件・設計の直しの記録を足す。
  - 紹介のページ（`docs/user/introduction.md`、日英）と図（`intro.mjs`、`tasks.mjs` の `approval-branches`）は、「マージで承認」と承認のブランチの形が変わらないので直さない。差分で合っていることを確かめる。
- 画面の文言：作業履歴の文言は `docs/spec/ui-wording.md` の規則に従い、`apps/web/src/i18n/wording-policy.test.ts` を通す。
- テスト
  - `apps/daemon/src/daemon-step-pull-requests.test.ts` で、次を確かめる：処理の流れの 1〜3・5、知らせ、push の後のマージ、閉じた PR、前の PR を閉じられなかったとき、ブランチの回、前の工程への差し戻しで新しい PR を作ること。
  - 実装の PR の知らせは `apps/daemon/src/daemon-implement.test.ts` で確かめる。
  - get_task の `pullRequests` の状態は `apps/daemon/src/task-mcp.test.ts` で確かめる。
  - コミットを push せずに作ることと、作ったコミットの push は、`repository.ts` のテストで確かめる。
  - ほかに `projection.test.ts`・`labels.test.ts`・`imitated-notices.test.ts`。
- 作業履歴 `docs/worklog/20261121-pbi-462-<スラッグ>.md` を足す。

## テスト観点

- [TV-1] 実行中の設計の直しの間のマージを、承認として進める
  - 入力：設計の PR #N の「提案あり」を取り込み、設計の直しを実行している間に、GitHub で #N がマージ済みになり、PR の確認が走る
  - 期待結果：実行が止まり、1回の追記で ReworkStoppedByMerge（step: design、number: N）・PullRequestMerged（number: N）・StepApproved（step: design）が記録され、タスクは次の工程へ進み、直しの結果は PR に push されない
- [TV-2] 実行待ち・一時停止の直しの間のマージも承認にする
  - 入力：要求要件の直しが実行待ちのタスクと、設計の直しの間に手動で一時停止したタスクで、それぞれの開いた工程の PR がマージされ、PR の確認が走る
  - 期待結果：どちらも ReworkStoppedByMerge（was が queued・paused）・PullRequestMerged・StepApproved が記録され、新しいブランチ・PR は作られない
- [TV-3] PR を作る時点でマージ済みなら、新しいブランチ・PR を作らず、提出の版を承認する
  - 入力：設計の直しの実行が終わり（直しの成果とテスト観点が提出の版と違う）、publishStepPullRequest が前の設計の PR #N（ローカルで open）を読むと、人が直さずに GitHub で merged にしている
  - 期待結果：<タスクブランチ>-design-2 のブランチの push・PR の作成・StepPullRequestPublished の記録が無く、#N のマージが承認として記録され、承認済みの設計の成果とテスト観点は #N で提出した版と一致し、直しの成果ではない
- [TV-4] PR の更新の直前に、直しのコミットが先頭に無いマージを見つける
  - 入力：publishStepPullRequest の最初の読み込みでは #N が open で、直しのコミットを push した後、PR の更新の直前に読み直すと、人が直さずに merged にしていて先頭が提出したコミットのまま
  - 期待結果：PR の更新（upsert）と StepPullRequestPublished の記録が無く、ReworkStoppedByMerge（step: design）・PullRequestMerged・StepApproved が記録され、承認済みの成果は提出した版になる
- [TV-5] 新しい PR を作る経路では、前の PR を閉じた後の読み直しでマージを見つける
  - 入力：タスクブランチが進んでいて新しい PR を作る経路で、最初の読み込みでは #N が open、新しいブランチの push の後・前の PR を閉じる操作の前に人が #N をマージし、閉じる操作はエラーを返さない
  - 期待結果：閉じる操作の後の読み直しで merged と分かり、新しい PR は作られず、StepPullRequestPublished は記録されず、ReworkStoppedByMerge（step: design）・PullRequestMerged・StepApproved が1組記録され、PR #N に知らせが1件書かれ、push した新しいブランチは stepBranches に残る
- [TV-6] 直しの PR を閉じられなかったら、新しい PR を作らず一時停止にし、止まっている間のマージは再開を待たずに承認し、ほかの作り直しは今までどおり進む
  - 入力：新しい PR を作る経路で、直しを始めたときの承認待ちの PR #N を閉じる操作がエラーになり、その後の読み直しで #N が open のまま。その後、再開しないまま人が #N をマージし、PR の確認が走る。別に、同じく一時停止した後に #N をマージせずに再開し、閉じる操作が成功する。さらに別に、前の工程への差し戻しの後の設計の PR（reworkingStepPullRequest でない PR）を作り直す経路で、閉じる操作がエラーになる
  - 期待結果：#N では、1回目は新しい PR が作られず、StepPullRequestPublished は記録されず、TaskPaused（reason: error）が記録され、マージの後の PR の確認が、再開の操作なしに ReworkStoppedByMerge（step: design、was: paused）・PullRequestMerged・StepApproved を1組記録し、新しいブランチ・PR は作られない。マージせずに再開した場合は、publishStepPullRequest がやり直して新しい PR を作り StepPullRequestPublished を記録する。差し戻しの後の経路では一時停止せず、警告だけで新しい PR が作られ StepPullRequestPublished が記録される
- [TV-7] 記録済みのブランチの名前は、push の前に作ったコミットが記録と違うときだけ飛ばす
  - 入力：(a) 観点5で <タスクブランチ>-design-2 を push したまま承認になった後、実装の PR の指摘で設計に戻し、設計の publishStepPullRequest が新しい PR を作る。(b) <タスクブランチ>-design-2 を push して StepBranchPushed を記録した後に PR の作成が失敗して一時停止し、成果を変えずに再開する
  - 期待結果：(a) は push の前に作ったコミットが記録と違うので、新しいブランチが <タスクブランチ>-design-3 になり、-design-2 への push は試みられず、push が失敗せず、PR が作られて StepPullRequestPublished が記録される。(b) は同じ <タスクブランチ>-design-2 へ同じコミットを push し直して PR が作られ、stepBranches の数は増えない
- [TV-8] publish の最中のマージは、publish の側が1回だけ記録する
  - 入力：publishStepPullRequest が本文のまとめを実行している間に #N がマージされ、その間に PR の確認が走る
  - 期待結果：PR の確認は実行を止めず記録もせず、publish の読み直しが ReworkStoppedByMerge・PullRequestMerged・StepApproved を1組だけ記録し、PR に知らせが1件書かれる
- [TV-9] 人が直してからマージしたら、人の版を承認済みの成果にする
  - 入力：直しの間に、人が #N に直接コミットしてからマージし、マージのコミットの設計のファイルが sacty の提出した版と違う
  - 期待結果：PullRequestMerged が edited: true と、マージのコミットの document を持ち、承認済みの設計は人の版になる。設計のファイルを読めないときは何も記録されず、次の確認で記録される
- [TV-10] get_task と画面で、マージした PR が open のまま残らない
  - 入力：観点1の承認の後に get_task を呼び、タスクの画面を開く
  - 期待結果：pullRequests の #N の state が merged になり、画面も #N をマージ済みとして出す
- [TV-11] 作業履歴に、直しを捨てたことを工程の名前で出す
  - 入力：step: design の ReworkStoppedByMerge を、作業履歴の表示の文言にする（日英）
  - 期待結果：「PR #N がマージされたため、設計の直しを止めた」と、それに対応する英語の文になる。step の無い記録は、今までの「実装の作り直し」の文言のままになる
- [TV-12] 既存の履歴を、新しい版で投影し直す
  - 入力：(a) step の無い ReworkStoppedByMerge・PullRequestMerged・StepApproved を含む実装の作り直しの履歴と、(b) 設計の PR #N の承認待ちから同じ工程へ戻す ChangesRequested の後、直しの AgentRunCompleted まで進んだ（承認の無い）履歴を、新しい版で投影し直す
  - 期待結果：(a) は実装の承認として投影され、タスクの状態・承認済みの実装・指摘の無効化が変更の前の版の結果と一致する。(b) は reworkingStepPullRequest が #N を返し、#N の写しが StepSubmitted の時点の設計の成果とテスト観点と一致する
- [TV-13] PR に1回だけ知らせる
  - 入力：観点1の承認の後に PR の確認が2回走り、捨てた指摘が3件ある。別に、実装の PR の作り直しをマージで止めたタスク、セキュリティのタスク、GitHub のアカウントの無いプロジェクトでも同じことが起きる
  - 期待結果：#N と実装の PR に、目印 <!-- sacty-merge-approval:<タスク ID>:<PR 番号> --> の付いたコメントがそれぞれ1件だけあり、マージを承認として扱ったこと・自動の直しを取り込まなかったこと・残っていた提案の件数（#N では 3 件）が書かれている。セキュリティのタスクとアカウントの無いプロジェクトには書かれない
- [TV-14] 知らせの目印の判定を、取り込みと返信の絞り込みで分ける
  - 入力：目印 <!-- sacty-merge-approval: と <!-- sacty-merge-not-approved: で始まるコメントが、sacty のアカウントと、sacty のアカウントでない人（PR の作者を含む）から、工程の PR と実装の PR に付いている
  - 期待結果：sacty のアカウントのコメントは指摘として取り込まれない。人のコメントは指摘として取り込まれ、書き済みとも見なされず、sacty の知らせが1件書かれる。再レビューの返信の絞り込みでは、作者のコメントも含めて目印の付いたコメントは返信に数えられない
- [TV-15] 停止を確かめる前に再起動しても、コンテナを残したまま承認しない
  - 入力：観点1で実行を止めた後、ReworkStoppedByMerge を記録する前にデーモンを再起動する
  - 期待結果：起動時の回復が unstoppedRuns 付きの TaskPaused を記録し、停止を確かめた後の PR の確認で ReworkStoppedByMerge（was: paused）・PullRequestMerged・StepApproved が記録される
- [TV-16] push の後のマージは今までどおり
  - 入力：直しのコミットを #N に push し、PR を更新して StepPullRequestPublished を記録した後に、人が #N をマージする
  - 期待結果：ReworkStoppedByMerge は記録されず、PR の確認が PullRequestMerged（edited: false）・StepApproved を記録し、知らせは書かれない
- [TV-17] 直しの間に閉じた PR は今までどおり
  - 入力：設計の直しの間に、#N がマージされずに閉じられる
  - 期待結果：ReworkStoppedByMerge と承認は記録されず、直しの後に新しいブランチ・PR が作られ、#N が superseded になる
- [TV-18] 前の工程への差し戻しでは、マージを承認にせず直しの PR を作り、PR に1回だけ知らせる
  - 入力：設計の PR #N の指摘で要求要件に戻し、要求要件の PR はマージ済み（承認済み）と記録されている。要求要件の直しの間に人が #N をマージし、PR の確認が2回走り、その後に要求要件が承認されて設計の工程が動き、設計の publishStepPullRequest まで進む。別に、同じことがセキュリティのタスクと GitHub のアカウントの無いプロジェクトで起きる
  - 期待結果：要求要件の直しの後に -requirements-2 のブランチと新しい PR が作られる。PR の確認と設計の publishStepPullRequest のどちらでも #N のマージで ReworkStoppedByMerge と設計の StepApproved は記録されず、設計の新しいブランチと新しい PR が作られる。#N には目印 <!-- sacty-merge-not-approved:<タスク ID>:<N> --> の付いたコメントが1件だけあり、要求要件の直しの最中だったため設計の承認として扱っていないことと、要求要件の承認の後に設計の PR を作り直すことが書かれている。セキュリティのタスクとアカウントの無いプロジェクトには書かれない
- [TV-19] 修正を戻すと落ちる
  - 入力：reworkingStepPullRequest が常に undefined を返すようにし、publishStepPullRequest のマージの分岐と、直しの PR を閉じられなかったときの分岐と、ブランチの回で記録済みのコミットと比べる処理と、ReworkStoppedByMerge の投影の成果の戻しと、sentBackFrom の PR への知らせを外して、観点1〜9・13・18 のテストを動かす
  - 期待結果：それらのテストが落ちる
- [TV-20] 仕様書・ユーザー文書・ADR に、工程の PR の直しの間のマージが書かれている
  - 入力：docs/spec/approval.md・tasks-and-steps.md・docs/user/tasks.md・docs/user/getting-started.md とその英語版、足した ADR の差分
  - 期待結果：要求要件・設計の直しの間（直しのコミットが PR の先頭になる前）にマージされたら、承認として進み、直しを捨て、新しい PR を作らず、PR に1回知らせることが日英で書かれている。push の後と閉じたときは今までどおりであること、承認待ちでの一時停止の間は見守らないこと、要求要件へ戻している間の設計の PR のマージは承認にならず PR に知らせが出て設計の PR が作り直されること、直しの PR を閉じられなければ新しい PR を作らず一時停止にすること（ほかの作り直しは警告で進むこと）も書かれ、「マージ済みなら新しい PR を作る」は承認済みのマージ（前の工程への差し戻し）に限られている。docs/user/tasks.md（日英）には、直しの PR を閉じられずに一時停止したら再開すればやり直すことと、止まっている間に人がマージすると再開を待たずに承認として進むことが書かれている。getting-started.md（日英）の旧版への復帰の説明に、マージで止めた要求要件・設計の直しの記録は旧版で読み込めないことが書かれている。ADR には、この決めと、理由（今の「人のマージで承認」の決まりにそろえる・人の直しが黙って戻るのを防ぐ）と、前の版のデーモンに戻せなくなることが書かれている
