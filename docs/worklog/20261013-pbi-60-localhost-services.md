# docker compose のサービスに、localhost のままでも接続できるようにする

- 日付: 2026-10-13（UTC）
- タスク: PBI-60
- PR: #69
- ブランチ: feat/issue-60-localhost-services
- 関係する ADR: [docker compose のサービスを起動した工程とテストでは、localhost のポートへの接続をサービスへ転送し、リポジトリの設定を書き換えさせない](../adr/20261013-1415-localhost-forwarding-to-services.md)

## 目的

docker compose のサービス（PBI-47）を起動した工程とテストで、`localhost:<ポート>` への接続をサービスへ転送し、リポジトリの設定の
接続先が localhost のままでも届くようにする。受け入れ条件の要点は次のとおり。

- エージェントのコンテナとテストのコンテナで、`localhost:<サービスのポート>` に接続するとサービスに届き、サービス名でもこれまでどおり届く。
- 同じポートを使うサービスが複数・使用中のポートは転送せず、理由が残る（失敗にしない）。
- サービスを起動しない工程・テストは何も変わらない。指示の文言が、localhost でもサービス名でも接続できる、に変わる。
- 実際の docker compose で、localhost の接続先のままテストが通る。

## したこと

- 転送の本体（`apps/daemon/src/agents/forward.ts`）：Node.js だけで動く小さな TCP の転送。元のコマンドをくるみ、`127.0.0.1`（と使えれば
  `[::1]`）で待ち受けてから元のコマンドを子プロセスとして動かす。標準入出力・終了コードはそのまま。使用中のポートは転送せず、理由を出す。
- 転送する番号（`apps/daemon/src/services.ts`）：コンテナのポート、compose でホストに出しているポート（短い書き方・長い書き方・アドレス付き・
  範囲）。複数のサービスが同じ番号を使うときは転送しない（`sharedPorts`、`packages/core/src/events.ts`）。UDP など TCP 以外は除き、
  同じサービスの中ではホストに出すポートの対応を優先する。
- 組み込み（`apps/daemon/src/agents/docker.ts`・`apps/daemon/src/agents/test-runner.ts`・`apps/daemon/src/service.ts`）：サービスを起動した
  エージェントの実行とテストの実行だけ、コマンドをくるむ。
- 指示（`apps/daemon/src/prompts.ts`）：localhost でもサービス名でも接続できる、設定は書き換えない、に変えた。
- 作業履歴の文言（`apps/web/src/lib/labels.ts`・`apps/web/src/i18n/messages/labels.ts`）：「db（localhost:15432 → db:5432）」のように出す。
- `README.md`：仕組みと制限。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npx vitest run`（665 件）・`npm run build` が通った。レビューの対応の後、レビューでは 668 件・
  lint・typecheck の成功を確かめた。
- 実際の Docker（sacty の DockerComposeServices・DockerTestRunner・DockerExecutor、postgres:17）で、PostgreSQL のプロトコルで `select 41+1` を実行した。
  - `localhost:5432`・`127.0.0.1:5432`・`::1`・`db:5432` → すべて 42。
  - `15432:5432` のとき `localhost:15432` → 42。db と db2（published 25432）のとき、`localhost:15432` は db、`localhost:25432` は db2 に届き、
    両方が使う `localhost:5432` は転送しない。
  - 転送なし（これまで）は `127.0.0.1` が ECONNREFUSED。
  - 失敗するコマンド（exit 5）の終了コードと出力はそのまま。テストを止めたときは 137 で、コンテナも片付く。
  - エージェントのコンテナでも localhost で届き、出力の JSON もこれまでどおり読める。
- 主要な処理を 25 か所わざと壊し、すべてテストが落ちることを確かめた。
- レビューの対応の後、実際の Docker で、`localhost:8125` が TCP のサービスに届くこと、80 と 8080 で別の応答を返すサーバーで
  `localhost:8080` が 80 側、`localhost:18080` が 8080 側に届くことを確かめた。
- 画面の変更は作業履歴の 1 行だけなので、動画は撮っていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| UDP のポートまで TCP の転送の候補に入るので、別々のサービスの `8125:8125/tcp` と `8125:8125/udp` がぶつかりと見なされ、TCP 側の転送まで止まる | ports（短い・長い書き方）と expose の両方でプロトコルを見て、TCP 以外のポートは転送の候補にもぶつかりの判定にも入れないようにした。TCP 以外のポートは記録に別の項目で残し、指示に「localhost には転送していない」と添える。テストを足した |
| 同じサービスの中で `ports: ["8080:80", "18080:8080"]` があると、`localhost:8080` が明示した `app:80` ではなく `app:8080` に転送される | 同じサービスの中ではホストに出すポートの対応（published → target）を優先し、上書きされた番号をぶつかりとして数えないようにした。ほかのサービスとぶつかる番号は、これまでどおり転送しない。テストを足した |

## 残したこと

- MySQL のクライアントなどで `localhost` と書くと UNIX ソケットで接続するので届かない（`127.0.0.1` なら届く）。README・指示に書いた。
- アプリ自身がサービスと同じポート番号で待ち受けると、番号がぶつかって起動できない。
- `ports` も `expose` も無いサービスは転送しない。`network_mode: service:X` のサービスには届かない。
