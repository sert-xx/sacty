# タスクのテンプレート「ドキュメント構築」を足す

- 日付: 2026-10-30（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/task-template-expansion-9u3okd
- 関係する ADR: [タスクのテンプレート「ドキュメント構築」で、実装からドキュメントと、それを参照・直すスキルを作る](../adr/20261030-0934-task-template-docs-setup.md)

## 目的

タスクのテンプレートを増やす。ドキュメントが足りない既存のリポジトリで、エージェントのコンテキストが足りない問題に対して、
実装からドキュメントを作り、それを参照する・直すスキルを置くテンプレートを足す。既存のドキュメントを活かすことと、
人のレビューの負担を抑えることを両立させる。

## したこと

- `packages/core/src/events.ts`：`TaskTemplate` に `docs-setup` を足した。
- `apps/daemon/src/task-templates.ts`：`docsSetupBody`（ゴール）と、題 `ドキュメント構築（<owner>/<name>）` を足した。
  スキルの名前 `DOCS_SKILLS`・状態の表記 `DOCS_STATUS` を定数にし、スキルの置き場所は `DEPLOYMENT_SKILL_PATHS` から作る。
- `apps/web`：「タスクを作成」のテンプレートの選択肢と説明、テンプレートの名前の文言（日本語・英語）を足した。
  説明の本文は2文なので、`wording-policy.test.ts` の例外に足した（「Sacty セットアップ」と同じ理由）。
- docs：仕様書 `tasks-and-steps`・ユーザードキュメント `tasks`（日本語・英語）に、テンプレートを書いた。ADR を足した。

## 確かめたこと

| 観点 | 確かめ方と結果 |
| --- | --- |
| ゴールのスキルの置き場所が、`deployment-observer` と同じ規則か | `task-templates.test.ts` に足した。原本の場所・リンクの場所・リンクをたどった先が原本になることを確かめる |
| 既存のドキュメントを書き直させない・レビューの負担を抑える指示がゴールにあるか | 同じテストで、棚卸し・状態・`（未確認）`・質問の形・最初の PR を絞ることの文があることを確かめる |
| 画面の文言の規則 | `npx vitest run apps/web/src/i18n` が通る |
| docs の規則（日本語の版と英語の版の突き合わせ・リンク） | `npx vitest run tests/docs` が通る |
| 全体 | `npm run typecheck`・`npx biome check .` が通る。`npx vitest run` は 2953 件が通り、8 件が落ちる（`host-mcp-processes`・`agent-sessions`・`context-mcp`・`question-form.browser`）。8 件は、この変更を退避した状態でも同じく落ちるので、作業した環境（コンテナ）によるもので、この変更とは関係しない |

## レビューの指摘と対応

なし
