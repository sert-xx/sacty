**日本語** | [English](event-log.en.md)

# 作業履歴（イベントと投影）

タスクに起きたことは、すべて作業履歴（追記専用のイベントの列）に記録する。
タスクの状態は保存せず、起動のときに作業履歴を先頭から読み直して作る（投影）。
実行ごとのエージェントの出力（セッションログ）は大きいので、作業履歴ではなくファイルに置く。

関係する ADR: なし

## イベントの形

`BranchPushed` の省略可能な `documentFixes` は、伏せて切ったパス・理由・差分を持つ。
`reasonTruncated` と `diffTruncated` は各値を切ったことを示す。
投影は push ごとの修正を順に保持する。

- 書くときの形は `{ type, payload }`。
  `type` で種類を分ける zod の判別共用体（`EventInput`）で検証する。
  種類は145（タスクの作成・分割、重ねた子タスクの依存先のマージ、工程の進行、エージェントの実行、予算・一時停止・再開・中止、タスクの題・イメージの変更、変更の申し出と判断、検証、終わっていない実装と変更の無いやり直し、git・PR（実装の無い進め方で、人がコミットを足したので消さずに残した工程のブランチの記録 `StepBranchKept` と、完了で消せなかった工程のブランチと理由の記録 `StepBranchesLeft` を含む）、PR のドラフトの解除・向き先の付け替え・CI のやり直しの依頼、sacty が外した切り替えの記録と、ドラフトへ戻さなかった記録（人が外した・読めなかった・決められなかった）、人が PR に足したコミットの取り込み、PR の本文の記録と人が直した本文のまとめ、以前の版の最終レビューの前のドラフトの PR の CI、レビュー、PR のレビューの子タスクの作成、取り込み元への返信、質問、エラーの分析、書き出し、PR のラベル、マージの後の監視、セキュリティ対応のタスクの依頼、完了したタスクの監査など）。
- 記録した後の形（`ActivityEvent`）は、書くときの形に次を足したもの。
  - `seq`（作業履歴全体で単調に増える）
  - `id`（UUID）
  - `taskId`・`projectId`
  - `at`（同じ追記の中のイベントは同じ時刻）
  - `actor`
- `actor` は `person`・`sacty`・`orchestrator`・`gatherer`（タスクの開始時の情報収集。[タスクと工程](tasks-and-steps.md#情報収集)）・`guardian`（以前の版の最終レビューと AI の判定）・`agent`・`auditor`（完了したタスクの監査。[監査](audit.md)）のどれか。
- AI を使ったイベントの多くは、次を持つ。
  - トークン数（`usage`：`input`・`cacheRead`・`cacheWrite`・`output`）
  - 費用（`costUsd`）と、推定かどうか（`estimated`）、使った分の全体を読めなかったか（`costUnknown`。失敗しうるイベントだけ）
  - 使った AI の設定（`authMode`・`model`・`reasoningEffort`）
  - 実行の ID（`runId`）
- イベントの版の番号は無い。
  古い作業履歴は、スキーマの既定値（`.default`）・任意の項目（`.optional`）・読み替え（`.transform`）で読む。
- 利用者に見せる文は `DaemonText`（文字列か、文言のコードと引数 `{ code, params }`）で持つ。
  画面と通知が、その言語（`ja`・`en`）の文言にする。
  知らないコードや引数が合わないときは、コードの文字列をそのまま出す（例外にしない）。

コード: `packages/core/src/events.ts`（`EventInput`・`ActivityEvent`・`Actor`・`TokenUsage`）、`packages/core/src/message-code.ts`（`DaemonText`・`message`）、`packages/core/src/messages.ts`（`renderMessage`・`DAEMON_MESSAGES`）

## 保存

- 作業履歴は、`SACTY_HOME/sacty.db`（SQLite、`node:sqlite`、WAL）の `activity` テーブルに置く。
  列は `seq`（自動増分の主キー）・`id`・`task_id`・`project_id`・`at`・`actor`・`type`・`payload`（JSON）。
- トリガー（`activity_no_update`・`activity_no_delete`）が更新・削除を拒否する（追記専用）。
- 追記は `BEGIN IMMEDIATE` から `COMMIT` の中で、1件ずつ `EventInput` で検証して書く。
  失敗すれば全体を戻す。
- 読むときも1件ずつ `EventInput` で検証する。
- 以前の名前の `ledger` テーブルがあり `activity` が無ければ、名前を変えて引き継ぐ。
- 保存先の口は追記と読み出し（`append`・`all`・`forTask`・`close`）だけ。

コード: `apps/daemon/src/activity.ts`（`SqliteActivityStore`・`SCHEMA`・`RENAME_LEGACY`・`ActivityStore`）

## 投影

- 起動のとき、すべてのイベントを `project` で読み、タスクの ID ごとの `Task` を作ってメモリーに持つ。
  - `seq` が前より大きくなければ例外にする。
  - 同じ走査で、ダッシュボードの集計（`DashboardStats`）にもイベントを畳み込む（[ダッシュボードの集計](architecture.md#ダッシュボードの集計)）。
- イベントを書くときは、次の順に進む。
  1. `applyEvent` で、いまの状態に適用できるかを確かめる（できなければ `task.invalidState` の誤り）。
  2. 作業履歴に書く。
  3. メモリーの状態に適用する。
- 適用できないイベント（二重の作成・知らないタスク・中止したタスクへのイベント・状態や実行の ID の食い違いなど）は、投影が例外にする。
  ただし中止したタスクでも、セッションの保存の記録 `AgentSessionArchived`・`OrchestratorSessionUsed` と、監査が登録したメモリーの削除 `AuditMemoryDeleted` は受け付ける。
- 記録だけで状態を変えないイベントもある（`AiRequestsRetried`・`SubagentNoticeImitated`・`RunCostRecorded`・`ReviewGitHubRetried`・`PushRetried`・`PushRetryEnded`・`AgentFellBack`・`ServicesStarted`・`AgentSessionArchived`・`AgentRunTimedOut`・`AgentRunContinued`・`WorkspaceFilesSkipped`・`PullRequestBodyResolved`。費用を持つものは、下のとおり予算に足す）。
- 直しに入る前の提案の選り分け（PBI-436。[直しに入る前の提案の選り分け](approval.md#直しに入る前の提案の選り分け)）の記録は次のとおり。
  - `StepSuggestionsHeld`（actor `sacty`）：要求要件・設計の PR で直しを打ち切った工程 `step`、PR 番号 `number`、先頭 `commit`、レビューの回 `round`、連続した提案だけの回数 `suggestionRounds`。
  - `SuggestionsTriaged`（actor `agent`）：`items[]`（提案ごとの `id`・取り込んだ指摘の位置 `remark`・提案の文 `text`・判断 `decision`（`address` か `decline`）・理由 `reason`・判断が無く対応する側にした印 `defaulted`・元のコメントの URL `url`）、`dropped[]`（提案のすべてを対応しないとして差し戻しから外した指摘の位置）、`round`・`suggestionRounds`（判断の材料にした、レビューの回と、提案だけの回が続いた数）、`stop`（判定し直した回の提案もすべて対応しないので、返信の後に、一時停止せずにドラフトを外す。以前の版は一時停止した）、実行の記録（`agentId`・`runResult`・`usage`・`costUsd` など）。
  - 直しでは解消できない指摘で止めるための記録（PBI-452）：`TaskPaused` の理由 `needs_decision` と `commit`（止めた PR の先頭）、`PullRequestReviewImported` の `items[].by`（`person`・`unverified`）、`ReworkStoppedByMerge` の `decision`、判定のブロックの `rework.findings[].needsDecision`（子タスクの `reviewVerdicts[].rework`）。投影は `Task.decisionPauses`（止めた回ごとの先頭・指摘と根拠・人の判断の文）と `pendingReview.unverified` を持つ。前の版は、足した欄を読まずに捨てるが、理由 `needs_decision` の `TaskPaused` は読めない（一度記録したら、前の版に戻せない）。`FinalReviewSkipped` の `securityScope.violation` は、`lines` を持たず、`max` に固定で 300 を書く（前の版が読める）。
  - 要求要件・設計の直しをマージで止める記録（PBI-462）：`ReworkStoppedByMerge` の `step`（工程）。前の版は、`step` を読まずに捨てて実装の作り直しの記録として投影し、整合性のエラーになって起動できない（一度記録したら、前の版に戻せない）。投影は `Task.stepSubmitted`・`reworkOf`・`sentBackFrom`・`stepBranchCommits` を持つが、これらは既存の記録から作り直すので、保存する形は増えない。
  - 投影は、選り分けが済んだことを `pendingReview.triage` に持ち（起動し直しても実行し直さない）、`dropped` の指摘を `pendingReview` から外して `Task.remarks` に足す（`triaged: true`・`status: declined`・`round: 0`・`origin`。直しの回・直しの指示・提出での対応の書き直しの対象に数えない）。一部だけ対応しない指摘は `pendingReview` に残し、`pendingReview.triage.declined` に対応しない提案の文と理由を持つ（差し戻しの `remarks[].declinedParts` に引き継ぐ）。対応しないとした提案は `Task.declinedSuggestions`（文・理由・URL・回）に消さずに積む。`stop` は `Task.triageStop` に持ち、ドラフトを外す（`PullRequestMarkedReady`）と消える（一時停止では消さない。以前の版が一時停止させたタスクも、再開で同じ先頭のドラフトを外す）。
  - PR のプッシュのやり直し（PBI-467）：`PushRetried`（`branch`・`commit`・`attempt`・`maxAttempts`・`waitMs`・`message`（失敗の文。秘密の値は伏せたもの））と `PushRetryEnded`（`branch`・`commit`・`outcome`（`pushed` か `failed`）・`retries`）。どちらも記録だけで状態は変えない。前の版は、この 2 種を `EventInput` の検査で読めず、起動できない（一度記録したら、前の版に戻せない）。
    - 前の版に戻せるのは、どちらかを記録する前まで。戻す前に、作業履歴の `activity` の表に、`type` が `PushRetried` か `PushRetryEnded` の行が無いことを確かめる。
    - 戻して起動できなければ、この変更の版へ進め直す。
  - ドラフトの切り替えの記録（PBI-468）：`PullRequestUndraftNoted`（`number`・`eventId`。sacty が外した切り替えの GitHub のイベント ID。`eventId` が無いのは、外す要求の答えから今回の外しの ID を決められなかったとき）と `PullRequestRedraftSkipped`（`number`・`reason`（`person`・`unreadable`・`undetermined`）・`eventId`（`person` だけ。人の外しの ID））。`PullRequestMarkedReady` と `ready` の `PullRequestRetargeted` には、外しを覚える版が書いたことを示す `undraftTracked` が付く（無い記録は前の版が外した）。状態は `Task.draftTrail`（PR の番号ごと）にだけ持つ。判定と記録の重複の決まりは、[最終レビューをしない流れ](tasks-and-steps.md#最終レビューをしない流れ)。
    - 前の版は、この 2 種を `EventInput` の検査で読めず、起動できない（`activity.ts` の `toEvent`）。前の版に戻せるのは、どちらかを記録する前まで。互換の層は作らない。不具合は前の版へ戻さず、直した版を出して直す（[ADR](../adr/20261121-2022-do-not-redraft-pull-request-a-person-marked-ready.md)）。
  - `runResult` が `interrupted` のもの（判断を採用しなかった）は、費用だけを数え、状態を変えない。
  - `ReviewRejudgeRequested` の `reason: triaged`：選り分けで、差し戻す指摘が残らなかったので、実装を実行せずに判定し直しを求めた。承認待ちの実装の PR について、`SuggestionsTriaged` と同じ追記で記録する（`Task.reviewRejudge.reason`）。`reason` が無いものは、実装の提出の記録（PBI-357）。
- PR のレビューの過程の記録（PBI-460。[PR のレビューだけのタスク](tasks-and-steps.md#pr-のレビューだけのタスク)）は次のとおり。PR に投稿しない過程の情報を残し、タスクの画面と MCP の `get_task` で読む。
  - `AgentRunCompleted` は、`reviewDispatch`（観点ごとの担当の数）の隣に、任意の欄 `reviewRecord`（`ReviewRecord` か `null`）を持つ。欄を足しただけで、イベントの種類と列挙は増えない。記録のブロックを返さなかった実行と、これより前の作業履歴には、欄が無い。
  - 答えのうち、情報文字列に `sacty-review-record` を含む最初のブロックだけを読む（`readReviewRecordBlock`）。そのブロックが閉じていない・JSON として読めない・形の検査に通らない・上限を超える・秘密の値を伏せる処理が失敗したときは `null`。`null` でも、レビューは使い、投稿を止めない。
  - 欄と上限は次の表のとおり（`checkReviewRecord`）。表に無い欄は認めず、どれか 1 つでも形の検査に通らなければ、記録の全体を `null` にする（一部だけ残さない）。答えに無い配列の欄は空の配列にし、`dropped` の無い件数は 0 にする。

    | 欄 | 中身 | 上限 |
    | --- | --- | --- |
    | `mode` | `subagents`（観点ごとの担当に分けて見た）か `sequential`（逐次モードで見た） | — |
    | `viewpoints` | 観点ごとの扱い（`id`・`status`・`reason`）。`status` は `launched`・`relaunched`・`failed`・`substituted`（親が代わりに見た）・`not_launched`（起動しなかった） | 100 件 |
    | `notReviewed` | 見られなかった観点と理由（`id`・`reason`） | 100 件 |
    | `dismissed` | 採用しなかった指摘と理由（`title`・`viewpoint`・`reason`） | 100 件 |
    | `dropped` | 落とした指摘の件数（`overlapping`・`outOfScope`・`handled`・`must`。0 以上の整数） | — |
    | `scope` | 絞ったこと・絞らなかったことと理由、基準にしなかった指示など（文字列） | 20 件 |
    | `verification` | 検証の経過（`kind`・`text`）。`kind` は `ran`・`reused`・`stopped`・`skipped` | 20 件 |

  - 文字列はすべて、秘密の値を伏せてから 1 件 500 文字に切る（伏せてから切るので、境界をまたぐ値も残らない）。伏せ方は、監査の材料と同じ（`auditRedactor`）。
  - 記録の文字列は、PR を読んだエージェントが書いた、信頼しない入力として扱う。`get_task` は記録の欄（データ）として返し、再レビューの指示は `previousReview` の JSON のデータの区画に入れて、データで指示ではないと添え、画面は文字列のまま出す（Markdown・HTML として解釈しない）。
  - 投影は、`Task.reviewRecords` を、`reviewVerdicts` と同じく回ごとの配列で持つ。要素は `round`・`record`（`null` を含む）・その回の `reviewDispatch`（`agentId` つき）。同じ回の実行し直しは、その回の要素だけを置き換え、ほかの回は残す。記録の欄が無い実行の回は、要素を作らない（同じ回の前の実行の要素も残さない）。最新の回の `Task.reviewDispatch` は変わらない。
  - 前回の記録の写し：`previousReview`（`PreviousReviewSnapshot`）は、任意の欄 `record` を持つ。同じタスクの再レビュー（`ReviewRestarted`）は、その回の `reviewRecords` の記録を写す。GitHub の再依頼で作るタスクは、元のタスクの最新の回の記録を写す（`reviewRerequest.previousReview`）。`earlierReviews` に移す古い `previousReview` からは `record` を落とす（同じタスクの回の記録は `reviewRecords` に、再依頼の元のタスクの回の記録は元のタスクの画面と `get_task` にある）。写すのは、`get_task` と再レビューの指示のデータに出すため。再レビューを絞るかの判断に使うのは、同じタスクの再レビューだけ。
  - 投稿する文字列からの除去（`stripReviewRecord`・`withoutReviewRecord`）：エージェントの答えから作って投稿するすべての文字列（本文・行へのコメントの各本文・リスク評価の各文）から、記録を読めたかどうかに関わらず、次を取り除く。投稿の直前（`buildReviewBody`・`buildReviewComments`）にも、同じ規則で取り除く。
    - フェンスの見つけ方：行頭の空白（数を問わない）・引用（`>`）・リストの印を除いた後に、バッククォートかチルダの 3 文字以上で始まる行を開きとし、同じ文字で、開きと同じ長さ以上のフェンスで閉じる。閉じていないものは、文字列の終わりまで。バッククォートのフェンスは、同じ行の情報文字列にバッククォートを含むものを開きにしない（行の途中でバッククォートが閉じる書き方は、インラインのコードで、フェンスではない）。改行は `\r\n`・`\r`・`\n` のどれでも分ける。
    - 除くフェンス：情報文字列のどこかに `sacty-review-record` を含むもの（大小文字・前後の空白・`json sacty-review-record` のような並びを問わない）と、情報文字列を問わず、中身に記録に固有の欄名（`viewpoints`・`notReviewed`・`dismissed`・`dropped`・`verification`）のうち 2 種類以上をキーとして含むもの（JSON として読めるかは問わない。1 種類だけなら、設定の例として残す）。閉じていないもの・2 つ目以降も除く。見出し付きのフェンスの中に別のフェンスが入れ子になっているときは、中身の欄名の有無によらず、外側のフェンスごと除く。
    - キーの一致は、大小文字、欄名の前後の引用符（二重・一重・無し）、`:` の前の空白を問わない。前後に英数字か `_` が続く語（`myverification:` など）は当てない。`mode`・`scope` は一般の設定の語なので、判定に使わない。
    - フェンスの外：行頭の空白・引用・リストの印を除いた後に `{` か `[` で始まる行から、括弧の釣り合う行まで（釣り合わなければ文字列の終わりまで）を 1 つの範囲とし、その中に 2 種類以上のキーの一致があれば、範囲ごと除く。範囲の外の地の文の行は、キーの一致があっても除かない。
    - 除いた後に `sacty-review-record` の文字列（大小文字を問わない）が残る行も除く。
    - 除いた後の文字列を同じ規則で確かめ直し、何も除かれなくなるまで繰り返す（20 回まで）。
    - 除いて空になった行へのコメントは捨てる。リスク評価の文のどれかが空になったときは、その回の評価を使わない。
- 投稿していないレビューの打ち切り（PBI-465。[投稿の前の先頭の変化での打ち切り](tasks-and-steps.md#投稿の前の先頭の変化での打ち切り)）の記録は次のとおり。
  - `ReviewRunStopped`（actor `sacty`）：`reason`（`head_changed`：PR の先頭が変わった、`merged`・`closed`：PR がマージ・クローズされた）、`from`（レビューしていた先頭）、`to`（新しい先頭。`head_changed` だけ）、`runIds`（止めた実行）、費用（`costUsd`・`estimated`・`usage`・`costUnknown`）。費用は、`AgentRunCompleted` を記録していない実行の分だけ持つ（投稿の直前の打ち切りは、数え済みなので持たない）。
  - 記録できるのは、投稿していないレビューのタスクの、実行中・対象の確認中・投稿待ちだけ。一時停止・完了・始め直しの待ちの間は、投影が `ActivityIntegrityError` にする。
  - 投影は、タスクを `queued` に戻し、今の実行の ID を消す。`head_changed` では、`reviewTarget`・`reviewResolvedAt`・`outputs.review`・`reviewComments` と、回ごとの記録（`reviewVerdicts`・`reviewRecords`・`reviewDispatch`）のすべてから今の回の要素を消し、`Task.reviewStop`（`from`・`to`・`at` と、消した対象の `repo`・`number`）を持つ。`reviewStop` は次の `ReviewTargetResolved` で消す。`reviewRound`・`previousReview`・`earlierReviews` は変えない。`merged`・`closed` は、続く `TaskCancelled` で中止する。
  - 投影の `previousReview`・`earlierReviews`（`PreviousReviewSnapshot`）は、その回の `reviewPost.latestCommit` を写して `latestCommit` に持つ（親に届かなかった回を決めるため。保存する形は増えない）。
  - 前の版のデーモンは、`ReviewRunStopped` を持つ作業履歴を `EventInput` で読めず、そのタスクだけでなく、デーモンが起動できない。戻せるのは、最初の `ReviewRunStopped` を記録する前まで。
- 費用を持つイベント（[費用](#費用)の20種類）を適用できたときは、その `costUsd` をタスクの `budget.usedUsd` に足す（小数第6位で丸める）。
  `estimated` が1件でもあれば、`budget.estimated` を立てる。
- `Task` の主な項目
  - `status`
  - `steps`（工程ごとの `todo`・`active`・`done`・`skip`）
  - 工程の出力と承認した成果、承認の待ち（`gate`）
  - 指摘（`remarks`）、変更の申し出（`proposals`）、予算（`budget`）
  - 実行中の実行の ID
  - 検証・テスト・統合レビューの結果（以前の版の最終レビューの結果も）
  - PR とタスクブランチ、分割の親子
  - 一時停止の理由、質問、書き出し、オーケストレーターのセッション
  - マージの後の監視（`deployment`）と修正のタスクの元（`fix`）

`status` の値は次のとおり。

| 値 | 意味 |
| --- | --- |
| `blocked` | 分割の子タスクで、先に終わるべき子タスク（`dependsOn`）を待っている |
| `waiting_children` | 分割の親タスクで、子タスクを待っている |
| `queued` | 実行待ち（ワーカーが拾う） |
| `running` | 実行中 |
| `idle` | 実行していない（判定や PR の確認などを待っている） |
| `paused` | 一時停止（理由は `pausedReason`） |
| `awaiting_approval` | 人間の承認待ち |
| `escalated` | エスカレーション（人間の判断待ち） |
| `cancelled` | 中止 |

コード: `packages/core/src/projection.ts`（`project`・`applyEvent`・`Task`・`TaskStatus`）、`packages/core/src/cost.ts`（`chargeBudget`）、`apps/daemon/src/service.ts`（`TaskService.append`・`reviewRecordOf`）、`packages/core/src/events.ts`（`ReviewRecord`・`REVIEW_RECORD_LIST_MAX`・`REVIEW_RECORD_SHORT_LIST_MAX`・`REVIEW_RECORD_TEXT_MAX`）、`apps/daemon/src/review-record.ts`（`readReviewRecordBlock`・`checkReviewRecord`・`stripReviewRecord`・`withoutReviewRecord`）

## 費用

- 単価（`PricePerMTok`）は100万トークンあたりの米ドルで、`input`・`cachedInput`・`cacheWrite`（既定 0）・`output`。
- 費用 = (`input`×`input` の単価 + `cacheRead`×`cachedInput` の単価 + `cacheWrite`×`cacheWrite` の単価 + `output`×`output` の単価) ÷ 10^6（分子を整数に丸めてから割る）。
- サブスクリプションとスタブの実行は、同じ単価で換算した推定の費用（`estimated`）として扱い、予算の判定に使う。
- 実行の費用は、CLI が報告した額（Claude Code の `total_cost_usd`）があればそれ、無ければモデルごとの使用量をそのモデルの単価で換算した額（単価が設定に無いモデルは、工程のエージェントの単価）にする
  （[エージェントの実行](agent-execution.md#出力の扱い)）。
  CLI の報告を使った実行と、モデルごとに換算した実行は、どちらにしたかを `RunCostRecorded`（`reported`・`converted`。設定の単価で換算した額も持つ）に記録する。予算には、実行の結果のイベントの `costUsd` だけを足す。
- タスクの予算に入れる費用を持つイベントは、次の20種類（`CHARGED_EVENT_TYPES`）。
  `costUsd` を持つイベントはこれですべて。
  統合レビューの `IntegrationReviewed` は費用を持たず、続く `AgentRunCompleted` に記録する。

  | イベント | 工程ごとの費用の表の行 |
  | --- | --- |
  | `InformationGathered`（と、actor が `gatherer` の `OrchestratorFailed`） | 情報収集（`gather`） |
  | `TicketTriaged` | チケットの読み取り（`triage`。情報収集が兼ねたものは費用を持たず、行にしない） |
  | `RepositoryChosen` | リポジトリの選択（`repository`） |
  | `StepsChosen`・`StepsSkipped`・`OrchestratorFailed`（actor が `gatherer` のものを除く） | オーケストレーター（`orchestrator`） |
  | `PullRequestBodyResolved`（PBI-334） | オーケストレーター（`orchestrator`。人が直した PR の本文との競合をまとめた実行。エージェントを実行しなかった（`agentId` が無い）ものは、行にしない。[人が直した本文の更新](approval.md#人が直した本文の更新)） |
  | `PullRequestRiskAssessed`（PBI-362） | オーケストレーター（`orchestrator`。版を上げる前の、PR を作る前のリスク評価の実行。PBI-429 の後は、レビューの工程の答えから読んだ評価の記録（実行しないので行にしない）と、判定し直した回の提案がすべて対応しないとされたときの評価だけの実行（`via: suggestions_declined`。PBI-440）。エージェントを実行しなかった（`agentId` が無い。予算の上限で評価しなかったもの・レビューの工程の答えから読んだもの・前回の評価を引き継いだもの（`inheritedFrom`。PBI-421））は、行にしない。[PR のリスク評価](risk-assessment.md)） |
  | `AgentRunCompleted`・`AgentRunFailed` | その工程 |
  | `ReviewRunStopped`（PBI-465） | レビュー（`review`。打ち切った実行の、`AgentRunCompleted` を記録していない分。投稿の直前の打ち切りは費用を持たない） |
  | `OutputExported` | 書き出し（`export`） |
  | `QuestionAnswered` | 質問への答え（`chat`） |
  | `ErrorAnalyzed` | エラーの分析（`errorAnalysis`。[エラーレポート](error-report.md)） |
  | `DeploymentChecked` | マージの後の監視の工程（`deployment`。[マージの後の監視](deployment-watch.md)） |
  | `ReworkJudged`（actor が `agent`。PBI-332） | 戻し先の判断（`rework`）。actor が `sacty`（`reviewTaskId` があり、PR のレビューの子タスクの答えから決めた）のものは実行していないので、行にしない |
  | `SuggestionsTriaged`（PBI-436） | 提案の選り分け（`suggestions`。直しに入る前に、AI のレビューの提案を選り分けた実行。採用しなかった実行（`runResult: interrupted`）も、費用を数えて行に出す。[直しに入る前の提案の選り分け](approval.md#直しに入る前の提案の選り分け)） |
  | `ChangeJudged`・`ReworkJudged`（actor が `guardian`。以前の版）・`FinalReviewed`・`FinalReviewFailed` | 以前の版の AI の判定（`guardian`。最終レビューもこの行） |

- 投影と工程ごとの費用の表は、どちらも同じ規則（`chargeBudget`）で費用を足す。
  一覧に無い種類が `costUsd` を持つと、型の検査で typecheck が通らない。
- 時間切れなどで使った分の全体を読めなかった実行は、読めた分（下限）を `costUsd` に足し、イベントに `costUnknown` を付ける（PBI-281）。
  - 付けるのは、実行の失敗を記録しうる `AgentRunFailed`・`ReviewRunStopped`・`OrchestratorFailed`・`StepsSkipped`・`ChangeJudged`・`ReworkJudged`・`SuggestionsTriaged`・`FinalReviewFailed`・`QuestionAnswered`・`ErrorAnalyzed`・`OutputExported`・`DeploymentChecked`・`PullRequestBodyResolved`・`PullRequestRiskAssessed`。
  - 読めなければ `costUsd` は 0 のままで、この 0 は費用が無かったのではなく不明を意味する。拾い方は[エージェントの実行](agent-execution.md)の出力の扱い。
  - 失敗して代わりのエージェントで判定し直した判定や、再開を断られて新しいセッションで始め直した実行は、先の実行が不明なら合計も不明にする。そのため、成功を記録するイベント（`AgentRunCompleted`・`StepsChosen`・`TicketTriaged`・`RepositoryChosen`・`InformationGathered`・`FinalReviewed`）も `costUnknown` を持てる。
  - `chargeBudget` は、印のあるイベントの回数を `budget.unknownRuns` に数える（無ければ持たない）。読めた分は予算の判定に入る。
  - 画面と作業履歴は、読めた分があれば「以上」、読めなければ「不明」と出し、$0 とは見せない。費用を文に出さない成功の記録（`StepsChosen`・`InformationGathered`・`TicketTriaged`・`RepositoryChosen`）も、印があれば末尾に出す。
- 完了したタスクの監査（`Audit…` のイベント）の費用は `auditCostUsd` に持ち、タスクの予算には入れない。
  監査の予算（タスクの監査の状態の `usedUsd`）に足す（[監査](audit.md)）。
- 予算の状態（`budgetState`）は次のとおり。

  | 状態 | 条件 |
  | --- | --- |
  | `exceeded` | 使った額が上限以上 |
  | `warn` | まだ通知していなくて、上限の `BUDGET_WARN_RATIO`（0.8）以上 |
  | `ok` | それ以外 |

コード: `packages/core/src/cost.ts`（`PricePerMTok`・`computeCostUsd`・`budgetState`・`CHARGED_EVENT_TYPES`・`isChargedEvent`・`addUsd`・`chargeBudget`）、`packages/core/src/events.ts`（`BUDGET_WARN_RATIO`）、`apps/daemon/src/service.ts`（`executeLogged`）

## セッションログ（実行ごとのファイル）

- 置き場所は `SACTY_HOME/runs/<タスク ID>/`。
  ファイルは 0600、ディレクトリは 0700。
  実行ごとに次のファイルを置く。

  | ファイル | 中身 |
  | --- | --- |
  | `<実行 ID>.jsonl` | エージェントの標準出力の JSONL |
  | `<実行 ID>.stderr.log` | 標準エラー出力 |
  | `<実行 ID>.meta.json` | 役割・AI・開始と終了の時刻・結果・切り詰めたか |

- 1実行あたり、出来事は先頭 15MB と末尾 3MB、標準エラー出力は先頭 1MB と末尾 1MB を残す。
  間は省き、省いた目印（JSONL は `{"type":"sacty.truncated", …}` の行）を入れる。
- 書く前に秘密情報を伏せる。
  届いた出力の切れ目をまたぐ値も伏せる（持ち越す分は、伏せる前の文字列で照合する）。
  後から分かった値は、閉じるときにファイル全体を伏せ直す。
- 書き込みに失敗しても実行は止めない（警告を1回出す）。
- 実行中の写し：デーモンは、開いていてまだ閉じていない実行のログを覚えておき、求められたらいまの写し（`snapshot`）を返す。
  質問への答えで使う（[タスクと工程](tasks-and-steps.md#オーケストレーターに質問)）。
  - 写しは、ファイルに書いた分とメモリーに持つ分（先頭の書きかけの行・末尾・境目をまたぐ値のために持っている分。伏せてから使う）をつなげる。
  - そのときの秘密情報（後から分かった値も）で伏せ直し、最後の改行で切る。
  - 末尾の前を省いていれば、閉じたときと同じ目印を入れる。
  - ファイルそのものは変えない。
  - 閉じた実行・ほかのデーモンが開いた実行の写しは無い。
- エージェントの設定の場所のセッションのファイルの写しは `runs/<タスク ID>/<実行 ID>/agent/` に置く（[エージェントの実行](agent-execution.md)）。
- タスクを中止しても消さない。
- 画面は `GET /api/tasks/:id/runs/:runId/log` などで読み、Claude Code（stream-json）と Codex（`exec --json`）の出力を読み分けて表示する。

コード: `apps/daemon/src/session-logs.ts`（`SessionLogStore`・`SessionLog.snapshot`・`SESSION_LOG_LIMITS`・`TRUNCATED_EVENT`・`StreamRedactor`）、`apps/web/src/lib/session-log.ts`（`parseSessionLog`）

## 画面の表示

- タスクの詳細は `GET /api/tasks/:id` の `{ task, activity }` を読み、作業履歴を新しい順に、イベントの種類ごとの文で並べる。
- 工程ごとの費用の表は、費用を持つイベントを行（[費用](#費用)の表）ごとに分けて集計する。
  行の順は次のとおり。
  1. 情報収集・チケットの読み取り・リポジトリの選択・オーケストレーター（記録があるときだけ）
  2. タスクの工程の順の工程
     - 実行していない工程も0回で出す。
     - 工程の一覧に無い工程の記録も出す。
     - デプロイの確認は、マージの後の監視の工程の行に入れる。
       実行中も出す。
  3. 書き出し・質問への答え・エラーの分析・戻し先の判断・提案の選り分け・以前の版の AI の判定（記録があるときだけ）
- 人が決めたチケットの読み取り・リポジトリの選択と、工程を固定していた頃の `StepsChosen`（エージェント・費用・使用量が無い）は、実行に数えない。
- 表の合計の費用と推定かどうかは、作業履歴の順に `chargeBudget` で足す。
  そのため、タスクの費用（`budget.usedUsd`・`budget.estimated`）と一致する。
- 実行ごとの内訳の結果は、完了・失敗・中断・実行中・使わなかった。打ち切ったレビューの実行（`ReviewRunStopped` の `runIds`）は、中断として出し、その記録の費用を付ける。「使わなかった」は、エージェントの実行は完了したが、sacty が結果を使わなかった実行（観点ごとの担当を 1 件も起動しなかった PR のレビュー。`reviewDispatch` を持つ `AgentRunFailed`。[PR のレビューだけのタスク](tasks-and-steps.md#pr-のレビューだけのタスク)）。費用は、ほかの実行と同じに数える。
- 不明な実行（`costUnknown`）は、実行ごとの内訳・工程の行・合計で、読めた分があれば「以上」、無ければ「不明」と出す。
  表の下に、不明の回数（`unknownRuns`。合計は `budget.unknownRuns` と同じ）の注記を出す。タスクの詳細の右の列の「費用」にも、不明の回数を出す。
- 表のセルには、推定（換算した概算）かどうかの印を出さない（表を読みにくくするため）。
  換算値で実際の請求ではないことは、表の見出しの補足で説明する。

コード: `apps/web/src/lib/labels.ts`（`describeEvent`）、`apps/web/src/lib/step-costs.ts`（`stepCosts`）、`apps/web/src/components/step-costs.tsx`（`StepCosts`）

## 整形の検査の記録

`AgentRunStarted` の `formattingBaseline` は起点のツリーと、間の取り込みの前後のツリーを持つ。
`AgentRunCompleted` の `formatting` は伏せた申告を持ち、`FormattingOnlyRejected` は件数だけを持つ。
`FinalReviewSkipped` の `formatting` は残った件数と申告を持ち、投影は最後の提出の値に置き換える。
前の版は既存の記録に足した欄を捨てるが、新しい種類を読めない。
版を戻す前に、作業履歴の `activity` テーブルで `type` が `FormattingOnlyRejected` の行が無いことを確認する。
行がある場合は前の版へ戻さず、修正版を使う。

コード: `packages/core/src/events.ts`、`packages/core/src/projection.ts`
