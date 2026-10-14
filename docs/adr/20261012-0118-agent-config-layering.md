# エージェントの設定ファイル（Codex の config.toml・Claude Code の settings.json）もコンテキストの層で重ね、sacty が決める項目とファイルは層から受け付けない

- 日時: 2026-10-12 01:18 UTC
- ステータス: 採用
- 関係する PR・タスク: #32、PBI-24
- 置き換え元: なし
- 置き換え先: なし

## 背景

#13 で、コンテキストの層から規約・スキル・MCP の設定を合成して工程エージェントに渡すようにした。エージェントの設定ファイルは、層で管理できなかった。同じ PR で、既定のコンテキストを一番上位の層として同梱することにした。

## 決定

- 各層の `agents/codex/config.toml`・`agents/claude/settings.json` をキーごとに重ねる（表は合わせ、配列などは下位で置き換える）。結果を `CODEX_HOME/config.toml`・`CLAUDE_CONFIG_DIR/settings.json` に置く。
- Claude Code の `permissions.allow / deny / ask` は、置き換えずに合わせる。
- 各層の `agents/codex/`・`agents/claude/` のファイルを、worker の `CODEX_HOME`・`CLAUDE_CONFIG_DIR` に写す。同じパスは下位が上書きする。Codex のルール（`rules/*.rules`）もほかのファイルと同じく名前のまま写し、既定のルールは `rules/sacty.rules` にする。
- 認証のファイル（`auth.json`・`.credentials.json`・`.claude.json`）、sacty が作るファイル（`AGENTS.md`・`CLAUDE.md`・`mcp.json`）、`skills/` は写さず、作業履歴に警告を残す。
- sacty が決める項目は使わず、作業履歴に警告を残す。Codex は `mcp_servers`・認証と接続先（`model_provider(s)`・`forced_login_method` など）・`approval_policy`・`profile(s)`。Claude Code は `apiKeyHelper` などの認証と、`env` の認証・接続先・sacty が入れる変数（`ANTHROPIC_*`・`CLAUDE_CODE_OAUTH_TOKEN`・`SACTY_*` など）。
- 壊れた設定ファイルは、「コンテキストを用意」の失敗として理由を示して止める。
- TOML の読み書きに smol-toml を使う。

## 理由

- `permissions` を合わせるのは、既定で許可したものにプロジェクトが足せるようにするため（本文）。
- 既定のルールを `sacty.rules` にするのは、層では別の名前にすれば既定を消さずに足せ、意図せず既定を上書きする事故を減らすため（本文・コミット）。途中のコミットでは、全部の層のルールを `rules/sacty.rules` にまとめ、Codex が書き足す `default.rules` と分ける形にしていたが、最後のコミットでファイルごとに重ねる形にした。
- `mcp_servers` を使わないのは、mcp.yaml から作るため（本文）。モデルは AI の定義の model をコマンドの引数で渡すので、設定より優先される（本文）。
- ほかの項目・ファイルを sacty が決めるものにした理由は記録に無い。

## 影響

- 既定の層にも、プロジェクトの層にも、エージェントの設定ファイルとサブエージェント（`agents/`）・`commands/` などを置ける。
- 層に置いた認証や接続先の設定は効かず、警告として作業履歴に残る。
