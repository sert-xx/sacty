# sacty の既定のコンテキストを同梱し、エージェントの設定ファイルも層で重ねる

- 日付: 2026-10-12（UTC）
- タスク: PBI-24
- PR: #32
- ブランチ: feat/issue-24-default-context
- 関係する ADR: [sacty に既定のコンテキストを同梱し、どのプロジェクトでも工程エージェントに一番上位の層として渡す](../adr/20261012-0118-bundled-default-context.md)、[エージェントの設定ファイル（Codex の config.toml・Claude Code の settings.json）もコンテキストの層で重ね、sacty が決める項目とファイルは層から受け付けない](../adr/20261012-0118-agent-config-layering.md)

## 目的

sacty に既定のコンテキストを同梱し、どのプロジェクトでも工程エージェントに一番上位の層として渡す。ネットワークなしで使え、秘密情報・サブエージェントなどの基本の規則を書く。コンテキストリポジトリがあれば下に重ねる。作業履歴に既定の層の版を残す。あわせて、各層のエージェントの設定ファイルを重ねて worker に置き、sacty が決める項目は sacty の値を使って作業履歴に残す。壊れた設定は理由つきで止める。

## したこと

- 既定のコンテキスト：`apps/daemon/default-context/` に `rules.md`（秘密情報を読まない・出さない、サブエージェントを起動してよい、作業の範囲など）・`README.md`・`skills/`（空）・`agents/codex/rules/sacty.rules` を置いた。
- 合成（`apps/daemon/src/context.ts`）：コンテキストリポジトリが無くても既定を渡し、あれば既定の下に重ねる（規則は既定から連結、同じ名前のスキル・MCP はプロジェクトのもの）。作業履歴の「コンテキストを用意」に `sacty-default@<中身のハッシュ>` を記録する（渡さないファイルの変更では版は変わらない）。
- 設定ファイルの重ね合わせ：各層の `agents/codex/config.toml`・`agents/claude/settings.json` をキーごとに重ね（表は合わせ、配列などは置き換え）、`CODEX_HOME/config.toml`・`CLAUDE_CONFIG_DIR/settings.json` に置く。Claude Code の `permissions.allow / deny / ask` は合わせる。
- ファイルの写し：各層の `agents/codex/`・`agents/claude/` のファイルを `CODEX_HOME`・`CLAUDE_CONFIG_DIR` に写す（同じパスは下位が上書き）。認証のファイル・sacty が作るファイル・`skills/` は写さず、警告を残す。
- sacty が決める項目（Codex の `mcp_servers`・認証と接続先・`approval_policy`・`profile(s)`、Claude Code の `apiKeyHelper`・`env` の認証と接続先と sacty の変数）は使わず、警告を残す。壊れた設定ファイルは「コンテキストを用意」の失敗として止める。
- Codex のルール：途中のコミットでは全部の層のルールを `rules/sacty.rules` にまとめていたが、最後のコミットで、ほかのファイルと同じく名前のまま写し同じ名前は下位が上書きする形にし、既定のルールのファイル名を `sacty.rules` にした。
- プロジェクトの設定のコンテキストリポジトリの説明を更新した（`apps/web/src/i18n/messages/projects.ts`）。TOML の読み書きに smol-toml を足した（`apps/daemon/package.json`）。

## 確かめたこと

- `npx vitest run`：308件すべて通った。lint・typecheck も通った。
- 既定の層を外す／設定を浅く合わせる／sacty が決める項目やファイルを通す／許可のルールを置き換える／同じ名前のファイルを上位で残す／既定の `sacty.rules` を外す、の各変更でテストが失敗することを確かめた。
- `skills/` にスキルを置けば既定のスキルとして渡ることを、テストで確かめた。
- ビルドしたアプリ（スタブの AI）で、コンテキストリポジトリの無いプロジェクトのタスクに `コンテキストを用意：sacty-default@…` が記録されることを確かめた。
- レビューで、全308件のテスト・lint・typecheck が通った。実際の Claude Code・Codex での設定の読み込みと動作、画面操作、ビルドは、レビューでは行っていない。

## レビューの指摘と対応

指摘は無かった（承認のみ。既定の規則の文案にも、修正が必須の事項は無かった）。

## 残したこと

- 実際の Claude Code・Codex で、重ねた設定ファイルが読み込まれ効くことは確かめていない。
