# プロジェクトの設定の「危険な操作」から、プロジェクトを削除できるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #204
- ブランチ: claude/youthful-brown-b4hr9a
- 関係する ADR: [プロジェクトの削除は定義だけを消し、終わっていないタスクがあれば拒否する](../adr/20261022-2338-project-delete-keeps-tasks.md)

## 目的

プロジェクトを削除できなかったので、プロジェクトの設定の画面に「危険な操作」として削除を置く。

## したこと

- `apps/daemon/src/projects.ts`：`ProjectStore` に `delete` を足した（SQLite とメモリーの両方）。
- `apps/daemon/src/service.ts`：`deleteProject` を足した。終わっていないタスク、または実行中・実行待ちの処理（`inflight`・
  `queuedTaskIds`）があるタスクがあれば `project.hasActiveTasks`（件数）で拒否する。消したら、そのプロジェクトの秘密情報の警告を消し、
  実行待ちの数え直し（`trackQueue`）をする。
- `apps/daemon/src/server.ts`：`DELETE /api/projects/:id` を足した（無ければ 404、拒否は 409）。
- `packages/core/src/messages.ts`：`project.hasActiveTasks` の文言を日本語と英語で足した。
- `apps/web/src/lib/daemon.ts`（`deleteProject`）・`apps/web/src/app/actions.ts`（`deleteProjectAction`）：名前の一致を確かめてから
  削除し、プロジェクトの一覧へ移る。
- `apps/web/src/components/delete-project.tsx`：「危険な操作」の欄と確認のダイアログ（名前を入力したときだけ削除のボタンを押せる）。
  プロジェクトの設定の画面（`apps/web/src/app/projects/[id]/settings/page.tsx`）の最後に置いた。
- 文言（`apps/web/src/i18n/messages/projects.ts`）を日本語と英語で足した。
- 仕様書（`docs/spec/architecture.md`）とユーザードキュメント（`docs/user/project-settings.md`・目次）を、英語の版も直した。

## 確かめたこと

- `npx vitest run apps/daemon/src/daemon.test.ts -t "プロジェクトの削除"`：2件とも通った（拒否・中止の後の削除・タスクが残ること・SQLite の削除）。
- `npm run typecheck`・`npx biome check .`：誤りなし。
- `npx vitest run`：2552件が通り、9件が失敗した。失敗は `agent-sessions`・`context-mcp`・`context`・`host-mcp-processes` のテストで、
  変更を戻した状態でも同じ9件が失敗する（この作業の環境で root として実行しているため、読めないファイルやプロセスの扱いが違う）。
- `scripts/docs-screenshots/capture.mjs` の写し（撮る画面だけを変えたもの）で、架空のデータの `sacty up` を起動し、プロジェクトの設定の
  画面の最後に「危険な操作」が出ること、確認のダイアログで名前を入力すると削除のボタンを押せること、終わっていないタスクのある
  プロジェクトでは削除せずに件数を添えた理由が出ることを確かめた。削除した後に一覧へ移ることは、画面では確かめていない。

## 残したこと

- 消したプロジェクトのタスクと作業履歴を消す操作は作っていない（ADR のとおり残す）。

### レビューの対応の後に確かめたこと

- `npx vitest run apps/daemon/src/daemon.test.ts -t "プロジェクト"`：67件が通った。足した判定（回答中の質問・実行待ち・実行中・採用の確かめ直し・起動のときの作り直し）を
  1つずつ外すと、それぞれ対応するテストが落ちることを確かめた。
- `npx vitest run apps/web`：476件が通った（`deleteProjectAction`・`fetchLive` の `missing`・開いている詳細とレビューの描き直し）。
- `npm run typecheck`・`npx biome check .`・`npx vitest run tests/docs`：誤りなし。
- `npx vitest run`：2559件が通り、11件が失敗した。9件は前と同じ環境による失敗。残りの2件は画面の文言の長さの規則（`wording-policy.test.ts`）で、
  確認のダイアログの本文を2つに分けて直した（直した後に `apps/web` のテストがすべて通ることを確かめた）。
- 撮影用のスクリプトの写しで、確認のダイアログに影響の文が出ること、プロジェクトのあるタスクの詳細はこれまでどおり開けることを画面で確かめた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 完了したタスクへの質問に回答している間でも削除できる | 回答中の質問（`chats`）も削除を断る条件にした。回答中は 409、回答の後は削除できることをテストした。 |
| 監査の提案の採用（秘密情報を伏せる間）と削除が重なると、消したプロジェクトに改修のタスクができる | 採用の確かめ（伏せた後の確かめ直しを含む）でプロジェクトが無ければ断り、`createAuditFixTask` も消したプロジェクトには作らないようにした（起動のときの作り直しを含む）。伏せる間に削除するテストと、採用を記録した後に消して起動し直すテストを足した。 |
| 消したプロジェクトのタスクを、URL を直接開くと見られる（ADR・ユーザードキュメントと合わない） | デーモンの `GET /api/tasks/:id` と実行の記録の API で、消したプロジェクトのタスクは 404 を返すようにした（`visibleTask`）。開いている詳細・レビューの画面は、取り直しで対象が無くなったら描き直して 404 にする（`RefreshWhenMissing`。`fetchLive` が `missing` を返すようにした）。 |
| 完了したタスクに実行中・実行待ちの監査が残る場合のテストが無い | 実行待ち・実行中（実行待ちの判定を使えない場合）それぞれで 409 と件数・定義が残ること、監査が終われば削除できることをテストした。判定を1つずつ外すと、それぞれのテストが落ちることを確かめた。 |
| `deleteProjectAction` のテストが無い | 名前が違えばデーモンを呼ばない・409 と届かないときの表示・成功のときの `revalidatePath` と `/projects` への移動をテストした（`apps/web/src/app/actions.test.ts`）。 |
| 確認のダイアログの本文に、タスクと作業履歴への影響を書く（警告を補足に置かない） | ダイアログの本文（日英）に書き、削除の欄の補足（Hint）はやめた。 |

### 2回目のレビュー

| 指摘 | 対応 |
| --- | --- |
| 開いている、実行が終わった実行のログの画面は、取り直しを止めるので、削除の後もログが残る | 実行が終わった後は、ログを読まずにタスクがまだあるかだけを確かめる取り直し（`/live/tasks/<ID>/runs/<実行の ID>?check=1`）を続け、無くなったら描き直して 404 にした（`LiveRunLog`）。終わった後はログを読み直さないこと・タスクが無くなったら1回だけ描き直すことをテストし、確かめの取り直しを外すとテストが落ちることを確かめた。 |
| 実行の記録の 404 のテストが、記録の無い実行を問い合わせていて、`visibleTask` を外しても通る | 実在する実行（`SessionLogStore` を渡して実行したもの）で、タスク・ログ・生のファイル（events・stderr）・元のファイルの一覧と中身が、削除の前は 200、削除の後は 404 になることをテストした。`server.ts` の実行の記録の `visibleTask` の判定を外すと、このテストが落ちることを確かめた。 |
