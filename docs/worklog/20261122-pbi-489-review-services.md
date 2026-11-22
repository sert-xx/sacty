# 実装の PR のレビューでサービスを起動する

- 日付: 2026-11-22（UTC）
- タスク: PBI-489
- PR: なし
- ブランチ: main
- 関係する ADR: [実装の PR のレビューに実装時のサービスを渡す](../adr/20261122-1714-review-implementation-services.md)

## 目的

実装で使った DB などをレビューでも使い、依存サービスが必要なテストを確かめられるようにする。

## したこと

レビュー対象の先頭に対応する実装の起動記録から、サービスの指定を取得する。
共用 compose の取得元を記録し、起動時の指定で停止と片付けを行う。

## 確かめたこと

| コマンド | 結果 |
| --- | --- |
| `npm test` | 346 ファイル、7108 件成功、14 件スキップ（Git の `merge-tree --merge-base` 非対応 13 件、実際の AI を使う評価 1 件） |
| `npm run lint` | 成功 |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功 |

`npx vitest run apps/daemon/src/daemon-step-pull-requests.test.ts -t '実装 PR のレビューのサービス'` を、変更を戻した3種類の版で実行した。

レビューの分岐を外した版で失敗したテスト。

- ファイルの compose を起動し、レビューを接続して停止する
- 記録した共用 compose のリポジトリとコミットを使い、取得先を消す
- 文書だけの再レビューと判定された回も起動する
- 後の実装とプッシュより、対象の先頭を作った実行を選ぶ
- レビュー中に親が再プッシュしても起動時の共用 compose を片付ける
- 起動失敗を伝え、サービス無しでレビューを続ける
- 起動処理の例外後に片付けてレビューを続ける
- 起動中に人が停止したらエージェントを実行せず、起動したサービスを消す
- old の記録では起動せずレビューを続ける
- missing の記録では起動せずレビューを続ける

レビューで常に起動する版で失敗したテスト。

- ファイルの compose を起動し、レビューを接続して停止する
- 記録した共用 compose のリポジトリとコミットを使い、取得先を消す
- 文書だけの再レビューと判定された回も起動する
- requirements の PR では親の実装記録があっても起動しない
- design の PR では親の実装記録があっても起動しない
- 後の実装とプッシュより、対象の先頭を作った実行を選ぶ
- レビュー中に親が再プッシュしても起動時の共用 compose を片付ける
- old の記録では起動せずレビューを続ける
- missing の記録では起動せずレビューを続ける
- none の記録では起動せずレビューを続ける

停止時に指定を引き直す版で失敗したテスト。

- ファイルの compose を起動し、レビューを接続して停止する
- 記録した共用 compose のリポジトリとコミットを使い、取得先を消す
- 文書だけの再レビューと判定された回も起動する
- レビュー中に親が再プッシュしても起動時の共用 compose を片付ける

実機の DB テストとメモリーの測定は、この環境に Docker がないため実施していない。
Docker のある環境で、次の手順を実行する。

1. テスト用リポジトリに次の `compose.yaml` を置く。

   ```yaml
   services:
     db:
       image: postgres:17
       environment:
         POSTGRES_PASSWORD: test
         POSTGRES_DB: test
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U postgres -d test"]
         interval: 2s
         timeout: 3s
         retries: 30
   ```

2. 同じリポジトリに `pg` をテスト依存として追加し、`DATABASE_URL` から接続して `select 1` を検証するテストを置く。

   ```js
   import { Client } from "pg";
   import { strict as assert } from "node:assert";
   import { test } from "node:test";
   test("database", async () => {
     const client = new Client({ connectionString: process.env.DATABASE_URL });
     await client.connect();
     try { assert.equal((await client.query("select 1 as value")).rows[0].value, 1); }
     finally { await client.end(); }
   });
   ```

3. テスト用リポジトリの README に、テストコマンド `DATABASE_URL=postgresql://postgres:test@db:5432/test node --test` を記載する。
   このコマンドを指定して、sacty でこのリポジトリの実装タスクを作成する。
   実装で compose の `db` を選んで PR を作成し、レビューの子タスクを実行する。
4. 実行ログでレビューの `ServicesStarted` と DB テストの成功を確かめる。
   レビュー中に `docker stats --no-stream` でエージェントと DB の使用量を測り、ホストの空きメモリーと比較する。
5. レビュー後、`docker ps -a --filter label=io.sacty.owner` で所有ラベル付きコンテナが残らないことを確かめる。
   測定値と不足の懸念をこの履歴に追記する。

## レビューの指摘と対応

### 設計の PR #577

容量の予約・見積もり・資源単位の上限化は依頼者の方針で対象外とし、同時実行数は利用者が調整する。
文書だけの再レビュー、対象の先頭の実行の特定、共用 compose の取得元、実行中の親の変更、変更を戻した場合のテストを扱った。

### この PR のレビュー

レビュー側が DB テストの実行方法を見つけられるよう、テスト用リポジトリの README にコマンドを記載する手順を追加した。

## 残したこと

Docker のある環境で実機確認とメモリー測定を行う。
