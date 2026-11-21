# モデルごとの上限（Opus・Sonnet）と費用の上限（spend limit）の文を、利用上限として扱う

- 日時: 2026-11-21 23:30 UTC
- ステータス: 採用
- 関係する PR・タスク: PBI-472
- 置き換え元: [利用上限で失敗したエージェントは、失敗の文から明ける時刻を確かに読み取れたとき、その時刻まで使わない](20261121-0200-superseded-agent-limit-reset-from-failure-message.md)（`Opus limit`・`Sonnet limit` を読む形に入れない部分と、分類は変えない部分）
- 置き換え先: なし

## 背景

[失敗の文から明ける時刻を読む ADR](20261121-0200-superseded-agent-limit-reset-from-failure-message.md) は、`Opus limit`・`Sonnet limit` の文を `classifyFailure` が利用上限にしないので読まないと書き、分類を変えないとした。
その結果、`You've hit your Opus limit · resets 3:45pm`・`You've hit your monthly spend limit` などは `error` になり、そのタスクでだけ代わりのエージェントを使った。ほかのタスクは同じ上限に当たり、1回ずつ失敗していた。

## 決定

- `Opus limit`・`Sonnet limit`・`spend limit` を含む文（大文字・小文字を問わない）は、利用上限（`usage_limit`）にする。`limit` を含むだけの文（`context limit` など）は、利用上限にしない。
- 明ける時刻は、`session limit`・`weekly limit` と同じ決まり（時間帯の名前つきの `resets 3:45pm (Asia/Tokyo)`）で読む。時間帯の名前の無い形と、日付つきの `resets Dec 1` は読み取れない扱い（`cooldown_minutes`）。
- 利用上限にしたときの待ち方・切り替えは変えない。

## 理由

利用者が 2026-11-21 に、これらの文を利用上限として扱うと決めた。

この ADR は、PBI-428 の ADR の「`Opus limit`・`Sonnet limit` を読む形に入れない」「分類は変えない」の部分を変える。ほかの決定は、PBI-428 の ADR のまま。

## 影響

- `Opus limit`・`Sonnet limit`・`spend limit` の文で止まったエージェントは、すべてのタスクで `cooldown_minutes` の間（時刻を読めたときはその時刻まで）使われない。切り替え先があれば使う。
- 時間帯の名前つきの `resets 3:45pm (Asia/Tokyo)` は読む。名前の無い形と `resets Dec 1` は読めず、`cooldown_minutes` になる。
- 仕様は [エージェントの実行](../spec/agent-execution.md#失敗したときの代わりのエージェント) にある。
