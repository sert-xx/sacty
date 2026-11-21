# 人がドラフトを外した PR を、sacty がドラフトへ戻さない

- 日付: 2026-11-21（UTC）
- タスク: PBI-468
- PR: なし
- ブランチ: sacty/task-16c52d3b
- 関係する ADR: [人がドラフトを外した PR を、sacty がドラフトへ戻さず、sacty の外しを作業履歴に記録して見分ける](../adr/20261121-2022-do-not-redraft-pull-request-a-person-marked-ready.md)

## 目的

PBI-447 の PR #501 で、人がドラフトを外した PR を sacty が 3 秒後に戻し、マージが「まだドラフト」で失敗した。
最後のドラフトの切り替えが sacty でない PR（人が外した PR）は、sacty がドラフトへ戻さず、戻さなかったことを作業履歴に残す。履歴を読めないときは戻さない側に倒す。一時停止に伴う戻しは変えない。

## したこと

- `apps/daemon/src/github.ts`：`draftHistory`（今の draft と、ドラフトでなければ最後の切り替えを読む）を足し、`setDraft` の答えに、切り替えの要求を呼んだか・要求の前の最後の外しの ID・答えの外しの ID を足した。
- `apps/daemon/src/service.ts`：戻す経路の前に置く判定（`mayRedraft`）と、sacty の外しの記録（`noteUndraft`）・戻さなかった記録（`noteRedraftSkipped`）を足した。
  判定は、直しの提出・`redraftFor`（`settleDraft`・`undraftMarkedReady`）・`redraftAwaiting`・`markReady` の戻し・`redraftAfterRetarget` に置いた。`settlePausedDraft` は判定を通さない。
  重ねた PR の直しの提出は、判定で戻さないとき `pr.stackDraftFailed` で止めない。
- `packages/core`：`PullRequestUndraftNoted`・`PullRequestRedraftSkipped` と、PR ごとの投影（`Task.draftTrail`）。
- `apps/web`：作業履歴の 2 行の表示（日英）。
- 文書：仕様書 4 ファイル（日英）・ユーザー文書（`tasks`、日英）・ADR 1 件。
- テスト：フェイクの GitHub に切り替えの履歴を足し、判定と記録を確かめた。「人が外した PR を戻す」前提と「答えを受け取れなかった後に戻す」前提の既存のテストを、新しい決まりに合わせた。

## 確かめたこと

- `npx vitest run`（全件）・`npm run typecheck`・`npm run lint` を実行した。結果は PR の説明に書いた。
- 判定を常に「戻す」にすると、新しいテスト 19 件が落ちることを確かめた。
- 実際の GitHub で、sacty と同じアカウントでドラフトを外したとき、戻さず作業履歴に1件残ることは、人が確かめる（GitHub のタイムラインの反映の遅れは、フェイクで再現できない）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 前の版が外した PR は「決められない」として戻さない（デプロイの時点で開いている PR だけの一時的なこと）。
- 新しい記録の後は前の版へ切り戻せない（互換の層は作らない）。
