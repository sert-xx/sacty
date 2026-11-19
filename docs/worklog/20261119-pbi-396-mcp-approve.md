# sacty mcp に承認を足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-396
- PR: なし
- ブランチ: なし
- 関係する ADR: [sacty mcp の承認は、画面の「承認する」と同じ API に限り、PR のマージは入れない](../adr/20261119-0300-mcp-approve-with-screen-api-not-merge.md)

## 目的

手元の AI が、利用者に頼まれたときに、画面の「承認する」と同じ承認を MCP からできるようにする。
`sacty mcp` に機能を1つずつ足す流れの3回目（1回目は作成、2回目は成果物と実行の読み取り）。PR のマージ・差し戻しなどは範囲外。

## したこと

- `apps/daemon/src/task-mcp.ts`：ツール `approve_step` を `TOOLS` の最後に足した（既存の8つの引数・結果・説明は変えていない）。`SactyApi` に `approve` を足し、`approvalOf`（承認待ちの工程・回・手段）を作って、タスクの要約に承認待ちのときだけ `approval` を足した。`INSTRUCTIONS` にも足した。
- `packages/cli/src/mcp.ts`：`approve`。先に `GET /api/tasks/:id`（消したプロジェクトのタスクを断る）、続けて `POST /api/tasks/:id/approve`。古い回の理由だけ、MCP 向けの文にした。結果を受け取れなかったときの案内（`APPROVE_UNCERTAIN`）を付けた。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示に承認を足した。
- デーモン（`service.approve`・`gateTask`・`server.ts`）・画面・`messages.ts` は変えていない。
- 仕様書（`docs/spec/mcp-server.md`）・ユーザードキュメント（`docs/user/mcp.md`・`cli.md`）の日英、ADR、この作業履歴、`CONTRIBUTING.md` のテストの表。

## 確かめたこと

- `npx vitest run --no-file-parallelism`（全件）・`npm run lint`・`npm run typecheck`・`npm run build`・`npx biome format .`。結果（2回目のレビューの指摘を直した後に実行）：`npx vitest run --no-file-parallelism` は 266 ファイル・5230 件が成功（14 件は既存の skip）、lint・typecheck・build・format は通った。
- `apps/daemon/src/task-mcp.test.ts`：本物のサービスと `createApp` で、承認できる（記録1件）・2回目は断る・古い回・違う工程・承認待ちでない・無いタスク・PR のマージで承認する工程（URL・何も変わらない）・引数の形の違い・結果を受け取れない・ツールの一覧。
- `packages/cli/src/mcp.test.ts`：呼ぶ API・消したプロジェクトのタスク・理由の文・時間切れ／切断／5xx の案内・401／接続拒否／前の版のデーモン。

## 既定で決めたこと

- ツールの名前は `approve_step`。
- 上限を超えた差し戻しの判断待ち（`escalated`）は、画面と同じく承認できる。
- 結果を受け取れなかったときは、5xx も「承認された可能性」にした（`create_task` と同じ）。

## 残したこと

- PR のマージ（GitHub への書き込み）。入れるかは人が決める。
- 差し戻し・変更の申し出への決定・質問への回答・一時停止／再開／中止・待つこと・ログの取得は、後続。

## レビューの指摘と対応

- 仕様書・ユーザー文書・README に承認の追加の反映漏れ（「最後の3つ」「下3行」・ツールの表・cli の節・README）を直し、日英をそろえた。
- 結果を受け取れなかったときの案内は、元の例外の文（「もう一度試してください」など）を使わず、原因の種類だけを書いて、自動でやり直さない案内に続けるようにした。
- `approvalOf` の二重呼び出しをやめ、デーモンの判定の読み取り側の写しであることをコメントに書いた。
- テストを足した：`approvalOf` の分岐、先の詳細の確認（GET）の失敗、承認のツールの読み取りでない扱い。
- 2回目のレビュー：仕様書の「その理由に続けて」を、5xx（デーモンの理由に続ける）と時間切れ・切断・本文を読めない（決まった文に続ける）の場合分けに直した（日英）。ユーザー文書に、`approve_step` を許可すると他人の指示で承認されうるので毎回確かめる設定をすすめることを足した（日英）。
- `approve` の「結果を受け取れなかった」案内を、`uncertainApproval` 1 か所にまとめた（5xx・時間切れ・切断・本文を読めない）。
- テスト：`approvalOf` に、承認待ちの工程と違う PR・url が空で repo から組む場合を足した。`task-mcp-read.test.ts` の偽の API に `approve` を足した。
