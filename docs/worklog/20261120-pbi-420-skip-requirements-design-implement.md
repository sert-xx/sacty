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

- `npm run lint`（biome）：通った。
- `npm run typecheck`：通った。
- `npx vitest run`（全件）：278 ファイルが通過（5657 件が通過、14 件はスキップ）。`tests/docs` も含む。
- 手で確かめたこと：実装の指示で集めた情報の節が 1 回だけ入ること、PR のレビューの子タスクの指示に依頼の本文が入ることは、テストで確かめた。実機のデーモンでの動作は確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 実装の指示に集めた情報と引き継ぐ PR の節が 2 回入る | `designFirst` のときは、タスクの内容の後に足さないようにした。節が 1 回だけのテストを足した |
| PR のレビューの子タスクに依頼が渡らない | `reviewReworkLines` で、親が `skip-requirements` のときに依頼（題と本文）を渡す。設計・実装の PR のレビューのテストを足した |
| 設計の判断が要るのに要求要件を残す候補に `skip-design` が入っている | `standard` だけにした（仕様書の日英も） |
| 規則を同じ段落に連結している | `SKIP_REQUIREMENTS_LINE` に分け、`PLAN_SELECTION_LINES` の次の要素に置いた。JSDoc に PBI-420 を足した |
| R-12・R-14・R-6 のテストが弱い | 子タスクの指示・`standard` を答えても選び直さないこと・`PLAN_ORDER` のテストを足した |
| 仕様書の PR の引き継ぎの列挙が古い | `skip-requirements` を日英に足した |
| `designReasonLines` の重複・文面の不揃い | 振る舞いを変えない整理なので、この PR では直していない（下の「残したこと」） |

## 残したこと

- `designReasonLines` と `keepRequirementsReasonLines` の共通化、要求要件を省いた経緯の文の 1 か所化。
- 統合レビュー・受け入れの確認の観点を `skip-requirements` のタスクで呼ぶテスト、R-8 の判定の関数を通すテスト。
