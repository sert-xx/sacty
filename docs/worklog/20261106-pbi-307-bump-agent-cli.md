# 既定のイメージのエージェントの CLI を最新の版に上げる

- 日付: 2026-11-06（UTC）
- タスク: PBI-307
- PR: #312
- ブランチ: feat/issue-307-bump-agent-cli
- 関係する ADR: [既定のイメージに入れるもの（元のイメージ・エージェントの CLI の依存・検査の道具）を、このリポジトリに固定した値で確かめる](../adr/20261101-2210-pin-agent-image-inputs.md)

## 目的

既定のイメージの Claude Code と Codex は版を固定していて、自動では上がらない。npm の最新の版に上げる。

## したこと

- `packages/cli/docker/agent-cli/package.json` の版を変え、`npm install --package-lock-only --omit-lockfile-registry-resolved` で lockfile を作り直した。
  - Claude Code：2.1.296 → 2.1.318
  - Codex：0.160.0 → 0.167.0
- 仕様書（`docs/spec/agent-execution.md`・`.en.md`）の版を直した。
- 再開の拒否の文を新しい版の本体で確かめ直したので、`apps/daemon/src/service.ts` のコメントと、`apps/daemon/src/agents/agents.test.ts` のテストの名前の版を直した。文の判定は変えていない。

sacty の版は上げていない。既定のイメージの名前（`sacty-agent:<版>`）が変わるのは、次のリリースの PR から。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：成功。
- `npm test`：206 ファイル、4177 件成功、3 件スキップ。
- `docker build`（arm64）：成功。`claude --version` は `2.1.318 (Claude Code)`、`codex --version` は `codex-cli 0.167.0`、ユーザーは `node`。
- `docker build`（`--platform linux/amd64`、エミュレーション）：成功。`codex --version` は `codex-cli 0.167.0`。`claude --version` は qemu の上で Bun のメモリの assert で落ちる（終了コード 134）。同じ環境で 2.1.296 も同じように落ちるので、今回の更新で変わったことではない。
- sacty が渡す引数：`claude --help`・`codex exec --help` に、`apps/daemon/src/agents/invocation.ts` の引数がすべてある。
- 再開の拒否：無いセッションの再開で、Claude Code は `No conversation found with session ID: <ID>`、Codex は `no rollout found for thread id <ID>` を出し、どちらも終了コード 1。`RESUME_REJECTED` のほかの文も、本体に残っている。
- 実際の出力の読み取り：コンテナの中の偽の API（Messages API・Responses API）につないで両方の CLI を実行し、出力を `parseClaudeResult`・`parseCodexEvents` に通した。答えと使用量を読めた。
- セッションのファイル：Claude Code は `projects/<作業ディレクトリ>/<セッション>.jsonl`、Codex は `sessions/<年>/<月>/<日>/rollout-*.jsonl` で、`agent-sessions.ts` の場所と同じ。`projects`・`sessions` だけを新しい設定の場所に写しても、どちらも再開できた。

確かめられなかったこと：

- 本物のモデルにつないだ実行（偽の API で確かめた）。
- 実機の amd64 での `claude` の実行（手元が arm64 で、エミュレーションでは動かないため）。

## わかったこと

Codex は、再開した実行の `turn.completed` の usage に前の実行の分を含める。`CodexOutcomeReader` はこれをそのまま足す。Codex 0.160.0 でも同じ出力で、今回の更新で変わったことではないので、この PR では直していない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |
