<!-- 対応するコード: package.json、packages/cli/src/index.ts、apps/web/src/lib/paths.ts、apps/web/src/components/dashboard.tsx、apps/web/src/components/shell/rail.tsx、apps/daemon/src/config.ts（CONFIG_TEMPLATE・resolveHome）、apps/daemon/src/instance-lock.ts -->

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

1. `npx sacty config init` で作った `~/.sacty/config.yaml` を開き、`providers` に使うツールの認証方式と、使えるモデルの単価
   （`available_models`）を設定します（[config.yaml の設定](config.md#接続先と単価providers)）。工程を実行する AI のモデルは sacty の既定を
   使うので、`agents` は書かなくてかまいません。雛形は、Codex の API キー（`providers.codex`）です。
2. 認証のトークンや API キーを、キーチェーンか 1Password に用意します（[秘密情報](secrets.md)）。雛形のままなら、
   OpenAI の API キーを `npx sacty secret set openai-api-key` で保存します。
3. エージェント実行用のコンテナイメージを `npx sacty image build` で作ります。Docker Hub や npm の公開レジストリを使えない環境では、
   作る前に `image_build` を書いてください（[コンテナイメージ](images.md)）。

## 起動する

```sh
npx sacty up
```

デーモンと画面を起動し、端末に画面の入り口の URL（`http://127.0.0.1:4700/auth?token=…`）を表示します。ブラウザーで開いてください（自動では開きません）。この URL を開いたブラウザーだけが画面を使えます。Ctrl+C で両方が終了します。ポートは `--port`・`--daemon-port`
で変えられます（[CLI](cli.md#sacty-up)）。

## 画面の構成

画面を開くと、まずダッシュボードを表示します。

| 画面 | URL | 中身 |
| --- | --- | --- |
| ダッシュボード | `/dashboard`（`/` を開いたときも） | すべてのプロジェクトをまたいで、あなたの出番・止まっているタスクの理由・終わっていないタスク・費用と予算・工程の待ち行列・取り込みの状況・流量・品質の信号を出します（[ダッシュボード](dashboard.md)）。Slack の通知を送れなかったときは、欄の上に理由を出します |
| タスクの一覧 | `/projects/<ID>/tasks` | そのプロジェクトのタスク。「タスクを作成」もここにあります |
| プロジェクトの設定 | `/projects/<ID>/settings` | そのプロジェクトの設定（[プロジェクトの設定](project-settings.md)） |
| プロジェクトの一覧 | `/projects` | プロジェクトの作成・インポート |
| タスクの詳細 | `/tasks/<ID>` | タスクの進み具合・承認・実行のログ |

- ヘッダーのプロジェクトの切り替えで「すべてのプロジェクト」を選ぶとダッシュボードに、プロジェクトを選ぶとそのプロジェクトのタスクの
  一覧に移ります。ヘッダーは、開いている画面のプロジェクト（ダッシュボードなどでは「すべてのプロジェクト」）を表示します。
- サイドメニューの「タスク」「設定」は、ヘッダーで選んでいるプロジェクトのタスクの一覧・設定を開きます。「すべてのプロジェクト」を
  選んでいる間は「タスク」を出さず、「設定」はプロジェクトの一覧を開きます。
- `/projects/<ID>` を開くと、そのプロジェクトのタスクの一覧に移ります。無いプロジェクトの ID を開くと、ページが見つからないと表示します。

## 最初のプロジェクトとタスク

1. 画面でプロジェクトを作り、「対象」（GitHub の Org かリポジトリ）と、ホストごとの「GitHub アカウント」を登録します
   （[プロジェクトの設定](project-settings.md)）。
2. 画面でタスクを作ります（[タスクを進める](tasks.md)）。Issue・PR を取り込んでタスクにするときは、
   [Issue・PR・チケットの取り込み](intake.md) を設定してください。

注意：対象に登録すると、タスクの内容によっては、sacty が対象のリポジトリにブランチをプッシュし、PR を作ります。

## sacty を更新する

sacty は、1日ごとに GitHub の sacty のリポジトリの `main` を確かめ、いま動いている版に無い変更があれば、どの画面でも上に「sacty の新しい版が
あります」と表示します。推奨のモデル（[既定のエージェント](config.md#既定のエージェント)）や修正を取り込むため、表示が出たら更新してください。

```sh
git pull origin main
npm install
npm run build
```

sacty のリポジトリで上を実行してから、動いている `sacty up` を Ctrl+C で止めて、起動し直します。

- 表示の「変更を見る」から、GitHub で変更の中身を確かめられます。
- 確かめられないとき（インターネットに出られない・手元だけのコミットがあるなど）は、何も表示しません。
- インターネットに出られない環境では、`config.yaml` に `update_check: false` と書くと、確かめを止められます（[config.yaml の設定](config.md)）。
- 既定のモデルが変わると、`available_models` に単価の無いモデルの警告が出ることがあります。そのモデルの単価を足してください。

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
