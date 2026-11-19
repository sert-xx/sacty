# sacty mcp に、タスクのエラーレポートを読むツールを足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-404
- PR: なし
- ブランチ: 提出のときに決まる
- 関係する ADR: なし

## 目的

手元の AI が、画面の「エラーレポートをダウンロード」と同じ Markdown を、MCP だけで読めるようにする。機能を1つずつ足す流れの10回目。
ただし、デーモンが止まって閉じられなかった実行のログ（閉じるときの伏せ直しを経ていない）は、MCP からは必ず省いたものだけを返す。
ツールは 16 個から 17 個になる（`get_error_report`）。読むだけで、エラーの分析を頼むツールと、省かない読み方は入れない。

## したこと

- デーモン（入力と印だけ）：`apps/daemon/src/server.ts` の `GET /api/tasks/:id/error-report` に、クエリ `stale=omit` を足した。受け取ると `service.errorReport` の `omitStaleLogs` を通して、既にある `buildErrorReport` の `omitStaleLogs: true` に渡し、応答に `x-sacty-stale-logs: omitted` を付ける。入力が無い・`omit` 以外の値は、入力が無いものとして扱い、本文・状態コード・`content-type`・404 は前と同じで、印も付けない（省かないのに印が付くことが無い）。`error-report.ts`・`session-logs.ts`・伏せ直しは変えていない。
- MCP の層：`apps/daemon/src/task-mcp.ts` に `get_error_report` を足した（引数は `task_id`・`lang`・`offset`・`max_bytes`・`fingerprint`。`z.strictObject`）。`packages/cli/src/mcp.ts` に `getErrorReport`（常に `stale=omit` を付ける。応答のヘッダーで印を読む）を足した。分け方は既にある `readByteRange`・`RANGE_MAX_BYTES`。印が無い応答（前の版のデーモン）は、本文を使わずに断る。
- `get_task` に `errorReportWorthReading` を足した（`task.errorAnalyses.length > 0 || hasFailures(activity)`。core の `hasFailures`）。`list_tasks` の要約には足していない。
- ツールの説明・`INSTRUCTIONS`（`sacty mcp` の使い方の表示を含む）・仕様書（`mcp-server`・`error-report`）・ユーザードキュメント（`mcp`・`cli`）の日英・`CONTRIBUTING.md` のテストの表。
- テスト：新しい `packages/cli/src/mcp-error-report.test.ts`（本物のサービス・`createApp`・`daemonApi` をつなぐ）。既存のテストは、ツールの数・名前・注釈・結果の欄、偽の API（`apiOver` が使う `testing/mcp-read.ts` の `readApiOver`・`readStubs`・`task-mcp-read.test.ts`・`task-mcp-wait.test.ts`）を合わせた。`mcp-waiting-list.test.ts` の `toHaveLength` も 17 にした。

## 既定で決めたこと

- 全体の指紋は、作成時刻の行（`- レポートの作成：…`）だけを除いた全体の SHA-256。作成時刻の行を含めると呼ぶたびに必ず変わり、続きが1度も読めないため。返す `text` は加工せず（行を抜かない）、指紋を数えるときだけ除く。
- 指紋が違うときは、続きを返さずに、「`fingerprint` を付けずに読み直す」と断る。
- `fingerprint` は、64 桁の 16 進で形を検査する（形が違えば SDK が断る）。省けば確かめない。
- 結果に `clamped` も入れた（`get_deliverable` と同じ名前・意味）。
- エラーの記録が無いタスクも、デーモンと同じくレポートを返す（断らない）。
- デーモンの `stale` の値が `omit` 以外のときは、断らず、入力が無いものとして扱う。
- 印は応答のヘッダー `x-sacty-stale-logs: omitted`。本文は変えない。
- 既存の文のうち、「実行のログを読むツールは、まだ無い」（仕様書）・「実行のログは、まだ読めません」（`cli.md`）・`INSTRUCTIONS` の「ログの取得はできません」は、実行ごとのログを読むツールが無いという意味で、今回も正しいので、直していない。

## 確かめたこと

- `npx vitest run packages/cli/src/mcp-error-report.test.ts`：9件が通った（閉じられなかった実行の省き方と、入力なしの API が従来どおり目印と注意書きを返すこと、`stale` の値ごとの印、前の版のデーモンに相当する応答での断り〔目印が結果・理由・標準エラーに無い〕、小さな `max_bytes` での連結と一致、作業履歴が増えたときの断りと増えないときの続き、断る7場合、呼ぶ前後の作業履歴・タスクの数・状態、`get_task` の欄の3場合）。
- `npm run format`（`biome format --write .`）・`npm run lint`・`npm run typecheck`：通った。
- `npx vitest run --no-file-parallelism`：全件を最後の変更の後に実行し、5411件が通り、14件は既存の skip だった。1回目の全件では、作業履歴の PR の欄の書き方・仕様書の「コード:」の書き方・日英の `offset` の数の3件が `tests/docs/docs.test.ts` で落ちたので、文書を直した。
- `npm run build`：実行していない（CI にも build の工程が無い）。
- 環境に無いツールは入れていない（`npm ci` だけ）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし（提出の前のセルフレビューは行わない。PR のレビューの指摘は、PR で受ける） | なし |

## 残したこと

- エラーの分析を頼むツール・省かない読み方・閉じるときの伏せ直しの失敗の扱い・`list_tasks` の要約へのエラーの記録の有無は、最初の版で入れない。
- 実行中のタスクのレポートは、作業履歴・実行中のログで中身が変わるので、続きを読む間に断られることがある（読み直す）。
