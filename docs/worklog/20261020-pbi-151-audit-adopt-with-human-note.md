# 監査の提案を、改善案に補足する・人の案に差し替えて採用できるようにする

- 日付: 2026-10-20（UTC）
- タスク: PBI-151
- PR: なし
- ブランチ: claude/sweet-davinci-m1jygz
- 関係する ADR: [監査の提案は、改善案に補足するか、人の案に差し替えて採用できる](../adr/20261020-1449-audit-adopt-with-human-note.md)

## 目的

監査の提案への判断が採用・却下の2つだけで、「原因は合っているが改善案はこちらで決めたい」「改善案は概ねよいが情報を補いたい」という
採用のパターンを残せなかった（ステークホルダー）。却下すると原因も否定した記録になり、以後の監査にもそう渡るため、採用に人の手入れを
添えられるようにする。

## したこと

- core（`packages/core/src/events.ts`・`audit.ts`・`projection.ts`・`messages.ts`）：`AUDIT_ADOPT_NOTE_KINDS`（`supplement`・`replace`）・
  `AUDIT_ADOPT_NOTE_MAX`（4,000 文字）・`AuditAdoptNote` を足し、`AuditProposalAdopted` の `note`、`AdoptAuditProposalInput` の `note`、
  判断（`AuditProposalDecision`）と投影の `decision.note`、文言のコード `input.auditNoteTooLong` を足した。
- デーモン（`apps/daemon/src/service.ts`・`audit-prompts.ts`・`ledger-audits.ts`・`audits.ts`）：`adoptAuditProposal` を非同期にし、却下の理由と
  同じく手入れの秘密情報を伏せてから記録するようにした。`createAuditFixTask` は、補足なら改善案の後に「人が足した補足：」を足し、
  差し替えなら人の案を指示にして監査の改善案を後に添える。`knownAuditCauses` が手入れを集め、深掘りの指示に「採用のときに人が手を入れた
  提案」の節を足した。画面に返す判断でも、前の記録のために手入れを形で伏せる。モックの監査も手入れを残す。
- 画面（`apps/web`）：採用のフォームに「改善案に手を入れる」（種類の選択と入力・フォーカスの移動）を足し、採用した提案には手入れを種類とともに
  出す。Server Action で種類と中身がそろっているかを確かめ、レポートにも手入れを出す。日英の文言を足した。
- テスト：`daemon.test.ts`（補足・差し替えの記録と改修のタスクの説明・秘密情報・以後の監査への渡し）、`audits.test.ts`（モックと入力の検査）、
  `audit-prompts.test.ts`、`audit-projection.test.ts`、`audit-actions.test.ts`、`audit.test.ts`（画面）、`audit.test.ts`（レポート）。
- 仕様書（`spec/audit`）・ユーザードキュメント（`user/audit`）の日英、ADR を足した。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通過。
- `npx vitest run`：2,400 件通過。`host-mcp-processes.test.ts`・`agent-sessions.test.ts`・`context-mcp.test.ts` の 8 件は、この環境
  （root で動くコンテナ）では変更の前のコミットでも同じく失敗する（プロセスと読めないファイルの扱い）。
- `npm run build`：通過。
- 実際のデーモンと画面を動かしての確認はしていない（手元に AI の認証が無い）。
