**日本語** | [English](split-and-integrate.en.md)

# タスク分割と統合レビュー

`split` の組み合わせでは、承認した設計をもとに、エージェントが子タスクを作る。
子タスクがすべて片付いたら、統合レビューで、子タスクの成果が親の要求要件を満たすかを確かめる。
通らなければ、修正の子タスクを足す。

関係する ADR: [依存のある子タスクは、依存先の PR が最終レビューに合格した時点で、その PR のブランチに重ねて始める](../adr/20261108-0615-stack-dependent-subtasks-on-reviewed-pull-requests.md)

## 分割

- 子タスクの数は `MIN_SPLIT_CHILDREN`（2）から `MAX_SPLIT_CHILDREN`（10）。
  修正の子タスクを足す2回目からは1件から作れる。
- エージェントの答え（見出し `sacty-split`）は、数・`key` の重複・無い依存・自分への依存・依存の循環を確かめる。
  読めなければ一時停止する。
- 子タスクは `start: split`・`parent`（親の ID と `dependsOn`）で作る。
  本文には、親の承認済みの要求要件・設計と、親がタスクの開始時に集めた情報（あれば）を添える。
  子タスクは情報を集め直さない（[タスクと工程](tasks-and-steps.md#情報収集)）。
  依存の無い子タスクは実行待ち、依存のある子タスクは `blocked` で始まり、依存先がすべて片付いたら実行待ちになる（`TaskUnblocked`）。
  依存先の PR が最終レビューに合格したら、片付くのを待たずに、その PR に重ねて始めることもある（下の「依存先の PR に重ねる子タスク」）。
- 子タスクのリポジトリは、子タスクの `repo`、無ければ親のリポジトリ。
  リポジトリの無い親の分割では、子タスクごとの `repo` をプロジェクトの対象と照らし、無い・対象に無いときは分割を使わずに止める。
  エージェントには、1つの子タスクは1つのリポジトリで完結させ、またがる変更は分けて `dependsOn` でつなぐよう指示する。
- 分割は1段だけ（子タスクは `split` を選べない）。
- 親は `waiting_children` で子タスクを待つ。
  子タスクがすべて片付いたら（完了したか、中止を人が認めた）`SplitCompleted` で次の工程へ進む。
- 子タスクが中止されたら、親を一時停止（`child_cancelled`）にする。
  親を再開すると、その中止を認めたことになる。

コード: `apps/daemon/src/service.ts`（`settleSplit`・`childSettled`・`splitWithRepositories`）、`apps/daemon/src/prompts.ts`（`extractSplitPlan`・`buildChildBody`・`splitRepositoryLines`）、`packages/core/src/events.ts`（`MIN_SPLIT_CHILDREN`・`MAX_SPLIT_CHILDREN`）

## 依存先の PR に重ねる子タスク

依存のある子タスクは、依存先の実装の PR が最終レビューに合格した時点で、マージを待たずに、その PR のブランチを起点にして始める（重ねた PR。PBI-317）。

- 始めるかの判定（`blockedStart`。親の `settleSplit` で、`blocked` の子タスクごとに）：依存先を次に分ける。決められなければ待つ。
  - ベースブランチに入った（`landed`）：中止を人が認めた、または、完了した・実装の PR がマージされた（`implementationMerged`。マージの後の監視の途中）もので、ほかの PR に重ねていないもの。
    重ねたまま PR がマージされた（人がドラフトを外して、重ねた先より先にマージした）ものは、変更が重ねた先の PR のブランチにしか入っていないので、まだ入っていない。重ねた先がマージされて付け替える（`StackedDependencyMerged`）と入る
  - 重ねられる：最終レビューに合格して作った、開いている実装の PR で、実装の承認待ち（`reviewedPullRequest`）。検証の待ちのために作った PR（`verifying`）・人が不合格のままレビューへ進めた今の提出の PR・引き継いだ人の PR は除く。子タスクと同じリポジトリのものだけ
  - それ以外
- 始め方：
  - 依存先がすべてベースブランチに入ったなら、ベースブランチから始める（`TaskUnblocked`。重ねない）。
  - 依存先のうち1つ（X）が重ねられ、ほかの依存先の今の変更がすべて X の合格したコミットに入っていると、記録から確かめられるなら、X に重ねて始める（`TaskUnblocked` の `stackedOn`。X の ID・PR のブランチ・合格したコミット）。依存先が2つ以上のときも、この規則で起点を決める。
    確かめ方（`covers`）は次のとおり。どれにも当たらなければ、確かめられないものとして待つ。
    - ベースブランチに入った依存先：X がその依存先を（依存の依存も含めて）待ち（`waitedOn`）、一度も重ねずにベースブランチから始めた（`Task.stack`・`Task.stackedBase` が無い）とき。X を始めた時点で、その依存先はもうベースブランチに入っていた。X が重ねて始めたなら、重ねた先の古い内容から作ったかもしれないので、確かめられない（X もベースブランチに入るまで待つ）。
    - まだ入っていない依存先：X から重ねた先をたどってその依存先に着き、各段の作業領域のベース（`workBaseCommit`）が、1つ下の依存先の今の合格したコミットと同じとき。下の依存先が直されて合格し直したのに、まだ取り込んでいなければ、確かめられない（取り込んで合格し直すまで待つ）。
  - それ以外（重ねる先を1つに決められない・別のリポジトリ・合格していない）は、待つ。
    たとえば、互いに依存しない A・B に依存する子タスクは、A がマージされても、B の合格したコミットには A の変更が入っていないので B に重ねず、B もベースブランチに入るまで待つ。
- 起点：重ねた子タスク（`Task.stack`）は、初めて作業領域を用意するとき、X の PR のブランチを clone して、合格したコミットにする（`prepareRepositoryNow`）。
  記録する起点のブランチ（`repository.baseBranch`）は X の PR のブランチ、起点のコミットは合格したコミット。オーケストレーターが選んだベースブランチでは用意し直さない。
  作業領域を用意する前に X の PR がマージされたら、付け替えた起点のブランチ（`Task.stackedBase`。`StackedDependencyMerged` の `baseBranch`）の最新で用意する。このときも、オーケストレーターが選んだベースブランチでは用意し直さない。
- 取り込み（`syncBase`）：取り込む時点はベースブランチの取り込みと同じ（[ベースブランチの取り込み](tasks-and-steps.md#ベースブランチの取り込み)）。重ねている間は、ベースブランチではなく X の PR の合格したコミットを取り込む（X が直されて合格し直したとき）。
  X の PR のブランチを取得し、合格したコミット（ブランチの先頭ではない）を、作業領域が今ベースにしているコミットを共通の祖先にして 3 方向でマージする。記録は `BaseBranchMerged`。
  X に合格した PR が無い（作り直しの途中・閉じられた）ときと、合格したコミットが今のベースと同じときは、取り込まない。衝突・失敗の扱いは、ベースブランチの取り込みと同じ。承認待ちの間は取り込まない。
- PR（`publish`）：重ねた子タスクの実装の PR は、向き先を X の PR のブランチにし、検証に通った後もドラフトのまま承認待ちにする（マージの順序を守らせるため。ドラフトの PR は GitHub でマージできない）。
  ドラフトにできなければ、承認待ちにせずに止める（`pr.stackDraftFailed`）。リポジトリがドラフトを使えなくても、ドラフトでない PR にしない（`PullRequests.upsert` の `requireDraft`。作れずに `pr.failed` で止める）。更新した PR をドラフトに戻せない・戻した答えがドラフトでないときも止める。再開すると、PR を作る・更新するところからやり直す。
  PR を更新するときも向き先を送り（`PullRequests.upsert` の `retarget`）、向き先を `PullRequestPublished` の `baseBranch` に記録する。重ねていないタスクの PR には記録しない（向き先は作るときに決めたベースブランチのまま）。
  本文の先頭（テンプレートに沿わせるときは目的の先頭）に、X の PR の番号・URL・子タスクの題と、X より先にマージしないこと、X がマージされたら sacty が向き先をベースブランチに付け替えてドラフトを外すことを書く（`stackedBodyLines`。長さの上限でも省かない）。
- X の PR がマージされたら（`stackAction` の `merged`）：子タスクに `StackedDependencyMerged` を記録し、起点のブランチを、X の PR が入ったブランチ（X の起点のブランチ）に付け替えて、重ねるのをやめる。
  X もまだ別の依存先に重ねたまま、先にマージされた（人がドラフトを外した）ときは、付け替えずに待つ（X の変更は、X が重ねた先の PR のブランチにしか入っていない。重ね直すと、作業領域のベース（X の合格したコミット）と取り込む先（X の変更を含まないことがある）が合わず、取り込みで X の変更が消えうる）。待つ間は、X に合格した PR が無いので取り込まない。X が重ねた先がマージされて X が付け替わったら、この子タスクも付け替える。
  記録した起点のコミット・取り込みは変えないので、次の取り込みで、付け替えた先の最新を、X の合格したコミットを共通の祖先にして取り込む。
  子タスクが完了していても記録する。
- 承認待ちの PR の向き先の付け替え（`retargetDue`・`retargetPullRequest`）：PR の確認（60秒ごと。`checkPullRequests`）で、承認待ちの子タスクの PR の向き先（記録）が今の起点のブランチと違えば、GitHub の PR の向き先を付け替え、本文を書き直す。重ねるのをやめたなら、ドラフトを外す（検証に通った PR なので）。`PullRequestRetargeted` を記録する。
  失敗したら記録せず、デーモンのログに出して、次の確認でやり直す（タスクは止めない）。承認待ちでない子タスクの PR は、次に PR を更新するときに付け替える。
  付け替えるかは、子タスクごとに、その時点の最新のタスクで決める（前の子タスクの GitHub の操作を待つ間に、後の子タスクが変わりうるため）。実行中の子タスクでは始めない。付け替えている間は、その子タスクを実行しない。
  差し戻し・一時停止・中止などでタスクが変わった（承認待ちでない・PR・コミット・提出・起点のブランチ・重ねた先のどれかが違う）ら、どの時点でも記録しない（やり直しの提出が、その時点の向き先・ドラフトで PR を更新する）。そのうえで、変わったのに気づいた時点で次のようにする。
  - 認証・本文の用意を待つ間：PR を更新しない。
  - PR の更新を待つ間：ドラフトを外さない（PR の向き先と本文は、更新したまま）。
  - ドラフトを外す操作を待つ間：ドラフトに戻す（答えを受け取れなかったときも。GitHub ではドラフトが外れているかもしれないため。`redraftAfterRetarget`。記録しないので、台帳のドラフトにそろえる。中止・完了したタスクは戻さない。戻せなければログに出す）。
- X が中止されたら（`stackAction` の `cancelled`。重ねた先の連なりのどこかが中止された）：子タスクが実行待ち・待機・承認待ちなら、一時停止する（`stack.dependencyCancelled`）。実行中なら、その実行が終わった後に止める。
  X の変更の上に作ったので、再開は受け付けない（中止はできる。親の `child_cancelled` の扱いは今までどおり）。合格する前に X が中止されたときは、今までどおり子タスクを始めない（`blocked` のまま。中止を人が認めたら、ベースブランチから始める）。
- マージの順序：人がドラフトを外して、子タスクの PR を X より先にマージしたら、今までと同じく、マージを承認として扱う（子タスクの変更は X の PR のブランチに入る）。
  ベースブランチにはまだ入っていないので、この子タスクに依存する子タスクは、X がマージされるまで待つ（上の `landed`）。
- 状態は作業履歴（`TaskUnblocked` の `stackedOn`・`StackedDependencyMerged`・`PullRequestPublished` の `baseBranch`・`PullRequestRetargeted`・`BaseBranchMerged`）から導くので、デーモンを起動し直しても失わない。
- 依存の無い子タスク・分割しないタスクには、重ねた先も PR の向き先の記録も無く、振る舞いは変わらない。

コード: `apps/daemon/src/service.ts`（`blockedStart`・`landed`・`covers`・`waitedOn`・`stackChain`・`cancelledInStack`・`stackAction`・`settleStack`・`retargetDue`・`retargetPullRequest`・`recordsPullRequestBase`・`stackedPullRequest`・`prepareRepositoryNow`・`syncBase`・`publish`・`resume`）、`apps/daemon/src/prompts.ts`（`stackedBodyLines`）、`apps/daemon/src/github.ts`（`GitHubPullRequests.upsert`）、`packages/core/src/events.ts`（`TaskUnblocked`・`StackedDependencyMerged`・`PullRequestRetargeted`）、`packages/core/src/projection.ts`（`stack`・`stackedBase`・`reviewedPullRequest`・`implementationMerged`）

## 統合レビュー

- AI は `step_agents.integrate`、無ければ `guardian_agent`（それも無ければ `default_agent`）。
- ベースブランチの最新を取得して使い捨ての写しで渡す。
  リポジトリの無い親では、子タスクのリポジトリとベースブランチごとに写しを並べる。
  指示には、承認済みの要求要件・設計、テスト観点（無ければ `REQ`）、子タスクの要約（題・状態・PR の URL・回・リポジトリ）、人の過去の指摘と AI のレビューの過去の指摘（節を分けて）を入れる。
  出力の形式の例の観点の ID は、判定する観点の ID（`integrationViewpointIds`）にする（PBI-137）。
- 指示は、最終レビューと同じく、受け入れ条件の確かめを名前・項目・ファイル・リンクが存在することの確認に縮めさせず（`ACCEPTANCE_DEPTH_REVIEW_LINE`）、共有の仕組み（キュー・ロック・キャッシュ・フラグなど）を新しく入れた・変えたときは、異常や失敗の後に後続の処理が続くかを確かめさせ（`sharedMechanismLines`。人が確かめることの欄が無いので、確かめられなかったことは判定の説明に書かせる）、出力の文をタスクの言語で書かせる（`OUTPUT_LANGUAGE_LINE`。PBI-301。[タスクと工程](tasks-and-steps.md)の最終レビュー）。
- 答え（見出し `sacty-integration-review`）で、すべての観点を満たし、すべての指摘が再発しておらず、`findings` が空のときだけ合格。
  指摘は人の指摘と AI のレビューの指摘の両方で、指示は両方に再発の判定を求める（最終レビューと同じ。[タスクと工程](tasks-and-steps.md)の最終レビュー）。AI のレビューの指摘の判定が無ければ不合格。
- 答えの JSON が崩れていても、最終レビューと同じに、直しながら読む（PBI-298。文字列の中の二重引用符・制御文字など。統合レビューの答えには入れ子のオブジェクトがないので、閉じ括弧の欠けは補わない）。直して読んだことは `IntegrationReviewed` の `outputRepaired` に記録する。直しても読めなければ不合格のままで、所見に壊れた位置（JSON の何行目の何文字目。`integrate.unreadableAt`）か、項目が足りないこと（`integrate.unreadableShape`）を残す。
- 合格したら、人の承認待ちにする。
  不合格なら `split` に戻して修正の子タスクを足させる。
  続けて `MAX_INTEGRATION_ATTEMPTS`（3）回通らなければ、修正の子タスクを足さずに、不合格のまま人の承認待ちにする。
  統合レビューの承認待ちで差し戻すと、回数を数え直す。

コード: `apps/daemon/src/service.ts`（`integrate`・`childRepositories`）、`apps/daemon/src/prompts.ts`（`buildIntegrationReviewPrompt`・`extractIntegrationReview`・`integrationViewpointIds`）、`apps/daemon/src/config.ts`（`agentFor`）、`packages/core/src/events.ts`（`MAX_INTEGRATION_ATTEMPTS`）
