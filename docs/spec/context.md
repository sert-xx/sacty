# コンテキストの合成

工程のエージェントに渡す規則・スキル・MCP サーバー・外部 PF・エージェントの設定（コンテキスト）を、層を重ねて合成し、実行のたびに
Claude Code・Codex の設定の場所に置く。層は、sacty の既定のコンテキストと、プロジェクトに指定したコンテキストリポジトリ（と、その
継承の鎖）。

関係する ADR: なし

## 層

- 上位から：sacty の既定のコンテキスト（`apps/daemon/default-context/`。取得せずに同梱のものを読む。名前は `sacty-default`、コミットの
  代わりに中身の SHA-256 を記録する）→ コンテキストリポジトリの継承の鎖の最も上の祖先 → … → プロジェクトが指定したリポジトリ（最下位）。
- 継承：`sacty-context.yaml` の `extends` に `<URL>[#<ref>]` を書く（最後の `#` で分ける）。同じ `repo#ref` が2度出たら `context.cycle`、
  深さが `MAX_CONTEXT_DEPTH`（10）に達したら `context.tooDeep` で止める。
- プロジェクトの指定（`ContextSource`）は `repo`（git の URL かローカルのパス。500 文字まで）と `ref`（ブランチやタグ。省けば既定のブランチ）。
- 取得はキャッシュしない。合成のたびに一時ディレクトリ（`sacty-context-*`）に `git clone --depth 1 [--branch <ref>]` し、使い終わったら消す。
  git に渡す環境は `GIT_TERMINAL_PROMPT=0` とホストの `PATH`・`HOME`・`SSH_AUTH_SOCK`・`TMPDIR`・`LANG` と認証だけ。
- 認証：HTTPS の URL で、そのホストの GitHub のアカウントをプロジェクトで選んでいるか、プロジェクトの対象に同じホストがあれば、gh の
  トークンを `http.https://<ホスト>/.extraheader` の設定（環境変数 `GIT_CONFIG_*`）で渡す。アカウントが要るのに選んでいなければ止める
  （`github.accountRequired`）。SSH・ローカルのパス・ほかのサーバーは、ホストの git の認証を使う。トークンは誤りの文から伏せる。

コード: `apps/daemon/src/context.ts`（`loadLayers`・`loadDefaultContext`・`resolveContext`・`parseExtends`・`GitContextFetcher`・`MAX_CONTEXT_DEPTH`・`DEFAULT_CONTEXT_REPO`）、`apps/daemon/src/service.ts`（`gitAuth`・`githubToken`）、`apps/daemon/src/gh.ts`（`gitAuthEnv`）、`packages/core/src/projects.ts`（`ContextSource`）

## コンテキストリポジトリのファイル

読むのは `sacty-context.yaml`・`mcp.yaml`・`platforms.yaml`・`rules.md`・`rules/`・`skills/`・`agents/` だけ（`README.md` は読まない）。
これらの中に通常のファイル・ディレクトリでないもの（シンボリックリンクなど）があれば止める（`context.notPlainFile`）。YAML が無ければ
既定値、読めなければ `context.fileUnreadable`、形が違えば `context.fileInvalid`（どの層のどのファイルのどの項目か）で止める。

| ファイル | 中身 |
| --- | --- |
| `rules.md` か `rules/*.md` | 規則。`rules.md` があればそれだけ、無ければ `rules/` の直下の `*.md` を名前の順に連結する。層ごとに `<!-- sacty context: <層> -->` を付けて上位から連結する |
| `skills/` | `SKILL.md` のあるディレクトリが1つのスキル（名前はディレクトリ名）。無いディレクトリはグループとして中を探す。同じ層で名前が重なれば先のものを使い警告する |
| `mcp.yaml` | `servers.<名前>`（`^[A-Za-z0-9_-]+$`）。コマンド型（`command`・`args`・`env`）か URL 型（`url`・`headers`・`via_gateway`（既定 `true`））。共通で `startup_timeout_sec`（1〜3600）・`tool_timeout_sec`（1〜86400）。値は文字列か `{ secret, prefix }`。文字列に `${` は書けない |
| `platforms.yaml` | `platforms.<名前>`。項目は `gateway.platforms` と同じ（[ゲートウェイ](gateway.md)） |
| `sacty-context.yaml` | `extends`、`locked`・`remove`（それぞれ `skills`・`mcp`・`platforms` の名前の一覧） |
| `agents/codex/config.toml`・`agents/claude/settings.json` | エージェントの設定。`agents/codex/`・`agents/claude/` の下のほかのファイルはパスごとに写す |

コード: `apps/daemon/src/context.ts`（`CONTEXT_ENTRIES`・`assertPlainEntries`・`readYaml`・`layerRules`・`layerSkills`・`McpFile`・`McpServer`・`McpValue`・`PlatformsFile`・`ContextManifest`・`AGENT_SETTINGS_FILES`）

## 合成の規則

- スキル・MCP・PF は、名前ごとに、層を上位から順に処理する。1つの層では、(1) その層の `remove` を処理し（上位が `locked` なら残して
  警告 `context.lockedRemove`）、(2) その層の項目を入れ（同じ名前は下位が上書き。`locked` の名前なら上位のものを残して警告
  `context.lockedOverride`）、(3) その層の `locked` を登録する。
- エージェントの設定は、表はキーごとに重ね、それ以外（配列を含む）は下位の値で置き換える。Claude の `permissions.allow`・`deny`・`ask`
  だけは重複を除いて合わせる。
- sacty が決める項目（Codex の `mcp_servers`・`model_provider`・`model_providers`・`approval_policy`・`sandbox_mode`・`profile` など、
  Claude の `apiKeyHelper` など、Claude の `env` の認証・接続先・設定の場所の変数と `SACTY_` で始まる名前）は使わずに警告する
  （`context.reservedSetting`）。`agents/` の下の `auth.json`・`AGENTS.md`・`CLAUDE.md`・`.credentials.json`・`.claude.json`・`mcp.json`・
  `skills` も写さずに警告する。
- ホストの MCP サーバー（`gateway.mcp_servers`）を足す。層の MCP と同じ名前なら、ホストのものを使い警告する（`context.hostMcpOverride`）。
- PF は、ホストの `gateway.platforms` と合わせる。同じ名前ならホストのものを使い警告する（`context.hostPlatform`）。
- 警告は工程を止めない。合成の結果（層・警告・PF の要約）は、工程の実行ごとに `ContextResolved` に記録する。取得の失敗と形の誤りは、
  実行の失敗にして一時停止する。

コード: `apps/daemon/src/context.ts`（`composeContext`・`mergeNamed`・`mergeSettings`・`RESERVED_SETTINGS`・`RESERVED_FILES`・`routeMcp`）、`apps/daemon/src/platforms.ts`（`mergePlatforms`）、`apps/daemon/src/service.ts`（`runContext`）

## 実行のときに置くファイル

設定の場所（Claude Code は `/tmp/sacty-claude-config`、Codex は `/.codex`）に、層のエージェントのファイル → スキル（`skills/<名前>/…`）→
sacty が作るファイルの順に置く（同じパスは後のものが上書き）。

| runtime | sacty が作るファイル |
| --- | --- |
| Claude Code | `CLAUDE.md`（規則）、`settings.json`（合成した設定）、`mcp.json`（`{ "mcpServers": … }`。コマンド型は `command`・`args`・`env`、URL 型は `type: "http"`・`url`・`headers`） |
| Codex | `AGENTS.md`（規則と、スキルの一覧 `- <名前>：<description>（<場所>）`）、`config.toml`（合成した設定と `[mcp_servers."<名前>"]`。URL 型は `url`・`http_headers`・`env_http_headers`） |

- MCP の秘密情報は、ファイルには `SACTY_MCP_SECRET_<番号>` の環境変数として書き、値はコンテナの環境変数で渡す（ホストで取り出す）。
- コマンド型の MCP サーバーは、コンテナの中で起動する。ホストで動かすのは `gateway.mcp_servers` のものだけ（[ゲートウェイ](gateway.md)）。
- URL 型の MCP サーバーは、`via_gateway` が `true`（既定）なら、ゲートウェイ経由に置き換える：エージェントには
  `http://host.docker.internal:<ポート>/ctx-mcp/<名前>` と、実行ごとのトークンの `Authorization` だけを渡し、元の URL とヘッダーは
  ゲートウェイが持つ（ヘッダーの秘密情報はホストで取り出す）。`via_gateway: false` なら、コンテナから直接つなぎ、秘密情報の値を
  環境変数でコンテナに渡す。
- MCP の時間切れ：Codex は `config.toml` に同じ名前で書く。Claude Code は、`tool_timeout_sec` をサーバーごとの `timeout`（ミリ秒）にし、
  `startup_timeout_sec` をどれかに書いたときだけ、全体の環境変数 `MCP_TIMEOUT` を、各サーバーの値（書いていないサーバーは 30 秒）の
  最大にする。どれかが実行全体の上限（30分）以上なら警告する（`context.mcpTimeoutOverRun`）。

コード: `apps/daemon/src/context.ts`（`planContext`・`codexServer`・`timeoutWarnings`・`CLAUDE_MCP_CONFIG`・`CLAUDE_MCP_STARTUP_DEFAULT_SEC`・`GATEWAY_TOKEN_SECRET`）、`apps/daemon/src/service.ts`（`contextContainerDir`・`mcpRouting`）

## 雛形（sacty context init）

`README.md`・`rules.md`・`skills/README.md`・`mcp.yaml`・`platforms.yaml`・`sacty-context.yaml`・`agents/codex/config.toml` を作る（中身は説明の
コメントだけで、既定のコンテキストを変えない）。同じパスか `rules` があれば、`--force` が無い限り何も書かずに止まる。途中のディレクトリが
ディレクトリでなければ `--force` でも止まる。

コード: `apps/daemon/src/context-template.ts`（`CONTEXT_TEMPLATE_FILES`・`initContextRepo`）

## プレビュー

- `GET /api/projects/:id/context-preview?runtime=`（保存した設定）と `POST /api/projects/:id/context-preview`（`{ runtime, definition? }`。
  編集中の設定）。`runtime` の既定は `claude-code`。実行と同じ合成を行うが、ファイルは書かず、作業履歴にも残さない。取得・設定の誤りは
  200 で `{ error }` を返す。
- 結果は、層・置くファイル（1ファイル 256KB、合計 8MB まで。バイナリは中身を出さない）・MCP（どこにつなぐか：`direct`・`gateway`・`host`）・
  スキル・規則・効果（`locked`・`remove`）・秘密情報の参照・環境変数・使える PF の要約・警告。秘密情報は参照の名前だけを出す。
- `sacty context preview <プロジェクト>`：`SACTY_HOME/daemon.json` の接続先に問い合わせる。プロジェクトは ID か名前。`--runtime`
  （`claude-code`｜`codex`）・`--json`（API の結果のまま）・`--no-content`（ファイルの中身を省く）。誤りなら終了コード 1。
- プロジェクトを保存するときも、コンテキストを指定していれば同じ合成を試し、誤りを返す（保存はする）。

コード: `apps/daemon/src/server.ts`（`PreviewRequest`）、`apps/daemon/src/service.ts`（`projectContextPreview`・`checkProjectContext`・`ContextPreviewView`）、`apps/daemon/src/context.ts`（`previewContext`・`ContextPreview`・`PREVIEW_FILE_MAX_BYTES`・`PREVIEW_TOTAL_MAX_BYTES`）、`packages/cli/src/context-preview.ts`（`fetchContextPreview`・`previewOutput`）
