**日本語** | [English](audit.en.md)

# 完了したタスクの監査

完了したタスクの過程（工程の判断から完了まで）を調べ、差し戻し・指摘・試行錯誤の原因と、それを防ぐ改修の提案を出す。
提案は人が採用・却下し、採用したものは改修のタスクにする。今は画面と API の形だけがあり、データはデーモンのモックが返す
（実際の監査は PBI-125 で作る）。

関係する ADR: [監査の画面を、裏側のモックで先に作る](../adr/20261017-1145-audit-ui-with-mock.md)

## 監査の対象と状態

- 監査するのは、完了したタスク（`status` が `idle` で、工程がすべて終わった・飛ばした）だけ。中止したタスクは監査しない。
- 監査の状態は `waiting`（監査待ち）・`surveying`（大まかな監査中）・`deepDiving`（深掘り中）・`completed`（監査済み）・
  `failed`（監査の失敗）・`budgetPaused`（予算で一時停止）。
- 監査は、まずタスク全体を大まかに監査し（`survey`：要約と根拠になった出来事の件数）、懸念のある工程を挙げる。挙げた工程は、
  工程ごとに別のセッションで深掘りする（`deepDives`）。
- 根拠になった出来事の種類は `changesRequested`（人の差し戻し）・`pullRequestRemark`（PR の指摘）・`pause`・`retry`・
  `toolFailure`（ツール呼び出しの失敗）・`escalation`。根拠は、作業履歴の行（`eventId`）とエージェントの実行（`runId`）に
  結び付けられる。

コード: `packages/core/src/audit.ts`（`TaskAudit`・`AuditStatus`・`AuditEvidence`）、`apps/daemon/src/audits.ts`（`isAuditTarget`）

## 原因と改修の提案

- 監査済みの監査は、原因（`findings`）ごとに改修の提案を持つ。提案には宛先がある：対象リポジトリ（`repository`）、
  コンテキストのリポジトリ（`context`。`depth` はプロジェクトのコンテキストを 0 として `extends` で上へたどった数）、
  sacty の既定のコンテキスト（`sacty`。ゴールガーディアンのプロンプトと既定のスキル）。
- 宛先の候補は、タスクの対象リポジトリ、そのタスクで使ったコンテキストの層（sacty の既定の層を除く。記録が無ければ
  プロジェクトのコンテキストを depth 0）、sacty の既定。
- 人は判断待ちの提案を採用か却下する。採用するときは宛先を候補から選び直せる。採用すると改修のタスクを作る（モックでは作った
  ことにするだけ）。却下には理由が要る（前後の空白を除いて 1〜2000 文字）。判断した提案は、もう一度は判断できない。
- 原因はプロジェクトの中でタスクをまたいでまとめる。原因の状態は、改修をマージした後にまた見つかれば `recurred`（再発）、
  見つかっていなければ `fixed`（改修済み）、採用した提案があれば `adopted`、判断待ちがあれば `proposed`、すべて却下なら
  `rejected`。
- プロジェクトをまたいで集約しない。ダッシュボードには件数だけを出す。

コード: `packages/core/src/audit.ts`（`AuditTarget`・`AdoptAuditProposalInput`・`RejectAuditProposalInput`）、
`apps/daemon/src/audits.ts`（`auditTargetCandidates`・`causeStatus`・`sortCauses`）

## 監査の予算

- 1回の監査の予算の上限は、タスクの予算とは別に持つ。既定は config.yaml の `budget.default_per_audit_usd`（既定 1 米ドル）。
- 上限に達した監査は `budgetPaused` になる。人が新しい上限（累計。使った額より大きい額）を入れて再開する。

コード: `apps/daemon/src/config.ts`（`budgetPerAuditUsd`）、`apps/daemon/src/service.ts`（`auditBudgetUsd`）、
`packages/core/src/audit.ts`（`ResumeAuditInput`）

## モック

- デーモンは、環境変数 `SACTY_AUDIT_MOCK=1` で起動したときだけモック（`MockAuditService`）を使う。既定は監査の無い実装
  （`NoAuditService`）で、タスクの監査は無く、監査の画面は空、採用・却下・再開は「無い」で断る。
- モックは、プロジェクトの完了したタスクに、完了した順に場面を割り当てる（監査済み・深掘り中・予算で一時停止・失敗・
  大まかな監査中・監査待ち、9 件目からは監査済みを2種類交互に）。最初の 3 件で原因のすべての状態が出て、9 件目で sacty の既定を宛先にした提案が出る（宛先の候補には、どのタスクにも sacty の既定がある）。
- 採用・却下・再開はデーモンのメモリにだけ持ち、起動し直すと戻る。返すデータには `mock: true` を付け、画面は「モック」の印を出す。

コード: `apps/daemon/src/audits.ts`（`MockAuditService`・`NoAuditService`・`AuditService`）、`apps/daemon/src/main.ts`

## API

| メソッドとパス | 中身 |
| --- | --- |
| `GET /api/tasks/:id/audit` | タスクの監査（`{ audit }`。無ければ null） |
| `POST /api/tasks/:id/audit/resume` | 予算で止まった監査を再開する（`{ capUsd }`） |
| `GET /api/projects/:id/audits` | プロジェクトの監査（原因・提案・監査したタスク）。プロジェクトが無ければ 404 |
| `GET /api/audits/dashboard` | ダッシュボードの件数（プロジェクトごと・週ごと） |
| `POST /api/audits/proposals/:id/adopt` | 提案を採用する（`{ target }`） |
| `POST /api/audits/proposals/:id/reject` | 提案を却下する（`{ reason }`） |

入力の誤りは 400（文言のコード）、状態に合わない操作（判断済み・候補に無い宛先・一時停止していない・上限が低い）は 409。

コード: `apps/daemon/src/server.ts`（`createApp`）

## 画面

- タスクの詳細：完了したタスクに「監査」の欄を出す（状態・費用・大まかな監査・懸念のある工程・原因と提案・再開のフォーム）。
  根拠から、作業履歴の行（`#event-<ID>`）と実行のログへ移れる。
- 監査の画面（`/projects/<ID>/audit`。サイドメニューの「監査」）：原因（再発を先に）・提案（判断待ちを先に）・監査したタスク・
  レポートの出力。
- ダッシュボード：「監査」の欄に、プロジェクトごとの原因・再発・判断待ちの件数と採用率、週ごとのタスクあたりの差し戻し・
  指摘の件数を出す。
- レポート（`/projects/<ID>/audit/report?from=&to=`）：期間（UTC の日付。終了日の終わりまで）に完了した監査の原因・提案・判断を
  Markdown で出す。見出しは画面の言語、監査の結果の文は訳さない。日時は年を含めた UTC。

コード: `apps/web/src/components/audit.tsx`（`TaskAuditCard`・`ProposalView`）、`apps/web/src/components/audit-screen.tsx`（`AuditScreen`）、
`apps/web/src/components/dashboard.tsx`（`AuditCard`）、`apps/web/src/lib/audit-report.ts`（`auditReport`・`reportPeriod`）
