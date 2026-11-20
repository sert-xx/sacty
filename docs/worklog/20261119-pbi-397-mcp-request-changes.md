# sacty mcp に差し戻しを足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-397
- PR: なし
- ブランチ: なし
- 関係する ADR: [sacty mcp の差し戻しは、基本の形に限り、上限の手前で止める](../adr/20261119-0400-superseded-mcp-request-changes-basic-stop-before-limit.md)

## 目的

手元の AI が、利用者に頼まれたときに、画面の「差し戻す」（戻し先・原因を選ばない基本の形）と同じ差し戻しを MCP からできるようにする。
機能を1つずつ足す流れの4回目。上限を超えた差し戻し・戻し先と原因の指定・PR へのコメントは範囲外。

## したこと

- `apps/daemon/src/task-mcp.ts`：ツール `request_changes` を `TOOLS` の最後に足した。`SactyApi` に `requestChanges` を足し、API を呼ぶ前の確かめ（`checkRequestChanges`。状態・工程・回・やり直せる工程・指摘・上限）と、指摘の整え方（`remarkLines`）を作った。`INSTRUCTIONS` にも足した。
- `packages/cli/src/mcp.ts`：`requestChanges`（`POST /api/tasks/:id/request-changes` に `{ step, submission, comments }` だけを送る）。結果を受け取れなかったときの案内（`CHANGES_UNCERTAIN`）と、古い回の差し戻しの文を付けた。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示。
- デーモン（`service.requestChanges`・`gateTask`・`server.ts`）・`@sacty/core`・画面は変えていない。
- 仕様書（`docs/spec/mcp-server.md`）・ユーザードキュメント（`docs/user/mcp.md`・`cli.md`・README）の日英、ADR、この作業履歴、`CONTRIBUTING.md` のテストの表。

## 確かめたこと

- `apps/daemon/src/task-mcp.test.ts`：本物のサービスと `createApp` で、差し戻せる（`ChangesRequested` 1件・`cause` なし・`overLimit` false）・PR を作った工程でも差し戻せる・2回目は断る・古い回・違う工程・承認待ちでない・無いタスク・消したプロジェクトのタスク・上限の4回目（API に送らず、`TaskEscalated` なし、状態そのまま）・`escalated`（何も変わらない）・指摘の空／51件／2001文字／改行・引数の形・送る本文・結果が `escalated` のとき・結果を受け取れない案内・ツールの一覧と注釈。AI のレビューの指摘だけの回を数えないこと・やり直せる工程が無いことは、`checkRequestChanges` にタスクを与えて確かめた。
- `packages/cli/src/mcp.test.ts`：送る本文（禁止の欄が入らない）・理由の文・時間切れ／切断／5xx の案内・401／接続拒否／前の版のデーモン。

- 見直しで足したテスト：指摘ちょうど 50 件（1文字列を改行で分けた場合も）が通ること、上限の数え方の混在（人 2 回＋AI 1 回は通り、人 3 回＋AI 1 回は断る）、`daemonApi` を本物の `createApp` につないだ差し戻し（`packages/cli/src/mcp.test.ts`）。AI の指摘の回は、本物のサービスでは作りにくいため、タスクを与えて確かめた。

## レビューへの対応

- テストの欠け（50件ちょうど・上限の混在・CLI と本物のデーモンのつなぎ目）：テストを足した。
- 確かめの順の説明：実際の順との違いを書き直した。
- テストの型キャスト（`as never`）：外した。

## 既定で決めたこと

- ツールの名前は `request_changes`。
- 指摘の中の改行は、画面の欄と同じく、1行1件に分ける（分けた後に 50 件・2000 文字を確かめる）。
- 確かめの順：無い → `escalated` → 承認待ちでない → 工程 → 回 → やり直せる工程 → 指摘が空 → 件数・長さ → 上限。デーモンは先に入力の形（件数・長さ）を確かめ、`gateTask` は `escalated` も通すため、API の順とは同じではない。どの断りも何も変えないので、順の違いは、複数の異常が重なったときに返す理由だけに表れる。
- 結果の `requested` に、やり直す工程（`reworkStep`）と指摘の件数（`comments`）を入れた。

## 残したこと

- 上限を超えた差し戻し・エスカレーション中のタスクへの操作・戻し先と原因の指定・イメージとエージェントの変更・PR へのコメントは、後続。
