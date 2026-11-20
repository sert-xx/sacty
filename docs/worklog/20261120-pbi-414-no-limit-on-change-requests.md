# 人の差し戻しの回数の上限を無くし、上限で止まったタスクを進められるようにした

- 日付: 2026-11-20（UTC）
- タスク: PBI-414
- PR: #455
- ブランチ: sacty/task-eaf687c5
- 関係する ADR: [人の差し戻しの回数の上限を無くす](../adr/20261120-0100-no-limit-on-human-change-requests.md)

## 目的

同じ工程への人の差し戻しが 3 回に達すると、次の差し戻しがエスカレーションになり、PR のコメントのやり取りだけでも止まっていた。
上限をすべての経路で無くし、以前の版で止まったタスクは、残った指摘を元の形のまま渡して、人の補足を別の欄で足して進められるようにする。

## したこと

- デーモン（`apps/daemon/src/service.ts`）：`requestChanges` から、上限でのエスカレーションと `gate.overLimit` の断りを外した。`overLimit` は常に偽で記録する。
  - エスカレーション中の差し戻しは、残った指摘（`pendingRemarks`）を元の順・元の形（文・`source`・`origin`・`fixOf`）で並べ、その後ろに人の補足（`comments`）を並べる。引き継ぐのは、エスカレーションした工程へ戻すときと、`rework_confirmation` のとき。
  - 長さ・件数の検査は、入力として受ける補足だけに当たる。残った指摘には当たらない。補足も残った指摘も無ければ `gate.remarksRequired`。
  - `settleHeldReview`（作り直しの途中の再開）も `overLimit` を偽にした。承認待ちの再開と PR の指摘の取り込み・「この PR で直す」は、`requestChanges` を通るので上限で止まらない。
- `continueOverLimit` を入力から外した。以前の版の画面・呼び出しが送っても、入力の検査が未知の項目を落とすので、断らずに無視する。
- `sacty mcp`（`task-mcp.ts`・`packages/cli/src/mcp.ts`）：`request_changes` の上限での断りと、説明・asks の案内・`get_task` の `escalation` の上限の文を直した。エスカレーション中のタスクを差し戻さない決まりは変えない。
- 画面：エスカレーション中の承認の画面で、残った指摘を 1 件ずつ元の文のまま出し、補足の欄を空で別に出す。「上限を超えて差し戻す」のボタンをやめ、差し戻しと承認（PR を作った工程は今の決まりどおり承認なし）にした。上限を前提にした文言（日英）を直し、以前の版の記録の文言（`changesTail`・`escalatedTooMany`・`gate.tooMany`）に「以前の版の記録」と分かる語を足した。
- コアの `MAX_CHANGE_REQUESTS` と `gate.overLimit` を消した。`ChangesRequested.overLimit` と `TaskEscalated` の `too_many_changes` は、過去の記録を読むために残した。`changeRounds` は承認の画面の表示が使うので残した。
- 文書：仕様書（承認と差し戻し・MCP サーバー・取り込み）とユーザードキュメント（タスク・MCP・取り込み）を日英で直し、以前の版のタスクの扱いを節か段落にまとめた。上限に触れる採用中の ADR 6 件を、新しい ADR で置き換えた（`superseded`）。
- 気づいたが直さなかったこと：画面を配る前から開いていた画面で差し戻すと、残った指摘が補足の欄に入ったまま届き、同じ文が二重になる（要求要件の「許す」の判断のとおり）。

## 確かめたこと

- `npm run lint`：通過（713 ファイル）。`npm run typecheck`：通過。`npx vitest run --no-file-parallelism`：277 ファイル・5580 件が通過（14 件はスキップ。`tests/docs` を含む）。
- 新しいテスト：`apps/daemon/src/daemon-no-change-limit.test.ts`（合成した以前の版の作業履歴で、引き継ぎ・別の工程・補足の検査・指定の無視を確かめる）、`apps/web/src/components/gate-form-submit.test.ts`（残った指摘の表示と承認のボタン）、`apps/web/src/lib/labels.test.ts`・`packages/core/src/messages.test.ts`（以前の版の記録の文言と、上限の文言が無いこと）。
- 既存のテストのうち、人の指摘で上限に当たってエスカレーションになると期待していたものは、要求要件に合わせて期待を変えた（同じ工程への 4 回目の差し戻しが `ChangesRequested` になる）。AI のレビューの指摘だけの回と `change_proposed` のテストは変えていない。
- 人が確かめること：以前の版で止まったタスクを画面で開き、残った指摘と補足の欄を見て差し戻す。その後、GitHub の PR で元のコメントに返信が付く。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 要求要件に対する AI のレビュー（引き継ぐ項目に `fixOf` が無い・承認の決まり・補足 0 件の断りなど） | 要求要件が承認済みなので、実装では `id` 以外の項目（`fixOf` を含む）を引き継ぎ、PR を作った工程は承認なし、補足も残った指摘も無ければ `gate.remarksRequired`、取り込みの仕様書も直した |
| 2 回目の AI のレビュー（ユーザードキュメント・CLI のヘルプ・コメントに残った上限の記述、案内文の引き継ぎ判定、作業履歴の欄） | 該当 5 か所と `dashboard.ts` のコメントを直し、案内文の判定を core の関数に寄せ、作業履歴の PR と結果を書いた |
