# 文書作成の工程にも、プロジェクトのコンテキスト・外部 PF・MCP・GitHub の読み取りを渡す

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/practical-cray-e9gjh7
- 関係する ADR: [文書作成の工程にも、ほかの工程と同じくプロジェクトのコンテキスト・外部 PF・MCP・GitHub の読み取りを渡す](../adr/20261022-1505-superseded-document-step-gets-context.md)

## 目的

文書作成（`document`）の工程のエージェントに、差し戻しで MCP・外部 PF・スキルを使うよう指示しても「そのようなスキルは無い」と返ってきた。
原因は、文書作成の工程だけ、コンテキスト・外部 PF・MCP・GitHub の読み取りを渡さない決まりだったこと。
利用者の依頼により、ほかの工程と同じくすべて渡し、外部 PF で情報を集められるようにする。

## したこと

- `apps/daemon/src/service.ts`
  - 工程の実行で、文書作成でもコンテキストを合成して渡すようにした（`runContext`）。
  - 文書作成でもホストの外部 PF を合わせて渡すようにした（`mergePlatforms`）。
  - 文書作成の実行にも GitHub の読み取りの中継を結びつけるようにした（`githubRelayHosts`）。
  - ゲートウェイで PF・MCP を絞る実行から文書作成を外した（絞るのは作業と書き出しだけ）。
- `apps/daemon/src/prompts.ts`：文書作成の指示を、コンテキストと外部サービスを渡していること・それらで情報を集めることに直した。
  原稿そのものは外部やリポジトリに直接書かず出力する、という指示は残した。
- テスト：文書作成に PF・MCP・コンテキスト・GitHub の読み取りが渡り、ゲートウェイで絞らないことを確かめるように、`daemon.test.ts` の
  前のテスト（渡さないことを確かめていた）を書き換えた。`prompts.test.ts` の文書作成の指示の確かめも直した。
- docs：仕様書（タスクと工程・ゲートウェイ）とユーザードキュメント（タスクを進める・ゲートウェイ）の日英を直し、ADR を足した。
  置き換えた2つの ADR のステータスと置き換え先を直し、名前を変えた ADR へのリンクを直した。

## 確かめたこと

- `npm run typecheck`：通った。
- `npm run lint`（`biome check .`）：通った。
- `npx vitest run`：今回の変更に関係するテスト（`daemon.test.ts`・`prompts.test.ts`・`tests/docs`）は通った。
  `agent-sessions.test.ts`・`context-mcp.test.ts`・`context.test.ts`・`host-mcp-processes.test.ts` の 9 件は、変更前のコードでも同じく落ちる（作業したコンテナの環境によるもの）。
- 実際のエージェント（Codex）で、文書作成の工程からスキル・MCP・外部 PF が使えることは確かめていない。

## 残したこと

- コンテキストのプレビューの既定の runtime は `claude-code` なので、Codex の工程に置くものを見るには `--runtime codex`（画面では runtime の選択）が要る。
