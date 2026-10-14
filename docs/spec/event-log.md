# 作業履歴（イベントと投影）

タスクに起きたことは、すべて作業履歴（追記専用のイベントの列）に記録する。タスクの状態は保存せず、起動のときに作業履歴を
先頭から読み直して作る（投影）。実行ごとのエージェントの出力（セッションログ）は大きいので、作業履歴ではなくファイルに置く。

関係する ADR: なし

## イベントの形

- 書くときの形は `{ type, payload }`。`type` で種類を分ける zod の判別共用体（`EventInput`）で検証する。種類は60（タスクの作成・分割、
  工程の進行、エージェントの実行、予算・一時停止・再開・中止、変更の申し出と判定、検証、git・PR、レビュー、取り込み元への返信、
  質問、書き出しなど）。
- 記録した後の形（`ActivityEvent`）は、それに `seq`（作業履歴全体で単調に増える）・`id`（UUID）・`taskId`・`projectId`・`at`
  （同じ追記の中のイベントは同じ時刻）・`actor` を足したもの。
- `actor` は `person`・`sacty`・`orchestrator`・`guardian`・`agent` のどれか。
- AI を使ったイベントの多くは、トークン数（`usage`：`input`・`cacheRead`・`cacheWrite`・`output`）・費用（`costUsd`）・推定かどうか
  （`estimated`）・使った AI の設定（`authMode`・`model`・`reasoningEffort`）・実行の ID（`runId`）を持つ。
- イベントの版の番号は無い。古い作業履歴は、スキーマの既定値（`.default`）・任意の項目（`.optional`）・読み替え（`.transform`）で読む。
- 利用者に見せる文は `DaemonText`（文字列か、文言のコードと引数 `{ code, params }`）で持つ。画面と通知が、その言語（`ja`・`en`）の
  文言にする。知らないコードや引数が合わないときは、コードの文字列をそのまま出す（例外にしない）。

コード: `packages/core/src/events.ts`（`EventInput`・`ActivityEvent`・`Actor`・`TokenUsage`）、`packages/core/src/message-code.ts`（`DaemonText`・`message`）、`packages/core/src/messages.ts`（`renderMessage`・`DAEMON_MESSAGES`）

## 保存

- `SACTY_HOME/sacty.db`（SQLite、`node:sqlite`、WAL）の `activity` テーブル。列は `seq`（自動増分の主キー）・`id`・`task_id`・`project_id`・
  `at`・`actor`・`type`・`payload`（JSON）。
- 更新・削除はトリガー（`activity_no_update`・`activity_no_delete`）で拒否する（追記専用）。
- 追記は `BEGIN IMMEDIATE` から `COMMIT` の中で、1件ずつ `EventInput` で検証して書く。失敗すれば全体を戻す。
- 読むときも1件ずつ `EventInput` で検証する。
- 以前の名前の `ledger` テーブルがあり `activity` が無ければ、名前を変えて引き継ぐ。
- 保存先の口は追記と読み出し（`append`・`all`・`forTask`・`close`）だけ。

コード: `apps/daemon/src/activity.ts`（`SqliteActivityStore`・`SCHEMA`・`RENAME_LEGACY`・`ActivityStore`）

## 投影

- 起動のとき、すべてのイベントを `project` で読み、タスクの ID ごとの `Task` を作ってメモリーに持つ。`seq` が前より大きくなければ
  例外にする。
- イベントを書くときは、先に `applyEvent` でいまの状態に適用できるかを確かめ（できなければ `task.invalidState` の誤り）、作業履歴に
  書いてから、メモリーの状態に適用する。
- 適用できないイベント（二重の作成・知らないタスク・中止したタスクへのイベント・状態や実行の ID の食い違いなど）は、投影が例外にする
  （中止したタスクでも、セッションの保存の記録 `AgentSessionArchived`・`OrchestratorSessionUsed` は受け付ける）。
- 記録だけで状態を変えないイベントもある（`AiRequestsRetried`・`ServicesStarted`・`AgentSessionArchived`）。
- 費用を持つイベント（[費用](#費用)の12種類）は、適用できたときに、その `costUsd` をタスクの `budget.usedUsd` に足す
  （小数第6位で丸める）。`estimated` が1件でもあれば、`budget.estimated` を立てる。
- `Task` の主な項目：`status`、`steps`（工程ごとの `todo`・`active`・`done`・`skip`）、工程の出力と承認した成果、承認の待ち（`gate`）、
  指摘（`remarks`）、変更の申し出（`proposals`）、予算（`budget`）、実行中の実行の ID、検証・テスト・最終レビュー・統合レビューの結果、
  PR とタスクブランチ、分割の親子、一時停止の理由、質問、書き出し、オーケストレーターのセッション。

`status` の値：

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

コード: `packages/core/src/projection.ts`（`project`・`applyEvent`・`Task`・`TaskStatus`）、`packages/core/src/cost.ts`（`chargeBudget`）、`apps/daemon/src/service.ts`（`TaskService.append`）

## 費用

- 単価（`PricePerMTok`）は100万トークンあたりの米ドルで、`input`・`cachedInput`・`cacheWrite`（既定 0）・`output`。
- 費用 = (`input`×`input` の単価 + `cacheRead`×`cachedInput` の単価 + `cacheWrite`×`cacheWrite` の単価 + `output`×`output` の単価) ÷ 10^6
  （分子を整数に丸めてから割る）。
- サブスクリプションとスタブの実行は、同じ単価で換算した推定の費用（`estimated`）として扱い、予算の判定に使う。
- タスクの予算に入れる費用を持つイベントは、次の12種類（`CHARGED_EVENT_TYPES`）。`costUsd` を持つイベントはこれですべて
  （統合レビューの `IntegrationReviewed` は費用を持たず、続く `AgentRunCompleted` に記録する）。

  | イベント | 工程ごとの費用の表の行 |
  | --- | --- |
  | `TicketTriaged` | チケットの読み取り（`triage`） |
  | `RepositoryChosen` | リポジトリの選択（`repository`） |
  | `StepsChosen`・`OrchestratorFailed` | オーケストレーター（`orchestrator`） |
  | `AgentRunCompleted`・`AgentRunFailed` | その工程 |
  | `OutputExported` | 書き出し（`export`） |
  | `QuestionAnswered` | 質問への答え（`chat`） |
  | `ChangeJudged`・`ReworkJudged`・`FinalReviewed`・`FinalReviewFailed` | ゴールガーディアン（`guardian`） |

- 投影と工程ごとの費用の表は、どちらも同じ規則（`chargeBudget`）で費用を足す。一覧に無い種類が `costUsd` を持つと、型の検査で
  typecheck が通らない。
- 予算の状態（`budgetState`）：使った額が上限以上なら `exceeded`、まだ通知していなくて上限の `BUDGET_WARN_RATIO`（0.8）以上なら `warn`、
  それ以外は `ok`。

コード: `packages/core/src/cost.ts`（`PricePerMTok`・`computeCostUsd`・`budgetState`・`CHARGED_EVENT_TYPES`・`isChargedEvent`・`addUsd`・`chargeBudget`）、`packages/core/src/events.ts`（`BUDGET_WARN_RATIO`）、`apps/daemon/src/service.ts`（`executeLogged`）

## セッションログ（実行ごとのファイル）

- 置き場所は `SACTY_HOME/runs/<タスク ID>/`。実行ごとに `<実行 ID>.jsonl`（エージェントの標準出力の JSONL）・`<実行 ID>.stderr.log`
  （標準エラー出力）・`<実行 ID>.meta.json`（役割・AI・開始と終了の時刻・結果・切り詰めたか）。ファイルは 0600、ディレクトリは 0700。
- 1実行あたり、出来事は先頭 15MB と末尾 3MB、標準エラー出力は先頭 1MB と末尾 1MB を残し、間を省いた目印（JSONL は
  `{"type":"sacty.truncated", …}` の行）を入れる。
- 書く前に秘密情報を伏せる（届いた出力の切れ目をまたぐ値も伏せる。後から分かった値は、閉じるときにファイル全体を伏せ直す）。
- 書き込みに失敗しても実行は止めない（警告を1回出す）。
- エージェントの設定の場所のセッションのファイルの写しは `runs/<タスク ID>/<実行 ID>/agent/` に置く（[エージェントの実行](agent-execution.md)）。
- タスクを中止しても消さない。
- 画面は `GET /api/tasks/:id/runs/:runId/log` などで読み、Claude Code（stream-json）と Codex（`exec --json`）の出力を読み分けて表示する。

コード: `apps/daemon/src/session-logs.ts`（`SessionLogStore`・`SESSION_LOG_LIMITS`・`TRUNCATED_EVENT`・`StreamRedactor`）、`apps/web/src/lib/session-log.ts`（`parseSessionLog`）

## 画面の表示

- タスクの詳細は `GET /api/tasks/:id` の `{ task, activity }` を読み、作業履歴を新しい順に、イベントの種類ごとの文で並べる。
- 工程ごとの費用の表は、費用を持つイベントを行（[費用](#費用)の表）ごとに分けて集計する。行の順は、チケットの読み取り・
  リポジトリの選択・オーケストレーター（記録があるときだけ）、タスクの工程の順の工程（実行していない工程も0回で出す。工程の一覧に無い
  工程の記録も出す）、書き出し・質問への答え・ゴールガーディアン（記録があるときだけ）。
- 人が決めたチケットの読み取り・リポジトリの選択と、工程を固定していた頃の `StepsChosen`（エージェント・費用・使用量が無い）は、
  実行に数えない。
- 表の合計の費用と推定かどうかは、作業履歴の順に `chargeBudget` で足すので、タスクの費用（`budget.usedUsd`・`budget.estimated`）と
  一致する。

コード: `apps/web/src/lib/labels.ts`（`describeEvent`）、`apps/web/src/lib/step-costs.ts`（`stepCosts`）、`apps/web/src/components/step-costs.tsx`（`StepCosts`）
