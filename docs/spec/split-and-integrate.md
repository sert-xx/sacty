**日本語** | [English](split-and-integrate.en.md)

# タスク分割と統合レビュー

`split` の組み合わせでは、承認した設計をもとに、エージェントが子タスクを作る。
子タスクがすべて片付いたら、統合レビューで、子タスクの成果が親の要求要件を満たすかを確かめる。
通らなければ、修正の子タスクを足す。

関係する ADR: なし

## 分割

- 子タスクの数は `MIN_SPLIT_CHILDREN`（2）から `MAX_SPLIT_CHILDREN`（10）。
  修正の子タスクを足す2回目からは1件から作れる。
- エージェントの答え（見出し `sacty-split`）は、数・`key` の重複・無い依存・自分への依存・依存の循環を確かめる。
  読めなければ一時停止する。
- 子タスクは `start: split`・`parent`（親の ID と `dependsOn`）で作る。
  本文には、親の承認済みの要求要件・設計と、親がタスクの開始時に集めた情報（あれば）を添える。
  子タスクは情報を集め直さない（[タスクと工程](tasks-and-steps.md#情報収集)）。
  依存の無い子タスクは実行待ち、依存のある子タスクは `blocked` で始まり、依存先がすべて片付いたら実行待ちになる（`TaskUnblocked`）。
- 子タスクのリポジトリは、子タスクの `repo`、無ければ親のリポジトリ。
  リポジトリの無い親の分割では、子タスクごとの `repo` をプロジェクトの対象と照らし、無い・対象に無いときは分割を使わずに止める。
  エージェントには、1つの子タスクは1つのリポジトリで完結させ、またがる変更は分けて `dependsOn` でつなぐよう指示する。
- 分割は1段だけ（子タスクは `split` を選べない）。
- 親は `waiting_children` で子タスクを待つ。
  子タスクがすべて片付いたら（完了したか、中止を人が認めた）`SplitCompleted` で次の工程へ進む。
- 子タスクが中止されたら、親を一時停止（`child_cancelled`）にする。
  親を再開すると、その中止を認めたことになる。

コード: `apps/daemon/src/service.ts`（`settleSplit`・`childSettled`・`splitWithRepositories`）、`apps/daemon/src/prompts.ts`（`extractSplitPlan`・`buildChildBody`・`splitRepositoryLines`）、`packages/core/src/events.ts`（`MIN_SPLIT_CHILDREN`・`MAX_SPLIT_CHILDREN`）

## 統合レビュー

- AI は `step_agents.integrate`、無ければ `guardian_agent`（それも無ければ `default_agent`）。
- ベースブランチの最新を取得して使い捨ての写しで渡す。
  リポジトリの無い親では、子タスクのリポジトリとベースブランチごとに写しを並べる。
  指示には、承認済みの要求要件・設計、テスト観点（無ければ `REQ`）、子タスクの要約（題・状態・PR の URL・回・リポジトリ）、人の過去の指摘を入れる。
  出力の形式の例の観点の ID は、判定する観点の ID（`integrationViewpointIds`）にする（PBI-137）。
- 答え（見出し `sacty-integration-review`）で、すべての観点を満たし、すべての指摘が再発しておらず、`findings` が空のときだけ合格。
- 合格したら、人の承認待ちにする。
  不合格なら `split` に戻して修正の子タスクを足させる。
  続けて `MAX_INTEGRATION_ATTEMPTS`（3）回通らなければ、修正の子タスクを足さずに、不合格のまま人の承認待ちにする。
  統合レビューの承認待ちで差し戻すと、回数を数え直す。

コード: `apps/daemon/src/service.ts`（`integrate`・`childRepositories`）、`apps/daemon/src/prompts.ts`（`buildIntegrationReviewPrompt`・`extractIntegrationReview`・`integrationViewpointIds`）、`apps/daemon/src/config.ts`（`agentFor`）、`packages/core/src/events.ts`（`MAX_INTEGRATION_ATTEMPTS`）
