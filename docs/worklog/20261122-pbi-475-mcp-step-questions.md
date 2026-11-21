# MCP で、承認待ちの成果物の「確認したいこと」を問いとして読めるようにする

- 日付: 2026-11-22（UTC）
- タスク: PBI-475
- PR: なし
- ブランチ: main
- 関係する ADR: [承認待ちの成果物の確認したいことは、専用の読み取りのツールで返す](../adr/20261122-0000-mcp-read-step-questions-with-tool.md)

## 目的

手元の AI が承認待ちのタスクを追うとき、成果物の「確認したいこと」の問いを見落として、答えずにマージ（推奨の答えで進む）しがちだった。
MCP から、問いの有無・件数・中身を読めるようにする。

## したこと

- `readStepQuestions` の `counted` に、問いごとの文（`items`）を足した。件数は `items` の数から出す。
- ツール `get_step_questions` を足した。承認待ちの要求要件・設計の問いを、件数と問いごとの文で返す。読み取れないときは「読み取れなかった」と返す。答え方は `approval.method` に合わせる。
- 要約に `stepQuestions`（問いの有無と件数）を足した。
- `get_task`・`approve_step`・`request_changes` の説明と使い方の文（`INSTRUCTIONS`）に、承認前に `get_step_questions` の問いも確かめて伝えることを書いた。
- 仕様書（日英）・ユーザー文書（日英）・ADR を合わせた。

## 既定で決めたこと

- 問いごとの文は、いちばん浅い箇条書きの1項目（入れ子・続きの行を含む）を1件とし、問い・推奨の答え・理由・懸念の欄には分けない。
- 1件 1000 文字・must と should それぞれ 20 件で切る。数えられない節の本文は 4000 文字で切る。
- 秘密の値は伏せ直さない（`get_deliverable` と同じ元）。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npm test`：実装の説明に結果を書いた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 人の判断待ち（`escalated`）を対象にするか書いていない | `status` が `awaiting_approval` のときだけを対象にし、`escalated` は欄を入れず、ツールは断る |
| 承認前の案内が `get_task` の説明と `INSTRUCTIONS` だけ | `approve_step`・`request_changes` の説明と `INSTRUCTIONS` の承認の段落にも足した |
| ツール数と作業履歴が影響範囲に無い | 仕様書の数を 20 個に直し、この作業履歴を足した |

## 残したこと

- 調査の成果物の問いは対象外のまま（must・should に分けないため）。
