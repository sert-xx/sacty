# オーケストレーターの工程の選び方を成果物の軸に直し、タスクの作成時に進め方を指定できるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #198
- ブランチ: claude/blissful-shannon-wyshfz
- 関係する ADR: [オーケストレーターに成果物から進め方を選ばせ、文書作成・作業のみ・設計だけをリポジトリのあるタスクでも選べるようにし、人がタスクの作成時に進め方を指定できるようにする](../adr/20261022-0955-plan-by-deliverable-and-requested-plan.md)

## 目的

手順書の作成なのに、対象リポジトリを選ぶと要求要件・設計・実装の工程が選ばれてしまう問題を直す。
オーケストレーターの選び方を柔軟にし、人がタスクの作成時に進め方（工程の組み合わせ）を選べるようにする。

## したこと

- 選べる組み合わせ：`document`・`operation`・`design-only` をリポジトリのあるタスクでも選べるようにした（`selectablePlans`・`allowedPlans`。`apps/daemon/src/prompts.ts`）。
- 選び方の指示：`PLAN_SELECTION_LINES` を、成果物 → （実装するときだけ）規模と明確さ、の順で選ばせる形に書き直した。`document`・`operation`・`design-only` の候補の説明も直した。
- 文書作成の指示：対象リポジトリがあれば、作業領域のコードの写しを根拠として読むよう伝えるようにした。
- 進め方の指定：`CreateTaskInput`・`TaskCreated` に `plan` を足し、タスクの `requestedPlan` にした（`packages/core`）。作成の時に `review` は PR のリンクがあるときだけ受け付ける（`task.reviewPlanNeedsPullRequest`）。工程の選択では指定した組み合わせだけを候補にし（`pinnedPlanLines`）、工程の見直しでは飛ばさない（`skippableSteps`）。
- 画面：タスクの作成のダイアログに「進め方」の選択（自動と各組み合わせ。選ぶと工程の並びを出す）を足し、タスクの詳細に指定した進め方を出すようにした。
- docs：仕様書（タスクと工程）・ユーザードキュメント（タスクを進める）の日英、ADR を足し、置き換えた ADR のステータスを直した。

## 確かめたこと

- `npm run typecheck`：通った。
- `npx biome check .`：通った。
- `npx vitest run`：今回の変更に関係するテスト（`prompts.test.ts`・`daemon.test.ts`・`projection.test.ts`・`actions.test.ts` など）は通った。
  `agent-sessions.test.ts`・`context-mcp.test.ts`・`context.test.ts`・`host-mcp-processes.test.ts` の 9 件は、変更前のコードでも同じく落ちる（作業したコンテナの環境によるもの）。
- `npx vitest run tests/docs`：通った。
- オーケストレーターが実際に document を選ぶかは、実モデルで確かめていない（指示の文面だけをテストで確かめた）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 再実行（中止したタスクのやり直し）で、元のタスクの指定した進め方を引き継ぐこと・選び直すこと。
- CLI からのタスクの作成は無いので、指定は画面と API（`POST /api/tasks` の `plan`）だけでできる。
