# 人が再開したら、そのタスクで失敗して使わないことにしたエージェントも忘れる

- 日付: 2026-11-21（UTC）
- タスク: PBI-437
- PR: なし
- ブランチ: なし
- 関係する ADR: [20261121-1000-resume-forgets-failed-agents.md](../adr/20261121-1000-resume-forgets-failed-agents.md)

## 目的

選んだエージェントが利用上限の間に代わりが失敗して止まったタスクを、期限の内に再開しても、代わりが試されない問題を直す。

## したこと

- `apps/daemon/src/service.ts` の `resume()`：`fallbackTried` を忘れる所で、そのタスクの `failedAgents` も忘れる。
- `apps/daemon/src/daemon-steps.test.ts`：期限の内の再開で代わりが再び実行されること、利用上限の覚えが無いときの切り替えの記録、両方が利用上限のときの `usage_limit`、ほかのタスクの覚えが残ることを確かめるテストを足した。修正を戻すと、前の 2 つが落ちる。
- 仕様・利用者向けの文書（日英）に、再開で忘れるものを書いた。

## 確かめたこと

- `npx vitest run apps/daemon/src/daemon-steps.test.ts -t 代わり`：17 件が通る。修正を戻すと 2 件が落ちる。
- 最後に `npm run lint`・`npm run typecheck`・`npx vitest run` を実行した（結果は PR の本文）。

## レビューの指摘と対応

なし。
