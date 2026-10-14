# 承認と差し戻し

承認ゲートのある工程は、人間が承認すると次の工程へ進む。承認は、sacty の画面で行うか、対象のリポジトリへの PR のマージで行う
（承認＝マージ）。差し戻すと、選んだ工程からやり直す。同じ工程への差し戻しが上限を超えると、エスカレーション（人間の判断待ち）になる。

関係する ADR: [sacty が作る PR に取り込むラベルを付け、別のタスクのレビューを元のタスクの PR の指摘として取り込む](../adr/20261014-1445-label-sacty-pull-requests-for-review.md)

## 画面での承認

- 承認できるのは、状態が `awaiting_approval` か `escalated` で、工程が承認待ちの工程（`gate.step`）と同じで、画面が見ていた提出の回
  （`submission`）がいまの回と同じとき（違えば `gate.staleSubmission`）。
- 再現（`reproduce`）の承認待ち（再現できなかった）は承認できない。
- PR を作った工程（成果物チェック、PR のある要求要件・設計）は、画面からは承認できない（`gate.approveOnPullRequest`）。
- 承認した成果は固定される（承認した工程の出力は、後から変わらない）。承認の後、次の工程が実行できる工程なら実行待ちに、
  そうでなければ `idle` にする。

コード: `apps/daemon/src/service.ts`（`approve`・`gateTask`・`nextAfterApproval`）、`packages/core/src/projection.ts`（`applyEvent` の `StepApproved`）

## PR での承認

要求要件・設計（`StepPullRequestKey`）と成果物チェックは、PR で承認する。

- PR で承認するタスクか（`stepPullRequestsOn`）：タスクブランチがあれば常に。無ければ、対象リポジトリがあり、画面で要求要件・設計を
  まだ提出しておらず、プロジェクトにそのホストの GitHub のアカウントがあるとき。
- タスクブランチ `sacty/task-<タスク ID の先頭8文字>` を、ベースブランチの起点のコミットから作る（`TaskBranchCreated`）。
- 要求要件・設計は、ファイル `<documentsDir>/<タスク ID の先頭8文字>/<工程>.md` にして、工程のブランチ `<タスクブランチ>-<工程>-<回>` から
  タスクブランチへの PR にする。`documentsDir` はオーケストレーターが決め、使えない形なら既定の `docs/sacty`（`DEFAULT_DOCUMENTS_DIR`）。
  ファイルの先頭に sacty が作った旨の HTML のコメントを入れ、設計にはテスト観点を含める。
- その工程の PR が開いていて、タスクブランチの先頭が変わっていなければ、同じ PR を更新する（その工程のやり直し）。PR がマージ済み・
  閉じられた、または前の工程の直しがマージされてタスクブランチが進んだときは、タスクブランチの最新から新しいブランチと PR を作り、
  開いていた前の PR を閉じる。PR を作れなければ、理由を記録して止める。
- 実装は、タスクブランチがあればタスクブランチの最新に積み、タスクブランチからベースブランチへの PR（成果物チェック）にする。
  タスクブランチに、要求要件・設計のファイル以外の変更が積まれていれば、公開を止める（`pr.taskBranchChanged`）。
- タスク分割の子タスクは、それぞれ自分のタスクブランチを持つ。

コード: `apps/daemon/src/service.ts`（`stepPullRequestsOn`・`taskBranchName`・`publishStepPullRequest`・`publish`）、`packages/core/src/events.ts`（`StepPullRequestKey`・`DEFAULT_DOCUMENTS_DIR`・`isDocumentsDir`）、`packages/core/src/projection.ts`（`stepDocumentPath`）、`apps/daemon/src/prompts.ts`（`buildStepDocument`）

## PR の取り込むラベル

sacty が作る PR すべて（実装の PR と、要求要件・設計の PR）に、作った直後に取り込むラベル（sacty の設定 `intakeLabel`）を付ける。
別のタスク（PR のレビューだけのタスク）として取り込ませ、作ったタスクとは別のコンテキストでレビューさせるため
（[チケットの取り込みと GitHub](intake.md)）。

- 取り込むラベルを設定していない、または PR のトリアージを Off にしている（`triageOff` に `pullRequests`。付けても取り込まれない）なら、
  付けない。何も記録しない。
- リポジトリにラベルが無ければ（`GET /repos/<owner>/<name>/labels/<ラベル>` が 404）、作ってから（`POST .../labels`、色 `0e8a16`）
  PR に付ける（`POST .../issues/<番号>/labels`）。作っている間にほかで作られた（422 の `already_exists`）ときは、そのまま付ける。
- 付けたら `PullRequestLabeled`（`created`：ラベルを作った）、付けられなければ `PullRequestLabelFailed`（どの操作が失敗したか
  `github.failed` の `getLabel`・`createLabel`・`addLabel` と、GitHub の答え。使った秘密の値は伏せる）を記録する。タスクの作業履歴の画面に出る。
  付けられなくても、PR の作成は失敗にしない（タスクはそのまま承認待ちに進む）。
- 1つの PR（リポジトリと番号）につき1回だけ。記録のある PR には、同じ PR を更新しても付けない（重ねて付けない・人が外したラベルを
  付け直さない・失敗しても付け直さない）。記録の無い PR（設定する前に作った PR など）は、次に更新したときに付ける。
  PR を作り直した（前の PR がマージ・クローズされて、新しい番号の PR を作った）ときは、新しい PR に付ける。
- 中止・一時停止を求められて、要求要件・設計の PR を記録しなかったときは付けない。

コード: `apps/daemon/src/service.ts`（`labelPullRequest`・`publishStepPullRequest`・`publish`）、`apps/daemon/src/github.ts`（`GitHubPullRequests.addLabel`）、`packages/core/src/projection.ts`（`pullRequestLabels`）

## PR の確認

デーモンは60秒ごとに、承認待ちの PR を確かめる（前の確認が終わるまで次を始めない）。

- マージされた：`PullRequestMerged` と `StepApproved`（どちらも actor `person`）を記録する。
  - sacty の提出と違う内容でマージされた（PR の先頭が sacty のコミットと違う）ときも承認にする（`edited`）。要求要件・設計は、マージした
    コミットからファイルを読み、人が直した版を承認した成果にする。ファイルが消された・読めないときは sacty の版を承認する。
    取得できなければ記録せず、次の確認でやり直す。
- マージされずに閉じられた：`PullRequestClosed` を記録し、承認にせず人間の判断を待つ（画面から承認はできない。差し戻すか中止する）。
- 開き直された：`PullRequestReopened` を記録して見守りを続ける。
- 確認の途中で状態・PR・コミットが変わったときは記録しない。

コード: `apps/daemon/src/service.ts`（`checkPullRequests`・`readMergedDocument`）、`apps/daemon/src/pr-watcher.ts`（`PullRequestWatcher`）

## PR の指摘の取り込み

- PR が開いていて承認待ちのとき、PR のレビュー・行へのコメント・通常のコメントを指摘として取り込む。最後のフィードバックから2分
  （`FEEDBACK_QUIET_MS`）待ってから、古い順に最大50件（`REMARKS_MAX`）、1件 2000 文字（`REMARK_MAX`）で取り込む
  （`PullRequestReviewImported`、actor `person`）。同じものは二度取り込まない。
- bot の投稿と、プロジェクトのアカウントが投稿した、sacty のレビューの目印（`<!-- sacty-review:<タスク ID>[:<回>] -->`）で始まるレビュー・
  行へのコメントは取り込まない。ただし、その PR を取り込むラベルで取り込んだレビューだけのタスク（`source.review: sacty`。同じリポジトリと番号）
  の目印のものは、指摘として取り込む（作ったタスクとは別のタスクのレビューを、元のタスクに届けるため）。
- 取り込んだら、ゴールガーディアンが戻し先（その工程のやり直しか、前の工程への差し戻し）を判断し（`ReworkJudged`）、人の確認を挟まずに
  差し戻す。判断できなければ、戻せる工程の先頭（成果物チェックなら実装、要求要件・設計ならその工程）をやり直す。

コード: `apps/daemon/src/service.ts`（`importFeedback`・`feedbackRemarks`・`FEEDBACK_QUIET_MS`・`settleReview`・`judgeRework`）

## 差し戻し

- 戻せる工程（`reworkTargets`）：承認待ちの工程より前の `REWORK_STEPS` を、近い順に並べたもの。`reproduce`・`investigate` は、それ自身が
  承認待ちのときだけ。統合レビューの承認待ちでは `split` だけ。戻し先を省くと先頭（成果物チェックなら `implement`）。
- 承認待ちでの差し戻しには、指摘が1件以上要る（`gate.remarksRequired`）。人は指摘を無効にでき、無効にした指摘はエージェントに渡さない。
- 前の工程に戻すと、その工程から後の承認を取り消し、検証の結果と失敗の回数を戻す。PR で承認したタスクでは、マージ済みの PR は戻さない。
- 最終レビュー・統合レビューに通ったものを人が差し戻すと、見逃し（`GuardianMissed`）を記録する。

コード: `apps/daemon/src/service.ts`（`requestChanges`・`voidRemark`）、`packages/core/src/projection.ts`（`reworkTargets`・`reopen`・`changeRounds`）

## エスカレーション

| 理由 | いつ |
| --- | --- |
| `too_many_changes` | 同じ工程への差し戻しが `MAX_CHANGE_REQUESTS`（3）回に達した後の差し戻し。書きかけの指摘は残す。上限を超えて続けるには、明示して差し戻す（`overLimit`） |
| `change_undecidable` | ゴールガーディアンが変更の申し出を判定できなかった。人が判断する（`ChangeDecided`） |
| `rework_confirmation` | 以前の版の記録（いまは記録しない） |

コード: `apps/daemon/src/service.ts`（`requestChanges`・`decideChange`）、`packages/core/src/events.ts`（`TaskEscalated`・`MAX_CHANGE_REQUESTS`）
