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

- 時刻を読む形のうち、`reached` を許すのは `spend limit` だけ（`session limit reached · resets …` などは読まない）。

## 確かめたこと

- `npm run lint`：通った（806 ファイル）。
- `npm run typecheck`：通った。
- `npx vitest run --no-file-parallelism`：338 ファイル、6839 件成功、14 件スキップ。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| PBI-428 の ADR を置き換え済みにしていない | ファイル名・ステータス・置き換え先を直し、新しい ADR の置き換え元とリンクを合わせた |
| `reached` が `spend` 以外にも掛かる | `spend limit` だけに許した |
| ADR に影響の節、作業履歴に確かめたこと・残したことが無い | 足した |

## 残したこと

なし
