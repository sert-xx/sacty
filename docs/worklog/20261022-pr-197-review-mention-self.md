# レビューの投稿のメンションを、sacty の設定で PR の作者から自分に切り替えられるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #197
- ブランチ: ccr-fa47436a-n4x4df
- 関係する ADR: [レビューの投稿のメンションを、sacty の設定で PR の作者から自分に切り替えられるようにする](../adr/20261022-0727-review-mention-self.md)

## 目的

AI のレビューを自分で確かめてから PR の作者に知らせたい人のために、レビューの投稿のメンションの相手を、
PR の作者から自分（投稿するアカウント）に切り替えられるようにする。既定は今の挙動（作者にメンションする）。

## したこと

- `packages/core/src/projects.ts`：`SactySettings` に `reviewMentionSelf`（On のときだけ `true` を持つ。画面のチェックボックスの `on` も受け付ける）を足した。
- `apps/daemon/src/prompts.ts`：`buildReviewBody` に `mentionSelf` を足した。あれば作者の代わりにその login にメンションする（login の形でなければ誰にもメンションしない）。
- `apps/daemon/src/service.ts`：`postReview` で、設定が On なら、投稿するアカウント（プロジェクトで選んだ gh のアカウント）を `mentionSelf` に渡す。
- `apps/web`：「Sacty の設定」の「PR のレビューの取り込み」の区画に切り替えを足した（文言は日本語・英語）。
- 仕様書（`architecture`・`tasks-and-steps`）とユーザードキュメント（`intake`）を、日本語と英語で直した。

## 確かめたこと

- `npx vitest run packages/core/src/projects.test.ts apps/daemon/src/prompts.test.ts apps/web/src/components/settings-form.test.ts`
- `npx vitest run apps/daemon/src/daemon.test.ts -t メンション`
- `npx vitest run tests/docs`
- `npm run lint`・`npm run typecheck`：通った。
- `npx vitest run`（全体）：この変更と関係の無い9件（agent-sessions・context-mcp・context・host-mcp-processes。プロセスやファイルの権限を使うもの）が、変更前の main でも同じく失敗した。ほかは通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

なし
