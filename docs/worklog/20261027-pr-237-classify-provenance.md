# 要求要件・設計の項目の出典を別のサブエージェントに分類させ、人が確かめる所を示す

- 日付: 2026-10-27（UTC）
- タスク: なし
- PR: #237
- ブランチ: claude/kind-carson-iapnyd
- 関係する ADR: [承認する人が見る所を絞るため、要求要件・設計の項目の出典を、書いたエージェントとは別のサブエージェントに分類させる](../adr/20261027-1427-classify-provenance-before-approval.md)

## 目的

承認ゲートは残したまま、承認する人の負担を減らす。
要求要件・設計の項目ごとの出典を、引用・導出・推論に分け、人が確かめる項目（推論・原文の見つからない引用・分類の無い項目）だけを示す。

## したこと

- 既定のスキル `classify-provenance` を足した（`apps/daemon/default-context/skills/classify-provenance/SKILL.md`）。
- core：`Provenance`・`ProvenanceItem`・`PROVENANCE_STEPS`・`needsCheck`、`AgentRunCompleted.provenance`、投影の `provenances`。
  工程の実行の外で本文を差し替えたときは、セルフレビューと同じく記録なしにする（`voidSelfReview` を `voidSubmissionChecks` にした）。
- daemon：
  - `prompts.ts`：`provenanceLines`・`provenanceInputs`・`checkProvenance`・`provenanceIds`・`provenanceGuideLines` を足した。`extractBlocks` で `sacty-provenance` を読み、本文から取り除く。要求要件・設計の PR の本文に「確かめる所」を入れる。タスクの内容を `taskContent` に分けた。
  - `service.ts`：要求要件・設計の実行で、Input を `_input/<実行 ID>` に書き、`/sacty-input` に読み取り専用でマウントして、実行の後に消す。分類の結果を照らして記録する。
  - `workspace-cleanup.ts`：起動時の片付けに `_input` を足した。
- web：`ProvenanceNote` を、成果物のカードと承認の画面に出す。辞書は日英。
- docs：仕様書（タスクと工程・コンテキスト・構成）、ユーザードキュメント（タスク）、ADR。英語の版も直した。

## 確かめたこと

- `npx biome check .`・`npm run typecheck`・`npm run build`・`npx vitest run tests/docs` が通った。
- `npx vitest run`：変更に関わるテストはすべて通った。
  - 失敗が 9 件ある。`host-mcp-processes`・`agent-sessions`・`context-mcp` の 8 件と、`question-form.browser` の 1 件（Chromium headless shell が無い）。
  - どれも変更前の `main` でも同じく失敗し、この環境が原因。
- 回帰テスト
  - 指示（Input のディレクトリを渡したときだけ、書いた側の要約を渡させない、セルフレビューの後）
  - Input のファイル（指摘・無効にした指摘・設計の承認済みの要求要件）
  - 照合（そろえ方・短すぎる抜き出し・推論の抜き出し・知らない ID と区分・重なる ID・読めない形）と、本文からの除去
  - 案内と PR の本文（`provenance.test.ts`）
  - 記録・マウント・実行の後の削除・記録なし・差し戻しの指摘の Input（`daemon.test.ts`）
  - 表示（`apps/web/src/components/provenance.test.ts`）、スキルの中身（`default-skills.test.ts`）

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

- 実機の AI がスキルに従ってサブエージェントを起動し、分類する様子は、この環境では確かめていない（AI の設定が無い）。
- 設計の本文の判断は分類しない（テスト観点だけ）。
- 区分の付け方が合っているかを、差し戻しの実績で確かめる仕組み。
