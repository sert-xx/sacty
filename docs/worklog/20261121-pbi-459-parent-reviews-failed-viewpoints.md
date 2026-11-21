# 観点の担当が起動し直しても失敗したときは、親が代わりに見る

- 日付: 2026-11-21（UTC）
- タスク: PBI-459
- PR: なし
- ブランチ: なし
- 関係する ADR: [観点の担当が起動し直しても失敗したときは、親が代わりに見る](../adr/20261121-2200-parent-reviews-failed-viewpoints.md)

## 目的

判定の無いレビューを減らすため、起動し直しても失敗した観点を、親が代わりに見る。

## したこと

- review-dispatch の集約に「親が代わりに見る」を足し、PR のレビュー・自己レビュー・SKILL.md を合わせた。
- 仕様書・ユーザー文書（日英）・ADR を足した。
- 代わりに見たことは本文に書かず、集約の記録の `substituted_by_parent`・`failure_reason` に残す。デーモンの記録の型は変えていない。
- テストを足した。

## 確かめたこと

- `npx biome check --error-on-warnings .`：通過。
- `npx vitest run apps/daemon/src/default-skills.test.ts apps/daemon/src/prompts.test.ts apps/daemon/src/review-verdict-missing.test.ts tests/docs`：499 件が成功。
- 全件の vitest・typecheck・build は、この環境で関係の無い失敗があるため、変更に関係するファイルだけを実行した。
