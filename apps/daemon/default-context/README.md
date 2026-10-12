# sacty の既定のコンテキスト

sacty に同梱するコンテキストです（PBI-24）。どのプロジェクトでも、工程エージェントに一番上位の層として渡します。
プロジェクトのコンテキストリポジトリがあれば、その下に重なり、上書きされます。

形式はコンテキストリポジトリと同じです（このファイルは渡しません）。

- `rules.md`（または `rules/*.md`）：規則。Claude Code には CLAUDE.md、Codex には AGENTS.md として渡す
- `skills/<名前>/SKILL.md`：スキル。ディレクトリを置けば、コードを変えずに既定のスキルになる
- `mcp.yaml`：MCP サーバー
- `agents/codex/config.toml`・`agents/claude/settings.json`：エージェントの設定。キーごとに重ね、下位が上書きする
- `sacty-context.yaml`：locked（下位で上書き・取り除きできない項目）。既定は一番上位なので extends は使わない

作業履歴の「コンテキストを用意」には、`sacty-default@<中身のハッシュ>` として記録します。
