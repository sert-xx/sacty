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

## 画面のヘッダー（表示しているプロジェクト・お知らせ）

- 表示しているプロジェクトは cookie `sacty-project` に持つ（httpOnly・`SameSite=Lax`・1年）。ヘッダーの切り替え・タスクの一覧・
  サイドメニューの「設定」（`/projects/current`）は、cookie のプロジェクトを出す。cookie のプロジェクトが無い・無くなっていれば、
  最初のプロジェクト。cookie に入れる ID は `^[\w-]{1,100}$` の形のものだけ。
- cookie を変えるのは次のとき：ヘッダーの切り替えとお知らせ（`/switch`）、プロジェクトの作成・インポート（作ったプロジェクトに
  する）、プロジェクトの画面（タスクの詳細・レビュー・実行のログ・プロジェクトの設定）を開いたとき。開いたときは、cookie と
  画面のプロジェクトが違うときだけ、表示の後にサーバーアクションで変える（画面とヘッダーが描き直される）。デーモンのプロジェクトの
  一覧にそのプロジェクトが無ければ（削除したプロジェクトのタスク）変えない。一覧を取れなければ、無いとは扱わずに変える。
- ヘッダーは全体のレイアウトにあり、画面の中の移動（リンク）では描き直されない。お知らせの対象が変わる操作（承認・差し戻し・
  一時停止・再開・中止・タスクの作成など）のサーバーアクションは、`refresh()` を呼んでヘッダーも描き直させる（`redirect` で移る
  ときも、その前に呼ぶ）。
- ほかのタブ・CLI・デーモンでの変化（取り込みで増えたタスク・承認・再開・デーモンが拾って動き出したタスクなど）は、下の
  「画面のデータの取り直し」で、ヘッダーのプロジェクトの切り替え（対応待ちの件数）とお知らせに反映する。どの画面でも、タスクの状態によらない。

コード: `apps/web/src/components/shell/header.tsx`（`AppHeader`・`HeaderFallback`）、`apps/web/src/components/shell/live-header.tsx`（`LiveHeaderMenus`）、
`apps/web/src/lib/header-data.ts`（`loadHeaderData`）、`apps/web/src/components/shell/follow-project.tsx`（`FollowProject`）、
`apps/web/src/lib/project-select.ts`、`apps/web/src/lib/current-project.ts`（`selectProject`）、
`apps/web/src/app/switch/route.ts`、`apps/web/src/app/actions.ts`

## 画面のデータの取り直し

タスクの一覧・タスクの詳細・成果物のレビュー・実行のログ・プロジェクトの一覧（取り込みの状況）・ヘッダーのお知らせは、画面をリロード（`router.refresh` を含む、画面の全体の描き直し）せず、データだけを
一定の間隔で取り直し、変わった所だけを画面に反映する。入力の途中の文字・選択・開いたダイアログや欄（`details`）・フォーカス・
スクロールの位置は、画面の要素がそのまま残るので消えない。

- 取り直す先（画面のサーバーのルート）と、返すもの：

  | 先 | 返すもの |
  | --- | --- |
  | `GET /live/tasks?project=<ID>` | タスクの一覧の行と、人間の判断が必要なタスクのカード（表示に要るものだけ。`loadTaskList`） |
  | `GET /live/tasks/<ID>` | タスクの詳細に出すもの（タスク・作業履歴・親・子タスク・片付けるもの・イメージの候補など。`loadTaskDetail`） |
  | `GET /live/header?current=<ID>` | ヘッダーのプロジェクトの切り替え（対応待ちの件数）とお知らせ（`loadHeaderData`） |
  | `GET /live/tasks/<ID>/review` | 成果物のレビューの画面のタスク |
  | `GET /live/tasks/<ID>/runs/<実行の ID>?events=&eventsMark=&stderr=&stderrMark=` | 実行のログの、画面が持っている分に足された分（下を参照） |
  | `GET /live/projects` | プロジェクトの一覧と、取り込みの状況（`loadProjectList`） |

- 間隔は3秒（`LIVE_INTERVAL_MS`）。タスクの状態によらず、タスクが無いとき・すべてが承認待ち・一時停止・完了のときも取り直す。
  前の取り直しが終わってから次の間隔を数えるので、問い合わせは重ならない。
- 画面が見えていない（タブが隠れている）間は問い合わせない。見えたら、すぐに一度取り直す。
- 一覧とヘッダーは、画面を描いたときのプロジェクトのまま取り直す（ほかのタブでプロジェクトを切り替えても、この画面の中身だけが
  変わらないように）。プロジェクトを変えるのは、画面を開き直したとき（`/switch` など）。
- 画面は、前に受け取ったデータの版（中身のハッシュ）をヘッダー `x-sacty-live-version` で送る。同じなら、画面のサーバーは中身を
  送らない（`{ unchanged: true }`）。
- デーモンに届かない・読めないときは、200 で `{ unavailable: true }` を返し、画面はいまのまま残す（エラーを出し続けない）。
  届くようになったら、次の間隔でまた反映する。画面を描いたときに届かなかったときは、届くまでつながらないことを出し、届いたら中身を出す。
- 取り直しでは、対象リポジトリの候補（Org の対象は `gh` で GitHub に問い合わせる）を取らない。タスクの作成のダイアログの候補は、
  ダイアログを開いたときに一度だけ読む（[タスクと工程](tasks-and-steps.md)）。タスクの詳細で一時停止して人がリポジトリを選ぶときの候補は、まだ持っていないときだけ一度求める
  （`?repositories=1`）。
- 操作（承認・一時停止・再開など）のサーバーアクションが `refresh()` で画面を描き直したときは、そのときのデータを使う。
- 実行のログは、画面が持っている分の長さ（文字数）と目印（中身のハッシュ）を送り、いまのファイルの先頭が同じなら、足された分だけを
  受け取って後ろに足す。違えば（大きすぎて途中を省いた形に書き直されたなど）、全体を受け取って置き換える。読んでいる途中の
  スクロールの位置は動かさず、一番下を見ているときだけ、新しい行についていく。実行が終わったら取り直しを止める。エージェントの元の
  ファイルの一覧（ハッシュを計算する）は、実行が終わってから一度だけ取る。
- sacty の設定・プロジェクトの設定の画面は、自動で描き直さない（ヘッダーのお知らせだけを取り直す）。中身は人が編集する設定で、
  タスクの状態では変わらないため。最新にするには、開き直すか、画面を読み直す。

コード: `apps/web/src/lib/live.ts`（`pollWhileVisible`・`fetchLive`・`LIVE_INTERVAL_MS`）、`apps/web/src/lib/use-live-data.ts`（`useLiveData`）、
`apps/web/src/lib/live-server.ts`（`liveResponse`・`liveVersion`）、`apps/web/src/app/live/tasks/route.ts`、`apps/web/src/app/live/tasks/[id]/route.ts`、`apps/web/src/app/live/header/route.ts`、`apps/web/src/lib/task-list-data.ts`（`loadTaskList`）、
`apps/web/src/lib/task-detail-data.ts`（`loadTaskDetail`）、`apps/web/src/components/task-list.tsx`（`LiveTaskList`）、
`apps/web/src/components/task-detail.tsx`（`LiveTaskDetail`）、`apps/web/src/components/review.tsx`（`LiveReview`）、
`apps/web/src/components/run-log.tsx`（`LiveRunLog`・`applyChunk`）、`apps/web/src/lib/run-log-data.ts`（`appendedText`）、
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
