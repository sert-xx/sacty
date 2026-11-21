# 一時停止中のレビューの子タスクも、PR のマージ・クローズと親の完了で片付ける

- 日付: 2026-11-21（UTC）
- タスク: PBI-457
- PR: なし
- ブランチ: なし
- 関係する ADR: なし

## 目的

利用者の要望「親タスクが完了したら子タスクも片付けてほしい」。投稿済みで一時停止したレビューの子タスクが、PR がマージされ親が完了した後も一時停止のまま一覧に残っていた（PBI-411 の既定の決定「一時停止中はマージ・クローズで完了にしない」の結果）。この決定を、レビューの子タスク（`reviewOf`）に限って変える。

## したこと

- `apps/daemon/src/service.ts`
  - `checkReviewPullRequests`：投稿済みで一時停止中の子も PR を読み、マージ・クローズなら `endReviewWatch` で片付ける。
  - `endReviewWatch`（新規）：一時停止中なら sacty が `TaskResumed`（`retry: false`）を記録してから `ReviewWatchEnded` を記録する（前例は `checkDecisionPauses`）。`unstoppedRuns` がある間・再レビューの途中は終えず、次の確認に回す。記録の書き込みに失敗しても、警告を出して確認を続ける。
  - `reconcileReviewTasks`：親が完了（`isDone`）したら、PR を読まずに子を片付ける。投稿済みは完了、投稿前は中止。
- `packages/core/src/events.ts`：`ReviewWatchEnded`・`TaskCancelled` の理由に `parent_completed` を足した。画面の文言（日英）・MCP の `watchEnded` も対応。
- 仕様書（tasks-and-steps・approval・mcp-server、日英）とユーザー文書（intake・mcp、日英）を直した。

## ADR を足さない理由

PBI-411 の ADR（見守りの仕組み）の決定は変えていない。一時停止中のマージの扱いは、その作業記録の既定の決定で、ここで仕様書に合わせて書き換えた。

## 確かめたこと

- `apps/daemon/src/daemon-step-pull-requests.test.ts` に、条件 1〜6 と、書き込み失敗・`unstoppedRuns` のテストを足した。
- lint・型チェック・テスト全件の結果は、PR の説明に書く。
- 実機で 5ba3ef8d が完了になることは、台帳に触れないので確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 作業履歴が無い | このファイルを足した |
| mcp-server・mcp の文書に `parent_completed` が無い | 日英の 4 ファイルに足した |
| approval.en.md に一時停止中の子の扱いが無い | 英訳して足した |
| `endReviewWatch` の書き込み失敗を捕まえていない | 関数の中で try/catch し、警告を残して続ける。テストを足した |
| `unstoppedRuns` を確かめずに消す | ある間は終えずに次の確認に回す。テストを足した |
| テストの不足・名前の食い違い | 親の完了（見守り中）・再起動後・条件 4 のマージ側を足した |
| コメント・文言 | 直した |

## 残したこと

- 旧版に戻したとき、台帳の `parent_completed` を読めない可能性（`parent_cancelled` を足したときと同じ作り）。
