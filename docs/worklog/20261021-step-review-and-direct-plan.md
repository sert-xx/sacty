# 工程が終わるごとにオーケストレーターが要らない工程を飛ばし、要求要件・設計を省く組み合わせ direct を足す

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/amazing-feynman-m1uk9n
- 関係する ADR: [工程が終わるごとにオーケストレーターが要らない工程を飛ばし、要求要件・設計を省く組み合わせ direct を足す](../adr/20261021-1207-orchestrator-skips-steps-after-each-step.md)

## 目的

オーケストレーターは開始時に1回だけ工程を選び、その後は工程を減らせなかった。調査してはじめて単純な作業とわかるタスク（例：既にある
`isAdmin` でリンクの表示を切り替えるだけ）でも、要求要件・設計を作って承認を待ち、費用を使っていた。また、要求要件が明確でも、
要求要件を書かない実装の組み合わせが無かった。工程の完了ごとに要らない工程を飛ばせるようにし、要求要件を含まない組み合わせを足す。

## したこと

- `packages/core/src/events.ts`：組み合わせ `direct`（`investigate` → `implement` → `deployment`）、飛ばせる工程 `SKIPPABLE_STEPS`
  （`requirements`・`design`・`reproduce`）、イベント `StepsSkipped`（`after`・`steps`・`reason`・費用）を足した。
- `packages/core/src/projection.ts`：`skippableSteps` を足した。`advance` で、飛ばせる工程が残れば終わった工程を `stepReview` に持つ。
  `StepsSkipped` で工程を `skip` にし、実行対象を飛ばしたら次の工程へ進める。`stepReview` は `reopen`・`AgentRunStarted` でも消す。
  `reworkTargets` は飛ばした工程を除く。
- `packages/core/src/cost.ts`：`StepsSkipped` を予算に入れる種類に足した。`packages/core/src/messages.ts`：`orchestrator.stepReviewFailed`（日英）。
- `apps/daemon/src/service.ts`：`runNextInner` で、工程を実行する前に `reviewSteps` で見直す。オーケストレーターの実行（`runOrchestrator`）を
  使い、失敗・読めない答えなら止めずに飛ばさないで進める（sacty の記録）。テスト用に `stepReviewer` を足した（`planner` を差し替えて
  これを差し替えないときは見直さない）。
- `apps/daemon/src/prompts.ts`：`buildStepReviewPrompt`・`extractStepReview` を足した。オーケストレーターの指示に `direct` と見直しのことを
  書いた。`verificationBasis` は飛ばした工程を無いものとする。要求要件・設計を経ない実装の指示（`directImplementLines`）、要求要件を飛ばした
  設計の指示、最終レビュー・PR の本文の `REQ` をタスクの目的として扱うようにした。
- `apps/web`：作業履歴の文（`StepsSkipped`）、費用の表のオーケストレーターの行、セッションログを見られる行に足した。タスクの画面で、
  飛ばした要求要件・設計・再現の成果物を出さない。
- テスト：`projection.test.ts`（見直しの待ち・飛ばす・飛ばさない・受け付けない記録・`direct`・古い作業履歴）、`prompts.test.ts`
  （見直しの指示と答え・`direct` の実装・最終レビュー・PR の本文・設計）、`daemon.test.ts`（調査の後に要求要件・設計を飛ばして実装し
  PR まで進む、答えを読めないときに飛ばさずに進む、`direct` は見直さない）。オーケストレーターの答えを順に並べていた既存のテストに、
  見直しの答えを足した。
- docs：ADR を足した。仕様（タスクと工程・作業履歴）とユーザードキュメント（タスクを進める）を日英で直した。

## 確かめたこと

- `npm run lint`：通った（以前からの info が1件）。
- `npm run typecheck`：通った。
- `npx vitest run`：2427 件が通り、8 件が落ちた（`agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts`）。
  この 8 件は、変更を外した状態（`git stash`）でも同じく落ちるので、この作業の環境（クラウドのコンテナ）によるもので、変更とは関係ない。
- `npx vitest run tests/docs`：通った。
- 実際のエージェントでの動作（オーケストレーターが見直しで期待どおりに飛ばすか）は確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

- 版は上げていない（リリースの PR で上げる）。
- 既定のスキル `plan-steps` は、工程の選択の答えの出し方のためのもので、見直しの答えには使わせていない（指示に検査の手順を書いた）。
