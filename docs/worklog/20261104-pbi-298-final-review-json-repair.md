# 最終レビューの出力の JSON の崩れを直して読み、読めなければ何が読めなかったかを残す

- 日付: 2026-11-04（UTC）
- タスク: PBI-298
- PR: なし
- ブランチ: feat/issue-298-final-review-json-repair
- 関係する ADR: [最終レビューの出力の JSON が崩れていても、直して読み、読めなければ何が読めなかったかを残す](../adr/20261104-0100-repair-broken-final-review-json.md)

## 目的

実験 findings F43（S5 r4）：最終レビューの出力6回のうち3回で、`tests` の閉じ括弧 `}` が欠け、読めずに最終レビューをやり直した（$3.81、最終レビューの費用の 32%）。監査の側の同種の修正（PBI-293）と同じ考え方で、最終レビュー・統合レビューの出力を、崩れを直して読む。

## したこと

- `agent-json.ts`：寛容な読み取り（`lastLenientJsonAnswer`）に、見出しのオブジェクトの形（`LenientShape`）を渡せるようにした。入れ子のオブジェクトの中に、見出しのオブジェクトの項目が現れたら `}` を補う。直した箇所（種類・位置）を返す。`unescapeJson`・`cut`・`safeNear`（壊れた所の前後を、秘密情報が無いと確かめて残す）を、監査と共有できるよう移した。
- `prompts.ts`：最終レビュー・統合レビューの出力を、この読み取りで読む（`findBlock`）。直した結果が期待する形（観点の配列・文字列の `summary` など）でなければ読まない。直したことを `outputRepaired` に持たせ、読めなかったときの位置を `finalReviewUnreadableDetail` で作る。
- `service.ts`：最終レビューの読み直しの理由（`FinalReviewFailed`）に位置を足す。統合レビューには秘密情報を伏せる関数を渡す。
- `events.ts`・`messages.ts`：`FinalReviewed`・`IntegrationReviewed` に `outputRepaired`、文言（`review.outputRepaired` など、日英）を足した。
- `labels`（画面の作業履歴）：「最終レビュー」「統合レビュー」の行に、直して読んだことを添える。
- 仕様書（tasks-and-steps・split-and-integrate。日英）、ユーザードキュメント（tasks。日英）、ADR。

## 確かめたこと

- S5 r4 の実際の出力（`~/.sacty/runs/b0e24155-…/<実行>.jsonl` の最後の `result`。読むだけ）を `extractFinalReview` に通した：読めなかった3件は、`tests` の外に `humanChecks`・`summary` が読め、合格になる（補った位置は JSON の 1 行目の 2556・2888・2645 文字目）。読めた3件は、直さずに今までどおり読める。
- テスト：`agent-json.test.ts`（形つきの読み取りの境界。補う・補わない・決まらない・空の入れ子・位置）、`final-review-json-repair.test.ts`（証拠の3件と同じ形・読めた3件と同じ形・項目の並びの違い・判定が甘くならないこと・推測しないこと・位置と秘密情報・統合レビュー）、`daemon.test.ts`（補って読み、読み直しを求めずに `outputRepaired` を記録する。読めない理由に位置が付く）、`labels.test.ts`。
- 修正を戻すと、足したテストが落ちることを確かめた（`}` を補う処理を外す・形の確認を外す・同じ項目の確認を外す・理由の位置を外す）。
