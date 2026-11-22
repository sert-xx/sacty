# 工程のブランチの片付けの知らせと、完了で消せなかったブランチ

- 日付: 2026-11-22（UTC）
- タスク: PBI-480
- PR: なし
- ブランチ: main
- 関係する ADR: [完了で消せなかった工程のブランチは、やり直さず記録して画面に出す](../adr/20261122-1500-step-branches-left-at-completion.md)

## 目的

工程のブランチの片付けで、知らせが `[object Object]` と出る・英語の画面に日本語が混ざる・完了で消せなかったブランチが捨てられる・`stale info` の断りを扱わない、の 4 つを直す。

## したこと

- `cleanup.stepBranchUnrecorded` を `MessageError` で渡し、`cleanup.stepBranchPrepareFailed`・`cleanup.stepBranchFailed` の `detail` を入れ子の文言にした（日本語の埋め込みを外した）。
- 完了の片付け（`retireWorkspace`）で消せなかったブランチを、新しいイベント `StepBranchesLeft` に記録し、タスクの詳細に出すようにした。再実行で結果が変われば置き換え、同じなら足さず、git のメタデータが無い結果は使わない。
- `deleteBranch` が、期待する先頭を付けた削除の `stale info` を `git.branchLeaseRejected` で投げ、`settleStepBranch` が取得し直して、リモートに無ければ消せたもの・違えば `StepBranchKept`・同じなら消し直さず unresolved にした。
- 仕様書・ユーザー文書（日英）と ADR を足した。

## 既定で決めたこと

- やり直す仕組みは作らず、記録して人に任せた。

## 確かめたこと

- `npx vitest run apps/daemon/src/daemon-step-pull-requests-direct.test.ts`：36 件成功。準備失敗の理由が日英で翻訳されることも確かめた。
- 準備失敗の理由を日本語に固定する変更を一時的に戻し、TV-2 が失敗することを確かめた。

## 残したこと

完了で消せなかったブランチを後で自動でやり直す仕組みは作らない。
