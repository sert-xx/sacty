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
- ほかのタブ・CLI・デーモンでの変化は、次のときに反映する。それ以外の間は問い合わせない。
  - sacty やエージェントが作業しているタスク（`isWorking`）がある間は3秒ごと（`AutoRefresh`）。作業しているのは、実行待ち
    （`queued`）・実行中（`running`）、待機（`idle`）のうち実装の検証中（`verification` が `pending`＝テストの実行中か
    `tests_passed`＝最終レビュー中）・再現のテストの確かめ中（`reproductionPending`）、ゴールガーディアンの判定がまだの変更の申し出があるタスク。
  - タブに戻ってきた（隠れていた画面がまた見えた）とき（`RefreshOnVisible`）。デーモンにつながらず、仮のヘッダーを出していたときも。

コード: `apps/web/src/components/shell/header.tsx`（`AppHeader`・`HeaderFallback`）、`apps/web/src/lib/labels.ts`（`isWorking`）、`apps/web/src/components/shell/follow-project.tsx`（`FollowProject`）、
`apps/web/src/components/auto-refresh.tsx`、`apps/web/src/lib/project-select.ts`、`apps/web/src/lib/current-project.ts`（`selectProject`）、
`apps/web/src/app/switch/route.ts`、`apps/web/src/app/actions.ts`

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
