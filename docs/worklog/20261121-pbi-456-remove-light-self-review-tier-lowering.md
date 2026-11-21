# PBI-456 軽い依頼の自己レビューから、段階を 1 段下げる決まりを消す

- 日付: 2026-11-21（UTC）
- タスク: PBI-456
- PR: なし
- ブランチ: なし
- 関係する ADR: [軽い依頼の自己レビューから、段階を 1 段下げる決まりを消す](../adr/20261121-2100-remove-light-self-review-tier-lowering.md)

## 目的

軽い依頼の自己レビューから、段階を 1 段下げる決まりだけを消す。ほかの決まりは残す。

## したこと

- 既定のスキル review-dispatch（`SKILL.md`・`references/viewpoints.md`・`references/self-review.md`）、`lightSelfReviewLines`、仕様書・ユーザー文書（日英）から、段階を 1 段下げる決まりと、段階に触れる周りの文を消した。
- `references/aggregation.md` の出力の例の C-1 の `tier` を `standard` に直した。
- ADR を足し、PBI-369・PBI-455 の ADR を該当する部分だけ置き換えた。
- `self-review-depth.test.ts` を、段階を下げる文が無いことと、ほかの決まりの文が残っていることを確かめる形に直した。

## 確かめたこと

- `npx vitest run tests/docs apps/daemon/src/self-review-depth.test.ts apps/daemon/src/default-skills.test.ts`、`npm run lint`、`npm test`（結果は実装の説明のとおり）。

## レビューの指摘と対応

- なし。
