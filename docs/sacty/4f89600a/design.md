<!-- sacty task 4f89600a-c108-4031-98ca-70a5a146ea19 の設計。sacty が作成しました。 -->

# 設計：レビューの往復の待ちを削る

## スコープ

sacty のレビューの投稿をすぐ親に取り込み、親の提出の時点で子の再レビューを始め、sacty が作ったレビューの子タスクのイメージを親から決める。

- 対象
  - `apps/daemon/src/service.ts`：静かな時間の起点、投稿の後の即時の取り込み、提出の後の即時の再レビュー、2 つの経路の直列化、子タスクのイメージ
  - `packages/core`（`StepsChosen` の `imageSource` に `parent` を足す）と、画面の表示の文言（日英）
  - 仕様書・利用者向け文書（日英）・ADR・作業履歴
- 対象外
  - 再レビューを始めた後の子の動き（返信が済むまで実行待ちに出さない所・レビューの中身）
  - `retargetPullRequest` の後の再レビュー（付け替えの後は 60 秒ごとの確認に任せる）

## 確認したいこと

- must：なし
- should
  1. 子のイメージにする「親のイメージ」は、子が工程を選ぶ時点の親のタスクのイメージ（`stepImageOf(親, reviewOf.step)`。人が `TaskImageChanged` で変えた後なら変えた後のもの）でよいか。推奨：はい。親の次の直しも同じイメージで動き、子は再レビューでもイメージを選び直さないため。
     懸念：PR を作った実行のイメージ（`AgentRunStarted` の `image`）を求めていた場合、PR を作った後・子の初回の実行の前にイメージを変えたタスクだけ、PR を作ったときと違う環境でレビューされます。
  2. 親のイメージを使った `StepsChosen` の `imageSource` に、新しい値 `parent` を足してよいか。推奨：はい。今の 4 つの値はどれも当てはまらず、画面に「親のタスクのイメージ」と出せるため。
     懸念：足さずに `project` などを流用すると、子の作業履歴の「イメージを決めた元」が事実と違う表示になり、利用者が設定を探し違えます。

確認しないと決めたこと
- ADR を足す：`docs/README.md` が方針を変えたら ADR を足すと決めており、子のイメージをオーケストレーターに選ばせる方針（PR #180）を変えるため。

## 既定で決めたこと

- 即時の経路は投稿・提出の処理から待たずに起こす（`void`）。失敗は `console.warn` に出すだけで、子・親のタスクには何も記録しない。
- 指摘なしを待つ実装の PR で、提出の直後に GitHub から読んだ先頭が提出したコミットと違えば、即時の経路は何もせず 60 秒ごとの確認に任せる（GitHub の反映の遅れで前の先頭を対象にしないため）。
- 子の `StepsChosen` の理由の文は、今の `review.reviewOnly` のままにする（決めた元は `imageSource` で示す）。

## 処理の流れ

- 静かな時間（`importFeedback`）
  - `feedbackSeenAt` はすべての項目について今までどおり記録し、起点の `newest` は `source !== "sacty_review"` の項目だけで数える。人の指摘が無ければ待たない。
  - 待つ・取り込むの判断は回全体で 1 つ（人の指摘で待つ回は sacty のレビューも待つ）。
- 即時の取り込み
  - `postReview` が `PullRequestReviewPosted` を記録した後、`child.reviewOf.taskId` の親について `importFeedbackSoon(親の ID)` を起こす。
  - 親が承認待ち・PR が開いている（台帳）・子の PR と親の `gatePullRequest` の番号が同じ・中止を求められていない、のときだけ、トークンを取って `importFeedback` を呼ぶ。
- 即時の再レビュー
  - `reconcileReviewTasks` の親ごとの処理を `reconcileReviewTask(親の ID, 読んだ先頭?)` に切り出す。60 秒ごとの確認はこれを親ごとに呼ぶ。
  - `publish`・`publishStepPullRequest` は `ensureReviewTask` の後に、これを起こす。
  - 切り出した処理は、await（`pullRequestHead`・`redraftAwaiting`・`markReady`）の後と記録の直前に、親と子を `this.tasks` から読み直して判断する。
- 直列化：既存の `serialized` で、取り込みは `feedback-import:<親の ID>`、再レビューは `review-reconcile:<親の ID>` のキーで順に流す。後に流れた方は、先の方が記録した後の台帳で判断する。
  - 取り込みは、記録の直前に `latest.importedFeedback` に含まれる key を `batch` から除く（空なら記録しない）。
- 子のイメージ（`chooseReviewSteps`）
  - 順は、`pinnedImage` → `via === "sacty"` なら親のイメージ（`images` にある名前のときだけ）→ 今までの決め方（候補が無ければ既定、あればオーケストレーター）。
  - 親のイメージを使うときは `reviewOnlySteps("sacty")` に `image`・`imageSource: "parent"` を付け、記録は sacty（費用 0）。

## エラー時の振る舞い

- 即時の経路で、トークン・GitHub の読み出し・記録のどれかが失敗したら、警告を出して終える。取りこぼした分は 60 秒ごとの確認が拾う。
- GitHub がまだ投稿を返さなければ、`fresh` が空で何も記録しない。

## 影響範囲

- 文書
  - `docs/spec/approval.md`（日英）：PR の指摘の取り込み・PR のレビューの子タスク・PR の確認
  - `docs/spec/tasks-and-steps.md`（日英）：工程の選択の PR のレビューだけのタスクのイメージの決め方、PR のレビューだけのタスク
  - `docs/user/intake.md`（日英）：sacty が作った PR のレビュー
  - `docs/adr/`（新しい ADR）、`docs/worklog/`（`YYYYMMDD-pbi-425-<slug>.md`）
- 画面：`apps/web/src/i18n/messages/labels.ts`（日英）の `stepsImages` に、`parent` の表示（「親のタスクのイメージ」）を足す。

## テスト観点

- [TV-1] sacty のレビューだけなら待たずに取り込む
  - 入力：親が承認待ちで、まだ取り込んでいないフィードバックが、時計で 10 秒前に投稿した source が sacty_review の項目だけ
  - 期待結果：その回の checkPullRequests で PullRequestReviewImported（actor sacty）が 1 件記録される。
- [TV-2] 人の指摘が混ざると sacty のレビューも一緒に待つ
  - 入力：取り込んでいないものが、30 秒前の人のコメントと 10 秒前の sacty のレビュー
  - 期待結果：時計を人のコメントから 2 分たつ手前まで進めた確認では何も記録されず、2 分を過ぎた確認で両方の key を含む PullRequestReviewImported が 1 件だけ記録される。
- [TV-3] 古い人の指摘と新しい sacty のレビューは待たずに取り込む
  - 入力：取り込んでいないものが、3 分前の人のコメントと 10 秒前の sacty のレビュー
  - 期待結果：その回の確認で、両方の key を含む PullRequestReviewImported（actor person）が 1 件記録される。
- [TV-4] 投稿の直後に親の取り込みが始まる
  - 入力：レビューの子タスクが PullRequestReviewPosted を記録し、偽の GitHub の feedback がその投稿を返す。checkPullRequests は呼ばない
  - 期待結果：親に PullRequestReviewImported が記録されるのを待つと記録され、その項目の source が sacty_review である。
- [TV-5] 投稿の直後に取り込めなくても 60 秒ごとの確認が取り込む
  - 入力：子の投稿の直後の feedback の読み出しが、1 回目は投稿を返さない（または例外を投げる）
  - 期待結果：子の PullRequestReviewPosted は残って子は止まらず、親にも何も記録されず、その後の checkPullRequests で PullRequestReviewImported が 1 件記録される。
- [TV-6] 即時の取り込みでも古い先頭へのレビューを捨てる
  - 入力：子が投稿したレビューの先頭が、PR の今の先頭と違う
  - 期待結果：即時の取り込みで PullRequestReviewDiscarded（stale_head）が記録され、PullRequestReviewImported は記録されない。
- [TV-7] 親が取り込めない状態なら即時の取り込みは記録しない
  - 入力：子の投稿の時点で、親が pendingReview を持つ（または承認待ちでない）
  - 期待結果：親に PullRequestReviewImported が記録されない。
- [TV-8] 取り込んだ PR のレビューのタスクの見守りは 2 分待つ
  - 入力：source.review が label のレビューのタスクが PR を見守っていて、30 秒前に PR へ push があった
  - 期待結果：2 分たつ前の確認では見守りの再レビューが始まらず、2 分を過ぎた確認で始まる（今と同じ）。
- [TV-9] 実装の PR の直しの提出で再レビューが始まる
  - 入力：子がレビューを投稿して終わった後、親が実装の直しを publish して承認待ちに戻る。checkPullRequests は呼ばない
  - 期待結果：子に ReviewRestarted（reason updated、commit は提出したコミット）が記録されるのを待つと記録される。
- [TV-10] 要求要件・設計の PR の直しの提出で再レビューが始まる
  - 入力：設計の PR の子がレビューを投稿して終わった後、親が設計の直しを publishStepPullRequest で提出する
  - 期待結果：子に ReviewRestarted（reason updated）が記録される。
- [TV-11] 提出の時点で動かしてはいけない親と子は動かさない
  - 入力：親の一時停止・中止を求めている、子の一時停止を求めている、子が実行中、のいずれかで親が直しを提出する
  - 期待結果：どの場合も子に ReviewRestarted が記録されない。
- [TV-12] 指摘なしを待つ実装の PR は GitHub の今の先頭を対象にする
  - 入力：awaitingReview の実装の PR で、提出の直後に偽の GitHub が返す先頭が、提出したコミットの場合と違うコミットの場合
  - 期待結果：同じ場合は ReviewRestarted の commit がその先頭になり、違う場合は即時の経路では記録されず、その後の checkPullRequests で記録される。
- [TV-13] すべて断った提出では判定し直しが 1 回だけ起きる
  - 入力：awaitingReview の実装の PR で、親がその先頭の指摘をすべて断り、返信が済んだ状態で提出し、続けて checkPullRequests を呼ぶ
  - 期待結果：子に ReviewRestarted（reason declined）が 1 件だけ記録される。
- [TV-14] 提出の時点で始められなくても 60 秒ごとの確認が始める
  - 入力：awaitingReview の実装の PR で、提出の直後の先頭の読み出しが例外を投げる
  - 期待結果：提出は成功して親が承認待ちになり、子には何も記録されず、その後の checkPullRequests で ReviewRestarted（updated）が記録される。
- [TV-15] 取り込みの 2 つの経路が重なっても二重に取り込まない
  - 入力：feedback の応答を遅らせ、checkPullRequests の取り込みと投稿の後の即時の取り込みを重ねる。先に始める方を入れ替えて 2 回試す
  - 期待結果：どちらの順でも、同じ key を含む PullRequestReviewImported は 1 件だけである。
- [TV-16] 再レビューの 2 つの経路が重なっても二重に記録・作成しない
  - 入力：pullRequestHead の応答を遅らせ、提出の後の即時の再レビューと checkPullRequests の reconcileReviewTasks を重ねる。先に始める方を入れ替えて 2 回試す
  - 期待結果：どちらの順でも、同じ先頭の ReviewRestarted は 1 件だけで、その PR の親の ReviewTaskCreated と子の TaskCreated も 1 件だけである。
- [TV-17] sacty の子は親のイメージを使い、オーケストレーターを実行しない
  - 入力：images に候補があり、親のタスクのイメージが候補の名前で、via sacty の子が工程を選ぶ
  - 期待結果：オーケストレーターは実行されず、子の StepsChosen の image は親のイメージ、imageSource は parent、actor は sacty である。
- [TV-18] 親のイメージを決められなければ今までの決め方に戻る
  - 入力：親にイメージの記録が無い場合と、親のイメージの名前が images から消えた場合
  - 期待結果：どちらも、オーケストレーターが選んだイメージで StepsChosen（imageSource orchestrator）が記録され、image.unknown では止まらない。
- [TV-19] プロジェクトの対象・再実行の指定は親のイメージより優先する
  - 入力：親のイメージと違う名前を、プロジェクトの対象（または子の再実行）で指定している
  - 期待結果：子の StepsChosen の image はその指定の名前で、imageSource は project（または rerun）である。
- [TV-20] 取り込んだ PR のレビューのタスクのイメージの決め方は変わらない
  - 入力：images に候補があり、via requested（または label）のレビューのタスクが工程を選ぶ
  - 期待結果：オーケストレーターが実行され、StepsChosen の imageSource は orchestrator である。
- [TV-21] imageSource の parent を画面に表示する
  - 入力：imageSource が parent の StepsChosen を作業履歴の文言に変える（日英）
  - 期待結果：日本語は「親のタスクのイメージ」、英語は同じ意味の文言が、イメージの名前の後ろに出る。
- [TV-22] 仕様書に新しい取り込みと再レビューの決まりが書かれている
  - 入力：docs/spec/approval.md と approval.en.md の、PR の指摘の取り込み・PR のレビューの子タスク・PR の確認の差分
  - 期待結果：静かな時間の起点が人の指摘だけであること、投稿の直後の取り込み、提出の時点の再レビュー、失敗したら 60 秒ごとの確認が拾うこと、2 つの経路を直列にすることが、日英の両方に書かれている。
- [TV-23] 仕様書に子タスクのイメージの決め方が書かれている
  - 入力：docs/spec/tasks-and-steps.md と tasks-and-steps.en.md の、工程の選択と PR のレビューだけのタスクの差分
  - 期待結果：via sacty の子は親のイメージ（imageSource parent）を使うこと、優先の順、決められないときの戻り方が、日英の両方に書かれている。
- [TV-24] 利用者向け文書と ADR・作業履歴が書かれている
  - 入力：docs/user/intake.md と intake.en.md の、sacty が作った PR のレビューの節、docs/adr と docs/worklog に足したファイル
  - 期待結果：利用者向け文書に、投稿・提出の直後に取り込み・再レビューが進むことと、子が元のタスクのイメージでレビューすることが、です・ます調で経緯の言い回しなしに書かれ、ADR に子のイメージの方針の変更、作業履歴に PBI-425 の作業が書かれている。
- [TV-25] フォーマッター・リンター・全テストが通る
  - 入力：変更後のリポジトリで npm run lint、npm run typecheck、npx vitest run --no-file-parallelism を実行する
  - 期待結果：どれも終了コード 0 で終わる。
