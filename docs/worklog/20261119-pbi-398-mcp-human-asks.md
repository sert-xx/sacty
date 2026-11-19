# sacty mcp の get_task に、人に確かめたいことと人の判断待ちの理由を出す

- 日付: 2026-11-19（UTC）
- タスク: PBI-398
- PR: なし
- ブランチ: なし
- 関係する ADR: [sacty mcp の人への問いかけは、読み取り側に出し、答えは既存の承認・差し戻しで行う](../adr/20261119-0600-mcp-read-human-asks-without-answer-tool.md)

## 目的

sacty が人に問いかけて待っているとき、手元の AI が MCP だけで「何を問われているか」「どう答えるか」を読めるようにする。機能を1つずつ足す流れの5回目。
ツールは足さない（10個のまま）。読み取り側（要約と `get_task`）に欄を足し、答えは既存の承認・差し戻し・PR のコメントで案内する。変更の申し出・後続に回したい案への決定は範囲外。

## したこと

- `apps/daemon/src/task-mcp.ts`：要約に `asks`（件数。0件なら無い）、`get_task` に `humanAsks`（中身・件数・答え方）と `escalation`（理由・工程・やり直す工程・書きかけの指摘の件数・開いている変更の申し出の ID・MCP でできること／画面で決めること）を足した。判定は `@sacty/core` の `humanAsks`・`openProposal`。文は1000文字で切り、件数は 20 件で省いて、省いた件数を入れる。
  `get_task`・`approve_step`・`request_changes` の説明と `INSTRUCTIONS` に足した（データとして扱う注意・答え方・成果物の「確認したいこと」は `get_deliverable`）。既存の文は消していない。
- デーモン・`@sacty/core`・画面・`packages/cli` は変えていない（新しい API の呼び出しなし）。
- 仕様書・ユーザードキュメント（日英）、ADR、この作業履歴、`CONTRIBUTING.md` のテストの表。

## 確かめたこと

- `npx vitest run --no-file-parallelism apps/daemon/src/task-mcp.test.ts`：63 件（PBI-398 の節は 17 件）が通る。本物のサービスと `createApp` で、確認つきの承認待ち（要求要件の差し戻し→対応に `confirm`）、同じ文の確認の統合、PR を作った工程（実装）の答え方、確認が無い承認待ち、承認・差し戻しの後、25 件・長い文の切り詰め、差し戻しの上限のエスカレーション（指摘の文が出ない）、変更の申し出のエスカレーション、作業履歴が増えないこと、ツール10個・注釈・説明文を確かめた。
- 全体の検査（format・lint・typecheck・テスト全件）の結果は、実装の説明に書いた。
- サービスで作れなかった状態：`undecided`（PR の指摘の取り込みとゴールガーディアンの判断が要る）は、サービスで作った承認待ちのタスクに `prRework` を足して `describeTask` で確かめた。理由が古い・記録が無い `escalated`（`unknown`）も、サービスのタスクの値を書き換えて確かめた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| `escalation` の `canDoHere`・`decideOnScreen` が理由・承認の手段と合わない | 理由と `approval.method` で分けた（PR で承認する工程は PR のマージを案内。画面の `GateNotice` と同じ分け方） |
| `change_undecidable` が返らない | 開いている申し出の判定が `undecidable` なら `change_undecidable` を返す |
| 答え方が、再現・差し戻しの上限後の承認待ちと合わない | 再現も `request_changes` で答えられると案内し、`reworkTargets`・`changeRounds`（core）で、差し戻せない・上限に達しているときは画面で決めると案内する |
| `undecided.remarkIds` の省いた件数が出ない | `omittedRemarkIds` を足した |
| 使い方の文の既存の文に句を継ぎ足した | 既存の文を元に戻し、`humanAsks`・`escalation` の注意は別の文にした |
| ユーザードキュメントが「承認だけ」と言い切っている | 承認の手段が `approve_step` のときだけと直し、`canDoHere` で確かめるよう書いた（日英） |
| 切り詰め・境界のテストが足りない | 1000/1001 文字・`undecided` の ID 20/21 件・`change_undecidable`・答え方の分岐（上限・再現）のテストを足した |

## 既定で決めたこと

- 変更の申し出のエスカレーションでは、core が `task.escalation` を作らないため、理由は `openProposal` の有無で `change_proposed` とする。工程・やり直す工程は申し出の `fromStep`・`target`。
- 上限：確認の文・理由は 1000 文字、`confirms` は 20 件、1件の指摘の ID は 20 件。
- 要約の欄は `asks`（件数）。`get_task` は `humanAsks`・`escalation`。

## 残したこと

- 答える専用のツール・MCP から PR へのコメント・変更の申し出への決定・後続に回したい案への決定・上限を超えた差し戻し・成果物の「確認したいこと」の取り出し。
