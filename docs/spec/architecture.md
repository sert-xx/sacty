**日本語** | [English](architecture.en.md)

# 全体の構成

sacty は、npm workspaces の4つのパッケージでできている。
`sacty` コマンド（cli）が、常駐するデーモン（daemon）と画面（web）を起動する。
画面はデーモンの API だけを呼び、デーモンが作業履歴への記録と工程の実行（コンテナ）を行う。

関係する ADR: なし

## パッケージ

| パス | パッケージ | 役割 | 依存（sacty の中） |
| --- | --- | --- | --- |
| `packages/core` | `@sacty/core` | 作業履歴のイベントの型、イベントからタスクの状態を作る投影、費用の計算、プロジェクト・sacty の設定の型、文言のコード | なし（外部は `zod` だけ） |
| `apps/daemon` | `@sacty/daemon` | 常駐プロセス。HTTP の API、作業履歴（SQLite）、工程の実行、ゲートウェイ、取り込み、通知 | `@sacty/core` |
| `apps/web` | `@sacty/web` | 画面（Next.js）。操作はデーモンの API に依頼する | `@sacty/core` |
| `packages/cli` | `sacty` コマンド | `sacty up` などのコマンドと、エージェント実行用のイメージの Dockerfile（`packages/cli/docker/Dockerfile`） | `@sacty/core`・`@sacty/daemon`・`@sacty/web` |

コード: `packages/core/package.json`、`apps/daemon/package.json`、`apps/web/package.json`、`packages/cli/package.json`

## プロセスと通信

![プロセスと通信](images/architecture.svg)

- デーモンの API（`/api/*`）は、`sacty up` が起動のたびに作るトークンを `Authorization: Bearer` で求め（`timingSafeEqual` で比べる）、合わなければ 401（`unauthorized`）を返す。
  `127.0.0.1` だけで待ち受ける。
- 画面は、Next.js のサーバー側でだけデーモンを呼ぶ（トークンをブラウザに渡さない）。
  接続先とトークンは、環境変数 `SACTY_DAEMON_URL`・`SACTY_DAEMON_TOKEN` からリクエストのたびに読む。
- デーモンは誤りを次のように返す。
  どちらも文言のコードと引数で返し、画面が画面の言語の文言にする。
  - 入力の誤り（zod の検証）：400 で `invalid_input`
  - 操作できない状態：409 で `invalid_operation`

主な API は次のとおり（`apps/daemon/src/server.ts`）。

| 種類 | パス |
| --- | --- |
| 状態 | `GET /api/health`・`GET /api/status`・`GET /api/dashboard`・`GET /api/github/accounts` |
| タスク | `GET/POST /api/tasks`（`GET` の `?open=1` は終わっていないタスクだけ）・`GET /api/tasks/:id`・`POST /api/tasks/:id/{approve,request-changes,pause,resume,cancel,rerun,derive,submit-for-review,security-fixes,repository,agents,images,questions,rereview,error-analysis}`・`GET /api/tasks/:id/{cleanup-plan,security-findings,error-report}`・`POST /api/tasks/:id/remarks/:remarkId/void`・`POST /api/tasks/:id/proposals/:proposalId/decide`・`POST /api/tasks/:id/exports/:step/retry` |
| 実行の記録 | `GET /api/tasks/:id/runs/:runId/log`・`…/files/:file`・`…/agent-files`・`…/agent-files/raw` |
| プロジェクト | `GET/POST /api/projects`・`GET/PUT/DELETE /api/projects/:id`・`GET /api/projects/:id/{repositories,platforms,export}`・`GET/POST /api/projects/:id/context-preview`・`POST /api/projects/import` |
| スケジュールタスク | `GET/POST /api/projects/:id/schedules`・`GET/PUT/DELETE /api/schedules/:id` |
| 監査 | `GET /api/tasks/:id/audit`・`POST /api/tasks/:id/audit/resume`・`GET /api/projects/:id/audits`・`GET /api/audits/dashboard`・`POST /api/audits/proposals/:id/{adopt,reject}`・`POST /api/audits/memories/:id/delete` |
| sacty の設定 | `GET/PUT /api/settings`・`POST /api/settings/notification-test`・`GET /api/notifications`・`POST /api/intake/run`・`POST /api/secrets/prefetch` |

コード: `apps/daemon/src/server.ts`（`createApp`・`handleError`）、`apps/web/src/lib/daemon.ts`（`daemonFetch`）、`packages/cli/src/index.ts`（`up`）

## 画面の構成（URL）

| URL | 中身 |
| --- | --- |
| `/` | `/dashboard` へ移す |
| `/dashboard` | ダッシュボード。すべてのプロジェクトをまたいで見る |
| `/projects` | プロジェクトの一覧（作成・インポート） |
| `/projects/<ID>` | `/projects/<ID>/tasks` へ移す |
| `/projects/<ID>/tasks` | そのプロジェクトのタスクの一覧（人間の判断が必要なタスクのカード・「タスクを作成」） |
| `/projects/<ID>/settings` | そのプロジェクトの設定 |
| `/projects/<ID>/schedules`・`/projects/<ID>/schedules/<スケジュールタスクの ID>` | そのプロジェクトのスケジュールタスクの一覧・詳細（[スケジュールタスク](scheduled-tasks.md)） |
| `/projects/current`・`/projects/current/tasks`・`/projects/current/schedules` | 表示しているプロジェクト（cookie）の設定・タスクの一覧・スケジュールタスクの一覧へ移す（303）。ほかの `/projects/current/…`（`/projects/current/settings` も）は 404 |
| `/tasks/<ID>`・`/tasks/<ID>/review`・`/tasks/<ID>/runs/<実行の ID>` | タスクの詳細・成果物のレビュー・実行のログ |
| `/tasks/<ID>/error-report` | エラーレポートのダウンロード（[エラーレポート](error-report.md)） |
| `/settings` | sacty の設定 |

- 画面の中のリンクと移動先は、`apps/web/src/lib/paths.ts` で作る（プロジェクトの ID はエンコードする）。
  - プロジェクトの作成・インポートの後は、そのプロジェクトの設定（`/projects/<ID>/settings`）へ移る。
  - タスクの詳細の「タスク」（パンくず）は、そのタスクのプロジェクトのタスクの一覧へ戻る。
    タスクを読む前と、デーモンに届かないときは `/projects/current/tasks` へ戻る。
- タスクの詳細の並び（`TaskDetailView`）
  - 題・状態・工程の並び・操作（一時停止・中止・再レビュー）・タブを、画面の上に固定する（スクロールしても見える）。
  - 承認・判断を待っているときの案内（`GateNotice`）と再開の欄は、どのタブでもタブの下に出す。
  - タブは、概要・作業履歴・費用・工程の設定・監査（完了したタスクだけ）。開いたタブは `?tab=` に残す（概要なら付けない。出していないタブの指定は概要にする）。
    隠したタブの中身も描いておき、入力の途中の文字や開いた欄はタブを切り替えても消えない。
  - URL のハッシュ（`#event-<ID>`・`#audit`・`#proposals` など）の要素が隠したタブの中にあれば、そのタブを開いてから要素へ移る（開いたとき・同じ画面の中でハッシュが変わったとき・同じ画面へのハッシュ付きのリンクを押したとき。画面の中のリンクは `hashchange` を起こさないので、押したリンクのハッシュで開く）。不正なパーセント表記のハッシュは無視する。
  - タブ（表示のタブ・成果物の工程）は、左右の矢印キー・Home・End で移れる（選んだタブだけがフォーカスの順に入る）。
  - 概要の成果物は、工程を選んで1つずつ出す（`Deliverables`）。最初は、作業中・承認待ち・最後に終えた工程の順に選ぶ（`currentStep`）。
    1つずつ出すので、承認済みのカードも折りたたまない（`ExpandCards`）。まだ始まっていないマージの後の監視は選べない（工程が無くても監視の記録がある古いタスクは選べる）。
  - 右の列に、プロパティ（いまの工程・PR・費用・プロジェクト・リポジトリ・ブランチ・テスト・元のチケット・関係するタスク・作成と最終更新）・エラーレポート（エラーの記録があるタスクだけ。[エラーレポート](error-report.md#画面)）・最近の作業履歴（5件）の順に出す。
  - 変更の申し出と判定の欄は、申し出があるときだけ出す。
- プロジェクトの画面のプロジェクトは、URL の ID で決める。
  デーモンのプロジェクトの一覧に無い ID なら 404。
- タスクの一覧の「すべてのタスク」は、画面の中で絞り込める（`TaskFilterBar`・`matchesFilter`）。タスクが1件も無いときは出さない。
  - 条件：題に含む文字（大文字と小文字を区別しない）・開始時期（作った日時 `createdAt` を、画面のタイムゾーンの日にして比べる。
    から・まで の両端の日を含む）・開始地点・作業するリポジトリの名前（決まっていないタスクは「未定・リポジトリ無し」）・
    状態の種類（`statusTone`。「終わっていない」は完了と中止のほか）。空の条件は絞り込まない。すべての条件に合う行だけを出す。
  - 開始地点とリポジトリの選択肢は、一覧にあるものだけ（リポジトリは名前の順）。
    選んでいる値は、取り直しで一覧から消えても選択肢に残す（`filterOptions`）。
  - 条件はブラウザの中だけで持ち、URL・cookie には残さない。3秒ごとの取り直しでは消えず、別のプロジェクトの一覧へ移ると消える。
  - 件数（「全体の件数中 出している件数」）と、条件があれば「条件をクリア」を出す。合う行が無ければ、そのことを出す。
  - 「あなたの出番」のカードは絞り込まない。
- ダッシュボードは、欄（カード）を並べる。
  幅が足りれば横に並べ、足りなければ縦に積む（欄が1つなら幅いっぱい）。
  欄の並びは、あなたの出番 → 止まっているタスクの理由 → 終わっていないタスク → 費用と予算 → 工程の待ち行列 → 取り込みの状況 → 流量 → 品質の信号。
  すべての欄はすべてのプロジェクトをまたぎ、消したプロジェクトのタスクは出さない・数えない。
  - データは次の3つの経路で取る。
    タスクの全件や作業履歴を3秒ごとに運ばない。
    - 終わっていないタスク（`GET /api/tasks?open=1`。終わったタスクは `isFinished`）。
      完了したタスクの成果物を3秒ごとに運ばないためである。
      完了したものを含む全件は、成果物の大きさによって1回で数十〜数百 MB になる。
      ヘッダーのお知らせ（対応待ち）も同じ経路で取る。
    - 作業履歴を要する集計（`GET /api/dashboard`。下の[ダッシュボードの集計](#ダッシュボードの集計)）。
    - 取り込みの状況（`GET /api/status` の `intake`）。
  - 一覧の欄（あなたの出番・終わっていないタスク・予算に近いタスク）は、1行の高さが 4rem 以上、欄の高さは5件分（20rem）。
    それより多ければ欄の中でスクロールする（キーボードでもスクロールできるよう、欄がフォーカスを受ける）。
    題とプロジェクトの名前は1行に切り詰め、全文はホバー（`title`）と、行にフォーカスがある間の折り返しで出す。
    件数の補足は、言語ごとの文言で組み立てる。
  - 見出しの横の補足（`Hint`）に、仕組み・数字の定義・期間の境を書き、本文には出さない（[画面の文言と補足](ui-wording.md)）。
  - 待っている時間と「続いている」の判定は、画面の時計（1分ごとに進む。`CLOCK_INTERVAL_MS`）で計算する。
    取り直しのたびに版が変わるため、データに「今」を入れない。
  - 空のとき：プロジェクトが無い・該当が無い・設定が無いときは、欄ごとにそのことを出す。
    描いたときにデーモンに届かなければ、欄を出さずに届かないことを出す（届いたら欄を出す）。
    一度出した後に届かなくなったときは、欄を最後に取れた内容のまま残し、更新できないことを出す（[画面のデータの取り直し](#画面のデータの取り直し)）。
  - 欄を足すときは、`DashboardData`（`loadDashboard`）に欄のデータを足し、`LiveDashboard` に `DashboardCard` を足す（取り直しは画面で1つ）。
- 欄の上に、Slack の通知を送れなかった理由（デーモンの警告のうち `notify.failed`。`notificationProblems`）を、sacty の設定へのリンクつきで出す（無ければ出さない）。
  欄と同じく取り直す。

ダッシュボードの欄ごとの中身は次のとおり。

- あなたの出番
  - 終わっていないタスクのうち、状態の表示が人の出番のものを、待っている時間が長い順に出す。
    人の出番は、`statusTone` が `person` のもの（承認待ち・一時停止・エスカレーション）。
    承認待ちでも、ゴールガーディアンが PR の指摘を判断している間は除く。
  - 各行は、題・プロジェクト・状態・待っている時間。
    題は、人が判断する場所へのリンク（`personAction`）。
    PR で確かめる工程は PR を新しいタブで開く（[承認と差し戻し](approval.md#pr-での承認)）。
  - 待ち始めは、その状態になった作業履歴の記録（`StepSubmitted`・`TaskPaused`・`TaskEscalated`・再現できなかった `ReproductionChecked`）の最後の時刻（集計の `waitingSince`）。
    記録が無ければ `updatedAt`。
  - 待っている時間は、分・時間・日のどれか1つ（切り捨て。1分未満は「1分未満」。`durationText`）。
  - 無ければ「対応待ちはありません。」
- 止まっているタスクの理由
  - 一時停止（`paused`）のタスクを、理由（`pausedReason`。無ければ `manual`）ごとに数える。
  - 並びは利用上限・認証・予算・エラー・検証の不合格・人が止めた・子タスクの中止（`PAUSE_REASON_ORDER`）で、件数が 0 の理由は出さない。
  - 利用上限・認証（`FIX_ONCE_REASONS`）は、1か所直せばまとめて動くことが多いので目立たせる。
  - 行は `details` で、開くとその理由のタスク（題はタスクの詳細へのリンク・プロジェクト）が欄の中で広がる。
    取り直しでも同じ要素が残るので、開いた状態は消えない。
  - 無ければ「止まっているタスクはありません。」
- 終わっていないタスク
  - 完了・中止を除くタスクを、最後に動いた順（`updatedAt` の新しい順）に出す。
    承認待ち・一時停止・エスカレーションも含む（`statusTone` が `completed`・`cancelled` でないもの）。
  - 件数の上限は無い。
  - 各行に、題（タスクの詳細へのリンク）・プロジェクトの名前・状態を出す。
  - プロジェクトが無いとき・終わっていないタスクが無いときは、そのことを出す。
- 費用と予算
  - 今日と、今日を含む直近7日の費用（集計の `costs`。完了・中止したタスクの分も含む）。
  - 費用は sacty が使用量と単価から計算した値で、実際の請求額は扱わない。
    そのため、`estimated` かどうかで分けずに「概算」の1行で出す。
  - 予算に近いタスクは、終わっていないタスクのうち、使用済みが上限の 80%（`BUDGET_WARN_RATIO`）以上のもの（上限に達したものを含む）。
    使った割合の大きい順に、使用済み / 上限・上限に達した印つきで出す（`nearBudgetRows`）。
- 工程の待ち行列
  - 実行中の件数 / 同時に実行する数の上限と、実行待ちの件数を出す。
    上限は sacty の設定 `maxParallelTasks`（設定していなければ・読めなければ既定値）。
  - 実行中は、ワーカーが処理しているタスク（`inflight`）。
    状態が `idle` の処理（実装の後の最終レビュー（テストの実行を含む）・書き出しなど）も含む。
  - 実行待ちは、ワーカーが次に処理する対象（`queuedTaskIds`。ワーカーと同じ判定）のうち、まだ処理していないもの。
  - 実行待ちが上限より多い状態が10分（`QUEUE_OVER_MS`）続いたら目立たせ、sacty の設定へのリンクを添える。
  - 「続いている」の始まり（`overSince`）は、デーモンが更新する（`trackQueue`・`queueOverSince`。画面の取得には依らない）。
    更新するのは、作業履歴に書くたび・実行の開始と終わり・sacty の設定とプロジェクトの保存のたび。
    メモリーだけに持ち、再起動で数え直す。
- 取り込みの状況
  - プロジェクトの一覧と同じ表示（`IntakeStatusView`）と、「今すぐ取り込む」（`runIntakeAction`）を出す。
  - 表示は、種類ごとの最後の取り込みの時刻・作ったタスクの数・取り込めなかった対象。
    設定が無い・Off・読めないときは、そのことと sacty の設定へのリンクを出す。
  - 「今すぐ取り込む」は、設定ファイルを読めないときは出さない。
- 流量
  - 今日を含む直近7日・30日の完了・中止の件数と、その期間に完了したタスクの作成（`createdAt`）から完了までの時間の中央値（完了が無ければ「—」）。
  - 終わった時刻は、作業履歴の記録でタスクが終わった（`isFinished` が偽から真になった）時刻。
  - 終わった後に終わっていない状態に戻れば数えず、また終われば新しい時刻で数える。
- 品質の信号
  - 今日を含む直近30日の回数。
  - 差し戻しは、実際に差し戻した記録（`ChangesRequested`）を1回として数える。
    - PR の指摘でゴールガーディアンが戻したもの（投影がその記録の時刻を `prRework` に残す）は「PR の指摘の差し戻し」、ほかは「人の差し戻し」に分ける。
    - 判断 `ReworkJudged` だけで差し戻されなかったものは数えない。
  - 見逃しではない差し戻しも区別できるよう、差し戻しは原因（`ChangesRequested` の `cause`）ごとにも数える（`reworkByCause`）。
    原因が無い記録は「原因が分からない」（`unspecified`）に数える。人が原因を選ばなかった差し戻しや、ゴールガーディアンが判断できなかった指摘の差し戻しが当たる。
    原因を記録する前の作業履歴は、差し戻しの直前（同じタスクの直前の記録）に `GuardianMissed` があれば `guardian_missed`、無ければ `unspecified` に数える。
    ゴールガーディアンの見逃しの回数は `GuardianMissed` の数なので、原因が `guardian_missed` の差し戻しの数とは限らない（合格の最終レビューが無いものは見逃しを記録しない）。
  - ほかに、ゴールガーディアンの見逃し（`GuardianMissed`。原因が見逃しの差し戻しだけが記録する）、統合レビューの不合格（`IntegrationReviewed` の `passed` が偽）、監視で作った修正のタスク（`DeploymentFixRegistered`）を数える。
  - 工程ごとの差し戻しは、人の差し戻しと PR の指摘の差し戻しを、差し戻された成果物の工程ごとに数える。
    工程は `ChangesRequested` の `step`（承認ゲートで止まっていた工程）。
    要求要件・設計・実装（`REWORK_STEPS`）は常に、ほかの工程は回数があるときだけ出す。
  - 「原因が分からない差し戻し」（`reworkByCause.unspecified`）を、「ゴールガーディアンの見逃し」の下に並べて出す（見逃しかどうか分からない差し戻しが、見えなくならないように）。
  - 見逃しではないと分かっている差し戻しは、「新しい要望・方針の変更」「ベースの変化による競合」を原因ごとに出す。
- 期間の境は、画面の言語ではなく、sacty を動かしているマシン（デーモン）のローカルの日付で決める。
  - 今日：その日の 0 時から。
  - 直近7日：今日を含む7日。
  - 直近30日：今日を含む30日。
  - タイムゾーンは集計の `timeZone` で画面に渡し、費用の欄の補足に出す。

コード: `apps/web/src/lib/paths.ts`、`apps/web/src/app/page.tsx`、`apps/web/src/app/dashboard/page.tsx`、
`apps/web/src/app/projects/[id]/page.tsx`、`apps/web/src/app/projects/[id]/tasks/page.tsx`、`apps/web/src/app/projects/[id]/settings/page.tsx`、
`apps/web/src/components/task-list.tsx`（`TaskFilterBar`）、`apps/web/src/lib/task-filter.ts`（`matchesFilter`・`filterOptions`・`localDay`）、
`apps/web/src/app/projects/current/[[...view]]/route.ts`、`apps/web/src/app/tasks/[id]/page.tsx`（`Breadcrumb`）、`apps/web/src/components/task-detail.tsx`（`TaskDetailView`・`GateNotice`・`Deliverables`・`currentStep`・`Properties`）、`apps/web/src/components/card-section.tsx`（`ExpandCards`）、
`packages/core/src/projection.ts`（`isFinished`）、`apps/daemon/src/server.ts`（`createApp`）、`apps/web/src/lib/dashboard-data.ts`（`loadDashboard`・`isOpenTask`・`openTaskRows`・`attentionRows`・`pausedGroups`・`nearBudgetRows`）、`apps/web/src/components/dashboard.tsx`（`LiveDashboard`・`DashboardGrid`・`DashboardCard`・`AttentionCard`・`PausedCard`・`OpenTasksCard`・`CostsCard`・`QueueCard`・`IntakeCard`・`FlowCard`・`QualityCard`・`durationText`）、`apps/web/src/components/intake-status.tsx`（`IntakeStatusView`・`IntakeRunNow`）、`apps/web/src/lib/dashboard-rules.ts`（`PAUSE_REASON_ORDER`・`FIX_ONCE_REASONS`・`REWORK_STEPS`）、`apps/web/src/lib/labels.ts`（`statusTone`・`personAction`）

## ダッシュボードの集計

作業履歴を要する集計（対応待ちの時刻・費用・流量・品質・待ち行列）は、デーモンが `GET /api/dashboard` で返す（`DashboardSummary`）。
画面が3秒ごとに取り直しても、タスクの全件や作業履歴を読み直さない。

- デーモンは、起動のときに作業履歴を読んで状態を復元するのと同じ1回の走査で、イベントを1つずつ `DashboardStats` に畳み込む（`project` の `applied`）。
  作業履歴に書き足すときも、適用したイベントを畳み込む。
- 持つもの
  - タスクごとの、対応待ちになった最後の記録の時刻（`StepSubmitted`・`TaskPaused`・`TaskEscalated`・再現できなかった `ReproductionChecked`）。
  - 費用を持つイベント（`CHARGED_EVENT_TYPES`。費用が 0 のものは持たない）の時刻・費用。
  - タスクが終わった時刻（`isFinished` が偽から真になったイベントの時刻。終わっていない状態に戻れば消す）と作成からの時間。
  - 品質の信号のイベントの時刻・種類・工程。
- 32日（`KEEP_DAYS`）より古い記録は捨てる。
  捨てるのは、畳み込みの中で記録の時刻で1日に1回と、集計のとき。
  32日は、直近30日の欄と日付の境の余裕の分で、画面を開かずに動かし続けても記録は増え続けない。
- 集計のときは、今あるプロジェクトの ID と今のタスクを渡し、消したプロジェクトのタスクの記録は数えない（プロジェクトが戻れば数える）。
- 返すもの
  - `timeZone`
  - `waitingSince`（対応待ちのタスクだけ）
  - `costs`（`today`・`days7` の費用（米ドル。`estimated` で分けない）と期間の始まり `since`）
  - `flow`（`days7`・`days30` の `completed`・`cancelled`・`medianLeadMs` と `since`）
  - `quality`（`since`・`counts`・`reworkBySteps`）
  - `queue`（`running`・`queued`・`max`・`overSince`）
  - 「今」の時刻は返さない（画面の時計で計算する）。
- 期間の境は、デーモンのマシンのローカルの日付（`localDayStart`）。
  未来の時刻の記録は除かない（デーモンの時計で記録したものだけなので）。
  中央値（`median`）は、偶数個なら真ん中2つの平均。

コード: `packages/core/src/dashboard.ts`（`DashboardStats`・`localDayStart`・`median`）、`packages/core/src/projection.ts`（`project`）、`apps/daemon/src/service.ts`（`dashboard`）、`apps/daemon/src/server.ts`（`createApp`）、`apps/web/src/lib/daemon.ts`（`getDashboardSummary`）

## 画面のヘッダーとサイドメニュー（表示しているプロジェクト・お知らせ）

- 開いている画面が、どのプロジェクトの画面かを URL で決める（`pageScope`）。
  - プロジェクトの画面：`/projects/<ID>/tasks`・`/projects/<ID>/schedules`・`/projects/<ID>/audit`・`/projects/<ID>/settings`（URL のプロジェクト）と `/tasks/…`（タスクの詳細・レビュー・実行のログ。表示しているプロジェクト）。
  - 「すべてのプロジェクト」の画面：ほか（ダッシュボード・プロジェクトの一覧・sacty の設定など）。
- ヘッダーのプロジェクトの切り替えは、先頭に「すべてのプロジェクト」（`/dashboard` へ移る）、続けて個別のプロジェクトを出す。
  個別のプロジェクトを選ぶと、`/switch` で cookie を変えてから `/projects/<ID>/tasks` へ移る。
  - プロジェクトの画面では、選んだ表示はそのプロジェクト。
    URL の ID がプロジェクトの一覧に無ければ「すべてのプロジェクト」。
  - 「すべてのプロジェクト」の画面では、選んだ表示は「すべてのプロジェクト」。
    件数はすべてのプロジェクトの対応待ちの合計。
- 表示しているプロジェクトは cookie `sacty-project` に持つ（httpOnly・`SameSite=Lax`・1年）。
  - タスクの詳細などのヘッダーの選んだ表示と、サイドメニューの「タスク」（`/projects/current/tasks`）・「スケジュール」（`/projects/current/schedules`）・「監査」（`/projects/current/audit`）・「設定」（`/projects/current`）は、cookie のプロジェクトを使う。
  - cookie のプロジェクトが無い・無くなっていれば、最初のプロジェクトを使う。
  - cookie に入れる ID は `^[\w-]{1,100}$` の形のものだけ。
- cookie を変えるのは次のとき。
  - ヘッダーの切り替えとお知らせ（`/switch`）。
    移動先が無ければ、切り替えたプロジェクトのタスクの一覧へ移る。
  - プロジェクトの作成・インポート（作ったプロジェクトにする）。
  - プロジェクトの画面（タスクの一覧・スケジュールタスクの一覧と詳細・監査・プロジェクトの設定・タスクの詳細・レビュー・実行のログ）を開いたとき。
    - cookie と画面のプロジェクトが違うときだけ、表示の後にサーバーアクションで変える（画面とヘッダーが描き直される）。
    - デーモンのプロジェクトの一覧にそのプロジェクトが無ければ（削除したプロジェクトのタスク）変えない。
    - 一覧を取れなければ、無いとは扱わずに変える。
- サイドメニューとお知らせは、画面の種類で変わる。

  | 画面 | サイドメニュー | お知らせ |
  | --- | --- | --- |
  | 「すべてのプロジェクト」 | 「設定」だけ。「設定」はプロジェクトの一覧（`/projects`）へ移る（どのプロジェクトにも飛ばない） | プロジェクトで分けずに新しい順。開くと、そのタスクのプロジェクトに切り替えてタスクを開く |
  | プロジェクト | 「タスク」「スケジュール」「監査」「設定」 | 「ほかのプロジェクト」「このプロジェクト」に分ける |

  サイドメニューに「ダッシュボード」は出さない。
  使わないためで、ダッシュボードはロゴとプロジェクトの切り替えの「すべてのプロジェクト」から開ける。
- ヘッダーは全体のレイアウトにあり、画面の中の移動（リンク）では描き直されない（選んだ表示は、画面の URL から画面の中で決める）。
  お知らせの対象が変わる操作（承認・差し戻し・一時停止・再開・中止・タスクの作成など）のサーバーアクションは、`refresh()` を呼んでヘッダーも描き直させる。
  `redirect` で移るときも、その前に呼ぶ。
- ほかのタブ・CLI・デーモンでの変化（取り込みで増えたタスク・承認・再開・デーモンが拾って動き出したタスクなど）は、下の「画面のデータの取り直し」で、ヘッダーのプロジェクトの切り替え（対応待ちの件数）とお知らせに反映する。
  どの画面でも、タスクの状態によらない。

コード: `apps/web/src/components/shell/header.tsx`（`AppHeader`・`HeaderFallback`）、`apps/web/src/components/shell/live-header.tsx`（`LiveHeaderMenus`・`selectedProject`）、
`apps/web/src/components/shell/menus.tsx`（`ProjectMenu`・`NotificationsMenu`）、`apps/web/src/components/shell/rail.tsx`（`railItems`）、`apps/web/src/lib/page-scope.ts`（`pageScope`）、
`apps/web/src/lib/header-data.ts`（`loadHeaderData`）、`apps/web/src/components/shell/follow-project.tsx`（`FollowProject`）、
`apps/web/src/lib/project-select.ts`、`apps/web/src/lib/current-project.ts`（`selectProject`）、
`apps/web/src/app/switch/route.ts`、`apps/web/src/app/actions.ts`

## 画面のデータの取り直し

次の画面は、画面をリロード（`router.refresh` を含む、画面の全体の描き直し）しない。
データだけを一定の間隔で取り直し、変わった所だけを画面に反映する。

- ダッシュボード
- タスクの一覧
- タスクの詳細
- 成果物のレビュー
- 実行のログ
- プロジェクトの一覧（取り込みの状況）
- ヘッダーのお知らせ

画面の要素がそのまま残るので、入力の途中の文字・選択・開いたダイアログや欄（`details`）・フォーカス・スクロールの位置は消えない。

- 取り直す先（画面のサーバーのルート）と、返すものは次のとおり。

  | 先 | 返すもの |
  | --- | --- |
  | `GET /live/dashboard` | ダッシュボードの欄のデータ（あなたの出番・止まっている理由・終わっていないタスク・費用と予算・待ち行列・取り込みの状況・流量・品質の信号・通知を送れなかった理由。`loadDashboard`） |
  | `GET /live/tasks?project=<ID>` | URL のプロジェクトの、タスクの一覧の行と、人間の判断が必要なタスクのカード（表示に要るものだけ。`loadTaskList`）。プロジェクトが無い・ID の形が違えば `{ missing: true }` |
  | `GET /live/tasks/<ID>` | タスクの詳細に出すもの（タスク・作業履歴・親・子タスク・片付けるもの・イメージの候補など。`loadTaskDetail`）。タスクが無ければ（消したプロジェクトのタスクを含む）`{ missing: true }` |
  | `GET /live/header?current=<ID>` | ヘッダーのプロジェクトの切り替え（対応待ちの件数）とお知らせ（`loadHeaderData`） |
  | `GET /live/tasks/<ID>/review` | 成果物のレビューの画面のタスク。タスクが無ければ（消したプロジェクトのタスクを含む）`{ missing: true }` |
  | `GET /live/tasks/<ID>/runs/<実行の ID>?events=&stderr=` | 実行のログの、画面が持っている分に足された分（下を参照） |
  | `GET /live/projects` | プロジェクトの一覧と、取り込みの状況（`loadProjectList`） |
  | `GET /live/update` | sacty の新しい版の知らせ（`loadUpdateData`。30秒ごと。[デーモンの起動と終了](daemon-lifecycle.md#最新版の確かめ)） |
  | `GET /live/docker` | Docker とエージェントのイメージの注意（`loadDockerData`。30秒ごと。[デーモンの起動と終了](daemon-lifecycle.md#docker-とエージェントのイメージの確かめ)） |
  | `GET /live/notifications?after=<番号>` | デスクトップ通知に出す、番号より後の通知（`loadDesktopFeed`。5秒ごと。このブラウザでデスクトップ通知を On にしているときだけ取り直し、版の比べは使わず、タブが隠れている間も取り直す。[通知](notifications.md#デスクトップ通知)） |

- 間隔は3秒（`LIVE_INTERVAL_MS`）。
  ただし、`/live/update`・`/live/docker`（どの画面にも出す知らせ）は30秒（`UPDATE_LIVE_INTERVAL_MS`・`DOCKER_LIVE_INTERVAL_MS`）、`/live/notifications` は5秒（`DESKTOP_INTERVAL_MS`）。
  タスクの状態によらず、タスクが無いとき・すべてが承認待ち・一時停止・完了のときも取り直す。
  前の取り直しが終わってから次の間隔を数えるので、問い合わせは重ならない。
- `{ missing: true }` のとき、表示は最後のデータのまま残す。タスクの詳細・成果物のレビュー・実行のログは、画面を描き直す（`RefreshWhenMissing`。
  サーバーがタスクを無いものとして 404 にするので、開いている間に消したプロジェクトのタスクを残さない）。
- 画面が見えていない（タブが隠れている）間は問い合わせない。
  見えたら、すぐに一度取り直す。
- タスクの一覧は URL のプロジェクトを、ヘッダーは画面を描いたときのプロジェクトのまま取り直す。
  ほかのタブでプロジェクトを切り替えても、この画面の中身だけが変わらないようにするためである。
  プロジェクトを変えるのは、画面を開き直したとき（`/switch` など）。
- 画面は、前に受け取ったデータの版（中身のハッシュ）をヘッダー `x-sacty-live-version` で送る。
  同じなら、画面のサーバーは中身を送らない（`{ unchanged: true }`）。
- 1回の取り直しの期限は10秒（`LIVE_TIMEOUT_MS`）。
  - 画面は、応答の本文を読む間も含め、期限で中断し、次の取り直しを予約する。
    応答しない画面のサーバーやデーモンで、取り直しが止まったままにならないようにするためである。
  - 画面のサーバーも、デーモンへの問い合わせに、ブラウザの中断（リクエストの中断）と8秒の期限（`LIVE_SERVER_TIMEOUT_MS`）を渡し、本文を読む間も含めて止める（`withDaemonSignal`）。
    応答しないデーモンへの問い合わせを、取り直しのたびに溜めないためである。
  - 取っている間にサーバーが画面を描き直したときは、その取り直しの結果（失敗も）を捨てる。
- デーモンに届かない・読めないときは、200 で `{ unavailable: true }` を返す（エラーを出し続けない）。
  - 画面は、表示を最後に取れたデータのまま残し、更新できないこと（表示が今の値でないかもしれないこと）を出す。
    ヘッダーは「更新が止まっています」と出す。
  - 期限切れ・画面のサーバーに届かないときも同じ。
  - 届くようになったら、次の間隔でまた反映し、その表示を消す。
- 画面を描いたときに届かなかったときは、届くまでつながらないことを出し、届いたら中身を出す。
  タスクの一覧・タスクの詳細・成果物のレビュー・実行のログは、そのとき、出した中身のプロジェクトを表示しているプロジェクトにする（`followProjectAction`。cookie と違うときだけ）。
  描いたときに届いていれば、サーバーの `FollowProject` が合わせる。
- ヘッダーは、プロジェクトが1つも無いときも取り直す（切り替えとお知らせは出さない）。
  ほかのタブや CLI で最初のプロジェクトを作ったら、切り替えとお知らせを出す。
- 取り直しでは、対象リポジトリの候補（Org の対象は `gh` で GitHub に問い合わせる）を取らない。
  - タスクの作成のダイアログの候補は、ダイアログを開いたときに一度だけ読む（[タスクと工程](tasks-and-steps.md)）。
  - タスクの詳細で一時停止して人がリポジトリを選ぶときの候補は、まだ持っていないときだけ求める（`?repositories=1`）。
    取れなかったとき（`ticketRepositoriesFailed`。取れた0件とは分ける）は、30秒（`REPOSITORIES_RETRY_MS`）空けて求め直す。
- 操作（承認・一時停止・再開など）のサーバーアクションが `refresh()` で画面を描き直したときは、そのときのデータを使う。
- 実行のログは、画面が持っている分の終わりの位置（ファイルの中のバイト）を送る。
  - デーモン（`GET /api/tasks/:id/runs/:runId/log` の `?eventsFrom=&stderrFrom=`）も、実行中はその位置より後だけを読み、画面のサーバーと画面へも足された分だけを送る。
  - 返した分の位置は `offsets`（`from`・`next`）で返し、書いている途中の文字（UTF-8 の複数バイトの途中）は次に回す。
  - 実行が終わった後と、位置がファイルより後ろのときは、全体を返し、画面は置き換える。
    実行が終わった後は、閉じるときに伏せ直しや上限でファイルが書き直されうるためである。
  - 読んでいる途中のスクロールの位置は動かさず、一番下を見ているときだけ、新しい行についていく。
  - エージェントの元のファイルの一覧（ハッシュを計算する）は、実行が終わってから取る。
    一覧だけを読めないときは、ログと終わったことは返す（`agentFilesFailed`）。
    画面は一覧を読めず取り直していることを出して、一覧だけを取り直す。
  - 実行が終わり、一覧も取れたら、ログの取り直しを止める。その後は、タスクがまだあるかだけを確かめる（`?check=1`。ログ・ファイルは読まない）。
    無ければ（プロジェクトを削除した）、画面を描き直して 404 にする（`RefreshWhenMissing`）。
- sacty の設定・プロジェクトの設定の画面は、自動で描き直さない（ヘッダーのお知らせだけを取り直す）。
  中身は人が編集する設定で、タスクの状態では変わらないためである。
  最新にするには、開き直すか、画面を読み直す。

コード: `apps/web/src/lib/live.ts`（`pollWhileVisible`・`fetchLive`・`LIVE_INTERVAL_MS`・`LIVE_TIMEOUT_MS`）、`apps/web/src/lib/use-live-data.ts`（`useLiveData`）、
`apps/web/src/lib/live-server.ts`（`liveResponse`・`liveVersion`）、`apps/web/src/app/live/tasks/route.ts`、`apps/web/src/app/live/tasks/[id]/route.ts`、`apps/web/src/app/live/header/route.ts`、`apps/web/src/app/live/dashboard/route.ts`、`apps/web/src/lib/task-list-data.ts`（`loadTaskList`）、
`apps/web/src/lib/task-detail-data.ts`（`loadTaskDetail`）、`apps/web/src/components/task-list.tsx`（`LiveTaskList`）、
`apps/web/src/components/task-detail.tsx`（`LiveTaskDetail`）、`apps/web/src/components/review.tsx`（`LiveReview`）、`apps/web/src/components/live-status.tsx`（`RefreshWhenMissing`）、
`apps/web/src/components/run-log.tsx`（`LiveRunLog`・`applyChunk`）、`apps/web/src/lib/run-log-data.ts`（`loadAgentFiles`）、
`apps/web/src/components/live-status.tsx`（`StaleNotice`・`FollowProjectAfterRecovery`）、`apps/daemon/src/session-logs.ts`（`completeUtf8Length`）、`apps/web/src/lib/daemon-signal.ts`（`withDaemonSignal`・`LIVE_SERVER_TIMEOUT_MS`）、
`apps/web/src/components/project-list.tsx`（`LiveProjectList`）、`apps/web/src/lib/project-list-data.ts`（`loadProjectList`）、
`apps/web/src/app/live/update/route.ts`、`apps/web/src/components/shell/update-notice-live.tsx`（`UPDATE_LIVE_INTERVAL_MS`）、`apps/web/src/app/live/docker/route.ts`、`apps/web/src/components/shell/docker-notice-live.tsx`（`DOCKER_LIVE_INTERVAL_MS`）、`apps/web/src/app/live/notifications/route.ts`、`apps/web/src/lib/desktop-notifications.ts`（`DESKTOP_INTERVAL_MS`）

## データの置き場所（SACTY_HOME）

`SACTY_HOME`（既定 `~/.sacty`）の下に置く。

| パス | 中身 |
| --- | --- |
| `config.yaml` | sacty の設定（AI・認証・イメージ・ゲートウェイなど）。デーモンは使うたびに読み直す |
| `sacty.db` | SQLite。作業履歴（イベント）・プロジェクト・スケジュールタスク・sacty の設定（画面の「sacty の設定」） |
| `daemon.lock`・`daemon-owner.json` | 二重の起動の判定と表示（[デーモンの起動と終了](daemon-lifecycle.md)） |
| `daemon.json` | `sacty context preview` が問い合わせる、起動中のデーモンの接続先とトークン |
| `workspaces/` | 作業領域。`<タスク ID>/repo`（対象リポジトリの clone）・`<タスク ID>/empty`（リポジトリの無いタスク）・`_git/<タスク ID>.git`（clone 直後の git のメタデータの退避。どのコンテナにもマウントしない）・実行ごとの `_guardian/<実行 ID>`・`_snapshots/<実行 ID>`・`_review/<実行 ID>`・`_input/<実行 ID>`・`_export/<実行 ID>`・`_deployment/<実行 ID>`・`_handoff/<実行 ID>`・`_question-logs/<実行 ID>`・`_audit-logs/<実行 ID>`・`_audit-ledger/<実行 ID>`・`_shared-compose/<実行 ID>`（実行の終わりに消す。中断で残ったものは起動のときに消す。`_shared-compose` は起動のときにまとめて消す）・`_cache/`。完了したタスクの `<タスク ID>` と `_git/<タスク ID>.git` は、もう使わなくなったら消す（[タスクと工程](tasks-and-steps.md#終わったタスクの作業領域の片付け)） |
| `runs/` | エージェントの実行ごとのセッションログ |
| `sessions/` | タスクごとのオーケストレーターのセッション（使い回しのためのキャッシュ） |
| `cache/shared-compose/` | 共用の compose のリポジトリのキャッシュ |
| `host-mcp/processes/` | ホストの MCP サーバー（コンテキストのコマンド型を含む）のプロセスの記録 |
| `context-mcp/layers/` | ホストで起動するコンテキストのコマンド型の MCP サーバーの作業ディレクトリ（層のリポジトリの写し） |
| `memory/` | 監査が登録したメモリー（`projects/<ID>/`・`repos/<ホスト>/<オーナー>/<名前>/`）。正本は作業履歴で、起動のときに書き直す（[メモリー](memory.md)） |

作業領域の写し・削除（clone の後の `.git` の退避、`_guardian` への写し、実行ごとの作業領域・中止したタスクの作業領域の削除など、対象リポジトリの大きさに比例するもの）は、非同期のファイル操作で行う。
数 GB・数万ファイルを写す間・消す間も、デーモンのイベントループを止めず、画面と API に応答し続ける。
写し終わる・消し終わるまで、工程は次に進まない（写しの途中で一時停止・中止を求められたら、写し終わった後、コンテナを起動する前に止める）。

コード: `apps/daemon/src/config.ts`（`resolveHome`・`configPath`）、`apps/daemon/src/main.ts`、`apps/daemon/src/service.ts`（`repoDir`・`trustedGitDir`）、`apps/daemon/src/repository.ts`（`prepare`・`copyWorkingTree`）、`apps/daemon/src/workspace-cleanup.ts`（`RUN_SCRATCH_DIRS`）、`apps/daemon/src/instance-lock.ts`、`packages/cli/src/context-preview.ts`（`DAEMON_FILE`）

## 設定の2つの置き場所

- `config.yaml`（ファイル）：AI のエージェント・認証・イメージ・ゲートウェイなど、マシンの設定。
  項目は [設定（config.yaml）](configuration.md) にある。
- sacty の設定（`sacty.db` の `settings` テーブルの1行）：画面の「sacty の設定」で変える、すべてのプロジェクトに共通の設定。

  | 項目 | 意味 |
  | --- | --- |
  | `intakeLabel` | 取り込むラベル（Issue だけ） |
  | `ticketLabel` | チケットの取り込むラベル |
  | `reviewLabel` | PR のレビュー用のラベル |
  | `reviewRequested` | 自分へのレビュー依頼の取り込み |
  | `reviewMentionSelf` | レビューの投稿で、PR の作者ではなく自分（投稿するアカウント）に @ メンションする（既定 Off。[タスクと工程](tasks-and-steps.md)） |
  | `triageOff` | Off にしたトリアージの種類（`issues`・`reviewLabel`・`tickets`） |
  | `maxParallelTasks` | 同時に実行するタスクの数（既定 3） |
  | `issueIntervalSec`・`reviewIntervalSec`・`ticketIntervalSec` | 取り込みの種類ごとの間隔（秒。60 以上。既定 300。[取り込み](intake.md#間隔)） |
  | `notification` | Slack の通知先（[通知](notifications.md)） |
  | `memoryRetentionDays` | メモリーを残す日数（1〜3650。既定 90。[メモリー](memory.md#掃除)） |

  設定の保存先を開くとき（デーモンの起動のとき）、消した項目（`triageOff` の `pullRequests`）が保存されていれば、消して書き直す。
  消すものが無ければ書かない。
- プロジェクト（`sacty.db`）：対象・GitHub のアカウント・コンテキストリポジトリ・共用の compose・チケットの取り込みなど（通知は sacty の設定）。
  - 変更（`PUT /api/projects/:id`）は、読み込んだときの `updatedAt` を `If-Match` ヘッダーで受け取り、保存の時点の `updatedAt` と一致するときだけ保存する。
    ヘッダーが無ければ 428（`precondition_required`。保存しない）。読み込んだ後にほかの保存で変わっていれば、上書きせずに 409（`project.changedElsewhere`）を返し、設定も `updatedAt` も変えない。
    照合と保存は同じ同期の処理（`saveProject`）で行うので、同時に保存しても、先に保存した変更を後の保存が消さない。項目ごとの併合はしない（別の項目だけを変えていても 409）。作成（`POST`）・インポートは版を要らない。
    `updatedAt` は、保存するたびに前の値より後の時刻になる（同じミリ秒に2回保存しても、時計が戻っても変わる。`SqliteProjectStore.put`）。
  - 画面（`ProjectEditor`）は、設定を読み込んだ版を保存に添え（`baseUpdatedAt`）、自分が保存したら返ってきた `updatedAt` に進める。画面の取り直しで届いた版には進めない（ほかの保存の内容を見ていないため）。
    409（`project.changedElsewhere`）のときは、理由と「再読み込みして最新の設定を見る」ボタンを出す。編集中の入力は、再読み込みするまで残す。
  - 削除（`DELETE /api/projects/:id`）は、プロジェクトの定義と、そのプロジェクトのスケジュールタスク（`schedules.deleteForProject`。[スケジュールタスク](scheduled-tasks.md)）を消す。タスク（スケジュールタスクが作ったものを含む）と作業履歴は消さない（消したプロジェクトのタスクは、画面に出さず、数えない）。
    プロジェクトが無ければ 404。そのプロジェクトに終わっていないタスク、または完了したタスクでも実行中・実行待ちの処理（監査・デプロイの確認など）・
    回答中の質問があれば、削除せずに 409（`project.hasActiveTasks`。件数を添える）を返す。消したら、そのプロジェクトの秘密情報の警告も消す。
  - 消したプロジェクトのタスクは、デーモンの `GET /api/tasks/:id` と実行の記録（`…/runs/:runId/{log,files/:file,agent-files,agent-files/raw}`）で
    404 を返す（`visibleTask`）。タスクの詳細・成果物のレビュー・実行のログの画面は、URL を直接開いても 404 になる。
  - 監査の提案の採用は、プロジェクトが無ければ断る（秘密情報を伏せる間に消されたときも、記録の前に確かめ直す）。採用を記録した後に消したときは、
    起動のときにも改修のタスクを作らない。
  - 画面では、プロジェクトの設定の最後の「危険な操作」から削除する。確認のダイアログでプロジェクトの名前を入力したときだけ削除でき（サーバーアクションでも一致を確かめる）、
    消したらプロジェクトの一覧へ移る。表示しているプロジェクト（cookie）が消えたら、最初のプロジェクトを表示する。

コード: `apps/daemon/src/settings.ts`（`SqliteSettingsStore`・`dropRemovedItems`）、`packages/core/src/projects.ts`（`SactySettings`・`DEFAULT_MAX_PARALLEL_TASKS`）、`apps/daemon/src/projects.ts`、
`apps/daemon/src/service.ts`（`saveProject`・`deleteProject`・`visibleTask`・`adoptAuditProposal`・`createAuditFixTask`）、`apps/daemon/src/server.ts`、`apps/web/src/components/delete-project.tsx`（`DeleteProjectSection`）、`apps/web/src/app/actions.ts`（`saveProjectAction`・`deleteProjectAction`）、`apps/web/src/components/project-editor.tsx`（`ProjectEditor`）、`apps/web/src/lib/daemon.ts`（`saveProject`）
