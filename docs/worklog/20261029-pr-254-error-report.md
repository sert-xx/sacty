# タスクのエラーを Markdown のエラーレポートにまとめてダウンロードし、オーケストレーターに分析させられるようにする

- 日付: 2026-10-29（UTC）
- タスク: なし
- PR: #254
- ブランチ: claude/error-report-feature-jiwiaw
- 関係する ADR: [エラーレポートを Markdown のダウンロードにし、オーケストレーターの分析を任意で足す](../adr/20261029-0609-error-report-markdown-download.md)

## 目的

タスクでエラーが起きたときに、何が起きたかを詳しく書いたレポートを出せるようにする。

- 通信できない環境でも使えるよう、サーバーに送らず、Markdown のファイルでダウンロードする。
- Sacty の内部の処理と、各工程のエージェントの動きを入れる。エラーの箇所は特に詳しくする。
- オーケストレーターに情報をまとめさせたり、追加で調べさせたりできる。
- テキストファイルとして重くなりすぎない。

## したこと

- core
  - エラーとして扱う記録の分け方（`failureKind`・`hasFailures`）を足した（`packages/core/src/error-report.ts`）。
  - 画面のセッションログの読み分け（`parseSessionLog`）を core に移し、画面はそれを使うようにした（`packages/core/src/session-log.ts`）。
  - エラーの分析のイベント `ErrorAnalysisRequested`・`ErrorAnalyzed`、投影の `errorAnalyses`・`pendingErrorAnalysis`・`errorAnalysisBlocked`、文言のコード `errorReport.*` を足した。`ErrorAnalyzed` は費用を持つイベントにした。
- デーモン
  - レポートを作る `buildErrorReport`（`apps/daemon/src/error-report.ts`）。基本の情報・エラーの概要・分析・エラーの詳細・実行の一覧とエージェントの動き・作業履歴の順に書き、部分ごとと全体（256KB）に上限を置く。
  - `GET /api/tasks/:id/error-report`（`?lang=en`）と `POST /api/tasks/:id/error-analysis`。
  - 分析は、質問への答えと同じ仕組み（オーケストレーターのセッションの複製・セッションログの読み取り専用のマウント・起点のコードの写し）で実行し、レポートの全体をログと同じ場所に置く。中止のときは分析の実行を止めて記録する。
- 画面
  - タスクの詳細の右の列に「エラーレポート」の欄（ダウンロードと分析）を足した。エラーの記録があるタスクだけに出す。
  - `/tasks/<ID>/error-report` でファイルとしてダウンロードさせる。
  - 作業履歴の文と、工程ごとの費用の表の「エラーの分析」の行を足した。
- docs：仕様書 [エラーレポート](../spec/error-report.md) を足し、作業履歴（イベントの数・費用を持つイベント）・全体の構成（API・URL）・困ったとき（ユーザードキュメント）を直した（日英）。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npm run build`：通った。
- `npx vitest run`：今回足した・直したテスト（`packages/core/src/projection.test.ts`・`apps/daemon/src/error-report.test.ts`・`apps/daemon/src/daemon.test.ts` のエラーレポートの describe・`apps/web/src/lib/step-costs-totals.test.ts` など）は通った。
  次のテストは、この環境（root で実行・Chromium が無い）では、変更前の main でも同じく失敗する。
  - `apps/daemon/src/host-mcp-processes.test.ts`（実際のプロセスの後始末）
  - `apps/daemon/src/agent-sessions.test.ts`・`apps/daemon/src/context-mcp.test.ts` のうち、読めないファイルを作って確かめる各1件
  - `apps/web/src/components/question-form.browser.test.ts`（Chromium が無い）
- 実際のデーモンと画面を起動しての手での確認（ダウンロード・分析の実行）はしていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

- 分析の本文は画面に出さず、レポートにだけ入れる。画面でも読みたいという声があれば、欄に出す。
- サーバーへの送信はしない（通信できる環境向けの送信先の設定は、必要になったら考える）。
