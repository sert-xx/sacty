<!-- sacty task b89b0fe1-ed14-4f2d-a476-9acb454c445d の設計。sacty が作成しました。 -->

# PBI-489 設計：PR のレビューの子タスクで、親の実装の工程のサービスを起動する

## スコープ

sacty が作った実装の PR のレビューの子タスクで、親の実装の工程と同じサービス（共用の compose を含む）を、レビューの実行の1回ごとに起動する。
起動・停止・後片付け・安全の検査は今の工程の経路をそのまま使い、起動の前に Docker の空きのメモリーを確かめる。足りないとき・起動に失敗したときは、サービス無しでレビューを続ける。

- 対象
  - `service.ts` の `serviceSpec`（子の `review` のときに親の `implement` の指定を返す）、起動の前のメモリーの確かめ、起動の失敗の扱い
  - `services.ts` の Docker の空きのメモリーを読む処理
  - `prompts.ts` の起動しなかった理由を伝える指示の1行
  - 仕様書（`services.md`・`tasks-and-steps.md`・`approval.md`、日英）、利用者向けの文書（`docs/user/compose.md`、日英）、ADR・作業履歴、テスト
- 対象外
  - スキル `docker-services` の本文（PBI-486）。起動の失敗のときも、今の「サービスは起動していません」の版を置く
  - 要求要件・設計の PR のレビューの子タスク、PR の取り込みで作ったレビューだけのタスク
  - 今の工程（調査・再現・実装）の起動の前のメモリーの確かめ、起動の数の新しい設定

## 確認したいこと

### must

なし

### should

1. 起動に失敗したことを、レビューの担当に伝えるか。
   推奨：伝える。指示に「サービス（compose・サービス名）の起動に失敗しました：理由」の1行を足し、スキルは本文を変えない。
   懸念：伝えないと、担当は「起動しない PR」と区別できず、DB が要るテストを確かめなかった理由を本文に正しく書けない。
2. レビューでサービスを起動するのに要る、Docker の空きのメモリーの下限をいくつにするか。
   推奨：2 GiB の固定の値。エージェントのコンテナ（テストの実行を含めて 1〜1.5 GiB の見込み）と、DB 1つの compose（数百 MiB）が収まる。実機の確かめ（TV-9）で、`docker stats` の実測が下限に収まるかを確かめる。
   懸念：大きな compose（複数の DB・検索エンジンなど）では、2 GiB の空きでも起動の後に足りなくなり、同時に動く実装の工程のテストが落ちうる。
3. 受け入れ条件 5 の実機の確かめを、誰がするか。
   推奨：人が docker のある環境でする。実装の工程は手順（使う compose と、確かめる DB のテスト）を作業履歴に書く。sacty のコンテナに docker が無い（`which docker` で確かめた）ため。
   懸念：決めないと、実装の PR が実機で確かめないまま出て、確かめ忘れのままマージされうる。

### 確認しないと決めたこと

- 「実装でサービスを使った」の判定：子の実行の時点の親の `task.services.steps` に `implement` があること（計画）で決める。起動に失敗すると実装の工程が失敗になり PR が出ないので、PR があれば計画と実績は一致する。
- 再レビューの回ごとの起動：毎回起動する。前回からの差分が文書だけの回（`rereviewDocsOnly`）も起動する。仕様の「実行の1回ごとに起動し、終わったら消す」のまま。
- メモリー（受け入れ条件 4）：同時に動く compose は今と同じく最大 `maxParallelTasks` 組（レビューの子タスクも `queuedTaskIds` で上限に数え、1つのタスクは同時に1つの工程しか実行しない）だが、レビューの分だけ重なりやすくなる。compose ごとの需要は利用者の compose で決まり前もって見積もれないので、レビューの起動の前に、その時点の空き（should 2）を確かめて、足りなければ起動しない。
  - 今の sacty の環境（コンテナから見たメモリー）は、合計 16 GiB・空き 9.1 GiB（`free -m`）。既定の 3 本が、それぞれ 2 GiB を足しても収まる。上限の 10 本では収まらないので、この確かめが要る。
- PR #584（PBI-487。情報収集と計画の指示・`servicesReason` を直す）との重なり：この設計は情報収集と計画の指示に触れず、`prompts.ts` の変更は `servicePromptLines` の近くだけなので、範囲は分けない。

## 既定で決めたこと

- 親の指定は、子の実行の時点の親のタスクから読む（`parentImageOf` と同じ）。親を後から再実行して指定が変われば、次のレビューから変わる。
- 起動の失敗には新しいイベントを足さない。`ServicesStarted`（`step: review`）は起動したときだけ記録する。
- 失敗で続けるのは、レビューの子タスクの `review` の工程だけにする。今の工程は、失敗のときに工程を止める扱いのまま。
- 空きのメモリーを読めないとき（`docker info`・`docker stats` の失敗）は、確かめずに起動を試みる。読めないことでレビューのサービスを止めない。
- メモリーが足りないときは、待たずにサービス無しで続ける。待つと、ほかの実行が終わるまでレビューが進まないため。

## 処理の流れ

- `serviceSpec(task, step)`：`step === "review"` で `task.reviewOf?.step === "implement"` のとき、親を `tasks.get(reviewOf.taskId)` で引き、`serviceSpec(parent, "implement")` を返す。親が無い・指定が無ければ undefined。
  - `startServices`・`stopServices` はどちらも `serviceSpec` で決めるので、起動・停止・共用の compose のディレクトリの片付けの判断がそろう。
- 工程の実行（`service.ts` の `startServices` を呼ぶ所）：子の `review` で指定があるとき
  1. Docker の空きのメモリー（`docker info` の `MemTotal` から、動いているコンテナの `docker stats --no-stream` の使用量の合計を引いた値）を読む。下限（should 2）より少なければ、起動しない。
  2. `startServices` が `ok: false` で `run.stoppedByPerson` なら、今と同じく実行を止める。
  3. それ以外の失敗（`services.unsafe`・共用の compose の取得の失敗・`up` の失敗など）と 1 で起動しなかったときは、`executed` を失敗にせずにレビューを実行する。スキルは `serviceSkill([])`、指示に起動しなかった理由の1行（should 1。メモリーのときは空きと下限）を足す。
- 安全の検査・正規化・ラベル・孤児の掃除・イメージの確定は、同じ `services.start` を通るので変えない。

## 影響範囲

- `services.md`（日英）：「いつ起動するか」に、使える工程とレビューの子タスクの扱い・起動の前のメモリーの確かめと下限・足りないときと失敗のときに続けること・同時に動く compose の上限を書き、「実装の工程の後に、テストのためにサービスを起動することはない」を書き換える。
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
- [TV-7] 前回からの差分が文書だけの再レビューでも起動する
  - 入力：rereviewDocsOnly が決まった、実装の PR のレビューの子タスクの review の工程を実行する
  - 期待結果：services.start が親と同じ file・names で呼ばれ、step: review の ServicesStarted が記録され、実行の後に services.stop が呼ばれる
- [TV-8] Docker の空きのメモリーが下限より少ないと、レビューでサービスを起動せずに続け、理由を担当に伝える
  - 入力：偽の Docker の空きのメモリーを下限より 1 バイト少ない値と、ちょうど下限の値にして、実装の PR のレビューの子タスクの review の工程をそれぞれ実行する
  - 期待結果：下限より少ないときは services.start が呼ばれずにエージェントが実行され、指示に空きと下限を含む起動しなかった理由の1行が入り、ちょうど下限のときは services.start が呼ばれる
- [TV-9] Docker の空きのメモリーを読めないときは、確かめずに起動を試みる
  - 入力：偽の docker info（または docker stats）が失敗する状態で、実装の PR のレビューの子タスクの review の工程を実行する
  - 期待結果：services.start が呼ばれ、起動に成功すれば step: review の ServicesStarted が記録される
- [TV-10] 仕様書と利用者向けの文書（日英）に、レビューでの起動の決まりが書かれている
  - 入力：docs/spec/services.md・tasks-and-steps.md・approval.md と docs/user/compose.md の日英の差分を読む
  - 期待結果：実装の PR のレビューの子タスクが、前回からの差分が文書だけの回も含めて親の implement のサービスを実行の1回ごとに起動すること、それ以外のレビューでは起動しないこと、起動の前に Docker の空きのメモリーを下限と比べ、足りないときと起動に失敗したときはサービス無しで続けて担当に伝えること、同時に動く compose が最大 maxParallelTasks 組であることが日英の両方に書かれ、「実装の工程の後に、テストのためにサービスを起動することはない」の文が残っていない
- [TV-11] 実機で、サービスを使うタスクの PR のレビューで DB が要るテストが流れる
  - 入力：docker のある環境で、実装の工程で DB の compose を使ったタスクの PR のレビューの子タスクを実行し、その実行のログと docker stats を見る
  - 期待結果：レビューの実行のログに、compose のサービスの起動と、DB が要るテストを実行して通った出力があり、実行の間の docker stats のエージェントと compose の使用量の合計が下限に収まり、実行の後に sacty の所有のラベルの付いたコンテナが残っていない
