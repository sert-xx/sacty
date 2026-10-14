<!-- 対応するコード: packages/cli/src/index.ts（USAGE・main・parsePort）、packages/cli/src/context-preview.ts、apps/daemon/src/context-template.ts、apps/daemon/src/config.ts（CONFIG_TEMPLATE） -->

# CLI（sacty コマンド）

`npx sacty <コマンド>` で使う。`npx sacty --help`（`-h`）で使い方を表示する。知らないコマンドは、使い方を表示して失敗で終わる。

## sacty up

```sh
npx sacty up [--port <画面のポート>] [--daemon-port <デーモンのポート>]
```

デーモンと画面（Next.js）を起動し、`http://127.0.0.1:4700` を表示する。Ctrl+C で両方が終了する。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--port` | `4700` | 画面のポート |
| `--daemon-port` | `4710` | デーモンのポート |

- 画面とデーモンは、どちらも 127.0.0.1 だけで待ち受ける。
- ポートは 1〜65535 で、`--port` と `--daemon-port` は違う番号にする。
- 同じ `SACTY_HOME` では二重に起動できない（[はじめに](getting-started.md#データの置き場所)）。

## sacty config init

```sh
npx sacty config init [--force]
```

設定ファイル（`~/.sacty/config.yaml`。`SACTY_HOME` を変えたら `$SACTY_HOME/config.yaml`）の雛形を作る（[config.yaml の設定](config.md)）。
すでにあれば止まる。上書きする場合は `--force` を付ける。

## sacty secret set

```sh
npx sacty secret set <名前>
```

秘密情報（トークンや API キー）を macOS のキーチェーンに保存する。名前は英数字と `.`・`_`・`-` だけ。値は `security` コマンドがたずねる
（[秘密情報](secrets.md)）。

## sacty image build

```sh
npx sacty image build [<名前>...]
```

エージェント実行用のコンテナイメージを作る。名前を省くと、既定のイメージと `config.yaml` の `images` に書いたすべての言語ごとのイメージを
作る（`default` は既定のイメージ）。`images` に無い名前を指定すると、作れる名前を示して止まる。`config.yaml` に誤りがあれば、作らずに止まる
（[コンテナイメージ](images.md)）。

## sacty context init

```sh
npx sacty context init [<ディレクトリ>] [--force]
```

コンテキストリポジトリの雛形を作る。ディレクトリの既定は今のディレクトリ。雛形と同じ名前のファイル（または `rules/`）があれば止まる。
上書きする場合は `--force` を付ける（[コンテキストリポジトリ](context.md#雛形を作る)）。

## sacty context preview

```sh
npx sacty context preview <プロジェクト> [--runtime claude-code|codex] [--json] [--no-content]
```

プロジェクト（ID か名前）のコンテキストの合成の結果（実行のときに置くファイルと、層・警告など）を表示する。起動中の sacty（`sacty up`）に
問い合わせる（起動していなければ止まる）。秘密情報は参照の名前だけを表示する。ただし、層の設定の中身や `mcp.yaml` の文字列の値など、
コンテキストリポジトリに書かれた値は、そのまま表示する。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--runtime` | `claude-code` | どちらの AI の形で表示するか（`claude-code` か `codex`） |
| `--json` | なし | API の結果のまま（JSON）で出す |
| `--no-content` | なし | ファイルの中身を省く |

コンテキストに誤りがあれば、終了コード 1 で終わる。

## 環境変数

| 名前 | 内容 | 既定値 |
| --- | --- | --- |
| `SACTY_HOME` | データ（作業履歴・設定・作業領域）の置き場所 | `~/.sacty` |

## 関係するページ

- [はじめに](getting-started.md)
- [困ったとき](troubleshooting.md)
