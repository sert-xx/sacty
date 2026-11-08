# Claude Code の実行に、権限の確認を求めないモードを明示して渡す

- 日付: 2026-11-08（UTC）
- タスク: PBI-320
- PR: #326
- ブランチ: feat/issue-320-claude-permission-mode
- 関係する ADR: [Claude Code の実行に、権限の確認を求めないモードを明示して渡す](../adr/20261108-1137-claude-permission-mode.md)

## 目的

既定のイメージの Claude Code を 2.1.318 に上げてから、工程の実行が確認を求めるモード（`default`）で動き、Bash のコマンド（`npm ci`・`npm test` など）が「requires approval」で拒まれていた。
最終レビューと PR のレビューがテストを実行できなかった。モードを明示して、CLI の版に左右されないようにする。

## 見つけた経緯と原因

- 実タスクでの確認（蔵書の API に項目を足すタスク）で、最終レビューの実行のログに `permission_denials` が並び、テストを実行しないまま記録の使い回しで合格していた。
- 手元の実行のログ（init の `permissionMode` と、result の `permission_denials`）を数えた：Claude Code 2.1.296 の 172 回はすべて `auto` で拒否 0、2.1.318 の 84 回はすべて `default` で、82 回に拒否があった。切り替わりは、2.1.318 に上げた後の最初の実行から。
- sacty は `--permission-mode` を渡しておらず、CLI の既定に任せていた。両方の版で `--permission-mode` の選択肢は同じ（`acceptEdits`・`auto`・`bypassPermissions`・`manual`・`dontAsk`・`plan`）で、既定だけが変わった。

## したこと

- `claude -p` の引数に `--permission-mode bypassPermissions` を足した（`CLAUDE_PERMISSION_MODE`。`apps/daemon/src/agents/invocation.ts`）。使わせないツール（`--disallowedTools`）は今までどおり。
- 仕様（日英）の起動の引数の表を直し、ADR を足した。

## 確かめたこと

- `sacty-agent:1.18.1`・`sacty-agent-node26-playwright:1.18.1` の中で `id -u` が 1000（root ではない）。`bypassPermissions` は root では使えないので確かめた。利用者のイメージも `node` ユーザーで動く（[イメージ](../user/images.md)）。
- `npx vitest run apps/daemon/src/agents`：167 件通った。引数を足す行を外すと 3 件落ちることを確かめた。
- `npm run -s lint`・`npm run -s typecheck`・`npx vitest run tests/docs`（93 件）：通った。
- `npx vitest run --no-file-parallelism`：212 ファイル、4480 件が通った（3 件は既存のスキップ）。
- 確かめていないこと（PR のレビューの実行で確かめる）：実際のイメージと認証で、工程の実行が Bash を拒まれないこと（init の `permissionMode` が `bypassPermissions`、`permission_denials` が空）。
- 確かめていないこと：このモードで、コンテキストの `settings.json` の `permissions.deny`・`ask` がどう効くか（既定のコンテキストには Claude Code の `permissions` を置いていない）。
