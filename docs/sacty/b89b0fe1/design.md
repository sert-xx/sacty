<!-- sacty task b89b0fe1-ed14-4f2d-a476-9acb454c445d の設計。sacty が作成しました。 -->

# PBI-489 設計：PR のレビューの子タスクで、親の実装の工程のサービスを起動する

## スコープ

sacty が作った実装の PR のレビューの子タスクで、親の実装の工程と同じサービス（共用の compose を含む）を、レビューの実行の1回ごとに起動する。
起動・停止・後片付け・安全の検査は今の工程の経路をそのまま使い、起動に失敗したらサービス無しでレビューを続ける。

- 対象
  - `service.ts` の `serviceSpec`（子の `review` のときに親の `implement` の指定を返す）、起動の失敗の扱い
  - `prompts.ts` の起動の失敗を伝える指示の1行
  - 仕様書（`services.md`・`tasks-and-steps.md`・`approval.md`、日英）、利用者向けの文書（`docs/user/compose.md`、日英）、ADR・作業履歴、テスト
- 対象外
  - スキル `docker-services` の本文（PBI-486）。起動の失敗のときも、今の「サービスは起動していません」の版を置く
  - 要求要件・設計の PR のレビューの子タスク、PR の取り込みで作ったレビューだけのタスク
  - 起動の数の新しい上限・メモリーの測定の仕組み

## 確認したいこと

### must

なし

### should

1. 起動に失敗したことを、レビューの担当に伝えるか。
   推奨：伝える。指示に「サービス（compose・サービス名）の起動に失敗しました：理由」の1行を足し、スキルは本文を変えない。
   懸念：伝えないと、担当は「起動しない PR」と区別できず、DB が要るテストを確かめなかった理由を本文に正しく書けない。
2. 前回のレビューからの差分が文書だけの再レビュー（`rereviewDocsOnly`）でも起動するか。
   推奨：起動しない。この回はコードのテストを実行しない指示なので、起動しても使われない。
   懸念：起動すると、この回ごとに compose の起動（最大 300 秒の待ち）とメモリーが無駄にかかる。
3. 受け入れ条件 5 の実機の確かめを、誰がするか。
   推奨：人が docker のある環境でする。実装の工程は手順（使う compose と、確かめる DB のテスト）を作業履歴に書く。sacty のコンテナに docker が無い（`which docker` で確かめた）ため。
   懸念：決めないと、実装の PR が実機で確かめないまま出て、確かめ忘れのままマージされうる。

### 確認しないと決めたこと

- 「実装でサービスを使った」の判定：子の実行の時点の親の `task.services.steps` に `implement` があること（計画）で決める。起動に失敗すると実装の工程が失敗になり PR が出ないので、PR があれば計画と実績は一致する。
- 再レビューの回ごとの起動：毎回起動する。仕様の「実行の1回ごとに起動し、終わったら消す」のまま。
- メモリー（受け入れ条件 4）：起動の数の上限は増えない。レビューの子タスクも `maxParallelTasks` に数え（`queuedTaskIds`）、1つのタスクは同時に1つの工程しか実行しないので、同時に動く compose は今と同じく最大 `maxParallelTasks` 組。この上限を仕様書に書き、新しい上限は設けない。
- PR #584（PBI-487。情報収集と計画の指示・`servicesReason` を直す）との重なり：この設計は情報収集と計画の指示に触れず、`prompts.ts` の変更は `servicePromptLines` の近くだけなので、範囲は分けない。

## 既定で決めたこと

- 親の指定は、子の実行の時点の親のタスクから読む（`parentImageOf` と同じ）。親を後から再実行して指定が変われば、次のレビューから変わる。
- 起動の失敗には新しいイベントを足さない。`ServicesStarted`（`step: review`）は起動したときだけ記録する。
- 失敗で続けるのは、レビューの子タスクの `review` の工程だけにする。今の工程は、失敗のときに工程を止める扱いのまま。

## 処理の流れ

- `serviceSpec(task, step)`：`step === "review"` で `task.reviewOf?.step === "implement"` のとき、親を `tasks.get(reviewOf.taskId)` で引き、`serviceSpec(parent, "implement")` を返す。親が無い・指定が無ければ undefined。
  - `startServices`・`stopServices` はどちらも `serviceSpec` で決めるので、起動・停止・共用の compose のディレクトリの片付けの判断がそろう。
  - `rereviewDocsOnly` の回は、起動の前に undefined にする（should 2）。
- 工程の実行（`service.ts` の `startServices` を呼ぶ所）：子の `review` で `startServices` が `ok: false` のとき
  - `run.stoppedByPerson` なら、今と同じく実行を止める。
  - それ以外（`services.unsafe`・共用の compose の取得の失敗・`up` の失敗など）は、`executed` を失敗にせずにレビューを実行する。スキルは `serviceSkill([])`、指示に失敗の1行（should 1）を足す。
- 安全の検査・正規化・ラベル・孤児の掃除・イメージの確定は、同じ `services.start` を通るので変えない。

## 影響範囲

- `services.md`（日英）：「いつ起動するか」に、使える工程とレビューの子タスクの扱い・失敗のときに続けること・同時に動く compose の上限を書き、「実装の工程の後に、テストのためにサービスを起動することはない」を書き換える。
- `tasks-and-steps.md`（日英）の「PR のレビューだけのタスク」の検証の項、`approval.md`（日英）の「PR のレビューの子タスク」の親から引き継ぐものに、サービスを足す。
- `docs/user/compose.md`（日英）の「どの工程で使うか」に、実装の PR のレビューを足す。

## テスト観点

- [TV-1] 実装でファイルの compose を使ったタスクの PR のレビューで、同じサービスを起動して担当をつなぐ
  - 入力：親の task.services が file・names・steps に implement を持ち、reviewOf.step が implement の子タスクの review の工程を、偽の services で実行する
  - 期待結果：services.start が親と同じ file・names で呼ばれ、step: review の ServicesStarted が記録され、スキルと指示に接続先が入り、実行の後に同じ runId で services.stop が呼ばれる
- [TV-2] 実装で共用の compose を使ったタスクの PR のレビューで、共用の compose を取得して起動し、後で片付ける
  - 入力：親の task.services が compose（プロジェクトの共用の compose の名前）を持ち、reviewOf.step が implement の子タスクの review の工程を実行する
  - 期待結果：共用の compose が実行ごとのディレクトリに取得されて起動し、ServicesStarted に compose の名前とコミットが入り、実行の後にそのディレクトリが消える
- [TV-3] 実装でサービスを使っていないタスクの PR のレビューでは起動しない
  - 入力：親の task.services が無いか steps に implement を持たない子タスクの review の工程を実行する
  - 期待結果：services.start と services.stop は呼ばれず、ServicesStarted は記録されず、スキルは「サービスは起動していません」の版になる
- [TV-4] 要求要件・設計の PR のレビューでは、親がサービスを使っていても起動しない
  - 入力：親の task.services の steps に implement があり、reviewOf.step が requirements または design の子タスクの review の工程を実行する
  - 期待結果：services.start は呼ばれず、ServicesStarted は記録されない
- [TV-5] レビューでサービスの起動に失敗しても、サービス無しでレビューを続け、失敗を担当に伝える
  - 入力：偽の services.start が ok: false（services.unsafe など）を返す状態で、実装の PR のレビューの子タスクの review の工程を実行する
  - 期待結果：工程は失敗にならずにエージェントが実行され、指示に起動の失敗と理由の1行が入り、スキルは「サービスは起動していません」の版で、ServicesStarted は記録されない
- [TV-6] レビューのサービスの起動の間に人が止めたら、今の工程と同じく実行を止める
  - 入力：実装の PR のレビューの子タスクで、services.start の待ちの間にタスクを一時停止する
  - 期待結果：エージェントは実行されず、止めた理由は run.stoppedByPerson になり、起動したサービスは止めて消される
- [TV-7] 前回からの差分が文書だけの再レビューでは起動しない
  - 入力：rereviewDocsOnly が決まった、実装の PR のレビューの子タスクの review の工程を実行する
  - 期待結果：services.start は呼ばれず、ServicesStarted は記録されない
- [TV-8] 仕様書と利用者向けの文書（日英）に、レビューでの起動の決まりが書かれている
  - 入力：docs/spec/services.md・tasks-and-steps.md・approval.md と docs/user/compose.md の日英の差分を読む
  - 期待結果：実装の PR のレビューの子タスクが親の implement のサービスを実行の1回ごとに起動すること、それ以外のレビューでは起動しないこと、起動に失敗してもサービス無しで続けて担当に伝えること、同時に動く compose が最大 maxParallelTasks 組であることが日英の両方に書かれ、「実装の工程の後に、テストのためにサービスを起動することはない」の文が残っていない
- [TV-9] 実機で、サービスを使うタスクの PR のレビューで DB が要るテストが流れる
  - 入力：docker のある環境で、実装の工程で DB の compose を使ったタスクの PR のレビューの子タスクを実行する
  - 期待結果：レビューの実行の間に compose のサービスが起動し、レビューの本文に DB が要るテストを実行した結果が書かれ、実行の後に sacty の所有のラベルの付いたコンテナが残っていない
