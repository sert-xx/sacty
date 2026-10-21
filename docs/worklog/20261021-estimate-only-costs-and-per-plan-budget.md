# 費用を概算だけにし、工程の組み合わせごとの予算を足す

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: なし（作った後に番号を書き足す）
- ブランチ: claude/happy-hamilton-wir01q
- 関係する ADR: [費用は概算だけを出し、工程の組み合わせごとに予算を決められるようにする](../adr/20261021-1351-estimate-only-costs-and-per-plan-budget.md)

## 目的

- ダッシュボードの「費用と予算」の「実請求」の行を消し、費用を「概算」だけで出す。sacty では実際の請求額を扱えない（直せない）ため。
- タスクごとの予算（`budget.default_per_task_usd`）に加えて、工程の組み合わせ（`STEP_PLANS`）ごとの予算を設定できるようにする。
  設定の無い組み合わせは、これまでのタスクの予算を使う。

## したこと

- 集計（`packages/core/src/dashboard.ts`）：`CostSum` をやめ、`costs.today`・`costs.days7` を `estimated` で分けない米ドルの数にした。
- 画面（`apps/web`）：費用の表を「概算」の1行（補足つき）にし、「実請求」の行と、予算に近いタスクの「概算」の印を消した。
  `BudgetRow` の `estimated` を消した。文言（日英）の `actual` を消し、`estimatedHint` を直した。
- 設定（`apps/daemon/src/config.ts`）：`budget.per_plan_usd`（`StepPlan` ごとの正の数）を足し、`SactyConfig.budgetPerPlanUsd` にした。
  `sacty config init` が書くひな形にコメントで例を足した。
- 作業履歴（`packages/core/src/events.ts`）：`StepsChosen` に `budgetCapUsd`（任意）を足した。
- 投影（`packages/core/src/projection.ts`）：`StepsChosen` の `budgetCapUsd` で予算の上限を変え、80% の通知をし直す。`BudgetCapRaised` で
  `budget.raised` を立てる。
- デーモン（`apps/daemon/src/service.ts` の `runNextInner`）：選んだ組み合わせに予算があり、人が上限を上げていなければ、`StepsChosen` に
  `budgetCapUsd` を入れる。
- テスト：`dashboard.test.ts`（core・web）・`dashboard-data.test.ts`・`projection.test.ts`・`agent-defaults.test.ts`・`daemon.test.ts`。
- 仕様書（`architecture`・`configuration`・`tasks-and-steps`）とユーザードキュメント（`dashboard`・`config`）の日英を直した。
  費用の欄を分けて出すと決めた ADR を、その部分について置き換え済みにした。

## 確かめたこと

- `npm run typecheck`：通った。
- `npx biome check .`：指摘なし。
- `npx vitest run tests/docs`：89 件通った。
- `npx vitest run apps/daemon/src/daemon.test.ts`：663 件通った。
- `npx vitest run`：9 件失敗（変更後）。うち `GET /api/dashboard` の 1 件は費用の形の変更によるもので、直して通った。残りの 8 件
  （`agent-sessions`・`context-mcp`・`host-mcp-processes`）は、変更を戻した状態でも同じく失敗する（この環境のプロセス・権限によるもの）。

## レビューの指摘と対応

（まだ無い）
