# 入口を足す・変える変更で、差し替えない実行と、差し替えない道のテストを求める

- 日付: 2026-11-21（UTC）
- タスク: PBI-451
- PR: #509
- ブランチ: なし
- 関係する ADR: [20261121-1900-entry-point-unmocked-run-and-test.md](../adr/20261121-1900-entry-point-unmocked-run-and-test.md)

## 目的

PBI-399 の MCP の道具が、時計を差し替えたテストをすべて通ったのに、本物の時計（小数を返す）で失敗した。
差し替えた部品の境目を、実装とレビューの段で拾えるようにする。入口を足さない変更には、手順も実行の時間も足さない。

## したこと

- `apps/daemon/src/prompts.ts`：`implementVerificationLines` に `ENTRY_UNMOCKED_RUN_LINE` を足した（文書だけの依頼には出さない）。
- 既定のコンテキスト：`review-execution/references/C-4.md` に手順 6・チェックポイント・NG 例 7、`review-dispatch/references/viewpoints.md` の C-4 の「見るもの」。新しい観点 ID は足していない。
- 仕様書（日英）：`tasks-and-steps` の提出の前の検証の節。
- テスト：`prompts.test.ts` に、行が出る経路と出ない経路のテスト。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npm test`（全件）を実行した（すべて通った。全件は 326 ファイル・6408 件が通り、14 件はスキップ）。
- 旧方針の文（外部を読むだけの通信に限った認証の外し方、`setTimeout` の例）を、方針に合わせて直した。
- 秘密の値は書いていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 新しい観点 ID、PR の本文を組み立てる所、コンテナの道具は変えていない。
