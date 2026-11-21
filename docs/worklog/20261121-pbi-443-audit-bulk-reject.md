# 監査の画面で、たまった提案を原因ごとに束ねて上位から出し、まとめて却下できるようにする

- 日付: 2026-11-21（UTC）
- タスク: PBI-443
- PR: なし
- ブランチ: sacty/task-pbi-443
- 関係する ADR: [監査の提案は、原因ごとに束ねて上位から出し、複数を選んでまとめて却下できる。まとめての却下は記録の欄 `bulk` で残す](../adr/20261121-1400-audit-bulk-reject.md)

## 目的

監査の画面を開いたら、効きそうな原因から順に、数分で数件を判断できるようにする。要らない提案を、まとめて片付けられるようにする。

## したこと

- 画面：原因の節と提案の節を 1 つにし、原因を畳んだ行で上位 20 件から出す（`audit-causes.tsx`・`audit-view.ts`）。絞り込みと出す件数は URL（`?causes=`・`?shown=`）に残し、区切りはページのサーバーの側で行う。
- まとめて却下：提案の選択・確認のダイアログ・結果の表示を足した。サーバーアクション `rejectAuditProposalsAction` が形・件数・重複・理由の長さを確かめてから、受け口を呼ぶ。
- core：`AuditProposalRejected` と提案の判断（`rejected`）に、省略できる `bulk`（`{ id, count }`）を足した。
- デーモン：`POST /api/audits/proposals/reject`（`rejectAuditProposals`）、モック（`MockAuditService.rejectMany`）、以後の監査に渡す「却下された提案と理由」を、まとめての却下は操作ごとに 1 行にした（`bulkRejectedTitle`）。
- 作業履歴の行と、提案の表示に「まとめて却下（全 N 件）の 1 件」を足した。
- 文書：`docs/spec/audit(.en).md`・`docs/user/audit(.en).md`・`docs/user/introduction(.en).md`・ADR・スクリーンショット。

## 確かめたこと

- 画面（`audit-causes.test.ts`・`audit-view.test.ts`・`audit-actions.test.ts`）、デーモン（`daemon-audit-bulk.test.ts`・`audits.test.ts`）、core（`audit-projection.test.ts`）のテストを足した。
- 原因 300 件・提案 2,000 件の画面の初回の描画（サーバーでの描画。区切りを含む）は約 8 ms で、ボタンは 25 個（提案 200 件のデータと同じ）。まとめて却下 2,000 件（元のタスク 50 件）の受け口は約 180 ms。
- 幅 375px・明暗・日英で、横にはみ出さないことを実際のブラウザーで確かめた。
