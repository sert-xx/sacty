# 同じ原因の要修正が続くときに人の判断を求める

- 日付: 2026-11-23（UTC）
- タスク: PBI-492
- PR: なし
- ブランチ: main
- 関係する ADR: [同じ原因の要修正が続く場合に人の判断を求める](../adr/20261123-0007-repeated-cause-decision.md)

## 目的

同じ原因の要修正が繰り返されるとき、範囲を絞る案を示し、人が判断できるようにする。

## したこと

レビューの指示に案と受け入れ条件の照合を追加した。
3回目以降の PR レビューは既存の印で停止し、セルフレビューでは判断事項を報告と画面に出す。
人の指摘が同じ回にあっても停止する。
判断後に同じ先頭の新しいレビュー回で同じ原因が続いた場合も、根拠の文の書き出しで区別して再び停止する。

## 確かめたこと

| コマンド | 結果 |
| --- | --- |
| `npm run lint` | 成功 |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功 |
| `npm test` | 346ファイル、7,137件成功、14件スキップ（Git の機能が無い13件と AI 評価1件） |
| `npx vitest run apps/daemon/src/needs-decision.test.ts apps/daemon/src/prompts.test.ts apps/daemon/src/prompts-design-weight.test.ts apps/daemon/src/default-skills.test.ts apps/daemon/src/daemon-deliverables.test.ts apps/web/src/components/self-review.test.ts tests/docs` | 10ファイル、608件成功 |
| 同じ先頭での停止条件を戻したテスト | 新しい再停止のテストが失敗 |
| プロンプト・停止処理・報告の型・画面表示をそれぞれ戻したテスト | それぞれ関連テストが失敗 |
| ビルド済みデーモンの `GET /api/tasks/example-task` | 認証情報を隔離し、架空のタスクの応答に判断事項が残ることを確認（HTTP 200） |

## レビューの指摘と対応

### 設計のレビュー

セルフレビューと利用者向け文書にも判断を求める規則を適用し、人の指摘が混在する回と判断後に続く回を扱った。
承認済み文書の誤りにも3回目以降の例外を適用した。

### この PR の最初の提出

まだ無い（最初の提出）。

## 残したこと

なし。
