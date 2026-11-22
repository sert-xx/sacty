**日本語** | [English](services.en.md)

# サービス（docker compose）

テストや動作確認に DB・モック API などが要るとき、sacty はホストで docker compose のサービスを起動し、工程のエージェントのコンテナをそのネットワークにつなぐ。
エージェントには Docker の権限を渡さない。
対象リポジトリの compose と、プロジェクトに書いた複数の共用 compose を同じ工程で使える。

関係する ADR: [サービスのビルドに共有のタグを付けさせず、エージェントのイメージを ID に確定させる](../adr/20261018-0430-compose-build-image-isolation.md)、[最終レビューのエージェントが最終レビューの中でテストを実行し、sacty はテストのコンテナを使わない](../adr/20261021-1431-superseded-guardian-runs-tests.md)、[情報収集がテストと動作確認に要るサービスを分け、オーケストレーターはそれをもとに依存だけを起動させ、対象のアプリは工程がコンテナの中で起動する](../adr/20261023-1410-superseded-gather-sorts-services-for-orchestrator.md)

## いつ起動するか

- どの compose ファイルのどのサービスを、どの工程で使うかは、オーケストレーターが工程を選ぶときに決める（[タスクと工程](tasks-and-steps.md)）。
  オーケストレーターが選べる工程は `investigate`（不具合の調査のときだけ）・`reproduce`・`implement`。
  選ぶのは、別で管理されている依存アプリ（このリポジトリのコードを動かさないもの）と、DB・キャッシュ・モックなど。
  このリポジトリのコードを動かすサービス（工程で変える・確かめるアプリ）は選ばせない。工程のエージェントが、コンテナの中で起動してサービスにつなぐ。
  分け方は compose の `build` の有無ではなく、何を動かすかによる（指示。強制はしない）。
  compose ファイルはサブディレクトリや様々な名前も探し、テスト・開発の手順書やスキルから参照されるファイルも調べる。
  テストや動作確認に必要なサービスを選ばないときは、要るサービスと理由を `servicesReason` に書くよう指示する。
  情報収集のまとめに分類があれば、それをもとにし、compose ファイルなどで確かめて確定させる（[タスクと工程](tasks-and-steps.md#実行の環境とサービス)）。
- 工程の指示は `servicePromptLines` でスキルを先に読むよう伝え、起動したサービスの接続先の候補も添える。
  `serviceSkill` は同じ候補をスキルに書き、localhost は転送の予定であると伝える。
  届かない場合は別の候補を試し、すべて届かなければ何を確かめられなかったかを報告する。
  起動しない工程にもスキルを置き、サービスが無いため確かめられなかったことの報告を求める。
- 工程のエージェントの実行の1回ごとに起動し、終わったら消す。
- 実装の PR のレビューの子タスクは、文書だけの再レビューを含め、対象の先頭と同じコミットの最後の `BranchPushed` より前の最後の実装の `AgentRunStarted` に対応する `ServicesStarted` からサービスを選ぶ。
  ファイルとサービス名を引き継ぎ、共用 compose は記録の `repo` と `commit` から取得する。
  実行ごとに起動し、起動時の指定で停止・片付けをする。
  対応するプッシュがない場合や共用 compose の取得元が記録されていない場合は起動せず、理由を担当に伝える。
  起動に失敗した場合も理由を伝えてサービス無しでレビューを続ける（人による停止を除く）。
  実装で起動していなければレビューでも起動せず、要求要件・設計の PR や取り込んだ PR のレビューも対象外。
- レビューを含むタスクの同時実行は `maxParallelTasks` が上限で、1タスクは同時に1工程を実行するため、同時に動く compose は最大 `maxParallelTasks` 組。
  メモリーの予約や需要の見積もりは行わず、利用者が同時実行数を調整する。
- 以前の版の最終レビューのための起動の記録（`ServicesStarted` の `forTests` が `true`）は、読むためだけに残す。
- 共用の compose は、プロジェクトに書いただけでは起動しない。
  オーケストレーターが名前で選んだときだけ、取得・起動する（対象リポジトリがあるタスクだけ）。
  設定に無い名前を選んだら止める（`services.sharedUnknown`）。

コード: `apps/daemon/src/service.ts`（`serviceSpec`・`startServices`・`stopServices`・`withSharedCompose`）、`apps/daemon/src/prompts.ts`（`SERVICE_STEPS`・`composeServicesOf`・`servicePromptLines`・`serviceSkill`）

## 起動と停止

1. compose ファイルが作業領域の外なら起動に失敗する。
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
   単一の compose ではエージェントのコンテナを `--network sacty-svc-…_sacty` でつなぐ。
   複数の compose では共通ネットワークを作り、それぞれを別のプロジェクトとして同じネットワークで起動する。
   エージェントはそのネットワーク1つにつなぎ、サービス名とコンテナのポートで接続する。
6. 終わったら（失敗・打ち切りでも）、`docker compose -p <名前> down -v --remove-orphans --rmi local` で、コンテナ・ネットワーク・ボリュームと、ビルドしたイメージを消す。
   複数の compose では、各プロジェクトを止めてから共通ネットワークも消す。
   各 compose の停止は120秒、ネットワークの削除は30秒を上限とし、失敗した対象をログに残して残りの回収を続ける。

- エージェントのイメージの確定
  - サービスを使う工程では、起動する前に、エージェントのイメージ（タスクのイメージ）を `docker image inspect` でイメージ ID に確定させ、その ID で実行する。
    起動の後にタグが変わっても、確定したイメージで動く。
  - 確かめられない・30 秒（`IMAGE_ID_TIMEOUT_MS`）で終わらなければ、名前のまま実行する。
  - 確定を待つ間に人が止めたら（一時停止・中止）、`docker image inspect` を止め、サービスもエージェントも始めない。
  - サービスを使わない工程では確かめない。
- 失敗の理由は、秘密情報を伏せてから末尾 2000 文字にする。
- デーモンの起動のとき、名前が `sacty-svc-` で始まるプロジェクトのうち、所有のラベルのデーモンが動いていないもの（ラベルが無いものを含む）を消す。
  `ps` を読めなければ何も消さない。

コード: `apps/daemon/src/services.ts`（`DockerComposeServices.startOnce`・`startGroup`・`stopGroup`・`stop`・`cleanupAll`・`imageId`・`sanitizeCompose`・`composeProject`・`labelOwner`・`OWNER_LABEL`・`LOG_TAIL`）

## 安全の検査

使うサービスとその依存に、次のものがあれば、起動せずに理由を示す（`services.unsafe`）。

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
| `forRepos` | 任意。対象のリポジトリか Org の URL を1〜50件。重複と対象外は拒否する |

ひもづいたリポジトリ（Org の場合はその配下）では、原則使うよう指示し、使わない理由を `servicesReason` に書かせる。
ひもづけが無いものは説明から判断し、別のリポジトリにだけひもづいたものは候補から除く。
対象が未決定の情報収集には全件とひもづけ先を示す。
複数の compose は1つのネットワークで起動する。
サービス名か `container_name` の別名が compose 間で衝突すると、起動前に `services.nameConflict` で止める。
複数の compose で `names` を指定したときは、各 compose に存在する名前を選ぶ。
どの compose にも存在しない名前はエラーにし、空なら各 compose の全サービスを選ぶ。

- 取得
  - 実行のたびに、リポジトリごとのキャッシュ `SACTY_HOME/cache/shared-compose/<URL の SHA-256 の先頭24桁>.git`（bare）に、`git fetch --depth 1` で ref の最新を取る。
  - そのコミットを `workspaces/_shared-compose/<実行 ID>` に書き出し、そこを作業領域として起動する。
    終わったら消す。
    デーモンの起動のときに、`_shared-compose` ごと消す。
  - 同じキャッシュの取得は並べない。
- 認証は、コンテキストリポジトリと同じ（HTTPS で GitHub のアカウントがあれば gh のトークン。ほかはホストの git の認証）。
- 元の `container_name` は、sacty のネットワークの別名にする（サービス名とぶつからない形のときだけ）。
- 取得できない・ファイルが無い・安全の検査に当たる・起動できないときは、どの共用の compose かを示して起動に失敗する（`services.sharedFetchFailed`・`services.sharedMissing`・`services.sharedUnsafe`・`services.sharedFailed`）。

コード: `packages/core/src/projects.ts`（`SharedCompose`・`SharedComposeName`）、`apps/daemon/src/shared-compose.ts`（`GitSharedComposeFetcher`・`sharedComposeRunDir`・`cleanupSharedComposeRuns`）、`apps/daemon/src/service.ts`（`startServices`・`gitAuth`）
