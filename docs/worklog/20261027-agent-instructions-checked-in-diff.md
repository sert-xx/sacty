# スキルなどエージェント向けの指示の文書を、テストを書かずに差分で確かめる

- 日付: 2026-10-27（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-53784160-fdng3i
- 関係する ADR: [スキルなどエージェント向けの指示の文書は、テストを書かずに差分で確かめ、ふつうは direct か skip-design で進める](../adr/20261027-0020-agent-instructions-checked-in-diff.md)

## 目的

スキルを作るタスクが要求要件 → 設計 → 実装の流れになり、設計のテスト観点がエージェントの振る舞いの形で書かれ、ゴールガーディアンがテストを求めて進まないことがあった。
スキルなどエージェント向けの指示の文書を、文書として差分で確かめさせ、工程も軽くする。

## したこと

- `apps/daemon/src/prompts.ts`
  - エージェント向けの指示の文書を指す言い方 `AGENT_INSTRUCTIONS` を足した。
  - 実装の指示（`UNTESTED_LINES`）に、その文書も実行される振る舞いの無い変更として扱い、エージェントを起動して確かめるテストを書かないこと、スキルに含めるスクリプトなどはコードとして扱うことを足した。
  - 最終レビューの指示（`buildFinalReviewPrompt` の差分で確かめる申告の行）に、その文書の変更を振る舞いを変えないものとして扱い、エージェントを起動して確かめることを求めないことを足した。
  - 要求要件の指示に、その文書を書く・直すタスクの要求を文書に何が書かれているべきかで書き、受け入れの確かめ方を差分で文書の中身を確かめることとして書くことを足した（利用者の求め）。
  - 設計の指示に、その文書を書く・直す観点を、エージェントの振る舞いではなく文書に何が書かれているべきかで書くことを足した。
  - オーケストレーターの指示（`PLAN_SELECTION_LINES`）に、エージェント向けの指示をリポジトリに足す・直すタスクは、ふつう `direct` か `skip-design` にすることを足した。
- 仕様書（`docs/spec/tasks-and-steps.md`・`docs/spec/context.md` と英語の版）、ユーザードキュメント（`docs/user/tasks.md` と英語の版）に書いた。ADR を足した。

## 確かめたこと

- `npx vitest run apps/daemon/src/prompts.test.ts apps/daemon/src/daemon.test.ts`：通った。
  要求要件・設計・オーケストレーターの指示のテストを `prompts.test.ts` に、実装・最終レビューの指示の確かめを `daemon.test.ts` の既存のテスト（文書だけの観点）に足した。
- `npm run lint`・`npm run typecheck`・`npm run build`・`npx vitest run tests/docs`：通った。
- `npx vitest run`（全体）：8 件が失敗した（`agent-sessions`・`context-mcp`・`host-mcp-processes`・`question-form.browser`）。
  変更前のコミットでも同じ 8 件が失敗するので、作業した環境（コンテナ）によるもので、この変更とは関係ない。
