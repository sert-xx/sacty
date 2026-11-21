# PBI-472 モデルごとの上限と費用の上限の文を、利用上限として扱う

- 日付: 2026-11-21（UTC）
- タスク: PBI-472
- PR: なし
- ブランチ: main
- 関係する ADR: [モデルごとの上限（Opus・Sonnet）と費用の上限（spend limit）の文を、利用上限として扱う](../adr/20261121-2330-model-and-spend-limits-are-usage-limits.md)

## 目的

Opus・Sonnet・費用の上限の文が `error` になり、ほかのタスクが同じ上限に当たって失敗していた。利用上限として扱う。

## したこと

- `classifyFailure` が、`Opus limit`・`Sonnet limit`・`spend limit` の文を `usage_limit` にするようにした。
- `parseLimitReset` が、時間帯の名前つきのこれらの文の時刻を、`session limit`・`weekly limit` と同じ決まりで読むようにした。
- 仕様書（日英）・ユーザー文書（日英）を合わせ、方針の変更を [ADR](../adr/20261121-2330-model-and-spend-limits-are-usage-limits.md) に書いた。

## 既定で決めたこと

- 時刻の読み取りは、大文字・小文字を区別するまま（分類だけ区別しない）。
