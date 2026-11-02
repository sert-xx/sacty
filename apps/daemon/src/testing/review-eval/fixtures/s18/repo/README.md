# library-api

蔵書の登録と貸出を扱う小さな HTTP API です（Hono + TypeScript、保存先はメモリ）。

## セットアップ

Node.js 22 以上が必要です。

```sh
npm install
npm run dev        # http://localhost:3000
```

## コマンド

| コマンド                  | 内容                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `npm test`                | テスト（vitest）                                                     |
| `npm run typecheck`       | 型の検査                                                             |
| `npm run lint`            | prettier の検査                                                      |
| `npm run build`           | `dist/` にビルド                                                     |
| `npm run generate`        | API の定義から型とリファレンスを作る                                 |
| `npm run check:generated` | 生成したファイルが、定義から作り直した結果と一致するかを確かめる     |
| `npm run ci`              | CI で実行するもの（`check:generated`・lint・typecheck・test・build） |

## API の定義と生成するファイル

API の定義は [openapi/library.yaml](./openapi/library.yaml)（OpenAPI 3.1）です。次のファイルは、この定義から作ってコミットしています。

| ファイル                    | 作り方                                                 |
| --------------------------- | ------------------------------------------------------ |
| `src/generated/schema.d.ts` | `openapi-typescript`（`npm run generate:types`）       |
| `docs/api-reference.md`     | `scripts/generate-docs.mjs`（`npm run generate:docs`） |

定義を変えたときは `npm run generate` で作り直します。CI（`npm run ci`）の `check:generated` が、コミットしたファイルと作り直した結果の差を確かめます。

サーバー（`src/app.ts`・`src/store.ts`）と、クライアント（`src/client.ts`）は、生成した型を使います。

## 変更の決まり

- 利用者に見える API の変更は [CHANGELOG.md](./CHANGELOG.md) に書き、`openapi/library.yaml` の `info.version` と `package.json` の `version` を同じ値に上げる（既存の利用者を壊さない追加は minor）
- 既存の利用者を壊す変更（項目の削除・必須の追加など）は、事前に相談する

## エラー

`{ "error": { "code", "message" } }`。400 入力不正 / 404 未存在 / 409 状態が合わない・重複。
