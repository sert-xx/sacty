# sacty

AIソフトウェアファクトリー。チケットを取り込み、オーケストレーターとゴールガーディアンが工程を進め、
人間は承認ゲートでだけ判断する。

## 必要なもの

- macOS
- Node.js 22.13以上

## 起動

```sh
npm install
npm run build
npx sacty up
```

`sacty up` はデーモンと画面（Next.js）を起動し、`http://127.0.0.1:4700` を表示する。Ctrl+Cで両方が終了する。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--port` | 4700 | 画面のポート |
| `--daemon-port` | 4710 | デーモンのポート（127.0.0.1でのみ待ち受け） |

データ（台帳）は `~/.sacty/sacty.db` に保存される。環境変数 `SACTY_HOME` で変更できる。

## 構成

| パス | 役割 |
| --- | --- |
| `packages/core` | 台帳のイベントと、イベントからタスクの状態を復元する処理 |
| `apps/daemon` | 常駐プロセス。台帳（SQLite、追記専用）への書き込みはここだけが行う |
| `apps/web` | 画面（Next.js、shadcn/ui）。操作はデーモンのAPIに依頼する |
| `packages/cli` | `sacty` コマンド |

## 開発

```sh
npm test          # ユニットテスト
npm run lint      # Biome（整形とリンター）
npm run typecheck # 型チェック
```
