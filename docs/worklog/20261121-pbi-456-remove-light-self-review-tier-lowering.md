# PBI-456 軽い依頼の自己レビューから、段階を 1 段下げる決まりを消す

- 日付: 2026-11-21（UTC）
- タスク: PBI-456
- PR: #516
- ブランチ: なし
- 関係する ADR: [軽い依頼の自己レビューから、段階を 1 段下げる決まりを消す](../adr/20261121-1044-remove-light-self-review-tier-lowering.md)

## 目的

軽い依頼の自己レビューから、段階を 1 段下げる決まりだけを消す。ほかの決まりは残す。

## したこと

- 既定のスキル review-dispatch（`SKILL.md`・`references/viewpoints.md`・`references/self-review.md`）、`lightSelfReviewLines`、仕様書・ユーザー文書（日英）から、段階を 1 段下げる決まりと、段階に触れる周りの文を消した。
- `references/aggregation.md` の出力の例の C-1 の `tier` を `standard` に直した。
- ADR を足し、PBI-369・PBI-455 の ADR を該当する部分だけ置き換えた。
- `self-review-depth.test.ts` を、段階を下げる文が無いことと、ほかの決まりの文が残っていることを確かめる形に直した。

## 確かめたこと

- `npm run format`（biome format）: 通った。
- `npm run lint`（biome check）: 通った（790 ファイル、警告なし）。
- `npm run typecheck`: 通った。
- `npx vitest run`（全件）: 330 ファイル、6445 件が通った（14 件はスキップ）。`tests/docs`・`self-review-depth.test.ts`・`default-skills.test.ts` を含む。
- `npm run build`: 実行しなかった。作業領域に成果物を書くため。

## レビューの指摘と対応

- ADR の理由に、比べた案と採らなかった理由が無いとの指摘：理由に 2 案を足した。
- 作業履歴に確かめた結果・typecheck・「残したこと」・PR 番号が無いとの指摘：直した。

## 残したこと

なし
