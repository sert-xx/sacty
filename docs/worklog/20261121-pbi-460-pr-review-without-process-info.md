# PR に投稿するレビューを判断に要る情報だけにし、Sacty の過程の情報を Sacty の記録に移す

- 日付: 2026-11-21（UTC）
- タスク: PBI-460
- PR: なし
- ブランチ: main
- 関係する ADR: [PR に投稿するレビューには判断に要る情報だけを書き、Sacty の過程の情報は Sacty の記録に残す](../adr/20261121-1603-superseded-pr-review-without-process-info.md)

## 目的

PR を読む人は Sacty を使っていないことがあるので、PR に投稿するレビューを「直すべきか・何が問題か」の情報だけにする。
観点・担当・採用しなかった指摘・落とした件数・エージェント・検証のやり方・タスクの ID などの過程の情報は、PR に書かず、Sacty の記録（`reviewRecord`）に残して、タスクの画面と `get_task` で読めるようにする。

## したこと

- 実装（コードはこの文書の直しの前に済んでいたもの）
  - レビューのエージェントに、過程の情報を本文の後の `sacty-review-record` の JSON で返させ、検査・伏せ・切り詰めをして `AgentRunCompleted` の `reviewRecord` に残す（`apps/daemon/src/review-record.ts`・`apps/daemon/src/service.ts`）。
  - 投稿する文字列（本文・行へのコメント・リスク評価）から記録のブロックを取り除き、本文の末尾を「AI がレビューしました（人間は確認していません）。」だけにした（`apps/daemon/src/prompts.ts`）。
  - 投影に回ごとの `reviewRecords` を足し、`previousReview` に前回の記録を写す（`packages/core/src/events.ts`・`packages/core/src/projection.ts`）。
  - 同じタスクの再レビューは、前回の記録が無い・見られなかった観点か止まった検証がある回を絞らない。
  - タスクの詳細に回ごとの記録を出し（`apps/web/src/components/review-records.tsx`）、`get_task` に `reviewRecords`・`previousReview.record`・`riskAssessment` を足した（`apps/daemon/src/task-mcp.ts`）。
  - 返信・工程の成果物のコメントの末尾からタスクの ID を外し、担当を起動しないレビューが続いて止まったときの知らせの理由を固定の文にした。
  - 既定のスキル `review-dispatch` の規則を、本文に書かず集約の記録で返す形に直した。
- 仕様書（日英）
  - `docs/spec/tasks-and-steps`：本文と過程の記録の項目を足し、観点の見方の 1 行・本文の最後の行の記述を消した。再レビューの絞りの条件を記録で確かめる形にし、返信と成果物のコメントの末尾を直した。
  - `docs/spec/event-log`：投影の節に、`reviewRecord` の欄・上限・形の検査・伏せてから切ること・`null` になる場合・`reviewRecords`・`previousReview.record`・投稿する文字列から取り除く規則を書いた。
  - `docs/spec/context`：既定のスキルの規則の要約（文書だけの再レビュー・絞った再レビュー・本文に書かないもの・落とした件数・取得できない文書・基準にしない指示）を、本文に書かず集約の記録で返す形にした。
  - `docs/spec/mcp-server`：`get_task` の `previousReview.record`・`reviewRecords`・`riskAssessment` を書いた。
  - `docs/spec/risk-assessment`：長いときの省略の案内を「リスク評価は長いため省略しました。」だけにした。
  - `docs/spec/approval`：指摘への対応の返信の末尾を直した。
  - `docs/spec/intake`：止まった知らせの理由の要点に、固定の文の場合を足した。
- ユーザードキュメント（日英）
  - `docs/user/intake`：PR に書かれる情報と書かれない情報、画面の「レビューの記録」の欄と `get_task` で読むこと、再レビューを絞らない条件、止まった知らせの理由を直した。英語の版に無かった「読めなかった文書」の行も足した。
  - `docs/user/tasks`：返信と成果物のコメントの末尾を直した。
  - `docs/user/mcp`：`get_task` に、レビューの記録とリスク評価の全文を足した。
- ADR：新しい ADR を足し、PBI-349 と PBI-379 の ADR を、置き換えた部分を書いて `superseded` にした（`git mv`）。名前の変更で切れた、作業履歴 2 件のリンクを直した。

## 確かめたこと

- `npx vitest run tests/docs`：4 ファイル・98 件のテストがすべて通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | — |

## 残したこと

- 「指摘への対応の返信」の末尾から指摘の ID を外すことと、`deferral-notice.ts` の「後続に回す」案の通知の末尾（`Sacty のタスク <ID> で、…`）は、後者を今回の範囲に入れていない。同じ趣旨（Sacty を使わない読み手にタスクの ID を見せない）で、別の件にするかを人が決める。
- 確かめたことは、コードのテスト・型検査・リンターを含む全件のテストの実行を、実装の説明に書いた。
