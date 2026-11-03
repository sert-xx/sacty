# 文書だけの依頼の実装のセルフレビューを、文書向けの観点で走らせる

- 日付: 2026-11-03（UTC）
- タスク: PBI-295
- PR: #295
- ブランチ: feat/issue-295-pbi-295
- 関係する ADR: [文書だけの依頼の実装のセルフレビューは、文書向けの観点で走らせる](../adr/20261103-0830-self-review-kind-for-documents-only.md)

## 目的

実験（findings F38、S2 r3）で、Markdown だけの依頼の実装のセルフレビューが、コード向けの観点（C-1〜C-6・C-15）の担当を起動していた。実装・修正の工程の主対象の種類が `code` に固定されていたため。

## したこと

- `apps/daemon/src/prompts.ts`：実装・修正の工程の 3 か所で使う `implementSelfReviewLines` を足した。`task.documentsOnly`（PBI-284 の判定）が真なら、`selfReviewLines` の種類を `user-doc`（対象は「実装（文書）」）にし、それ以外は今までどおり `code`。`selfReviewLines` の種類に `user-doc` を足した（下書きの一時ファイルの指示は `design-doc` だけ）。
- 既定のスキルは変えていない。主対象が `user-doc` なら、スキルの規則（主対象の種類の必須観点を全部起動する）により U-1〜U-4 と横断の観点だけが起動し、C-n は起動しない。
- 仕様書（日英）の「提出の前のセルフレビュー」とユーザードキュメント（日英）の「提出の前のセルフレビュー」、ADR を直した。

## 確かめたこと

- `apps/daemon/src/prompts.test.ts`：文書だけの依頼（標準・direct・テストの仕組みが無い）は `user-doc`・`実装（文書）`、コードを含む依頼（標準・direct・不具合の修正）は `code`、要求要件・設計は `documentsOnly` でも `design-doc` のままを確かめる。`prompts.ts` の変更を戻すと落ちることを確かめた。
- `apps/daemon/src/default-skills.test.ts`：観点カタログの `user-doc` が U-n だけで、起動の規則が主対象の種類の必須観点だけを起動すると書いていることを確かめる。
