**日本語** | [English](architecture.en.md)

# 全体の構成

sacty は、npm workspaces の4つのパッケージでできている。`sacty` コマンド（cli）が、常駐するデーモン（daemon）と画面（web）を起動する。
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

```text
sacty up（packages/cli）
 ├─ デーモン（apps/daemon）  127.0.0.1:<--daemon-port。既定 4710>
 │    ├─ ゲートウェイ（AI の中継・PF の中継・MCP の中継）  127.0.0.1
 │    └─ docker（エージェント・テストのコンテナ、compose のサービス）
 └─ 画面（apps/web, next start）  127.0.0.1:<--port。既定 4700>
```

- デーモンの API（`/api/*`）は、`sacty up` が起動のたびに作るトークンを `Authorization: Bearer` で求め（`timingSafeEqual` で比べる）、
  合わなければ 401（`unauthorized`）を返す。`127.0.0.1` だけで待ち受ける。
- 画面は、Next.js のサーバー側でだけデーモンを呼ぶ（トークンをブラウザに渡さない）。接続先とトークンは環境変数
  `SACTY_DAEMON_URL`・`SACTY_DAEMON_TOKEN` から、リクエストのたびに読む。
- 入力の誤り（zod の検証）は 400 で `invalid_input`、操作できない状態は 409 で `invalid_operation` を返し、どちらも文言のコードと
  引数で返す（画面が画面の言語の文言にする）。

主な API（`apps/daemon/src/server.ts`）：

| 種類 | パス |
| --- | --- |
| 状態 | `GET /api/health`・`GET /api/status`・`GET /api/github/accounts` |
| タスク | `GET/POST /api/tasks`・`GET /api/tasks/:id`・`POST /api/tasks/:id/{approve,request-changes,pause,resume,cancel,repository,questions,rereview}`・`GET /api/tasks/:id/cleanup-plan`・`POST /api/tasks/:id/remarks/:remarkId/void`・`POST /api/tasks/:id/proposals/:proposalId/decide`・`POST /api/tasks/:id/exports/:step/retry` |
| 実行の記録 | `GET /api/tasks/:id/runs/:runId/log`・`…/files/:file`・`…/agent-files`・`…/agent-files/raw` |
| プロジェクト | `GET/POST /api/projects`・`GET/PUT /api/projects/:id`・`GET /api/projects/:id/{repositories,platforms,export}`・`GET/POST /api/projects/:id/context-preview`・`POST /api/projects/import`・`POST /api/projects/:id/notification-test` |
| sacty の設定 | `GET/PUT /api/settings`・`POST /api/intake/run`・`POST /api/secrets/prefetch` |

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
| `/projects/current`・`/projects/current/tasks` | 表示しているプロジェクト（cookie）の設定・タスクの一覧へ移す（303）。ほかの `/projects/current/…` は 404 |
| `/tasks/<ID>`・`/tasks/<ID>/review`・`/tasks/<ID>/runs/<実行の ID>` | タスクの詳細・成果物のレビュー・実行のログ |
| `/settings` | sacty の設定 |

- 画面の中のリンクと移動先は、`apps/web/src/lib/paths.ts` で作る（プロジェクトの ID はエンコードする）。プロジェクトの作成・インポートの
  後は、そのプロジェクトの設定（`/projects/<ID>/settings`）へ移る。タスクの詳細の「タスク」（パンくず）は、そのタスクのプロジェクトの
  タスクの一覧へ戻る（タスクを読む前・デーモンに届かないときは `/projects/current/tasks`）。
- プロジェクトの画面のプロジェクトは、URL の ID で決める。デーモンのプロジェクトの一覧に無い ID なら 404。
- ダッシュボードは、欄（カード）を並べる。幅が足りれば横に並べ、足りなければ縦に積む（欄が1つなら幅いっぱい）。いまの欄は
  「終わっていないタスク」だけ。
  - すべてのプロジェクトの、完了・中止を除くタスク（承認待ち・一時停止・エスカレーションも含む。`statusTone` が `completed`・
    `cancelled` でないもの）を、最後に動いた順（`updatedAt` の新しい順）に出す。件数の上限は無い。消したプロジェクトのタスクは出さない。
  - 各行に、題（タスクの詳細へのリンク）・プロジェクトの名前・状態を出す。1行の高さは 4rem、欄の高さは5件分（20rem）で、それより
    多ければ欄の中でスクロールする（キーボードでもスクロールできるよう、欄がフォーカスを受ける）。
  - プロジェクトが無いとき・終わっていないタスクが無いときは、そのことを出す。
  - 欄を足すときは、`DashboardData`（`loadDashboard`）に欄のデータを足し、`LiveDashboard` に `DashboardCard` を足す（取り直しは画面で1つ）。

コード: `apps/web/src/lib/paths.ts`、`apps/web/src/app/page.tsx`、`apps/web/src/app/dashboard/page.tsx`、
`apps/web/src/app/projects/[id]/page.tsx`、`apps/web/src/app/projects/[id]/tasks/page.tsx`、`apps/web/src/app/projects/[id]/settings/page.tsx`、
`apps/web/src/app/projects/current/[[...view]]/route.ts`、`apps/web/src/app/tasks/[id]/page.tsx`（`Breadcrumb`）、
`apps/web/src/lib/dashboard-data.ts`（`loadDashboard`・`isOpenTask`・`openTaskRows`）、`apps/web/src/components/dashboard.tsx`（`LiveDashboard`・`DashboardGrid`・`DashboardCard`・`OpenTasksCard`）

## 画面のヘッダーとサイドメニュー（表示しているプロジェクト・お知らせ）

- 開いている画面が、どのプロジェクトの画面かを URL で決める（`pageScope`）。プロジェクトの画面は `/projects/<ID>/tasks`・
  `/projects/<ID>/settings`（URL のプロジェクト）と `/tasks/…`（タスクの詳細・レビュー・実行のログ。表示しているプロジェクト）。
  ほか（ダッシュボード・プロジェクトの一覧・sacty の設定など）は「すべてのプロジェクト」の画面。
- ヘッダーのプロジェクトの切り替えは、先頭に「すべてのプロジェクト」（`/dashboard` へ移る）、続けて個別のプロジェクト（`/switch` で
  cookie を変えてから `/projects/<ID>/tasks` へ移る）を出す。選んだ表示は、プロジェクトの画面ではそのプロジェクト（URL の ID が
  プロジェクトの一覧に無ければ「すべてのプロジェクト」）、「すべてのプロジェクト」の画面では「すべてのプロジェクト」（件数は
  すべてのプロジェクトの対応待ちの合計）。
- 表示しているプロジェクトは cookie `sacty-project` に持つ（httpOnly・`SameSite=Lax`・1年）。タスクの詳細などのヘッダーの選んだ表示と、
  サイドメニューの「タスク」（`/projects/current/tasks`）・「設定」（`/projects/current`）は、cookie のプロジェクトを使う。cookie の
  プロジェクトが無い・無くなっていれば、最初のプロジェクト。cookie に入れる ID は `^[\w-]{1,100}$` の形のものだけ。
- cookie を変えるのは次のとき：ヘッダーの切り替えとお知らせ（`/switch`。移動先が無ければ、切り替えたプロジェクトのタスクの一覧）、
  プロジェクトの作成・インポート（作ったプロジェクトにする）、プロジェクトの画面（タスクの一覧・プロジェクトの設定・タスクの詳細・
  レビュー・実行のログ）を開いたとき。開いたときは、cookie と画面のプロジェクトが違うときだけ、表示の後にサーバーアクションで変える
  （画面とヘッダーが描き直される）。デーモンのプロジェクトの一覧にそのプロジェクトが無ければ（削除したプロジェクトのタスク）変えない。
  一覧を取れなければ、無いとは扱わずに変える。
- 「すべてのプロジェクト」の画面では、サイドメニューは「ダッシュボード」と「設定」だけを出し、「設定」はプロジェクトの一覧
  （`/projects`）へ移る（どのプロジェクトにも飛ばない）。お知らせは、プロジェクトで分けずに新しい順に出し、開くと、そのタスクの
  プロジェクトに切り替えてタスクを開く。プロジェクトの画面では、サイドメニューは「ダッシュボード」「タスク」「設定」を出し、お知らせは
  「ほかのプロジェクト」「このプロジェクト」に分ける。
- ヘッダーは全体のレイアウトにあり、画面の中の移動（リンク）では描き直されない（選んだ表示は、画面の URL から画面の中で決める）。
  お知らせの対象が変わる操作（承認・差し戻し・一時停止・再開・中止・タスクの作成など）のサーバーアクションは、`refresh()` を呼んで
  ヘッダーも描き直させる（`redirect` で移るときも、その前に呼ぶ）。
- ほかのタブ・CLI・デーモンでの変化（取り込みで増えたタスク・承認・再開・デーモンが拾って動き出したタスクなど）は、下の
  「画面のデータの取り直し」で、ヘッダーのプロジェクトの切り替え（対応待ちの件数）とお知らせに反映する。どの画面でも、タスクの状態によらない。

コード: `apps/web/src/components/shell/header.tsx`（`AppHeader`・`HeaderFallback`）、`apps/web/src/components/shell/live-header.tsx`（`LiveHeaderMenus`・`selectedProject`）、
`apps/web/src/components/shell/menus.tsx`（`ProjectMenu`・`NotificationsMenu`）、`apps/web/src/components/shell/rail.tsx`（`railItems`）、`apps/web/src/lib/page-scope.ts`（`pageScope`）、
`apps/web/src/lib/header-data.ts`（`loadHeaderData`）、`apps/web/src/components/shell/follow-project.tsx`（`FollowProject`）、
`apps/web/src/lib/project-select.ts`、`apps/web/src/lib/current-project.ts`（`selectProject`）、
`apps/web/src/app/switch/route.ts`、`apps/web/src/app/actions.ts`

## 画面のデータの取り直し

ダッシュボード・タスクの一覧・タスクの詳細・成果物のレビュー・実行のログ・プロジェクトの一覧（取り込みの状況）・ヘッダーのお知らせは、画面をリロード（`router.refresh` を含む、画面の全体の描き直し）せず、データだけを
一定の間隔で取り直し、変わった所だけを画面に反映する。入力の途中の文字・選択・開いたダイアログや欄（`details`）・フォーカス・
スクロールの位置は、画面の要素がそのまま残るので消えない。

- 取り直す先（画面のサーバーのルート）と、返すもの：

  | 先 | 返すもの |
  | --- | --- |
  | `GET /live/dashboard` | ダッシュボードの欄のデータ（終わっていないタスク。`loadDashboard`） |
  | `GET /live/tasks?project=<ID>` | URL のプロジェクトの、タスクの一覧の行と、人間の判断が必要なタスクのカード（表示に要るものだけ。`loadTaskList`）。プロジェクトが無い・ID の形が違えば `{ missing: true }` |
  | `GET /live/tasks/<ID>` | タスクの詳細に出すもの（タスク・作業履歴・親・子タスク・片付けるもの・イメージの候補など。`loadTaskDetail`） |
  | `GET /live/header?current=<ID>` | ヘッダーのプロジェクトの切り替え（対応待ちの件数）とお知らせ（`loadHeaderData`） |
  | `GET /live/tasks/<ID>/review` | 成果物のレビューの画面のタスク |
  | `GET /live/tasks/<ID>/runs/<実行の ID>?events=&stderr=` | 実行のログの、画面が持っている分に足された分（下を参照） |
  | `GET /live/projects` | プロジェクトの一覧と、取り込みの状況（`loadProjectList`） |

- 間隔は3秒（`LIVE_INTERVAL_MS`）。タスクの状態によらず、タスクが無いとき・すべてが承認待ち・一時停止・完了のときも取り直す。
  前の取り直しが終わってから次の間隔を数えるので、問い合わせは重ならない。
- 画面が見えていない（タブが隠れている）間は問い合わせない。見えたら、すぐに一度取り直す。
- タスクの一覧は URL のプロジェクトを、ヘッダーは画面を描いたときのプロジェクトのまま取り直す（ほかのタブでプロジェクトを切り替えても、
  この画面の中身だけが変わらないように）。プロジェクトを変えるのは、画面を開き直したとき（`/switch` など）。
- 画面は、前に受け取ったデータの版（中身のハッシュ）をヘッダー `x-sacty-live-version` で送る。同じなら、画面のサーバーは中身を
  送らない（`{ unchanged: true }`）。
- 1回の取り直しの期限は10秒（`LIVE_TIMEOUT_MS`）。応答の本文を読む間も含め、期限で中断し、次の取り直しを予約する（応答しない
  画面のサーバーやデーモンで、取り直しが止まったままにならない）。画面のサーバーからデーモンへの問い合わせにも、ブラウザの中断
  （リクエストの中断）と8秒の期限（`LIVE_SERVER_TIMEOUT_MS`）を渡し、本文を読む間も含めて止める（`withDaemonSignal`。応答しない
  デーモンへの問い合わせを、取り直しのたびに溜めない）。取っている間にサーバーが画面を描き直したときは、その取り直しの結果（失敗も）を捨てる。
- デーモンに届かない・読めないときは、200 で `{ unavailable: true }` を返す（エラーを出し続けない）。画面は、表示を最後に取れた
  データのまま残し、更新できないこと（表示が今の値でないかもしれないこと）を出す（ヘッダーは「更新が止まっています」）。
  期限切れ・画面のサーバーに届かないときも同じ。届くようになったら、次の間隔でまた反映し、その表示を消す。
- 画面を描いたときに届かなかったときは、届くまでつながらないことを出し、届いたら中身を出す。タスクの一覧・タスクの詳細・成果物のレビュー・
  実行のログは、そのとき、出した中身のプロジェクトを表示しているプロジェクトにする（`followProjectAction`。cookie と違うときだけ。
  描いたときに届いていれば、サーバーの `FollowProject` が合わせる）。
- ヘッダーは、プロジェクトが1つも無いときも取り直す（切り替えとお知らせは出さない）。ほかのタブや CLI で最初のプロジェクトを
  作ったら、切り替えとお知らせを出す。
- 取り直しでは、対象リポジトリの候補（Org の対象は `gh` で GitHub に問い合わせる）を取らない。タスクの作成のダイアログの候補は、
  ダイアログを開いたときに一度だけ読む（[タスクと工程](tasks-and-steps.md)）。タスクの詳細で一時停止して人がリポジトリを選ぶときの候補は、まだ持っていないときだけ求める
  （`?repositories=1`）。取れなかったとき（`ticketRepositoriesFailed`。取れた0件とは分ける）は、30秒（`REPOSITORIES_RETRY_MS`）
  空けて求め直す。
- 操作（承認・一時停止・再開など）のサーバーアクションが `refresh()` で画面を描き直したときは、そのときのデータを使う。
- 実行のログは、画面が持っている分の終わりの位置（ファイルの中のバイト）を送る。デーモン（`GET /api/tasks/:id/runs/:runId/log` の
  `?eventsFrom=&stderrFrom=`）も、実行中はその位置より後だけを読み、画面のサーバーと画面へも足された分だけを送る。返した分の位置は
  `offsets`（`from`・`next`）で返し、書いている途中の文字（UTF-8 の複数バイトの途中）は次に回す。実行が終わった後（閉じるときに伏せ直しや
  上限で書き直されうる）と、位置がファイルより後ろのときは、全体を返し、画面は置き換える。読んでいる途中のスクロールの位置は動かさず、
  一番下を見ているときだけ、新しい行についていく。エージェントの元のファイルの一覧（ハッシュを計算する）は、実行が終わってから取る。
  一覧だけを読めないときは、ログと終わったことは返し（`agentFilesFailed`）、画面は一覧を読めず取り直していることを出して、一覧だけを取り直す。実行が終わり、一覧も取れたら、
  取り直しを止める。
- sacty の設定・プロジェクトの設定の画面は、自動で描き直さない（ヘッダーのお知らせだけを取り直す）。中身は人が編集する設定で、
  タスクの状態では変わらないため。最新にするには、開き直すか、画面を読み直す。

コード: `apps/web/src/lib/live.ts`（`pollWhileVisible`・`fetchLive`・`LIVE_INTERVAL_MS`・`LIVE_TIMEOUT_MS`）、`apps/web/src/lib/use-live-data.ts`（`useLiveData`）、
`apps/web/src/lib/live-server.ts`（`liveResponse`・`liveVersion`）、`apps/web/src/app/live/tasks/route.ts`、`apps/web/src/app/live/tasks/[id]/route.ts`、`apps/web/src/app/live/header/route.ts`、`apps/web/src/app/live/dashboard/route.ts`、`apps/web/src/lib/task-list-data.ts`（`loadTaskList`）、
`apps/web/src/lib/task-detail-data.ts`（`loadTaskDetail`）、`apps/web/src/components/task-list.tsx`（`LiveTaskList`）、
`apps/web/src/components/task-detail.tsx`（`LiveTaskDetail`）、`apps/web/src/components/review.tsx`（`LiveReview`）、
`apps/web/src/components/run-log.tsx`（`LiveRunLog`・`applyChunk`）、`apps/web/src/lib/run-log-data.ts`（`loadAgentFiles`）、
`apps/web/src/components/live-status.tsx`（`StaleNotice`・`FollowProjectAfterRecovery`）、`apps/daemon/src/session-logs.ts`（`completeUtf8Length`）、`apps/web/src/lib/daemon-signal.ts`（`withDaemonSignal`・`LIVE_SERVER_TIMEOUT_MS`）、
`apps/web/src/components/project-list.tsx`（`LiveProjectList`）、`apps/web/src/lib/project-list-data.ts`（`loadProjectList`）

## データの置き場所（SACTY_HOME）

`SACTY_HOME`（既定 `~/.sacty`）の下に置く。

| パス | 中身 |
| --- | --- |
| `config.yaml` | sacty の設定（AI・認証・イメージ・ゲートウェイなど）。デーモンは使うたびに読み直す |
| `sacty.db` | SQLite。作業履歴（イベント）・プロジェクト・sacty の設定（画面の「sacty の設定」） |
| `daemon.lock`・`daemon-owner.json` | 二重の起動の判定と表示（[デーモンの起動と終了](daemon-lifecycle.md)） |
| `daemon.json` | `sacty context preview` が問い合わせる、起動中のデーモンの接続先とトークン |
| `workspaces/` | 作業領域。`<タスク ID>/repo`（対象リポジトリの clone）・`<タスク ID>/empty`（リポジトリの無いタスク）・`_git/<タスク ID>.git`（clone 直後の git のメタデータの退避。どのコンテナにもマウントしない）・実行ごとの `_guardian/<実行 ID>`・`_snapshots/<実行 ID>`・`_review/<実行 ID>`・`_export/<実行 ID>`・`_shared-compose/<実行 ID>`（起動のときに `_shared-compose` ごと消す） |
| `runs/` | エージェントの実行ごとのセッションログ |
| `sessions/` | タスクごとのオーケストレーターのセッション（使い回しのためのキャッシュ） |
| `cache/shared-compose/` | 共用の compose のリポジトリのキャッシュ |
| `host-mcp/processes/` | ホストの MCP サーバー（コンテキストのコマンド型を含む）のプロセスの記録 |
| `context-mcp/layers/` | ホストで起動するコンテキストのコマンド型の MCP サーバーの作業ディレクトリ（層のリポジトリの写し） |

コード: `apps/daemon/src/config.ts`（`resolveHome`・`configPath`）、`apps/daemon/src/main.ts`、`apps/daemon/src/service.ts`（`repoDir`・`trustedGitDir`）、`apps/daemon/src/instance-lock.ts`、`packages/cli/src/context-preview.ts`（`DAEMON_FILE`）

## 設定の2つの置き場所

- `config.yaml`（ファイル）：AI のエージェント・認証・イメージ・ゲートウェイなど、マシンの設定。項目は
  [設定（config.yaml）](configuration.md)。
- sacty の設定（`sacty.db` の `settings` テーブルの1行）：画面の「sacty の設定」で変える、すべてのプロジェクトに共通の設定。
  取り込むラベル（`intakeLabel`。Issue だけ）・チケットの取り込むラベル（`ticketLabel`）・PR のレビュー用のラベル（`reviewLabel`）・
  自分へのレビュー依頼の取り込み（`reviewRequested`）・Off にしたトリアージの種類（`triageOff`。`issues`・`reviewLabel`・`tickets`）・
  同時に実行するタスクの数（`maxParallelTasks`。既定 3）・取り込みの種類ごとの間隔（`issueIntervalSec`・`reviewIntervalSec`・
  `ticketIntervalSec`。秒。60 以上。既定 300。[取り込み](intake.md#間隔)）。
  - 設定の保存先を開くとき（デーモンの起動のとき）、消した項目（`triageOff` の `pullRequests`）が保存されていれば消して書き直す
    （消すものが無ければ書かない）。
- プロジェクト（`sacty.db`）：対象・GitHub のアカウント・コンテキストリポジトリ・通知・共用の compose・チケットの取り込みなど。

コード: `apps/daemon/src/settings.ts`（`SqliteSettingsStore`・`dropRemovedItems`）、`packages/core/src/projects.ts`（`SactySettings`・`DEFAULT_MAX_PARALLEL_TASKS`）、`apps/daemon/src/projects.ts`
