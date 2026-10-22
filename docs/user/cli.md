<!-- 対応するコード: packages/cli/src/index.ts（USAGE・main・parsePort）、packages/cli/src/context-preview.ts、apps/daemon/src/context-template.ts、apps/daemon/src/config.ts（CONFIG_TEMPLATE） -->

**日本語** | [English](cli.en.md)

# CLI（sacty コマンド）

`npx sacty <コマンド>` で使います。
`npx sacty --help`（`-h`）で使い方を表示します。
知らないコマンドを指定すると、使い方を表示して失敗で終わります。

## sacty up

```sh
npx sacty up [--port <画面のポート>] [--daemon-port <デーモンのポート>]
```

デーモンと画面（Next.js）を起動し、端末に画面の入り口の URL（`http://127.0.0.1:4700/auth?token=…`）を表示します（ブラウザーは自動では開きません）。
Ctrl+C で両方が終了します。

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

## 環境変数

| 名前 | 内容 | 既定値 |
| --- | --- | --- |
| `SACTY_HOME` | データ（作業履歴・設定・作業領域）の置き場所 | `~/.sacty` |

## 関係するページ

- [はじめに](getting-started.md)
- [困ったとき](troubleshooting.md)
