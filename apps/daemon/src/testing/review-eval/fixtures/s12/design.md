# 設計：予約の変更（API）

`PATCH /api/reservations/:id` を足します。変更後の値は作成と共通の検査にかけます。

## 確認したいこと

### must

なし

### should

なし

## 既定で決めたこと

- 会議室が利用停止（`isActive=false`）なら、予約の状態によらず変更を 422 にする（作成と同じ検査）

## 構成

| 層 | 追加・変更 |
| --- | --- |
| domain | `reservation.ts`：`newReservation` の検査を、開始が未来の検査を除いて共通の関数に分け、`changeReservation` を足す |
| usecase | `update-reservation.ts`（`UpdateReservation`） |
| presentation | `routes/reservations.ts` に `PATCH /:id` |

## 処理の流れ

`UpdateReservation.execute(id, changes)` は次の順に進めます。

1. 予約の `findById`（無ければ 404）、会議室の `findById`
2. `changeReservation(reservation, { room, changes, now })`
   1. 渡さない項目を変更前の値で補い、作成と同じ形式の検査（400）
   2. キャンセル済み、終了済み（`endsAt <= now`）、使用中（`startsAt <= now`）で `endsAt` 以外の項目がある、のどれかなら 422
   3. ほかの業務ルール（R-12・R-13・R-15、会議室が有効）の違反は 422
3. `update` が `false` なら 422

## テスト観点

- [TV-1] 開始前の予約の一部の項目だけを変えると、ほかの項目を保った予約を返すこと（R-3）
  - 期待結果：PATCH は 200 で、変えた項目だけが変わる
- [TV-2] 使用中の予約の終了だけを延ばせること（R-6）
  - 期待結果：200 が返り、endsAt だけが変わる
- [TV-3] 変更後の長さが 240 分ちょうどなら通り、超えれば 422 になること（R-12）
  - 期待結果：240 分は 200、245 分は 422
- [TV-4] 開始前の予約の新しい開始が現在以前なら 422 になること（R-13）
  - 期待結果：どちらも 422 が返り、予約が変更前と同じ
- [TV-5] 定員ちょうどは通り、定員超えは 422 になること（R-15）
  - 期待結果：定員ちょうどは 200、超えは 422
