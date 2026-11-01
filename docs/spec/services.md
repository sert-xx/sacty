**日本語** | [English](services.en.md)

# サービス（docker compose）

テストや動作確認に DB・モック API などが要るとき、sacty はホストで docker compose のサービスを起動し、エージェントのコンテナ（工程と、テストを実行する最終レビュー）をそのネットワークにつなぐ。
エージェントには Docker の権限を渡さない。
compose ファイルは、対象リポジトリのものか、プロジェクトに書いた共用の compose（別のリポジトリ）のどちらか一方を使う。

関係する ADR: [サービスのビルドに共有のタグを付けさせず、エージェントのイメージを ID に確定させる](../adr/20261018-0430-compose-build-image-isolation.md)、[ゴールガーディアンが最終レビューの中でテストを実行し、sacty はテストのコンテナを使わない](../adr/20261021-1431-superseded-guardian-runs-tests.md)、[情報収集がテストと動作確認に要るサービスを分け、オーケストレーターはそれをもとに依存だけを起動させ、対象のアプリは工程がコンテナの中で起動する](../adr/20261023-1410-gather-sorts-services-for-orchestrator.md)

## いつ起動するか

- どの compose ファイルのどのサービスを、どの工程で使うかは、オーケストレーターが工程を選ぶときに決める（[タスクと工程](tasks-and-steps.md)）。
  使える工程は `investigate`（不具合の調査のときだけ）・`reproduce`・`implement`。
  選ぶのは、別で管理されている依存アプリ（このリポジトリのコードを動かさないもの）と、DB・キャッシュ・モックなど。
  このリポジトリのコードを動かすサービス（工程で変える・確かめるアプリ）は選ばせない。工程のエージェントが、コンテナの中で起動してサービスにつなぐ。
  分け方は compose の `build` の有無ではなく、何を動かすかによる（指示。強制はしない）。
  情報収集のまとめに分類があれば、それをもとにし、compose ファイルなどで確かめて確定させる（[タスクと工程](tasks-and-steps.md#実行の環境とサービス)）。
- 工程（とテストを実行する最終レビュー）の指示には、サービスの接続先と一緒に、このリポジトリのアプリは docker を使わずにコンテナの中で起動して、サービスにつなぐよう添える（`servicePromptLines`）。
- 工程のエージェントの実行の1回ごとに起動し、終わったら消す。
- 実装の検証で、テスト（検証）のコマンドがある最終レビューでは、次のように動く。
  - ゴールガーディアンの実行の前に、実装の工程のサービスを起動する。
    作業領域は実装の作業領域。
    `ServicesStarted` の `forTests` は `true` で、検証（最終レビューの中のテスト）のための起動を表す。
  - ゴールガーディアンのコンテナをつなぎ、接続先を指示に足す。
  - 実行が終わったら、サービスを消す。
  - 起動できなければ、ゴールガーディアンを実行せずに一時停止する（`verify.testsUnavailable`）。
    再開すると、最終レビューからやり直す。
  - 起動を待つ間に人が止めたら、何も記録しない。
- 共用の compose は、プロジェクトに書いただけでは起動しない。
  オーケストレーターが名前で選んだときだけ、取得・起動する（対象リポジトリがあるタスクだけ）。
  設定に無い名前を選んだら止める（`services.sharedUnknown`）。

コード: `apps/daemon/src/service.ts`（`serviceSpec`・`startServices`・`stopServices`・`verify`・`withSharedCompose`）、`apps/daemon/src/prompts.ts`（`SERVICE_STEPS`・`composeServicesOf`・`servicePromptLines`）

## 起動と停止

1. compose ファイルが作業領域の外なら止める。
   参照するファイル（`include`・`extends`・`env_file`・`label_file`・`project_directory`）が作業領域の中かを確かめる（パスに `$` は使えない）。
2. `docker compose -f <ファイル> config --format json --no-env-resolution` で正規化する。
3. 使うサービスとその依存（`depends_on`・`network_mode: service:`）だけを残して、安全の検査をする（下）。
4. 設定を書き換える。
   - 各サービスから `ports` と `container_name` を外し、ネットワーク `sacty` に入れる。
   - ネットワーク・ボリュームの固定の名前を外す。
   - `build` を持つサービスからは `image` と `build.tags` を外し、`pull_policy: build` にする。
     ビルドしたイメージに、エージェントのイメージなどホストで共有するタグを付けさせないため。
     compose が `<プロジェクト>-<サービス>` の名前を付ける。
   - 所有のラベル `io.sacty.owner`（起動したデーモンの PID と開始時刻）を付ける。
5. 一時ファイルに書いた設定で、`docker compose -p sacty-svc-<実行 ID から作った名前> -f <設定> up -d --wait --wait-timeout 300 <サービス>` で起動する。
   エージェントのコンテナは `--network sacty-svc-…_sacty` でつなぎ、サービス名とコンテナのポートで接続する。
6. 終わったら（失敗・打ち切りでも）、`docker compose -p <名前> down -v --remove-orphans --rmi local` で、コンテナ・ネットワーク・ボリュームと、ビルドしたイメージを消す。

- エージェントのイメージの確定
  - サービスを使う工程では、起動する前に、エージェントのイメージ（工程のイメージ）を `docker image inspect` でイメージ ID に確定させ、その ID で実行する。
    起動の後にタグが変わっても、確定したイメージで動く。
  - 確かめられない・30 秒（`IMAGE_ID_TIMEOUT_MS`）で終わらなければ、名前のまま実行する。
  - 確定を待つ間に人が止めたら（一時停止・中止）、`docker image inspect` を止め、サービスもエージェントも始めない。
  - テストを実行する最終レビューでも、同じく実装の工程のイメージを確定させてから起動する。
  - サービスを使わない工程では確かめない。
- 失敗の理由は、秘密情報を伏せてから末尾 2000 文字にする。
- デーモンの起動のとき、名前が `sacty-svc-` で始まるプロジェクトのうち、所有のラベルのデーモンが動いていないもの（ラベルが無いものを含む）を消す。
  `ps` を読めなければ何も消さない。

コード: `apps/daemon/src/services.ts`（`DockerComposeServices.startOnce`・`stop`・`cleanupAll`・`imageId`・`sanitizeCompose`・`composeProject`・`labelOwner`・`OWNER_LABEL`・`LOG_TAIL`）

## 安全の検査

使うサービスとその依存に、次のものがあれば、起動せずに理由を示して止める（`services.unsafe`）。

- `privileged`・`cap_add`・`devices`・`device_cgroup_rules`・`volumes_from`・`cgroup_parent`・`use_api_socket`・`provider`
- `network_mode`（`service:` と `bridge` のほか）、`pid`・`ipc`・`uts`・`userns_mode`・`cgroup` の `host`・`container:`、`security_opt` の `unconfined`
- 作業領域の外の bind マウント（`volume`・`tmpfs` 以外の種類も）、作業領域の外の `build` の context・Dockerfile、`build` の `additional_contexts`・`ssh`・`network: host`・`privileged`・`entitlements`・`cache_to`、作業領域の外の `env_file`
- トップレベルの `external` のネットワーク・ボリューム、`bridge` 以外のネットワークの `driver`、ボリュームの `driver`・`driver_opts`、`external` か作業領域の外の `file` の `secrets`・`configs`

コード: `apps/daemon/src/services.ts`（`sanitizeCompose`・`checkComposeSources`）

## localhost の転送

サービスを起動した実行では、エージェントのコンテナの中で、`127.0.0.1:<ポート>`（使えれば `[::1]` も）をサービスの同じポートに転送する。
リポジトリの設定の接続先が localhost のままでも届くようにするため。

- 転送するポート
  - サービスの TCP のコンテナのポート（`ports`・`expose`）と、`ports` でホストに出す番号を転送する。
    `"15432:5432"` なら、`localhost:15432` も `db:5432` へ転送する。
  - 同じサービスの中では、ホストに出す番号の対応を優先する。
  - TCP 以外は転送しない。
  - 複数のサービスが同じ localhost の番号を使うときは、その番号は転送しない（記録の `sharedPorts` と、エージェントへの指示に出す）。
- 転送のしかた
  - コマンドの前に、sacty がコンテナの中で Node.js の小さなスクリプトを起動して転送する。
    スクリプトはコマンドが終われば止まる（終了コードは変えない）。
  - そのポートがすでに使われていれば、転送せずに続け、標準エラー出力に `[sacty] localhost の転送：` で知らせる（デーモンはログに写す）。

コード: `apps/daemon/src/services.ts`（`composePorts`・`localForwards`）、`apps/daemon/src/agents/forward.ts`（`FORWARD_SCRIPT`・`withLocalForwards`・`forwardNotices`）、`apps/daemon/src/prompts.ts`（`servicePromptLines`）

## 共用の compose

プロジェクトの `sharedComposes`（20件まで。名前の重複は不可）に書く。

| 項目 | 意味 |
| --- | --- |
| `name` | `^[a-z0-9][a-z0-9_-]{0,39}$` |
| `repo` | git の URL かローカルの絶対パス（500 文字まで）。URL にユーザー名・パスワード・トークンは書けない |
| `ref` | ブランチかタグ（省けば既定のブランチ） |
| `file` | リポジトリの根からの相対パス（`..`・`$` を含まない） |
| `description` | オーケストレーターが選ぶときの手がかり（1000 文字まで） |

- 取得
  - 実行のたびに、リポジトリごとのキャッシュ `SACTY_HOME/cache/shared-compose/<URL の SHA-256 の先頭24桁>.git`（bare）に、`git fetch --depth 1` で ref の最新を取る。
  - そのコミットを `workspaces/_shared-compose/<実行 ID>` に書き出し、そこを作業領域として起動する。
    終わったら消す。
    デーモンの起動のときに、`_shared-compose` ごと消す。
  - 同じキャッシュの取得は並べない。
- 認証は、コンテキストリポジトリと同じ（HTTPS で GitHub のアカウントがあれば gh のトークン。ほかはホストの git の認証）。
- 元の `container_name` は、sacty のネットワークの別名にする（サービス名とぶつからない形のときだけ）。
- 取得できない・ファイルが無い・安全の検査に当たる・起動できないときは、どの共用の compose かを示して工程を止める（`services.sharedFetchFailed`・`services.sharedMissing`・`services.sharedUnsafe`・`services.sharedFailed`）。

コード: `packages/core/src/projects.ts`（`SharedCompose`・`SharedComposeName`）、`apps/daemon/src/shared-compose.ts`（`GitSharedComposeFetcher`・`sharedComposeRunDir`・`cleanupSharedComposeRuns`）、`apps/daemon/src/service.ts`（`startServices`・`gitAuth`）
