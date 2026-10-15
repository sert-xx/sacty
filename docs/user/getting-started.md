<!-- 対応するコード: package.json、packages/cli/src/index.ts、apps/daemon/src/config.ts（CONFIG_TEMPLATE・resolveHome）、apps/daemon/src/instance-lock.ts -->

**日本語** | [English](getting-started.en.md)

# はじめに

sacty をインストールし、起動して、最初のタスクを動かすまでの手順を説明します。

## 必要なもの

- macOS
- Node.js 22.13 以上
- Docker（Docker Desktop・OrbStack・Colima など。工程はコンテナの中で実行します）
- GitHub CLI（`gh`）。GitHub にアクセスするアカウントでログインしておいてください（[プロジェクトの設定](project-settings.md#github-アカウント)）

## セットアップ

```sh
npm install
npm run build
npx sacty config init   # ~/.sacty/config.yaml を作る
```

1. `npx sacty config init` で作った `~/.sacty/config.yaml` を開き、工程を実行する AI（`default_agent` と `agents`）・認証方式・単価を
   設定します（[config.yaml の設定](config.md)）。雛形の `default_agent` は、Claude Code のサブスクリプション（`claude-subscription`）です。
2. 認証のトークンや API キーを、キーチェーンか 1Password に用意します（[秘密情報](secrets.md)）。雛形のままなら、
   `claude setup-token` で作ったトークンを `npx sacty secret set claude-oauth-token` で保存します。
3. エージェント実行用のコンテナイメージを `npx sacty image build` で作ります。Docker Hub や npm の公開レジストリを使えない環境では、
   作る前に `image_build` を書いてください（[コンテナイメージ](images.md)）。

## 起動する

```sh
npx sacty up
```

デーモンと画面を起動し、端末に `http://127.0.0.1:4700` を表示します。ブラウザーで開いてください（自動では開きません）。Ctrl+C で両方が終了します。ポートは `--port`・`--daemon-port`
で変えられます（[CLI](cli.md#sacty-up)）。

## 最初のプロジェクトとタスク

1. 画面でプロジェクトを作り、「対象」（GitHub の Org かリポジトリ）と、ホストごとの「GitHub アカウント」を登録します
   （[プロジェクトの設定](project-settings.md)）。
2. 画面でタスクを作ります（[タスクを進める](tasks.md)）。Issue・PR を取り込んでタスクにするときは、
   [Issue・PR・チケットの取り込み](intake.md) を設定してください。

注意：対象に登録すると、タスクの内容によっては、sacty が対象のリポジトリにブランチをプッシュし、PR を作ります。

## データの置き場所

- 作業履歴・設定・作業領域は `~/.sacty/` に保存します。環境変数 `SACTY_HOME` で変えられます。
- 同じ `SACTY_HOME` では、sacty を二重に起動できません（ポートを変えても同じです）。2つ目の `sacty up` は、データに触れる前に、
  動いているデーモンの接続先と PID を表示して失敗で終わります。判定は `SACTY_HOME/daemon.lock` の OS のファイルロックで行うので、
  前のデーモンが突然落ちても（SIGKILL など）、次の起動は妨げられません。
- 違う `SACTY_HOME` なら、ポートを変えて並行して動かせます。

## 開発するとき

```sh
npm test          # ユニットテスト
npm run lint      # Biome（整形とリンター）
npm run typecheck # 型チェック
npm run build     # ビルド
```

| パス | 役割 |
| --- | --- |
| `packages/core` | 作業履歴のイベント、イベントからタスクの状態を復元する処理、費用の計算 |
| `apps/daemon` | 常駐プロセス。作業履歴（SQLite、追記専用）への書き込みと、工程の実行（コンテナ）を行います |
| `apps/web` | 画面（Next.js、shadcn/ui）。操作はデーモンの API に依頼します |
| `packages/cli` | `sacty` コマンドと、エージェント実行用イメージの Dockerfile |

仕組みの詳細は [仕様書](../spec/README.md) にあります。

## 関係するページ

- [config.yaml の設定](config.md)
- [CLI](cli.md)
- [困ったとき](troubleshooting.md)
