# sacty mcp の list_tasks で、人の対応を待っているタスクを一覧できるようにする

- 日付: 2026-11-19（UTC）
- タスク: PBI-403
- PR: #446
- ブランチ: sacty/task-eb5445c8
- 関係する ADR: なし

## 目的

手元の AI が、「いま人が対応すべきタスク」を、1回の呼び出しで、取りこぼさず、絞って引けるようにする。機能を1つずつ足す流れの9回目。
ツールは16個のまま、`list_tasks` に引数と結果の欄を足す。デーモンのサービス・API の入口・`@sacty/core`・画面は変えず、いまある `GET /api/dashboard` を読む。

## したこと

- `apps/daemon/src/task-mcp.ts`：`list_tasks` に `offset`・`needs_person`・`state`・`project_id` を足し、入力を `z.strictObject` にした（知らない引数は SDK が断る）。結果に `order`・`nextOffset`・`excludedAiJudging` と、各タスクの `projectName`・`waitingSince`・`waitingSinceSource` を足した。要約に `pendingReview` を足した。`SactyApi` に `waitingSince` を足した。人の出番の判定（`isPersonTurn`。画面の `needsPerson`・`statusTone`・`attentionRows` の写し）を足した。説明と `INSTRUCTIONS` を足した。
- `packages/cli/src/mcp.ts`：`waitingSince`（`GET /api/dashboard`）を足した。欄が無い・読めないときは理由を返す。
- `packages/cli/src/index.ts` の使い方の表示、仕様書・ユーザードキュメント（日英）、`CONTRIBUTING.md` のテストの表、この作業履歴。
- 新しいテスト：`packages/cli/src/mcp-waiting-list.test.ts`（本物のサービスと `createApp`・本物の `daemonApi` をつなぐ）。既存のテストは、引数の一覧・空の結果の `order` に合わせ、偽の API に `waitingSince` を足した。

## 確かめたこと

- `npx vitest run --no-file-parallelism packages/cli/src/mcp-waiting-list.test.ts`：19件が通った（`needs_person` での続き 0・1・3・4件、記録のあるエスカレーションと `dashboard()` の一致、引数なしの API の呼び出しの中身を足した）。画面の判定の場合分け（3つの状態 × `pendingReview`・ほかの状態・消したプロジェクト・記録なし）、`dashboard()` の `waitingSince` との一致（待ち始めの順と作成の順が逆）、`state`・`project_id`、0・1・3・4件での続き、範囲の外の `offset`（空の一覧）、知らない引数（API を呼ばない・`tools/list`）、`GET /api/dashboard` の 5xx・欄なし・接続できない、読むだけを確かめた。
- `npm run lint`：警告・誤りなし。`npm run typecheck`：通った。
- `npx vitest run --no-file-parallelism`：全件を最後の変更の後に実行し、5401件が通り、14件は既存の skip だった。
- `npm run build`：実行していない（CI にも build の工程が無い）。

## 残したこと

- 画面と同じ状態の文と色・人が判断する場所へのリンク・PR の競合の案内。
- 人の出番の判定を core に移して画面と共有すること。
- ほかの15個のツールでも、知らない引数を断ること。
- ヘッダーのベルと同じ条件の一覧。
