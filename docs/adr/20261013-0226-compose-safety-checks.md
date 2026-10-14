# compose ファイルは起動の前に確かめ、危ない設定や確かめられないものがあれば起動しない

- 日時: 2026-10-13 02:26 UTC
- ステータス: 採用
- 関係する PR・タスク: #54、PBI-47
- 置き換え元: なし
- 置き換え先: なし

## 背景

sacty がホストで起動する compose のサービスは、対象リポジトリの compose ファイルに書かれたとおりに動く。compose ファイルには、ホストの Docker やファイルに届く設定を書ける。

## 決定

- compose ファイルは `docker compose config --no-env-resolution` で正規化してから確かめる。使うサービスとその依存（`depends_on`・`network_mode: service:`）に次があれば、
  起動せずに理由を示して止まる。
  - `privileged`・`cap_add`・`devices`・`volumes_from`・`cgroup_parent`・ホストのネットワーク・PID・IPC など・`security_opt` の unconfined・`use_api_socket`・`provider`
  - ビルドの `build.ssh`・`build.network: host`・`build.privileged`・`build.entitlements`
  - 作業領域の外のパスのマウント（Docker のソケットや、作業領域の外へのシンボリックリンクを含む）・作業領域の外の `build`（context・Dockerfile・git の URL）・`env_file`・`secrets`
  - external のネットワーク・ボリューム、bridge 以外のネットワークのドライバー、ボリュームの `driver`・`driver_opts`
- 正規化で元の参照が消えるもの（include の path・env_file・project_directory、extends の file、label_file）は、正規化の前に compose ファイルの YAML を
  （Compose と同じくマージキーを解決して）たどって確かめる。変数を含むパスは、展開した先がわからないので拒否する。
- compose ファイルを読めない・解析できない・compose ファイルの形でないときは、確かめられないものとして起動しない（失敗したら止める側に倒す）。
- 設定の JSON は stdout だけから読み、stderr は失敗の理由にだけ使う。

## 理由

- 確かめる項目の多くは、レビューの指摘で足した。`use_api_socket` はソケットのマウントの禁止を迂回してホストの Docker を操作できる。`env_file` は正規化で中身が展開されて確かめに届かず、
  作業領域の外の値がサービスに渡る。マージキーを解決しないと、アンカー経由で継承した作業領域の外の `label_file` を見落とす（レビュー）。
- 解析に失敗したときに止めるのは、JS 側で解析できないファイルを Compose も拒否するとは限らず、問題なしとして渡すと作業領域の外のファイルを読み込まれるため（レビューとその返信）。
- stdout だけを読むのは、Compose が警告を出すと（`version: "3.8"` など）正常な設定を起動できなかったため（レビュー）。
- 最初に挙げた危ない設定の一覧を選んだ理由は、PR の本文には書かれていない。

## 影響

- 危ない設定を含む compose ファイルのリポジトリでは、サービスを起動できず、工程が止まる。
- 作業領域の中のファイルの参照（初期化の SQL の bind マウントや作業領域の中の env_file など）は使える。
