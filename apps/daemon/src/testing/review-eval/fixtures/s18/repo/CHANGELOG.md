# 変更履歴

API の変更を新しい順に書きます。版は `openapi/library.yaml` の `info.version` です。

## 1.3.0 - 2026-10-20

- 追加：蔵書の一覧の `status` による絞り込み（`GET /books?status=available|on_loan`）

## 1.2.0 - 2026-09-28

- 追加：蔵書の一覧の `author` による絞り込み（`GET /books?author=`）

## 1.1.0 - 2026-09-14

- 追加：貸出（`POST /books/{bookId}/loans`）と返却（`POST /books/{bookId}/return`）

## 1.0.0 - 2026-09-01

- 最初の版：蔵書の登録・一覧・取得
