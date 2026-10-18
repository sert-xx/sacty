# リポジトリの Compose から、エージェントのイメージを差し替えられないようにする

- 日付: 2026-10-18（UTC）
- タスク: PBI-130
- PR: #142
- ブランチ: feat/issue-130-compose-image
- 関係する ADR: [サービスのビルドに共有のタグを付けさせず、エージェントのイメージを ID に確定させる](../adr/20261018-0430-compose-build-image-isolation.md)

## 目的

リポジトリの Compose のサービスのビルドが、エージェントのイメージのタグを書き換え、後で動く別のタスクの認証を奪えないようにする
（Codex Security の指摘）。

## したこと

- デーモン
  - Compose の検査：ビルドするサービスの `image`・`build.tags` を外し、`pull_policy: build` にする。`build.cache_to` を拒否する。
  - サービスを止めるとき（起動のときの片付けも）、ビルドしたイメージを `--rmi local` で消す。
  - サービスを使う工程で、起動する前にエージェントのイメージを ID に確定させ、その ID で実行する。
- docs：仕様書（docker compose のサービス）、ユーザードキュメント（compose）、ADR。

## 確かめたこと

- `npx biome check`・`npm run typecheck`・`npx vitest run`・`npm run build` が通った。
- 次の修正を戻すと、テストが落ちることを確かめた：`image` を外す、`build.tags` を外す、`pull_policy: build`、`cache_to` の拒否、止めるとき・
  片付けのときの `--rmi local`、ID の形の確かめ、ID への確定、元の設定を書き換えないこと。
- 実機の Docker で確かめた。
  - 比較：sacty の検査を通さない素の `docker compose` では、`image` と `pull_policy: build` で仮のタグが書き換わり、中身が差し替わる。
  - このブランチ：同じ指定（`build.tags` も）で `sacty-agent:0.1.0` を試しても、イメージ ID は変わらない。ビルドしたイメージは
    `sacty-svc-<実行>-<サービス>` で作られ、止めると消える。
