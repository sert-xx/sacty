# 既定のレビューに、要らないコードを探す観点（C-15）と UX の観点（C-16）・画面の記録を足す

- 日付: 2026-10-26（UTC）
- タスク: なし
- PR: #229
- ブランチ: claude/great-clarke-kf7o3d
- 関係する ADR: [既定のレビューに、要らないコードを探す観点と、画面を撮って UX を見る観点を足す](../adr/20261026-1014-review-code-conciseness-and-ux.md)

## 目的

既定のレビュー用スキルに、次の2つの観点を足す。

- 利用者にとって良い UI/UX になっているか。Playwright のスクリーンショットで確かめる。撮れる環境のときだけ撮り、撮れなければコードで確かめる。
- 過剰な実装・記述が無いか。要らないものを積極的に消す。

## したこと

- 観点カタログ（`review-dispatch/references/viewpoints.md`）
  - コードの必須に C-15（簡潔さ・範囲）、条件付きに C-16（UX・利用者の流れ）を足した。段階はどちらも `standard`。
  - C-5 の「見るもの」から要らないコードを外し、「見ないもの」に C-15 を書いた。C-13 の「見ないもの」に C-16 を書いた。
- 観点の資料（`review-execution/references/`）
  - `C-15.md`・`C-16.md` を足した。
  - `C-5.md` から未使用・過剰設計・言い直すだけのコメントの項目と例を外した（C-15 に移した）。
  - `C-13.md` に、画面の記録があれば画像も見ることを足した。
- 画面の記録（`review-dispatch/references/screen-capture.md`）を足した。
  - 撮る条件、起動の方法の探し方、撮る組み合わせ、保存の形（`screens.json`）、撮れないときの扱いを書いた。
  - 親の手順（`SKILL.md`）・流れ（`self-review.md`・`pr-review.md`）・依頼文の雛形・集約の記録（`aggregation.md`）からつないだ。
  - 担当の手順（`review-execution/SKILL.md`）に、画面の記録の使い方を足した。
- 仕様書（`docs/spec/context.md`・`context.en.md`）の「既定のレビュー用スキル」に、C-15・C-16・画面の記録を書いた。
- テスト（`apps/daemon/src/default-skills.test.ts`）に、観点と画面の記録の規則を確かめるものを足した。

## 確かめたこと

- `npx vitest run apps/daemon/src/default-skills.test.ts`：24 件すべて通った。
- `npx vitest run tests/docs`：通った。
- `npm run lint`：問題なし。
- `npx vitest run apps/daemon`：8 件が失敗した（`agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts`）。変更前のコードでも同じ 8 件が失敗するので、この変更とは関係ない（root で実行したコンテナの環境によるもの）。

## 残したこと

- 利用者向け文書（`user-doc`）にも、書きすぎを探す観点（D-10 に当たるもの）が無い。今回は足していない。
