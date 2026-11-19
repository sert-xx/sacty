# sacty mcp に、タスクのエラーレポートを読むツールを足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-404
- PR: なし
- ブランチ: 提出のときに決まる
- 関係する ADR: [sacty mcp のエラーレポートの読み取りは、閉じられなかった実行のログを必ず省き、省いた印と全体の指紋で確かめる](../adr/20261119-1500-mcp-error-report-always-omit-stale-logs.md)

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

- `npx vitest run packages/cli/src/mcp-error-report.test.ts`：10件が通った（閉じられなかった実行の省き方と入力なしの API、`stale` の値ごとの印、印の無い応答での断り〔目印が結果・理由・`console.error`・標準エラーに無い。`console.error` の呼び出しは1回以上〕、印付きの 200 のあとの本文の読み取りの失敗、連結の一致、作業履歴が増えたときの断りと、日本語・英語の両方で時間が進んでも続きが読めること、断る7場合、呼ぶ前後の作業履歴・タスクの数・状態、`get_task` の欄の3場合）。
- `npx biome check .`・`npm run typecheck`：通った。
- `npx vitest run --no-file-parallelism`：最後の変更の後の全件：5423件が通り、14件は既存の skip（1回目は `console.error` の呼び出しの記録を `mockRestore` の後に読む誤りで1件が落ち、直した）。
- `npm run build`：実行していない（CI にも build の工程が無い）。
- 環境に無いツールは入れていない（`npm ci` だけ）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 標準エラーのテストが `console.error` を集めていない（指摘 1） | `console.error` の呼び出しを集めて本文が無いことと、1回以上呼ばれたことを確かめる。印付きの 200 のあとに本文の読み取りが失敗する分岐と、分析の依頼・結果だけの作業履歴で `errorReportWorthReading` が `false` になるテストを足した |
| ADR が無い（指摘 2） | `docs/adr/20261119-1500-mcp-error-report-always-omit-stale-logs.md` を足し、作業履歴と `mcp-server`（日英）の「関係する ADR」からリンクした |
| 「approve_step の前の3つ」・呼ぶ API の段落が古い（指摘 3） | 日英とも、名前で書き直し、`get_error_report` を呼ぶ API の段落に足した |
| JSDoc が別の定数に付いている（指摘 4） | `READ_UNTRUSTED_NOTE` の上に戻し、`REPORT_UNTRUSTED_NOTE` には新しい説明を付けた |
| テストの題が「16個」のまま（指摘 5） | `mcp-cancel.test.ts`・`mcp-rerun.test.ts` の題から件数を外した |
| クエリの値・ヘッダーの名前と値を共有（人間の指摘 4） | 定数（`STALE_LOGS_*`）を `stale-logs.ts` に置き（2回目の直しで `task-mcp.ts` から移した）、`server.ts`・`mcp.ts`・`testing/mcp-read.ts` が使う。作成時刻の行の正規表現は共有せず、「時間が進んでも指紋が同じ」を日本語・英語の両方で確かめる |
| 印が無いとき本文を読まない（追加 A） | `getErrorReport` は、印が無ければ `res.text()` を呼ばず `{ omitted: false }` だけを返す。テストの写しも同じ形 |
| 変わり続けるレポートの案内（追加 B） | ツールの説明・仕様書・ユーザードキュメント（日英）に足した。動きは変えていない |
| ADR の `fingerprint` の説明が逆（2回目の指摘 1） | 仕様書と同じ言い方（付けなければ続きは読めるが、前に読んだ部分とつながらないことがある）に直した |
| 作成時刻の行の説明のコメントの位置（2回目の指摘 2） | `REPORT_CREATED_LINE` の直前に移した |
| ユーザー文書の「前の版の sacty が起動しているとき」の行（前回の指摘 3 の残り） | `mcp.md`・`mcp.en.md` に、`get_error_report` も更新を促して断ることを足した |
| `server.ts` が `task-mcp.js` を読み込む（人間の気づき） | 4つの定数を、ほかに依存しない `apps/daemon/src/stale-logs.ts` に置いた。`server.ts` はそこから読み、`task-mcp.ts` はそこから読んで外へ出す（CLI・テストの読み込み元は変えない）。`server.ts` に `task-mcp.js` の読み込みが無いことは grep で確かめた |

## 残したこと

- エラーの分析を頼むツール・省かない読み方・閉じるときの伏せ直しの失敗の扱い・`list_tasks` の要約へのエラーの記録の有無は、最初の版で入れない。
- 実行中のタスクのレポートは、作業履歴・実行中のログで中身が変わるので、続きを読む間に断られることがある（読み直す）。
