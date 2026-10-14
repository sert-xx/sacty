# docker compose のサービス（DB・モック API など）を、工程とテストの実行ごとに起動してつなぐ

- 日付: 2026-10-13（UTC）
- タスク: PBI-47
- PR: #54
- ブランチ: feat/issue-47-compose-services
- 関係する ADR: [docker compose のサービスは sacty がホストで実行ごとに起動し、エージェントとテストのコンテナをそのネットワークにつなぐ](../adr/20261013-0226-superseded-compose-services-per-run.md)、[compose ファイルは起動の前に確かめ、危ない設定や確かめられないものがあれば起動しない](../adr/20261013-0226-compose-safety-checks.md)

## 目的

docker compose で DB やモック API を起動してから確認・テストするリポジトリに対応する。エージェントには Docker の権限を渡さず、
sacty（ホスト）がサービスを起動し、エージェントとテストのコンテナをそのネットワークにつなぐ。

## したこと

- オーケストレーターが、工程を選ぶときに、compose ファイル・起動するサービス・サービスを使う工程（実装・再現・不具合の調査）を決める（`StepsChosen` の `services`）。
  内容の調査と、オーケストレーター・ゴールガーディアンでは起動しない（`apps/daemon/src/prompts.ts`・`packages/core/src/events.ts`）。
- `apps/daemon/src/services.ts`（新規）・`apps/daemon/src/service.ts`・`apps/daemon/src/agents/test-runner.ts`・`apps/daemon/src/agents/docker.ts`：
  - 工程のエージェントの実行と、テストの実行の1回ごとに `docker compose -p sacty-svc-<実行の ID> up -d --wait` で起動し、終わったら `down -v --remove-orphans` で消す。
    実行ごとに別のプロジェクト名なので、同じリポジトリのタスクを並行で動かしてもぶつからない。デーモンが途中で終わって残ったサービスは、次の起動のときに消す（`apps/daemon/src/main.ts`）。
  - compose ファイルは `docker compose config` で正規化してから確かめ、使うサービスとその依存（`depends_on`・`network_mode: service:`）に危ない設定があれば、起動せずに理由を示して止まる。
  - 起動するときに、`ports`・`container_name`・ネットワークとボリュームの固定の名前を外し、sacty のネットワークを足してエージェント・テストのコンテナをつなぐ。
  - サービスのイメージは、compose ファイルに書かれた名前のまま、ホストの Docker で取得・ビルドする。
- エージェントのプロンプトに、サービスの接続先（例 `db:5432`）と、docker のコマンドは使えないこと・実行の後にデータが消えることを書く。
- 作業履歴に「サービスを起動」を残す。起動できなければ、工程は実行せずに止め（`AgentRunFailed`）、テストは実行せずに止める。
- README に説明を足した。
- レビューの指摘に対応し、Docker のソケットの付与と作業領域の外の参照の拒否を広げ、警告が出ても設定を読めるようにし、YAML のマージキーを解決してから確かめ、
  compose ファイルを読めない・解析できないときは起動しないようにした（下の表）。

## 確かめたこと

- build・typecheck・lint・全テスト（497件）が通った。
- 追加したテスト：
  - 確かめと書き換え：ポート・固定の名前を外す、依存の範囲だけを確かめる、各種の危ない設定の拒否、作業領域の外へのリンク、まだ無いファイル（macOS の /var → /private/var のリンクの下でもずれない）。
  - daemon：サービスを使う工程とそのテストの前に起動してネットワークにつなぎ、終わったら消す。ほかの工程では起動しない。起動できなければ工程やテストを実行せずに止まる。
    内容の調査では起動せず、不具合の調査では起動する。
  - プロンプト（指定の読み取りの制限・接続先の文）、docker の引数（`--network`・権限は落としたまま）、作業履歴の文言。
- 主な判定を戻すと、テストが失敗することを確かめた（10通り）。
- 実際の Docker（Docker Desktop・Compose v5.3.1）で確かめた。
  - PostgreSQL（作業領域の初期化の SQL を bind マウント）を起動し、テストのコンテナから `db:5432` に接続して問い合わせられる（`select id from t` → 42）。
  - 同じ compose ファイルを2つの実行で並行に起動してもぶつからず、ホストのポートには出ない。止めた後に、コンテナ・ネットワーク・ボリュームが残らない。
  - Docker のソケットのマウント・privileged・`network_mode: host`・作業領域の外のマウントを含む compose ファイルは、起動せずに理由を示す。
- 画面は動画で確かめた（作業履歴の「サービスを起動」）。
- 最後の再レビューで、全503テスト・lint・型チェックが通った。サービスのコンテナの実際の起動・接続は、レビューでは未実施（`up` を偽物に差し替えて起動用の設定までを確かめた）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| `use_api_socket: true` を指定すると、ボリュームにソケットを書かなくても Compose が Docker API のソケットを渡す。確かめも除去もされず、明示的なソケットのマウントの禁止を迂回できる | `use_api_socket: true` を拒否した。あわせて、ホストでコマンドを動かす `provider`、ビルドにホストの SSH エージェント・ネットワーク・特権を渡す `build.ssh`・`build.network: host`・`build.privileged`・`build.entitlements` も拒否した。回帰テストを足し、実際の Compose v5.3.1 でも起動されないことを確かめた |
| `docker compose config` は `env_file` の中身を `environment` に展開して元の項目を消すので、後の確かめに届かず、作業領域の外のファイルの値がサービスに渡る | 正規化を `docker compose config --no-env-resolution` で行い、`env_file` を読み込まずにパスのまま残して作業領域の中かを確かめるようにした（include 経由も）。正規化で元の参照が消えるもの（include の path・env_file・project_directory、extends の file、label_file）は、正規化の前に compose ファイルの YAML をたどって確かめる。変数を含むパスは拒否する。実際の Compose でも、作業領域の外の env_file・label_file を含むファイルが起動されないことを確かめた |
| stdout と stderr をつなげて JSON として読んでいたので、Compose が警告を1行でも出すと（`version: "3.8"` など）正常な設定を起動できない | stdout と stderr を分けて受け取り、設定の JSON は stdout だけから読む。stderr は失敗のときの理由にだけ使う。実際の Compose v5.3.1 で警告の出るファイルを起動できることを確かめ、回帰テストを足した |
| 再レビュー：YAML のマージキー（`<<: *anchor`）を解決せずに確かめていたので、アンカー経由で継承した作業領域の外の `label_file` を見落とす | Compose と同じくマージキーを解決してから確かめるようにした（yaml の `merge: true`）。アンカー経由の label_file・include（env_file）・extends の回帰テストを足し、実際の Compose v5.3.1 でも起動されないことを確かめた |
| 再レビュー：YAML の解析に失敗したとき（別名を多く使うファイルで yaml が `Excessive alias count` で拒否するなど）に、問題なしとして Compose に渡していた | compose ファイル（include・extends でたどったファイルを含む）を読めない・解析できない・compose ファイルの形でないときは、確かめられないものとして問題を返し、docker compose を実行せずに止めるようにした（失敗したら止める側に倒す）。回帰テストを足し、実際の Compose v5.3.1 でも起動されないことを確かめた |

## 残したこと

- 利用者の環境で、次を確かめる（PR で依頼した）：Rancher Desktop で、compose のサービスを使うリポジトリのタスクが動くこと（Docker Desktop でだけ確かめた）。
  利用者のレジストリのイメージを使う compose ファイルで、サービスを起動できること（ホストで `docker login` 済みであること）。
