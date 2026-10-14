# サービス（docker compose）

テストや動作確認に DB・モック API などが要るとき、sacty がホストで docker compose のサービスを起動し、エージェントとテストのコンテナを
そのネットワークにつなぐ（エージェントには Docker の権限を渡さない）。compose ファイルは、対象リポジトリのものか、プロジェクトに書いた
共用の compose（別のリポジトリ）のどちらか一方を使う。

関係する ADR: なし

## いつ起動するか

- どの compose ファイルのどのサービスを、どの工程で使うかは、オーケストレーターが工程を選ぶときに決める（[タスクと工程](tasks-and-steps.md)）。
  使える工程は `investigate`（不具合の調査のときだけ）・`reproduce`・`implement`。
- 工程のエージェントの実行と、テストの実行の1回ごとに起動し、終わったら消す。
- 共用の compose は、プロジェクトに書いただけでは起動しない。オーケストレーターが名前で選んだときだけ取得・起動する（対象リポジトリがある
  タスクだけ）。設定に無い名前を選んだら止める（`services.sharedUnknown`）。

コード: `apps/daemon/src/service.ts`（`serviceSpec`・`startServices`・`stopServices`・`runTests`・`withSharedCompose`）、`apps/daemon/src/prompts.ts`（`SERVICE_STEPS`・`composeServicesOf`）

## 起動と停止

1. compose ファイルが作業領域の外なら止める。参照するファイル（`include`・`extends`・`env_file`・`label_file`・`project_directory`）が作業領域の中か
   を確かめる（パスに `$` は使えない）。
2. `docker compose -f <ファイル> config --format json --no-env-resolution` で正規化する。
3. 使うサービスとその依存（`depends_on`・`network_mode: service:`）だけを残して、安全の検査をする（下）。
4. 各サービスから `ports` と `container_name` を外し、ネットワーク `sacty` に入れる。ネットワーク・ボリュームの固定の名前を外す。
   所有のラベル `io.sacty.owner`（起動したデーモンの PID と開始時刻）を付ける。
5. 一時ファイルに書いた設定で、`docker compose -p sacty-svc-<実行 ID から作った名前> -f <設定> up -d --wait --wait-timeout 300 <サービス>` で起動する。
   エージェント・テストのコンテナは `--network sacty-svc-…_sacty` でつなぎ、サービス名とコンテナのポートで接続する。
6. 終わったら（失敗・打ち切りでも）`docker compose -p <名前> down -v --remove-orphans` で、コンテナ・ネットワーク・ボリュームを消す。
- 失敗の理由は、秘密情報を伏せてから末尾 2000 文字にする。
- デーモンの起動のとき、名前が `sacty-svc-` で始まるプロジェクトのうち、所有のラベルのデーモンが動いていないもの（ラベルが無いものを含む）を
  消す。`ps` を読めなければ何も消さない。

コード: `apps/daemon/src/services.ts`（`DockerComposeServices.startOnce`・`stop`・`cleanupAll`・`sanitizeCompose`・`composeProject`・`labelOwner`・`OWNER_LABEL`・`LOG_TAIL`）

## 安全の検査

使うサービスとその依存に、次のものがあれば、起動せずに理由を示して止める（`services.unsafe`）。

- `privileged`・`cap_add`・`devices`・`device_cgroup_rules`・`volumes_from`・`cgroup_parent`・`use_api_socket`・`provider`
- `network_mode`（`service:` と `bridge` のほか）、`pid`・`ipc`・`uts`・`userns_mode`・`cgroup` の `host`・`container:`、`security_opt` の `unconfined`
- 作業領域の外の bind マウント（`volume`・`tmpfs` 以外の種類も）、作業領域の外の `build` の context・Dockerfile、`build` の `additional_contexts`・
  `ssh`・`network: host`・`privileged`・`entitlements`、作業領域の外の `env_file`
- トップレベルの `external` のネットワーク・ボリューム、`bridge` 以外のネットワークの `driver`、ボリュームの `driver`・`driver_opts`、
  `external` か作業領域の外の `file` の `secrets`・`configs`

コード: `apps/daemon/src/services.ts`（`sanitizeCompose`・`checkComposeSources`）

## localhost の転送

サービスを起動した実行では、エージェントとテストのコンテナの中で、`127.0.0.1:<ポート>`（使えれば `[::1]` も）をサービスの同じポートに
転送する（リポジトリの設定の接続先が localhost のままでも届くように）。

- 転送するのは、サービスの TCP のコンテナのポート（`ports`・`expose`）と、`ports` でホストに出す番号（`"15432:5432"` なら `localhost:15432` も
  `db:5432` へ）。同じサービスの中では、ホストに出す番号の対応を優先する。TCP 以外は転送しない。
- 複数のサービスが同じ localhost の番号を使うときは、その番号は転送しない（記録の `sharedPorts` と、エージェントへの指示に出す）。
- 転送は、コマンドの前に sacty がコンテナの中で起動する Node.js の小さなスクリプトで、コマンドが終われば止まる（終了コードは変えない）。
  そのポートがすでに使われていれば、転送せずに続け、標準エラー出力に `[sacty] localhost の転送：` で知らせる（デーモンはログに写す）。

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

- 取得：リポジトリごとのキャッシュ `SACTY_HOME/cache/shared-compose/<URL の SHA-256 の先頭24桁>.git`（bare）に、実行のたびに
  `git fetch --depth 1` で ref の最新を取り、そのコミットを `workspaces/_shared-compose/<実行 ID>` に書き出して、そこを作業領域として起動する
  （終わったら消す。デーモンの起動のときに `_shared-compose` ごと消す）。同じキャッシュの取得は並べない。
- 認証は、コンテキストリポジトリと同じ（HTTPS で GitHub のアカウントがあれば gh のトークン。ほかはホストの git の認証）。
- 元の `container_name` は、sacty のネットワークの別名にする（サービス名とぶつからない形のときだけ）。
- 取得できない・ファイルが無い・安全の検査に当たる・起動できないときは、どの共用の compose かを示して工程を止める
  （`services.sharedFetchFailed`・`services.sharedMissing`・`services.sharedUnsafe`・`services.sharedFailed`）。

コード: `packages/core/src/projects.ts`（`SharedCompose`・`SharedComposeName`）、`apps/daemon/src/shared-compose.ts`（`GitSharedComposeFetcher`・`sharedComposeRunDir`・`cleanupSharedComposeRuns`）、`apps/daemon/src/service.ts`（`startServices`・`gitAuth`）
