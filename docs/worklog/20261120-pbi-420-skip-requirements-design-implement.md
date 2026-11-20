# 受け入れ条件がそろい設計の判断が要る依頼を、設計 → 実装で進める

- 日付: 2026-11-20（UTC）
- タスク: PBI-420
- PR: なし
- ブランチ: sacty/task-（タスク ID の先頭 8 文字）
- 関係する ADR: [受け入れ条件がそろい設計の判断が要る依頼は、要求要件を省き、設計 → 実装で進める](../adr/20261120-0735-skip-requirements-for-design-decision.md)

## 目的

受け入れ条件がそろっていて設計の判断が残る依頼は、`standard` になり、要求要件の工程が受け入れ条件の言い直しになっていた（PBI-395）。要求要件を省き、設計 → 実装で進める組み合わせを足す。

## したこと

- `packages/core/src/events.ts`：組み合わせ `skip-requirements`（`design` → `implement` → `deployment`）を `STEP_PLANS` に足した。
- `apps/daemon/src/prompts.ts`：選び方の指示（`DETAILED_ACCEPTANCE_LINE`・`planDescriptions`・`PLAN_SELECTION_LINES`）、設計の指示（要求要件を省いたことと、最初の実行への `reason` の受け渡し `designReasonLines`）、実装の指示（タスクの内容を含み、依頼と承認済みの設計を基準にする）、PR の本文と提出の前のレビューの基準、`CONTINUABLE_PLANS`・`REPO_PLANS` を直した。
- 画面：選択肢（`PLAN_ORDER`）と名前（日本語「要求要件を省く」・英語「Skip requirements」）を足した。`budget.per_plan_usd` は `StepPlan` のキーなので、そのまま受ける。
- テスト：`skip-requirements-plan.test.ts`・`daemon-steps.test.ts`・`projection.test.ts`・`labels.test.ts`・`step-options.test.ts`。
- 仕様書（`tasks-and-steps`・`deployment-watch`。日英）、ユーザードキュメント（`tasks`・`config`・`deployment-watch`。日英）、ADR を直した。

## 決めたこと

- キーは `skip-requirements`、表示名は「要求要件を省く」・「Skip requirements」（人の指摘 S-2）。
- `sacty mcp` の `create_task` に組み合わせの引数は足さない（人の指摘 S-1）。
- 人が指定したタスクには、`reason` を設計に渡さず、「オーケストレーターの判断で」と書かない。
- `NEVER_LIGHT_PLANS` には入れない（`standard` も入っていない）。

## 確かめたこと

- 追加したテストと `tests/docs` を実行した（結果は PR の本文）。
