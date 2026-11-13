**日本語** | [English](daemon-lifecycle.en.md)

# デーモンの起動と終了

`sacty up` が、デーモン（`apps/daemon`）と画面（`apps/web` の Next.js）を子プロセスとして起動し、どちらかが終われば両方を止める。
デーモンは、同じ `SACTY_HOME` で1つしか動かない（OS のファイルロックで判定する）。

関係する ADR: [画面は、起動ごとの秘密で入ったブラウザだけが使える](../adr/20261018-0414-web-session-auth.md)、[画面の認証を設定で OFF にできるようにする](../adr/20261018-0929-web-auth-off-setting.md)、[sacty の最新版を、動いている版と GitHub Releases の最新のリリースで比べて知らせる](../adr/20261020-0008-update-check-against-releases.md)、[コンテキストリポジトリにイメージを定義できるようにし、デーモンが起動の後に裏で作る](../adr/20261111-0038-context-images-built-by-daemon.md)

## sacty up

- オプションは `--port`（画面のポート。既定 `4700`）と `--daemon-port`（デーモンのポート。既定 `4710`）。
  どちらも 1〜65535 の整数で、同じ値は誤りにする。
- 起動のたびに、次の2つを作る。
  - デーモンと画面の間で使うトークン（32 バイトの乱数の16進）
  - 画面の入り口の秘密（32 バイトの乱数の base64url。デーモンのトークンとは別のもの）
- デーモンを、環境変数 `SACTY_DAEMON_PORT`・`SACTY_DAEMON_TOKEN`・`SACTY_WEB_URL`（`http://127.0.0.1:<画面のポート>`。通知のリンクに使う）を付けて起動する。
  画面の入り口の秘密 `SACTY_WEB_TOKEN` は、利用者のシェルにあっても取り除いて渡す。
  その後、`GET /api/health` が応答するまで最大15秒待つ（200ミリ秒ごとに確かめる）。
  応答しなければ止める。
- デーモンが応答したら、`SACTY_HOME/daemon.json`（権限 0600）に、デーモンの接続先とトークンを書く（`sacty context preview`・`sacty launch` が読む）。
  - すでにほかの sacty の接続先が書かれていて、それがトークン付きで応答するなら、上書きせずに警告を出す。
  - 終わるときは、自分が書いたもの（接続先とトークンが同じ）だけを消す。
- 次に、画面を `next start -H 127.0.0.1 -p <画面のポート>` で起動する。
  環境変数は `SACTY_DAEMON_URL`・`SACTY_DAEMON_TOKEN`・`SACTY_WEB_TOKEN`（画面の入り口の秘密）・`SACTY_WEB_PORT`（画面のポート）を付ける。
- 端末に、画面の入り口の URL（`http://127.0.0.1:<画面のポート>/auth?token=<画面の入り口の秘密>`）を表示する（下の「画面の認証」）。
- SIGINT・SIGTERM を受けると、止めていることと、もう一度 Ctrl+C を押せば待たずに止めることを表示し、子プロセスに SIGTERM を送り、すべて終わってから終了する。
  30秒たっても残っている子には SIGKILL を送る（デーモンの後片付けの上限 20 秒より長く待つ）。
- 止めている途中で、もう一度 SIGINT・SIGTERM を受けると、後片付けを待たずに止める。
  デーモンには `FORCE_STOP_SIGNAL`（SIGUSR2）を、画面には SIGKILL を送り、5秒たっても残っている子には SIGKILL を送る。
  Ctrl+C では、端末からの SIGINT がデーモンにも直接届き、CLI からの SIGTERM と重なるので、デーモンは届いた SIGINT を数えずに、別のシグナルで見分ける。
- 子プロセスが想定外に終わったときは、もう片方も止め、失敗の終了コードで終わる（子の終了コードが 0 でも 1 にする）。
  デーモンが終了コード `3`（`ALREADY_RUNNING_EXIT_CODE`）で終わったときは、ほかの sacty が動いているため起動しなかったと表示する。

コード: `packages/cli/src/index.ts`（`up`・`waitForDaemon`・`parsePort`）、`packages/cli/src/up-stop.ts`（`UpStopper`・`STOP_TIMEOUT_MS`・`FORCE_STOP_TIMEOUT_MS`）、`apps/daemon/src/exit-codes.ts`（`FORCE_STOP_SIGNAL`）、`packages/cli/src/up-env.ts`（`daemonEnv`・`webEnv`・`signInUrl`）、`packages/cli/src/context-preview.ts`（`claimDaemonFile`・`removeDaemonFile`・`DAEMON_FILE`）

## 画面の認証

画面は、起動した本人のブラウザからのリクエストだけをデーモンへ中継する。
工程のコンテナも、ホストの 127.0.0.1 に届く（`host.docker.internal`）ためである。

- 入り口の URL（`/auth?token=<秘密>`）を開いたブラウザに cookie を渡し、トップ（`/`）へ移す。
  - cookie の名前は `sacty-session-<画面のポート>`、値は秘密から作った HMAC-SHA256。
    属性は `HttpOnly`・`SameSite=Lax`・`Path=/`・30 日。
  - 転送先は、ブラウザが開いている Host のまま（`127.0.0.1` と `localhost` は別の cookie になるため）。
  - 秘密が誤り・空なら 401 を返し、cookie を渡さない。
  - 入った後に `/auth` だけを開いたら、トップへ移す。
- 入り口の URL は、その起動の間は何度でも使える（別のブラウザで開き直せる）。
  起動し直すと秘密が変わり、前の cookie と URL は使えない。
- `config.yaml` の `web.auth: false` で OFF にできる（既定は ON。設定ファイルが無い・読めないときも ON）。
  OFF のときは次のようになる。
  - `sacty up` は秘密を作らず、画面に `SACTY_WEB_AUTH=off` を渡す。
    利用者のシェルの `SACTY_WEB_AUTH` は取り除き、設定ファイルからだけ決める。
  - 画面は cookie を確かめずに使える。
    Host の確かめは残す。
    入り口の URL はトップへ移すだけ。
  - 端末には、画面の URL と、工程のコンテナから画面を操作できるという警告を表示する。
- すべてのリクエスト（画面・取り直し・ダウンロード・Server Actions。ビルドした静的なファイルとアイコンを除く）で、Proxy（`apps/web/src/proxy.ts`）が次を確かめる。
  断るときは、画面の部品（デーモンに問い合わせる）を使わず、決まった文だけを画面の言語で返す。
  - Host がループバック（`127.0.0.1`・`localhost`・`[::1]`。ポートは問わない）でなければ 403（DNS rebinding の対策）。
  - 今の起動の cookie が無ければ 401。
    画面の秘密が無い（`sacty up` で起動していない）ときも 401 で、起動の仕方を出す。
- 画面の応答には `Content-Security-Policy: frame-ancestors 'none'` を付け、別のサイトの枠に埋め込ませない（クリックジャッキングの対策。`apps/web/next.config.ts`）。
- デーモンへ中継する所（`daemonFetch`）でも、今の起動の cookie を確かめ直す。
  無ければ、デーモンのトークンを使わずに断る（Proxy の範囲から外れた入口があっても中継しない）。
- デーモンの API の認証（`SACTY_DAEMON_TOKEN`）は変えない。
  画面の秘密は、デーモンにも工程のコンテナにも渡さない。
- 開いたままの画面の取り直し（live）が 401 になったときは、端末に表示された新しい URL を開くよう出す。
  起動し直して前の cookie が使えないときに起きるもので、デーモンに届かないときとは分けて出す。
  表示は最後に取れたデータのまま残す。

コード: `apps/web/src/proxy.ts`、`apps/web/src/lib/web-auth.ts`、`apps/web/src/lib/web-guard.ts`、`apps/web/src/lib/daemon.ts`（`daemonFetch`）

## デーモンの起動の順序

1. `SACTY_DAEMON_TOKEN` が無ければ、`sacty up` から起動するよう表示して終了コード 1 で終わる。
   ポートは `SACTY_DAEMON_PORT`（既定 4710）。
2. `SACTY_HOME` のディレクトリを作り、インスタンスのロックを取る（下の「二重の起動」）。
   取れなければ、作業履歴などに触れる前に終わる。
3. `SACTY_HOME/sacty.db` を開く（作業履歴・プロジェクト・sacty の設定）。
   設定（`config.yaml`）は使うたびに読み直す。
   続けて、「PR作成」の工程を含む以前の版のタスクを作業履歴から消す（`purgeLegacyTasksAtStartup`。消した件数を端末に出す）。
   設定に誤りがある間は消さずに、件数と誤りを端末に出して終了コード 1 で終わる。
4. 前回のデーモンが残した docker compose のサービスと、共用の compose の実行ごとの取得を片付ける。
5. 前回のデーモンが残したホストの MCP サーバーのプロセスを片付ける（[ゲートウェイ](gateway.md)）。
   コンテキストのコマンド型の MCP サーバーのものも、同じ記録で片付ける。
6. ゲートウェイを待ち受ける。
7. 中断された実行を回復する（`recoverInterrupted`）。
   - 答えの途中だった「オーケストレーターに質問」を、中断として記録する。
   - 実行の途中だったデプロイの確認を、中断として記録する。
     マージの後の監視の工程なら一時停止（`TaskPaused`、理由 `error`）にし、再開で確かめ直す。
     工程の無い以前のタスクなら、確かめられなかったとして終える（[マージの後の監視](deployment-watch.md)）。
   - 以前の版で AI の判定の途中だった変更の申し出を、人の判断待ち（`TaskEscalated`、理由 `change_proposed`）にする（[変更の申し出](tasks-and-steps.md#変更の申し出)）。
   - 実行中（`running`）だったタスクは、実行の失敗（`AgentRunFailed`）として記録し、一時停止（`TaskPaused`、理由 `error`）にする。
   - 終わらなかったエラーの分析を、中断として記録する（次の分析を受け付けるため。[エラーレポート](error-report.md#オーケストレーターの分析)）。
8. 前回のデーモンが残した作業領域を消し始める（`cleanupWorkspacesAtStartup`。[タスクと工程](tasks-and-steps.md#終わったタスクの作業領域の片付け)）。
   - 実行ごとの一時領域のうち、動いている実行のものでないもの。
   - もう使わない完了したタスクと、どのタスクのものでもない作業領域・退避した git のメタデータ。

   消し終わるのを待たずに、次に進む（API の待ち受けを遅らせない。`sacty up` は起動を 15 秒まで待って確かめるため）。
   消せなくても、理由を端末に出して起動を続ける。

   片付けを待たずに、続けて次を行う。
   - 採用を記録したが作る前に止まった、監査の改修のタスクと、セキュリティ対応のタスクを作る（`resumeAuditFixTasks`・`resumeSecurityFixTasks`）。
   - 監査が登録したメモリーを作業履歴に合わせて書き直し、残す日数を過ぎたものを消す（`syncMemories`。その後も定期的に消す。[メモリー](memory.md)）。
   - 最新版の確かめと、Docker とエージェントのイメージの確かめを始める（下の「最新版の確かめ」「Docker とエージェントのイメージの確かめ」）。
9. 実行できずに待っていた工程を実行待ちにする（`queueWaitingSteps`）。
10. 起動時の問題（設定の誤りなど）を端末に出す。
11. API を `127.0.0.1:<ポート>` で待ち受ける。
    待ち受けを始めたら、使う秘密情報をまとめて取り出す（プロジェクトのコンテキストの秘密情報を含む。コンテキストの取得は最長 30 秒まで待つ。[秘密情報](secrets.md)）。
    その後、8 の片付けが終わってから、次を始める（その間に止め始めていれば、始めない）。
    - ホストの MCP サーバーの起動
    - コンテキストのコマンド型の MCP サーバーの準備（前回の層の写し `SACTY_HOME/context-mcp/layers` を消し、使われなくなったものを止める確かめを始める）
    - 組織内 PF の認証の用意
    - コンテキストのイメージの作成（下の「コンテキストのイメージの作成」）
    - ワーカー・取り込み・PR の監視・スケジュールタスク

ワーカーは2秒ごとに、実行待ちのタスクを作成の古い順に実行する。
同時に実行する数の上限は、sacty の設定の `maxParallelTasks`（既定 `DEFAULT_MAX_PARALLEL_TASKS` = 3）。
同じタスクを同時に2つ実行しない。

PR の監視は60秒ごとに、前の確認が終わってから確かめる。
マージの後の CI/CD の監視も、その終わりに行う。

コード: `apps/daemon/src/main.ts`、`apps/daemon/src/workspace-cleanup.ts`（`startAfterCleanup`）、`apps/daemon/src/service.ts`（`recoverInterrupted`・`cleanupWorkspacesAtStartup`・`queueWaitingSteps`・`maxParallelTasks`）、
`apps/daemon/src/worker.ts`（`Worker`）、`apps/daemon/src/pr-watcher.ts`（`PullRequestWatcher`）、`packages/core/src/projects.ts`（`DEFAULT_MAX_PARALLEL_TASKS`）

## 最新版の確かめ

デーモンは、動いている sacty の版（`apps/daemon/package.json` の `version`）と、GitHub の sacty のリポジトリ（`SACTY_REPOSITORY` = `sert-xx/sacty`）の最新のリリース（GitHub Releases の `latest`。タグ `v<版>`）を比べる（PBI-135・PBI-147）。
最新のリリースの版が新しければ、新しい版があると画面に知らせる。
1.0.0 より前は、手元のコミットと `main` を比べていた。

- 動いている版は、`apps/daemon/package.json` の `version`（src・dist のどちらから動いても同じファイル）。
  - 動いているコードの版なので、起動してから最初の確かめのときに1回だけ読む。
    更新しても、起動し直すまでは前の版と比べる。
  - semver の `MAJOR.MINOR.PATCH`（先頭の `v` は任意。先行ゼロ・プレリリース・ビルドは認めない）でなければ確かめない。
- GitHub の最新のリリースの API（`GET /repos/sert-xx/sacty/releases/latest`）の `tag_name` を同じ形で読み、数で比べる（`1.10.0` は `1.9.0` より新しい）。
  - 最新のリリースの版が動いている版より大きければ、新しい版がある。
    同じ・小さい（手元が開発中の新しい版）なら知らせない。
  - 下書き・プレリリースは使わない（`latest` は返さないが、返っても使わない）。
  - 認証は付けない（公開のリポジトリ。1時間に 60 回の上限より十分少ない）。
- 起動のときと、それから1時間ごとに、前に問い合わせてから1日（`UPDATE_CHECK_INTERVAL_MS`）たっていれば問い合わせる。
  問い合わせる前に時刻を記録するので、重ねて問い合わせない。
  失敗しても、次の問い合わせは1日後。
- 確かめられないときは、黙って知らせを消す。
  誤りや警告にしない。
  確かめられないのは、版を読めない・リリースが1つも無い（404）・ネットワークに届かない・レート制限・応答の形が違う・タグが版の形でない・10 秒で応答しないとき。
- `config.yaml` の `update_check: false` なら、問い合わせず（動いている版も読まない）、知らせも出さない（設定を読めなければ ON）。
  - 設定は使うたびに読む。
  - OFF を見たら（確かめのときも、状態を返すときも）、知らせと問い合わせの時刻を消し、世代を進める。
  - 版を待つ間や問い合わせの間に OFF にされたら、問い合わせない・結果を残さない（その間に ON に戻っていても）。
  - ON に戻すと、1時間以内に確かめる。
- 知らせは `GET /api/status` の `update`（`latest`・`current`・`releaseUrl`）。
  設定に誤りがあっても載せる。
  - 画面は、どの画面でも中身の上に、最新の版と動いている版・リリースのページへのリンク（`https://github.com/` で始まるものだけ）・更新のコマンドを出す。
  - 共通の外枠は画面の移動で描き直されない。
    そのため画面は `/live/update` から 30 秒ごと（`UPDATE_LIVE_INTERVAL_MS`）に取り直し、知らせが現れる・消えるのをリロードせずに反映する。
- 更新のコマンドは、動いている `sacty up` を止めてから実行する順に示す（`npm run build` が画面の `.next` を消して作り直すため）。
  コマンドの前に、`npm run cli:install` で入れた人は `npm run build` の代わりに `npm run cli:install` を実行するよう添える（入口に入れたときの Node.js を書いているので、Node.js の版が変わったら入れ直す。[アーキテクチャ](architecture.md#パッケージ)）。
  既定のイメージの名前は版に連れて変わるので、`npx sacty image build` を含める。
  依存は `npm ci` で入れ直す（`package-lock.json` を書き換えないので、レジストリを設定で変えていても作業ツリーに差分が残らず、次の `git pull` がぶつからない）。

コード: `apps/daemon/src/update-check.ts`（`UpdateChecker`・`packageVersion`・`parseVersion`・`compareVersions`・`startUpdateCheck`・`SACTY_REPOSITORY`・`UPDATE_CHECK_INTERVAL_MS`）、
`apps/daemon/src/service.ts`（`TaskService.status`）、`apps/web/src/components/shell/update-notice.tsx`（`UpdateNotice`）、
`apps/web/src/components/shell/update-notice-live.tsx`（`UpdateNoticeLive`・`UPDATE_LIVE_INTERVAL_MS`）、`apps/web/src/components/shell/update-notice-view.tsx`（`UpdateNoticeView`・`safeGitHubUrl`・`UPDATE_COMMANDS`）

## Docker とエージェントのイメージの確かめ

デーモンは、起動のときと、それから1分ごと（`IMAGE_CHECK_INTERVAL_MS`）に、Docker を使える状態かを確かめる（PBI-148）。
確かめるのは、Docker が動いているか、エージェントのイメージが手元にあるか、設定のイメージが動いている sacty の版のものか。
タスクを実行して `run.imageMissing` などで止まる前に知らせるためである。

- まず `docker version --format {{.Server.Version}}` で、Docker（デーモン）が動いているかを確かめる。
  - 終了コード 0 なら動いている。
  - docker のコマンドが見つからない（起動の `ENOENT`）なら、`image.dockerNotInstalled` の注意を1つだけ出し、イメージは確かめない。
  - それ以外（デーモンに接続できない・10 秒（`IMAGE_INSPECT_TIMEOUT_MS`）で応答しない。応答しなければ止める）なら、`image.dockerUnreachable` の注意を1つだけ出し、イメージは確かめない。
- 確かめるイメージは、`config.yaml` の `image`（既定 `sacty-agent:<版>`）と `images.*` のイメージ（同じ名前は1回だけ）。
  - 設定ファイルが無ければ、既定のイメージだけを確かめる。
  - 設定に誤りがあれば、イメージは確かめない。
    設定の誤りは別に知らせている。
    Docker が動いているかは確かめる。
  - 設定は確かめるたびに読む。
- 設定のイメージが、sacty が名付けるイメージ（既定は `sacty-agent`、言語ごとは `sacty-agent-<名前>`）で、タグだけが動いている sacty の版と違うときは、古いイメージとして注意にする（`image.outdated`）。
  - 例は、`sacty config init` が書いた `image: sacty-agent:<前の版>` が、版を上げても残っているとき。
    タグが無いものも含む。
  - 注意には、直す場所（`image` か `images.<名前>.image`）・動いている版のイメージの名前・作るコマンドを書く。
  - そのイメージが手元にあるかは確かめない。
  - ほかの名前（利用者が付けた名前・レジストリのイメージ）は比べない。
- ほかのイメージは `docker image inspect --format {{.Id}} <名前>` を実行する。
  - 終了コード 0 ならある。
  - 標準エラー出力に `No such image`・`No such object` があれば無い。
  - それ以外（Docker に接続できない・docker が無い・10 秒で応答しない。応答しなければ止める）は確かめられない。
- 無いイメージごとに、名前と作るコマンドを注意にする（`image.missing`）。
  - 作るコマンドは、既定のイメージは `npx sacty image build`、言語ごとのイメージは `npx sacty image build <名前>`。
  - 名前にレジストリのホストを含むイメージ（最初の `/` の前に `.`・`:` があるか `localhost`）は、実行のときに取得を試みることも添える（`image.notLocal`）。
  - 確かめられないイメージが1つでもあれば、`image.dockerUnreachable` を1つだけ出す。
- 注意は `GET /api/status` の `docker` に載せる（`warnings` とは分ける）。
  設定ファイルが無いとき（設定の誤りとして `problems` が出る）も載せる。
  - 画面は、どの画面でも中身の上に「Docker を使える状態ではありません」として出す（`DockerNotice`）。
  - 画面は 30 秒ごと（`DOCKER_LIVE_INTERVAL_MS`）に `/live/docker` から取り直す。
    直れば、リロードせずに消える。
    取り直せないときは、最後に取れた表示のまま。
- 最初の確かめの結果は、端末（`sacty up` の出力）にも出す。
  起動は止めず、自動では作らない・設定を直さない。
  直せば、次の確かめで注意が消える。
  確かめている最中に重ねて確かめない。
- デーモンを止めるときは、間隔を止め、実行中の docker を止める（`SIGKILL`）。
  打ち切った確かめの結果は残さず、それからは確かめない。

コード: `apps/daemon/src/image-presence.ts`（`ImagePresenceChecker`・`pingDocker`・`inspectImage`・`imageTargets`・`isOutdatedImage`・`isRegistryImage`・`buildCommand`・`startImagePresenceCheck`・`IMAGE_CHECK_INTERVAL_MS`・`IMAGE_INSPECT_TIMEOUT_MS`）、
`apps/daemon/src/service.ts`（`TaskService.status`）、`apps/daemon/src/main.ts`、`apps/web/src/components/shell/docker-notice.tsx`（`DockerNotice`）、
`apps/web/src/components/shell/docker-notice-live.tsx`（`DockerNoticeLive`・`DOCKER_LIVE_INTERVAL_MS`）、`apps/web/src/components/shell/docker-notice-view.tsx`（`DockerNoticeView`）、
`apps/web/src/app/live/docker/route.ts`

## コンテキストのイメージの作成

コンテキストリポジトリの `images.yaml` のイメージ（[コンテキストの合成](context.md#コンテキストリポジトリのファイル)）は、`sacty image build` では作らず、デーモンが起動の後にプロジェクトごとに作る（PBI-325）。

- 読むとき：起動の 11 で始めるとき・プロジェクトを保存（作成・変更・取り込み）・削除したとき・5分ごと（`CONTEXT_IMAGES_REFRESH_MS`）。
  - コンテキストのあるプロジェクトだけを、1つずつ順に読む（`contextImages`。継承の鎖を合成し、`locked`・`remove` も効かせる）。
    1つのプロジェクトの取得を5分（`CONTEXT_IMAGES_LOAD_TIMEOUT_MS`）待っても終わらなければ、取得を止めて読めなかったことにする（`contextImage.loadTimedOut`）。
  - 設定（`config.yaml`）を読めなければ、作らない（片付けもしない）。
  - 読んでいる途中に読み直しを求められたら（プロジェクトの保存など）、読み終えてから、もう一度読む。
  - `config.yaml` の `images` と同じ名前のものは作らず、`contextImage.configOverride` の警告にする（自身のプロパティだけを比べる。`hasImage`）。
  - 読めなければ、前に読んだもの（あれば）を使い続け、`contextImage.loadFailed` の警告にする。
- 名前：`sacty-ctx-<印>-<プロジェクトの ID>-<名前>:<ハッシュ>`（`contextImageTag`）。
  印は `SACTY_HOME` の SHA-256 の先頭8文字（同じ Docker を使う別の `SACTY_HOME` のデーモンのイメージと見分ける）。
  ハッシュは、定義・`image_build`（認証は秘密情報の名前だけ）・既定のイメージの名前（sacty の版）・プロジェクトの ID・名前から作る。
  名前は Docker に使える形にする（英小文字・数字・`-`）。
- 状態：`queued`（順番待ち）・`building`（作成中）・`ready`（作成済み）・`failed`（失敗）。
  - 読むたびに `docker image inspect` で確かめ、あれば `ready`、無ければ `queued`。
    同じ名前のものは、前の状態を引き継ぐ（作成中・失敗のまま）。
    `ready` のものも確かめ直し、無ければ `queued` にする（確かめられないときは `ready` のまま）。
  - 状態はメモリーにだけ持つ（デーモンを起動し直すと、失敗したものも作り直す）。
  - 確かめられない（Docker に接続できない）ときは `failed`（`image.dockerUnreachable`）にし、次に読むときに確かめ直す。
- 作成：`queued` のものを、すべてのプロジェクトで1つずつ順に作る（読み直している途中のプロジェクトのものは、読み終えてから）。
  - `buildImage`（`sacty image build` と同じ Dockerfile。言語ごとのイメージとして作る）を使い、docker の出力の末尾（16 KiB。`CONTEXT_IMAGE_LOG_MAX`）を持つ。
  - `image_build` は、名前を決めたとき（読んだとき）のものを使う（名前のハッシュと中身を一致させる）。
  - 60分（`CONTEXT_IMAGE_BUILD_TIMEOUT_MS`）で終わらなければ、docker を止めて `failed`（`contextImage.buildTimedOut`）にし、次のものを作る。
    止めてから 15 秒（`CONTEXT_IMAGE_ABANDON_MS`）で終わらない処理（npm のトークンの取り出しが応答しないなど）は見切る（見切った処理は、止めた signal を見て docker を動かさない）。
  - Dockerfile の場所は、`sacty up` が渡す `SACTY_DOCKER_DIR`（無ければリポジトリの `packages/cli/docker`）。
  - 失敗したら `failed`（`contextImage.buildFailed`）にする。
    自動では作り直さない。
    `POST /api/projects/:id/context-images/:name/rebuild`（画面の「作り直す」）で `queued` に戻す（失敗していないものは `contextImage.notFailed`、無いものは `contextImage.notFound` で断る）。
  - すべて作り終え、設定を読めて、どのプロジェクトも今の定義を読めていれば、今の定義の名前以外の、自分の印の `sacty-ctx-<印>-` のイメージを `docker image rm` で消す（強制では消さない）。
    2分（`CONTEXT_IMAGES_PRUNE_TIMEOUT_MS`）で終わらなければ止め、止めた docker が終わる（`CONTEXT_IMAGE_ABANDON_MS` まで）のを待ってから先に進む。
    消している間は、読み直しが手元にあるかを確かめず、消し終えてから確かめる。
    消している間に順番待ちが増えたら、消し終えてから作る。
  - デーモンを止めるとき・作成の時間切れのときは、docker に `SIGTERM` を送り、10 秒（`DOCKER_KILL_GRACE_MS`）で終わらなければ `SIGKILL` を送る（`runDockerStreaming`）。
  - デーモンを止めるときは、間隔を止め、作成中の docker を止める。
    止めた作成の後片付け（npm の認証を書いた一時ファイルを消す）が終わるのを、ほかの後処理と一緒に待つ（上限は後処理と同じ 20 秒）。
- 状況：`GET /api/status` の `contextImages`（イメージのあるプロジェクトだけ）に載せ、読めなかった・同じ名前だったことは `warnings` に載せる。
  - 画面は、どの画面でも中身の上に、作成中・順番待ち・失敗したものを「イメージの作成」として出す（`ContextImagesNotice`）。
    作成中のログを開いて出し、失敗したものには理由・ログ・「作り直す」を出す。
  - 画面は 5 秒ごと（`CONTEXT_IMAGES_LIVE_INTERVAL_MS`）に `/live/context-images` から取り直す。
- 使い方：プロジェクトのタスクでは、`config.yaml` の `images` に、そのプロジェクトのコンテキストのイメージを足したものから選ぶ（`projectImagesConfig`。同じ名前は `config.yaml` のもの）。
  - 作成中・失敗のものも選べる（`imageDefined`）。
    実行のときは使わず、理由（`contextImage.building`・`contextImage.failed`）で止める（`resolveImage`）。
    マージの後のデプロイの確認も、既定のイメージに倒さず、確かめられなかったこと（`deploy.checkFailed`）として理由を記録する。
  - 画面の選択肢（タスクの作成・差し戻し・タスクの詳細・プロジェクトの対象）にも、そのプロジェクトのものを足す（`projectImages`）。
- 待ち：プロジェクトのコンテキストを読む前・読んでいる間・作る順番待ち・作成中は、そのイメージを使うかもしれないタスクの実行を始めない（`awaitingContextImages`。実行の印も付けず、ワーカーが2秒ごとに確かめ直す）。
  - 使うかもしれないのは、イメージが決まっていない（工程が無く、人もプロジェクトの対象も指定していない）タスクと、決まった名前が `default` でも `config.yaml` の `images` でもないタスク。
    名前は実行のときと同じ順で決める（タスクのイメージ（人が変えたものを含む）、古い版の工程ごとのイメージ、工程を選ぶ前なら作成時・プロジェクトの対象の指定）。
  - 60分（`CONTEXT_IMAGES_WAIT_MS`）待っても終わらなければ、`TaskPaused`（理由 `error`、`contextImage.waitTimedOut`）にする。
  - 待っている間の一時停止・中止は、実行していないタスクと同じにすぐ効く。
  - ワーカーは、待っているタスクを実行の対象から除いてから、同時に実行する数を数える（`runnableTaskIds`。後の実行できるタスクの枠を塞がない）。

コード: `apps/daemon/src/context-images.ts`（`ContextImageBuilder`・`contextImageTag`・`contextImagePrefix`・`contextLanguageImage`・`runDockerStreaming`・`removeStaleContextImages`・`CONTEXT_IMAGES_REFRESH_MS`・`CONTEXT_IMAGE_LOG_MAX`・`CONTEXT_IMAGE_BUILD_TIMEOUT_MS`・`CONTEXT_IMAGES_LOAD_TIMEOUT_MS`・`CONTEXT_IMAGES_PRUNE_TIMEOUT_MS`・`DOCKER_KILL_GRACE_MS`・`CONTEXT_IMAGE_ABANDON_MS`）、
`apps/daemon/src/context.ts`（`contextImages`）、`apps/daemon/src/config.ts`（`resolveImage`・`imageDefined`・`hasImage`）、
`apps/daemon/src/service.ts`（`projectImagesConfig`・`awaitingContextImages`・`runnableTaskIds`・`mayUseContextImage`・`loadContextImages`・`rebuildContextImage`・`refreshContextImages`・`CONTEXT_IMAGES_WAIT_MS`）、
`apps/daemon/src/server.ts`、`apps/daemon/src/main.ts`、`apps/daemon/src/worker.ts`（`Worker`）、`packages/cli/src/up-env.ts`（`daemonEnv`）、
`apps/web/src/components/shell/context-images-notice-view.tsx`（`ContextImagesNoticeView`）、`apps/web/src/components/shell/context-images-notice-live.tsx`（`CONTEXT_IMAGES_LIVE_INTERVAL_MS`）、`apps/web/src/lib/labels.ts`（`projectImages`）

## 二重の起動

- ロックのファイルは `SACTY_HOME/daemon.lock`。
  - デーモンは SQLite の排他ロック（`PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;`）を取り、コミットしないまま持ち続ける。
  - OS がプロセスに対してロックを持つので、デーモンがどう終わっても（SIGKILL を含む）ロックは外れる。
  - ロックのファイルは消さない。
  - ロックはファイル（inode）に掛かるので、同じディレクトリを別のパスで指しても二重に起動できない。
- ロックを取ったデーモンは、表示用に `SACTY_HOME/daemon-owner.json`（PID・接続先・起動の時刻）を書く。
  判定には使わない。
- 2つ目のデーモンは、ロックが取れない（`SQLITE_BUSY`）と、動いているデーモンの接続先・PID・起動の時刻を表示して、終了コード `3` で終わる。
  読めなければ、読めなかったことを表示する。
  ロックの取得のほかの失敗（権限など）は、例外のまま起動しない。
- ポートが違っても、同じ `SACTY_HOME` なら起動しない。
  違う `SACTY_HOME` なら、ポートを変えて並行して動かせる。

コード: `apps/daemon/src/instance-lock.ts`（`acquireInstanceLock`・`alreadyRunningMessage`・`LOCK_FILE`・`OWNER_FILE`）、`apps/daemon/src/exit-codes.ts`（`ALREADY_RUNNING_EXIT_CODE`）

## デーモンの終了

SIGINT・SIGTERM を受けると、デーモンは1回だけ次を行う。

1. 秘密情報の取り出しのための、コンテキストの取得の git を、プロセスグループごと止める（`stopFetchProcessesSync`）。
   この git は別のプロセスグループで動く。
2. ワーカー・取り込み・PR の監視を止め始める。
   ワーカーは新しい実行を始めず、実行中の処理の後片付けを待つ。
   画面から始めたエラーの分析も、記録と後片付けを待つ（止め始めた後は、分析を受け付けない。[エラーレポート](error-report.md#オーケストレーターの分析)）。
   作成中のコンテキストのイメージの docker build も止め、後片付けを待つ。
3. ホストの MCP サーバーと、コンテキストのコマンド型の MCP サーバーを止め始める。
   後片付けは待たない。
   コンテキストのものは層の写しも消す。
4. 実行中のエージェントのコンテナを止める。
   これより後は、新しいコンテナを起動しない（作業領域を写している途中だった実行は、写し終わっても起動せずに `run.daemonStopped` で終わる）。
5. 2 の後片付けを最大20秒（`DRAIN_TIMEOUT_MS`）待つ。
   3秒（`DRAIN_REPORT_MS`）たっても終わっていなければ、まだ終わっていないもの（実行中のタスク・エラーの分析・取り込み・PR の確認・スケジュールタスクの確認・コンテキストのイメージの作成）を表示する。
   20秒を過ぎたら警告を出して進む。
6. ゲートウェイを閉じ、ホストの MCP サーバーが止まるのを待ち、API の待ち受けを閉じる。
   ホストの MCP サーバーも、3秒たっても止まっていなければ、待っていることを表示する。
   それから DB を閉じ、ロックを外し（自分の書いた `daemon-owner.json` も消す）、終了コード 0 で終わる。

止めている途中で `FORCE_STOP_SIGNAL`（SIGUSR2。`sacty up` が、もう一度 Ctrl+C を押されたときに送る）を受けると、後片付けを待たずに、終了コード 1 で終わる。
後片付けの途中だった実行は、次の起動で中断として回復する（上の「デーモンの起動の順序」の 7）。

デーモンが例外などで終わるとき（`exit`。`FORCE_STOP_SIGNAL` で終わるときも含む）も、ホストの MCP サーバーのプロセスグループに SIGTERM を送り、コンテキストの取得の git のプロセスグループに SIGKILL を送る（[秘密情報](secrets.md)）。

コード: `apps/daemon/src/main.ts`（`shutdown`・`DRAIN_TIMEOUT_MS`・`DRAIN_REPORT_MS`）、`apps/daemon/src/shutdown-report.ts`（`waitNamed`）、`apps/daemon/src/exit-codes.ts`（`FORCE_STOP_SIGNAL`）、`apps/daemon/src/agents/docker.ts`（`DockerExecutor.abortAll`）、`apps/daemon/src/context-mcp.ts`（`ContextMcpServers.start`・`ContextMcpServers.stop`）、`apps/daemon/src/fetch-processes.ts`（`spawnStoppable`・`stopFetchProcessesSync`）
