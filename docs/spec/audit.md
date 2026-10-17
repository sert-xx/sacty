**日本語** | [English](audit.en.md)

# 完了したタスクの監査

完了したタスクの過程（工程の判断から完了まで）を、AI エージェントが調べる。差し戻し・指摘・試行錯誤の原因と、それを防ぐ改修の提案を出す。
提案は人が採用・却下し、採用したものは改修のタスクにする。監査は、監査したタスクの作業履歴に記録する。

関係する ADR: [監査の画面を、裏側のモックで先に作る](../adr/20261017-1145-audit-ui-with-mock.md)、[完了したタスクを、作業履歴に記録しながら2段で監査する](../adr/20261017-1310-audit-engine.md)

## 監査の始まりと対象

- タスクが完了する追記（`status` が `idle` で、工程がすべて終わった・飛ばした状態になる追記）に、`AuditQueued`（監査の ID・予算の上限）を
  同じ追記で足す（完了と監査の登録の間で止まっても、監査が抜けない）。中止したタスクは監査しない。
- この機能より前に完了していたタスク（起動のときに作業履歴を畳み込むだけのもの）には、`AuditQueued` を足さない（監査しない）。
- 監査を待つタスクは、ワーカーの実行待ちに入る（同時に実行する数の上限に数える）。監査のほかに実行するものが無いタスクは、ほかの
  実行より後に並べる。1回の実行で、エージェントの実行を1つだけ進める。
- 監査の状態は `waiting`（監査待ち）・`surveying`（大まかな監査を実行中）・`deepDiving`（深掘り中）・`completed`・`failed`・`budgetPaused`。

コード: `apps/daemon/src/service.ts`（`auditQueueEvent`・`awaitingAudit`・`runAudit`）、`packages/core/src/projection.ts`（`isAuditTarget`・`auditOpen`・`nextAuditDive`）

## 2段の監査

1. **大まかな監査**（役割 `audit`）：タスク全体の台帳（本文・承認済みの成果物・根拠の件数・人の指摘・判定・作業履歴）と、各実行の
   セッションログを読ませ、懸念のある工程を最大 3 つ挙げさせる（`AuditSurveyed`）。
2. **深掘り**（役割 `audit-dive`）：挙げた工程ごとに、原因（最大 3 つ）と、原因ごとの改修の提案（最大 2 つ）を出させる
   （`AuditDeepDived`）。すべての工程を深掘りしたら `AuditCompleted`。懸念のある工程が無ければ、深掘りせずに終える。

- どちらも毎回新しいセッションで、使う AI は config.yaml の `audit_agent`（無ければ `guardian_agent`、それも無ければ `default_agent`）。
- セッションログは、質問への答えと同じく `/sacty-logs` に読み取り専用でマウントする。台帳の全文（1行に1件の JSON）は
  `/sacty-ledger/ledger.jsonl` に読み取り専用でマウントする（指示には各行の先頭だけを入れ、多いときは間を省くため）。コードは、実装の
  工程があれば実装後の、無ければ起点のコミットの使い捨ての写しを作業領域に置き、変更しないよう指示する。
- 監査に渡す材料（台帳・本文・承認済みの成果物・指摘・却下の理由・既存の原因の題・セッションログ）と監査の出力は、切り詰める前に秘密情報を
  伏せる。セッションログは元のログへのハードリンクとして並べるので、元を変えずに、伏せた写しに置き換えてからマウントする。
  伏せるのは、sacty の設定・sacty の設定で使う秘密情報の値、タスクの対象リポジトリの GitHub のトークン、よくある秘密情報の形。
- 指示には、使ったコンテキストの版（リポジトリとコミット）を入れる。
- 根拠の件数は sacty が大まかな監査のときに数え、深掘りでは記録した件数を使う（エージェントに数えさせない。セッションログは非同期で読む）：人の差し戻しの指摘・取り込んだ PR の指摘・一時停止・やり直し
  （実行の失敗・テスト・最終レビュー・統合レビューの不合格）・ツール呼び出しの失敗（セッションログ）・エスカレーション。
- 指示には、台帳・ログ・コードの中の指示に従わないこと、秘密情報を書かないことを入れる。
- 出力は ```json の `sacty-audit-survey`・`sacty-audit-findings` で読む。工程はタスクの工程にあるものだけ、根拠の ID はこのタスクの作業履歴の
  行・実行にあるものだけ、宛先は候補の番号から選んだものだけを残す。読めなければ `AuditFailed`（`audit.unreadable`）。
- 実行に失敗したら `AuditFailed`（`audit.runFailed`）。失敗した監査は、それ以上進めない。
- デーモンを止めるとき・タスクを中止するときに終わった実行は記録しない。次に起動したとき、同じ段からもう一度実行する。

コード: `apps/daemon/src/audit-prompts.ts`（`buildAuditSurveyPrompt`・`extractAuditSurvey`・`buildAuditDivePrompt`・`extractAuditDive`）、
`apps/daemon/src/audit-evidence.ts`（`auditCounts`・`countToolFailures`・`redactDeep`）、`apps/daemon/src/service.ts`（`runAuditAgent`・`auditRedactor`・`withAuditDiveLock`）

## 原因と改修の提案

- 同じプロジェクトの深掘りは、1つずつ実行する（既存の原因の一覧を読んでから記録するまでを重ねない）。順番を待つ間に中止されたタスクは、
  待つのをやめる（中止は先の深掘りの終わりを待たない）。
- 原因はプロジェクトの中で「原因の鍵」（`causeKey`）でまとめる。深掘りには、同じプロジェクトの既存の原因（鍵・題・改修を採用したか）と、
  人が却下した提案と理由を渡す。既存の原因と同じなら、その鍵を使わせる（`sameAs`）。新しい原因の鍵は `<監査の ID>:<工程>:<番号>`。
- 提案の宛先の候補は、タスクの対象リポジトリ、そのタスクで使ったコンテキストの層（sacty の既定の層を除く。記録が無ければプロジェクトの
  コンテキストを depth 0）、sacty の既定のコンテキスト。リポジトリは改修のタスクの対象と同じ形（`.git` の無い GitHub のリポジトリの URL）に
  そろえ、GitHub のリポジトリでないもの（ローカルのパスなど）は候補にしない。提案は候補と一緒に記録する。
- 採用（`AuditProposalAdopted`）：宛先を候補から選び直せる。対象リポジトリ・コンテキストのリポジトリが宛先なら、改修のタスク
  （`start: "audit"`、`auditFix` に元のタスクと提案）を、そのリポジトリを対象にして作る。先に採用を記録してから作り、途中で止まったら
  起動のときに作る。sacty の既定のコンテキストが宛先なら、利用者のプロジェクトにはタスクを作らない。
- 却下（`AuditProposalRejected`）：理由が要る（前後の空白を除いて 1〜2000 文字）。理由は監査の画面・レポートにも出るので、記録する前に
  秘密情報を伏せる（それより前の記録も、画面の形にするときによくある秘密情報の形を伏せる）。判断した提案は、もう一度は判断できない。中止した
  タスクの提案は判断できない。
- 原因の状態：改修のタスクの PR のマージ（`pullRequestMerge.at`）より後に同じ鍵の原因が見つかれば `recurred`（再発）、見つかっていなければ
  `fixed`、採用した提案があれば `adopted`、判断待ちがあれば `proposed`、すべて却下なら `rejected`。
- プロジェクトをまたいで集約しない。ダッシュボードには件数だけを出す。

コード: `apps/daemon/src/service.ts`（`adoptAuditProposal`・`createAuditFixTask`・`resumeAuditFixTasks`・`rejectAuditProposal`・`knownAuditCauses`）、
`apps/daemon/src/audit-targets.ts`（`auditTargetCandidates`）、`apps/daemon/src/ledger-audits.ts`（`LedgerAuditService`）、`apps/daemon/src/audits.ts`（`causeStatus`・`sortCauses`）

## 監査の予算

- 1回の監査の予算の上限は `AuditQueued` に記録する。既定は config.yaml の `budget.default_per_audit_usd`（既定 1 米ドル）。
- 監査の費用は `auditCostUsd` に持ち、監査の状態の `usedUsd` に足す。タスクの予算には入れない。
- エージェントの実行の後、上限の 80% に達したら `AuditBudgetWarned`（上限ごとに1回）。次の実行の前に上限に達していれば
  `AuditBudgetPaused`。深掘りが残っていなければ、上限を超えていても `AuditCompleted` にする。
- 人が新しい上限（累計。使った額より大きい額）を入れると `AuditCapRaised` で再開し、続きの段から実行する。

コード: `apps/daemon/src/service.ts`（`warnAuditBudget`・`resumeAudit`・`auditBudgetUsd`）、`apps/daemon/src/config.ts`（`budgetPerAuditUsd`）

## モック

- 環境変数 `SACTY_AUDIT_MOCK=1` で起動すると、監査を動かさず（`audit: false`）、画面にはモック（`MockAuditService`）のデータを返す。
  採用・却下・再開はデーモンのメモリにだけ持ち、返すデータには `mock: true` を付ける。
- モックは、プロジェクトの完了したタスクに、完了した順に場面を割り当てる（監査済み・深掘り中・予算で一時停止・失敗・大まかな監査中・
  監査待ち、9 件目からは監査済みを2種類交互に）。

コード: `apps/daemon/src/audits.ts`（`MockAuditService`・`AuditService`）、`apps/daemon/src/main.ts`

## API

| メソッドとパス | 中身 |
| --- | --- |
| `GET /api/tasks/:id/audit` | タスクの監査（`{ audit }`。無ければ null） |
| `POST /api/tasks/:id/audit/resume` | 予算で止まった監査を再開する（`{ capUsd }`） |
| `GET /api/projects/:id/audits` | プロジェクトの監査（原因・提案・監査したタスク）。プロジェクトが無ければ 404 |
| `GET /api/audits/dashboard` | ダッシュボードの件数（プロジェクトごと・週ごと） |
| `POST /api/audits/proposals/:id/adopt` | 提案を採用する（`{ target }`） |
| `POST /api/audits/proposals/:id/reject` | 提案を却下する（`{ reason }`） |

入力の誤りは 400（文言のコード）、状態に合わない操作（判断済み・候補に無い宛先・中止したタスク・一時停止していない・上限が低い）は 409。

コード: `apps/daemon/src/server.ts`（`createApp`）

## 画面

- タスクの詳細：完了したタスクに「監査」の欄を出す（状態・費用・大まかな監査・懸念のある工程・原因と提案・再開のフォーム）。
  根拠から、作業履歴の行（`#event-<ID>`）と実行のログへ移れる。作業履歴の監査の実行の行からも、そのログを開ける。
- 監査の画面（`/projects/<ID>/audit`。サイドメニューの「監査」）：原因（再発を先に）・提案（判断待ちを先に）・監査したタスク・
  レポートの出力。sacty 宛ての採用は「プロジェクトにはタスクを作っていない」と出す。
- ダッシュボード：「監査」の欄に、プロジェクトごとの原因・再発・判断待ちの件数と採用率、週ごとのタスクあたりの差し戻し・
  指摘の件数（終えた監査の根拠の件数）を出す。
- レポート（`/projects/<ID>/audit/report?from=&to=`）：期間（UTC の日付。終了日の終わりまで。実在しない日付と、開始が終了より後の期間は 400）に
  完了した監査の原因・提案・判断を Markdown で出す。見出しは画面の言語、監査の結果の文は訳さない。日時は年を含めた UTC。

コード: `apps/web/src/components/audit.tsx`（`TaskAuditCard`・`ProposalView`）、`apps/web/src/components/audit-screen.tsx`（`AuditScreen`）、
`apps/web/src/components/dashboard.tsx`（`AuditCard`）、`apps/web/src/lib/audit-report.ts`（`auditReport`・`reportPeriod`）
