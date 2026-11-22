# テストに要るサービスの compose を探す

- 日付: 2026-11-22（UTC）
- タスク: PBI-487
- PR: なし
- ブランチ: main
- 関係する ADR: なし

## 目的

テストや動作確認に必要な compose の見落としを減らし、サービスを選ばない理由を確認できるようにする。

## したこと

情報収集と計画の指示に compose の探索先を追加した。
必要なサービスを選ばないときは、そのサービスと理由を計画に書くよう指示した。
作業履歴の既存の表示を確認し、仕様書とユーザー向けの説明を日英で更新した。

## 確かめたこと

| コマンド | 結果 |
| --- | --- |
| `npx vitest run apps/daemon/src/prompts.test.ts apps/web/src/lib/labels.test.ts tests/docs --no-file-parallelism` | 503 件成功 |
| `npm run lint` | 成功 |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功 |
| `npm test` | 346 ファイル、7089 件成功、14 件スキップ |

指示の変更を戻すと、計画と情報収集のテストがそれぞれ失敗した。

## レビューの指摘と対応

### この PR の最初の提出

まだ無い（最初の提出）

## 残したこと

なし。
