<!-- 対応するコード: packages/cli/src/index.ts（USAGE・main・parsePort）、scripts/cli-install.mjs、packages/cli/src/context-preview.ts、packages/cli/src/launch.ts、apps/daemon/src/local-launch.ts、apps/daemon/src/context-template.ts、apps/daemon/src/config.ts（CONFIG_TEMPLATE） -->

**日本語** | [English](cli.en.md)

# CLI（sacty コマンド）

`npx sacty <コマンド>` で使います（sacty のリポジトリの中で）。
`npm run cli:install` で入れれば、どのディレクトリでも `sacty <コマンド>` で使えます（[はじめに](getting-started.md#どのディレクトリでも-sacty-を使う)）。
`npx sacty --help`（`-h`）で使い方を、`npx sacty --version` で版を表示します。
`--help`・`--version` は、どのコマンドの後ろに付けても、そのコマンドを実行せずに使い方・版を出します（`sacty launch` の `--` の後ろに書いたものは、AI の CLI に渡します）。
知らないコマンドを指定すると、使い方を表示して失敗で終わります。

## sacty up

```sh
npx sacty up [--port <画面のポート>] [--daemon-port <デーモンのポート>]
```

デーモンと画面（Next.js）を起動し、端末に画面の入り口の URL（`http://127.0.0.1:4700/auth?token=…`）を表示します（ブラウザーは自動では開きません）。
Ctrl+C で両方が終了します。

- 止めるときは、実行中の処理の後片付け（作業履歴への記録など）を最大30秒待ちます。
  後片付けが長引くと、待っているもの（実行中のタスク・PR の確認など）を表示します。
- 待たずに止めるには、止めている途中で、もう一度 Ctrl+C を押します。
  後片付けの途中だった実行は、次の起動で中断として扱い、実行中だったタスクは一時停止になります。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--port` | `4700` | 画面のポート |
| `--daemon-port` | `4710` | デーモンのポート |

- 画面とデーモンは、どちらも 127.0.0.1 だけで待ち受けます。
- 画面は、入り口の URL を開いたブラウザーだけが使えます（工程のコンテナから操作されないように）。
  URL は起動のたびに変わり、その起動の間は別のブラウザーでも開けます。
  入っていないブラウザーで開くと、入り方だけを表示します。
- `~/.sacty/config.yaml` に `web: { auth: false }` と書くと、この認証を OFF にでき、端末に表示される `http://127.0.0.1:4700` を開くだけで使えます。
  ただし、工程のコンテナで動くコード（対象リポジトリのテスト・プロンプトインジェクション）が、画面を通して承認や設定の変更をできるようになります。
  OFF のときは、起動のたびに警告を表示します。
  - `web.auth` は `sacty up` の起動のときだけ読みます。
    書き換えたら、動いている `sacty up` を Ctrl+C で止めてから起動し直してください（起動したままでは、前の設定のままです）。
  - ON か OFF かは、起動したときの端末の表示でわかります。
    ON なら入り口の URL（`…/auth?token=…`）、OFF なら `http://127.0.0.1:4700` と警告を表示します。
- ポートは 1〜65535 で、`--port` と `--daemon-port` には違う番号を指定します。
- 同じ `SACTY_HOME` では二重に起動できません（[はじめに](getting-started.md#データの置き場所)）。

## sacty config init

```sh
npx sacty config init [--force]
```

設定ファイル（`~/.sacty/config.yaml`。`SACTY_HOME` を変えたら `$SACTY_HOME/config.yaml`）の雛形を作ります（[config.yaml の設定](config.md)）。
すでにあれば止まります。
上書きする場合は `--force` を付けてください。

## sacty secret set

```sh
npx sacty secret set <名前>
```

秘密情報（トークンや API キー）を macOS のキーチェーンに保存します（[秘密情報](secrets.md)）。
名前に使えるのは英数字と `.`・`_`・`-` だけです。
値は `security` コマンドがたずねます。

## sacty image build

```sh
npx sacty image build [<名前>...]
```

エージェント実行用のコンテナイメージを作ります（[コンテナイメージ](images.md)）。

- 名前を省くと、既定のイメージと `config.yaml` の `images` に書いたすべての言語ごとのイメージを作ります（`default` は既定のイメージです）。
- `images` に無い名前を指定すると、作れる名前を示して止まります。
- `config.yaml` に誤りがあれば、作らずに止まります。
- すべて作れたら、古い版のイメージ（`sacty-agent`・`sacty-agent-<名前>` の `X.Y.Z` のタグのもの）を、名前ごとに新しい版から2つ残して消します。7日より長く使っていないビルドキャッシュも消します。`image`・`images` に書いたイメージ、ほかのタグ・ほかの名前のイメージ、コンテナが使っているイメージは消しません。

## sacty context init

```sh
npx sacty context init [<ディレクトリ>] [--force]
```

コンテキストリポジトリの雛形を作ります（[コンテキストリポジトリ](context.md#雛形を作る)）。
ディレクトリの既定は今のディレクトリです。
雛形と同じ名前のファイル（または `rules/`）があれば止まります。
上書きする場合は `--force` を付けてください。

## sacty context preview

```sh
npx sacty context preview <プロジェクト> [--runtime claude-code|codex] [--json] [--no-content]
```

プロジェクト（ID か名前）のコンテキストを合成した結果（実行のときに置くファイルと、層・警告など）を表示します。
起動中の sacty（`sacty up`）に問い合わせます（起動していなければ止まります）。
秘密情報は参照の名前だけを表示します。
ただし、層の設定の中身や `mcp.yaml` の文字列の値など、コンテキストリポジトリに書かれた値は、そのまま表示します。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--runtime` | `claude-code` | どちらの AI の形で表示するか（`claude-code` か `codex`） |
| `--json` | なし | API の結果のまま（JSON）で出す |
| `--no-content` | なし | ファイルの中身を省く |

コンテキストに誤りがあれば、終了コード 1 で終わります。

## sacty launch

```sh
npx sacty launch <プロジェクト> [--runtime claude-code|codex] [--cwd <ディレクトリ>] [-- <AI の CLI に渡す引数>...]
```

プロジェクト（ID か名前）のコンテキスト（規則・スキル・MCP サーバー・外部 PF・エージェントの設定・段階のサブエージェント）で、手元の Claude Code か Codex を対話で起動します。
起動中の sacty（`sacty up`）に問い合わせます（起動していなければ止まります）。

- AI には、手元でログインしているアカウント（Claude Code・Codex のどちらも、キーチェーンでもファイルでも）と、手元の設定をそのまま使います。sacty の `agents` の設定と、sacty に保存した API キーは使いません。
- 作業するディレクトリは `--cwd`（既定は今のディレクトリ）です。対象リポジトリを手元に clone しておいてください。
- MCP サーバーは、プロジェクトのコンテキストのものだけを使います。手元の設定ファイルに書いた MCP サーバー（Claude Code の設定と `.mcp.json`、Codex の `config.toml` と対象リポジトリの `.codex/config.toml`）は使いません。プラグインなど、ほかの方法で入れた MCP サーバーは止めないことがあります。
  Codex では、手元の設定に同じ名前の MCP サーバーがあると、コンテキストのものを `<名前>-sacty` という名前で渡し、起動の前に `[sacty] 注意：` で知らせます（Codex は同じ名前の設定を混ぜてしまうため）。
- sacty は、権限の確認を省く設定を渡しません。Claude Code は権限の確認を求めるモード（`--permission-mode default`）、Codex は作業領域だけに書けるサンドボックスと、必要なときに承認を求める方針（`--sandbox workspace-write --ask-for-approval on-request`）で起動します。
- `--` の後の引数は、そのまま AI の CLI に渡します（例 `-- --model claude-opus-5-5`）。sacty が渡す引数と同じものを渡したときは、`--` の後のものが効きます（Claude Code は後に渡したもの、Codex の `-c` は後に渡したもの。Codex の `--sandbox`・`--ask-for-approval` は、渡したら sacty からは渡しません）。
- 作業履歴には記録しません。費用・予算も sacty では数えません。
- AI の CLI を終えると、sacty も終わり、置いた一時ファイルを消します。Ctrl+C は AI の CLI が受け取ります。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--runtime` | `claude-code` | 起動する AI（`claude-code` か `codex`） |
| `--cwd` | 今のディレクトリ | AI が作業するディレクトリ |

手元では渡せないものがあると、起動の前に `[sacty] 注意：` で表示します。

- sacty の AI の定義が Bedrock か `providers` の接続先のときは、段階のサブエージェントを渡しません（そのモデルの名前が、手元のログインでは使えないことがあるため）。
- コンテキストリポジトリの `agents/claude/` の `commands/` など、引数で渡せないファイルは渡しません。
- Codex では、規則とスキルの一覧が大きすぎて引数で渡せないとき、起動せずに止まります。

## 環境変数

| 名前 | 内容 | 既定値 |
| --- | --- | --- |
| `SACTY_HOME` | データ（作業履歴・設定・作業領域）の置き場所 | `~/.sacty` |

## 関係するページ

- [はじめに](getting-started.md)
- [困ったとき](troubleshooting.md)
