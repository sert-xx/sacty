# 再開の補足を PR のレビューに渡す

- 日付: 2026-11-23（UTC）
- タスク: PBI-499
- PR: なし
- ブランチ: main
- 関係する ADR: [再開の補足で決めた範囲を PR のレビューに渡す](../adr/20261123-2245-resume-notes-in-pr-review.md)

## 目的

人が再開時に決めた範囲を PR のレビューに反映する。

## したこと

補足を秘密の伏せと長さの上限を設けてレビューに渡し、人の判断を優先する規則を追加した。
止めた指摘の判断も伏せ、再提示の条件を揃えた。

## 確かめたこと

| コマンド | 結果 |
| --- | --- |
| `npx vitest run --no-file-parallelism apps/daemon/src/review-overlap.test.ts apps/daemon/src/needs-decision.test.ts` | 34 件成功 |
| `npm run lint` | 成功 |
| `npm run typecheck` | 成功 |
| `npx vitest run --no-file-parallelism` | 349 ファイル、7,302 件成功、14 件スキップ |
| `npm run build` | 成功 |

補足を渡す呼び出しを一時的に外すと、対象テストの 4 件が失敗した。

## レビューの指摘と対応

### 設計のレビュー

止めた指摘の再提示の条件を補足の判断に合わせた。
依頼本文の既存の経路は人の判断に従って変更しない。

### この PR の最初の提出

まだ無い（最初の提出）

## 残したこと

依頼本文に入る補足の伏せ・区切り・切り詰めの揃え方は後続の課題。
