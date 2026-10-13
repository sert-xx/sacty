# sacty の既定のコンテキスト

sacty に同梱するコンテキストです（PBI-24）。どのプロジェクトでも、工程エージェントに一番上位の層として渡します。
プロジェクトのコンテキストリポジトリがあれば、その下に重なり、上書きされます。

形式はコンテキストリポジトリと同じです（このファイルは渡しません）。

- `rules.md`（または `rules/*.md`）：規則。Claude Code には CLAUDE.md、Codex には AGENTS.md として渡す
- `skills/<名前>/SKILL.md`：スキル。ディレクトリを置けば、コードを変えずに既定のスキルになる。SKILL.md の無いディレクトリはグループで、`skills/<グループ>/<名前>/SKILL.md` も名前 `<名前>` のスキルになる（関連するスキルをまとめて置ける。例：`skills/review/`）
- `mcp.yaml`：MCP サーバー
- `agents/codex/`・`agents/claude/`：worker の CODEX_HOME・CLAUDE_CONFIG_DIR に写すファイル（同じパスは下位が上書き）
  - `config.toml`・`settings.json` はキーごとに重ね、下位が上書きする（Claude Code の `permissions.allow / deny / ask` は合わせる）
  - Codex のルール（`agents/codex/rules/*.rules`）も、ファイルごとに同じ名前なら下位が上書きする。既定のルールは `sacty.rules` にしてあり、層では別の名前にすれば既定を消さずに足せる
  - 認証のファイル・sacty が作るファイル（AGENTS.md・CLAUDE.md・mcp.json）・skills/ は写さない
- `sacty-context.yaml`：locked（下位で上書き・取り除きできない項目）。既定は一番上位なので extends は使わない

作業履歴の「コンテキストを用意」には、`sacty-default@<中身のハッシュ>` として記録します。
