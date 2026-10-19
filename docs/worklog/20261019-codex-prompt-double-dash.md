# Codex に渡す指示が `-` で始まるとき、オプションとして読まれて止まるのを直す

- 日付: 2026-10-19（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/codex-cli-prompt-parsing-zv4nq6
- 関係する ADR: なし

## 目的

メモリーがある工程では、指示の先頭に `--- メモリー ---` が付く（`apps/daemon/src/service.ts` の `memoryPromptLines`）。
Codex CLI（clap）は `-` で始まる引数をオプションとして読むため、`error: unexpected argument '--- メモリー ---' found` で
止まり、指示を受け取れなかった。指示の中身にかかわらず、指示として渡す。

## したこと

- `apps/daemon/src/agents/invocation.ts` の `buildInvocation`（`codex`）で、最後の指示の前に `--` を置く
  （`codex exec [オプション] [resume <ID>] -- <指示>`）。
- `-` で始まる指示を `--` の後に置くテストを足し、コマンドの形を見るテストを直した。
- 仕様書 `docs/spec/agent-execution.md`（と英語の版）の Codex のコマンドの説明を直した。

## 確かめたこと

- Codex CLI 0.163.0 で、`codex exec --skip-git-repo-check "--- メモリー ---"` が上のエラーになり、
  `codex exec --skip-git-repo-check -- "--- メモリー ---"`・`codex exec --skip-git-repo-check resume abc -- "--- メモリー ---"` では
  引数の読み取りを通ること（その先は CODEX_HOME が無いので止まる）を手で確かめた。
- `npm run lint`・`npm run typecheck`：通過。
- `npx vitest run`：この変更の前から失敗している 8件（`host-mcp-processes`・`context-mcp`・`agent-sessions` のテスト。
  この実行環境に依るもの）を除いて通過。変更の前後で失敗は同じ 8件。
- `npx vitest run tests/docs`：通過。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

なし
