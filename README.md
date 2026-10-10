# sacty

AIソフトウェアファクトリー。チケットを取り込み、オーケストレーターとゴールガーディアンが工程を進め、
人間は承認ゲートでだけ判断する。

## 必要なもの

- macOS
- Node.js 22.13以上
- Docker（Docker Desktop、OrbStack、Colima など。工程はコンテナの中で実行する）

## セットアップ

```sh
npm install
npm run build
npx sacty config init   # ~/.sacty/config.yaml を作る
npx sacty image build   # エージェント実行用のコンテナイメージを作る
```

`~/.sacty/config.yaml` で、工程を実行するAI（`default_agent`）と認証方式、単価を設定する。
単価（`price_per_mtok_usd`）は100万トークンあたりの米ドルで、利用するモデルの最新の単価に合わせる。

### 認証方式

| AI | 認証方式（`auth.mode`） | 用意するもの |
| --- | --- | --- |
| Claude Code | `subscription` | `claude setup-token` で作ったトークン |
| Claude Code | `api-key` | Anthropic APIキー |
| Claude Code | `bedrock` | BedrockのAPIキーと `region`。`model` は推論プロファイルID |
| Codex | `subscription` | ChatGPTでのログイン（`~/.codex/auth.json`） |
| Codex | `api-key` | OpenAI APIキー |
| （動作確認用） | `stub` | なし。実際のAIは呼ばない |

トークンやAPIキーは、設定ファイルには名前（`secret`）だけを書き、値はキーチェーンに保存する。

```sh
npx sacty secret set claude-oauth-token
```

値は `security` コマンドがたずねる。sactyは値をコマンドライン・台帳・ログ・画面に出さない。
コンテナには、選んだ認証方式の環境変数だけを渡す（ホストの `ANTHROPIC_API_KEY` などは引き継がない）。

サブスクリプションでは実際の請求は発生しないが、同じ単価で換算した値を費用として扱い、予算の判定に使う。

## 起動

```sh
npx sacty up
```

`sacty up` はデーモンと画面（Next.js）を起動し、`http://127.0.0.1:4700` を表示する。Ctrl+Cで両方が終了する。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--port` | 4700 | 画面のポート |
| `--daemon-port` | 4710 | デーモンのポート（127.0.0.1でのみ待ち受け） |

データ（台帳・設定・作業領域）は `~/.sacty/` に保存される。環境変数 `SACTY_HOME` で変更できる。

## 予算

1タスクあたりの予算の既定値は $1（`budget.default_per_task_usd`）。予算の80%で台帳に通知を記録し、
上限に達したら一時停止する（作業は残す）。再開するときは、累計の新しい上限を画面で入力する。

サブスクリプションの利用上限や認証エラーでも一時停止し、再開すると止まった工程を実行し直す。

## 構成

| パス | 役割 |
| --- | --- |
| `packages/core` | 台帳のイベント、イベントからタスクの状態を復元する処理、費用の計算 |
| `apps/daemon` | 常駐プロセス。台帳（SQLite、追記専用）への書き込みと、工程の実行（コンテナ）を行う |
| `apps/web` | 画面（Next.js、shadcn/ui）。操作はデーモンのAPIに依頼する |
| `packages/cli` | `sacty` コマンドと、エージェント実行用イメージのDockerfile |

## 開発

```sh
npm test          # ユニットテスト
npm run lint      # Biome（整形とリンター）
npm run typecheck # 型チェック
```
