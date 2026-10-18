**日本語** | [English](daemon-lifecycle.en.md)

# デーモンの起動と終了

`sacty up` が、デーモン（`apps/daemon`）と画面（`apps/web` の Next.js）を子プロセスとして起動し、どちらかが終われば両方を止める。
デーモンは、同じ `SACTY_HOME` で1つしか動かない（OS のファイルロックで判定する）。

関係する ADR: [画面は、起動ごとの秘密で入ったブラウザだけが使える](../adr/20261018-0414-web-session-auth.md)

## sacty up

- オプションは `--port`（画面のポート。既定 `4700`）と `--daemon-port`（デーモンのポート。既定 `4710`）。どちらも 1〜65535 の整数で、
  同じ値は誤りにする。
- 起動のたびに、デーモンと画面の間で使うトークン（32 バイトの乱数の16進）と、画面の入り口の秘密（32 バイトの乱数の base64url。
  デーモンのトークンとは別のもの）を作る。
- デーモンを `SACTY_DAEMON_PORT`・`SACTY_DAEMON_TOKEN`・`SACTY_WEB_URL`（`http://127.0.0.1:<画面のポート>`。通知のリンクに使う）の
  環境変数を付けて起動し（画面の入り口の秘密 `SACTY_WEB_TOKEN` は、利用者のシェルにあっても取り除いて渡す）、`GET /api/health` が応答するまで最大15秒待つ（200ミリ秒ごとに確かめる）。応答しなければ止める。
- デーモンが応答したら、`SACTY_HOME/daemon.json`（権限 0600）に、デーモンの接続先とトークンを書く（`sacty context preview` が読む）。
  すでにほかの sacty の接続先が書かれていて、それがトークン付きで応答するなら上書きせず、警告を出す。終わるときは、自分が書いたもの
  （接続先とトークンが同じ）だけを消す。
- 次に、画面を `next start -H 127.0.0.1 -p <画面のポート>` で、`SACTY_DAEMON_URL`・`SACTY_DAEMON_TOKEN`・`SACTY_WEB_TOKEN`
  （画面の入り口の秘密）・`SACTY_WEB_PORT`（画面のポート）を付けて起動する。
- 端末に、画面の入り口の URL（`http://127.0.0.1:<画面のポート>/auth?token=<画面の入り口の秘密>`）を表示する（下の「画面の認証」）。
- SIGINT・SIGTERM を受けると、子プロセスに SIGTERM を送り、すべて終わってから終了する。30秒たっても残っている子には SIGKILL を送る
  （デーモンの後片付けの上限 20 秒より長く待つ）。
- 子プロセスが想定外に終わったときは、もう片方も止め、失敗の終了コードで終わる（子の終了コードが 0 でも 1 にする）。デーモンが
  終了コード `3`（`ALREADY_RUNNING_EXIT_CODE`）で終わったときは、ほかの sacty が動いているため起動しなかったと表示する。

コード: `packages/cli/src/index.ts`（`up`・`waitForDaemon`・`parsePort`）、`packages/cli/src/up-env.ts`（`daemonEnv`・`webEnv`・`signInUrl`）、`packages/cli/src/context-preview.ts`（`claimDaemonFile`・`removeDaemonFile`・`DAEMON_FILE`）

## 画面の認証

工程のコンテナもホストの 127.0.0.1 に届く（`host.docker.internal`）ため、画面は、起動した本人のブラウザからのリクエストだけを
デーモンへ中継する。

- 入り口の URL（`/auth?token=<秘密>`）を開いたブラウザに、cookie（名前 `sacty-session-<画面のポート>`、値は秘密から作った
  HMAC-SHA256。`HttpOnly`・`SameSite=Lax`・`Path=/`・30 日）を渡し、トップ（`/`）へ移す。転送先は、ブラウザが開いている Host のまま
  （`127.0.0.1` と `localhost` は別の cookie になるため）。秘密が誤り・空なら 401 で、cookie を渡さない。入った後に `/auth` だけを
  開いたら、トップへ移す。
- 入り口の URL は、その起動の間は何度でも使える（別のブラウザで開き直せる）。起動し直すと秘密が変わり、前の cookie と URL は使えない。
- すべてのリクエスト（画面・取り直し・ダウンロード・Server Actions。ビルドした静的なファイルとアイコンを除く）で、Proxy
  （`apps/web/src/proxy.ts`）が次を確かめる。断るときは、画面の部品（デーモンに問い合わせる）を使わず、決まった文だけを画面の言語で返す。
  - Host がループバック（`127.0.0.1`・`localhost`・`[::1]`。ポートは問わない）でなければ 403（DNS rebinding の対策）。
  - 今の起動の cookie が無ければ 401。画面の秘密が無い（`sacty up` で起動していない）ときも 401 で、起動の仕方を出す。
- デーモンへ中継する所（`daemonFetch`）でも、今の起動の cookie を確かめ直し、無ければデーモンのトークンを使わずに断る（Proxy の範囲
  から外れた入口があっても中継しない）。
- デーモンの API の認証（`SACTY_DAEMON_TOKEN`）は変えない。画面の秘密は、デーモンにも工程のコンテナにも渡さない。

コード: `apps/web/src/proxy.ts`、`apps/web/src/lib/web-auth.ts`、`apps/web/src/lib/web-guard.ts`、`apps/web/src/lib/daemon.ts`（`daemonFetch`）

## デーモンの起動の順序

1. `SACTY_DAEMON_TOKEN` が無ければ、`sacty up` から起動するよう表示して終了コード 1 で終わる。ポートは `SACTY_DAEMON_PORT`（既定 4710）。
2. `SACTY_HOME` のディレクトリを作り、インスタンスのロックを取る（下の「二重の起動」）。取れなければ、作業履歴などに触れる前に終わる。
3. `SACTY_HOME/sacty.db` を開く（作業履歴・プロジェクト・sacty の設定）。設定（`config.yaml`）は使うたびに読み直す。
4. 前回のデーモンが残した docker compose のサービスと、共用の compose の実行ごとの取得を片付ける。
5. 前回のデーモンが残したホストの MCP サーバーのプロセス（コンテキストのコマンド型の MCP サーバーのものも、同じ記録で）を片付ける
   （[ゲートウェイ](gateway.md)）。
6. ゲートウェイを待ち受ける。
7. 中断された実行を回復する（`recoverInterrupted`）：
   - 答えの途中だった「オーケストレーターに質問」を、中断として記録する。
   - 実行の途中だったデプロイの確認を、中断として記録する。マージの後の監視の工程なら一時停止（`TaskPaused`、理由 `error`）にし、再開で確かめ直す。工程の無い以前のタスクなら、確かめられなかったとして終える（[マージの後の監視](deployment-watch.md)）。
   - 判定の途中だったゴールガーディアンの判定を、判定できなかった（`undecidable`）として記録する。
   - 実行中（`running`）だったタスクは、実行の失敗（`AgentRunFailed`）として記録し、一時停止（`TaskPaused`、理由 `error`）にする。
8. 実行できずに待っていた工程を実行待ちにする（`queueWaitingSteps`）。
9. 起動時の問題（設定の誤りなど）を端末に出す。
10. API を `127.0.0.1:<ポート>` で待ち受ける。待ち受けを始めたら、使う秘密情報をまとめて取り出し（プロジェクトのコンテキストの秘密情報を含む。
    コンテキストの取得は最長 30 秒まで待つ。[秘密情報](secrets.md)）、
    その後で、ホストの MCP サーバーの起動、コンテキストのコマンド型の MCP サーバーの準備（前回の層の写し `SACTY_HOME/context-mcp/layers`
    を消し、使われなくなったものを止める確かめを始める）、組織内 PF の認証の用意、ワーカー・取り込み・PR の監視を始める。

ワーカーは2秒ごとに、実行待ちのタスクを作成の古い順に、同時に実行する上限（sacty の設定の `maxParallelTasks`。既定
`DEFAULT_MAX_PARALLEL_TASKS` = 3）まで実行する。同じタスクを同時に2つ実行しない。PR の監視は60秒ごとに、前の確認が終わってから確かめる（マージの後の CI/CD の監視も、その終わりに行う）。

コード: `apps/daemon/src/main.ts`、`apps/daemon/src/service.ts`（`recoverInterrupted`・`queueWaitingSteps`・`maxParallelTasks`）、
`apps/daemon/src/worker.ts`（`Worker`）、`apps/daemon/src/pr-watcher.ts`（`PullRequestWatcher`）、`packages/core/src/projects.ts`（`DEFAULT_MAX_PARALLEL_TASKS`）

## 二重の起動

- ロックのファイルは `SACTY_HOME/daemon.lock`。SQLite の排他ロック（`PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;`）を取り、
  コミットしないまま持ち続ける。ロックは OS がプロセスに対して持つので、デーモンがどう終わっても（SIGKILL を含む）外れる。
  ロックのファイルは消さない。ファイル（inode）に掛かるので、同じディレクトリを別のパスで指しても二重に起動できない。
- ロックを取ったデーモンは、表示用に `SACTY_HOME/daemon-owner.json`（PID・接続先・起動の時刻）を書く。判定には使わない。
- 2つ目のデーモンは、ロックが取れない（`SQLITE_BUSY`）と、動いているデーモンの接続先・PID・起動の時刻（読めなければ、読めなかったこと）
  を表示して、終了コード `3` で終わる。ロックの取得のほかの失敗（権限など）は、例外のまま起動しない。
- ポートが違っても、同じ `SACTY_HOME` なら起動しない。違う `SACTY_HOME` なら、ポートを変えて並行して動かせる。

コード: `apps/daemon/src/instance-lock.ts`（`acquireInstanceLock`・`alreadyRunningMessage`・`LOCK_FILE`・`OWNER_FILE`）、`apps/daemon/src/exit-codes.ts`（`ALREADY_RUNNING_EXIT_CODE`）

## デーモンの終了

SIGINT・SIGTERM を受けると、1回だけ次を行う。

1. 秘密情報の取り出しのための、コンテキストの取得の git（別のプロセスグループで動く）を、グループごと止める（`stopFetchProcessesSync`）。
2. ワーカー（新しい実行を始めず、実行中の処理の後片付けを待つ）・取り込み・PR の監視を止め始める。
3. ホストの MCP サーバーと、コンテキストのコマンド型の MCP サーバーを止め始める（後片付けを待たない。コンテキストのものは層の写しも消す）。
4. 実行中のエージェントとテストのコンテナを止める。
5. 2 の後片付けを最大20秒（`DRAIN_TIMEOUT_MS`）待つ。過ぎたら警告を出して進む。
6. ゲートウェイを閉じ、ホストの MCP サーバーが止まるのを待ち、API の待ち受けを閉じてから、DB を閉じ、ロックを外し（自分の書いた
   `daemon-owner.json` も消す）、終了コード 0 で終わる。

デーモンが例外などで終わるとき（`exit`）も、ホストの MCP サーバーのプロセスグループに SIGTERM を送り、コンテキストの取得の git の
プロセスグループに SIGKILL を送る（[秘密情報](secrets.md)）。

コード: `apps/daemon/src/main.ts`（`shutdown`・`DRAIN_TIMEOUT_MS`）、`apps/daemon/src/context-mcp.ts`（`ContextMcpServers.start`・`ContextMcpServers.stop`）、`apps/daemon/src/fetch-processes.ts`（`spawnStoppable`・`stopFetchProcessesSync`）
