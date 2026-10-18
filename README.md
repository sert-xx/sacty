**日本語** | [English](README.en.md)

# sacty

AIソフトウェアファクトリー。タスクを取り込み、オーケストレーターとゴールガーディアンが工程を進め、
人間は承認ゲートでだけ判断する。

## すぐ始める

macOS・Node.js 22.13 以上・Docker・GitHub CLI（`gh`）が要る。

```sh
npm install
npm run build
npx sacty config init   # ~/.sacty/config.yaml を作る（AI・認証方式・単価を設定する）
npx sacty secret set claude-oauth-token   # 雛形の AI（Claude Code のサブスクリプション）の、claude setup-token で作ったトークンを保存する
npx sacty image build   # エージェント実行用のコンテナイメージを作る（公開のレジストリを使えないなら、先に config.yaml の image_build を書く）
npx sacty up            # デーモンと画面を起動し、画面の入り口の URL（http://127.0.0.1:4700/auth?token=…）を端末に表示する（ブラウザーで開く）
```

詳しい手順は [はじめに](docs/user/getting-started.md) にある。

## ドキュメント

- [ユーザードキュメント](docs/user/README.md)：設定・コマンド・使い方（目次から目的のページを引ける）
- [docs の入口](docs/README.md)：仕様書・ADR・作業履歴を含む、ドキュメント全体の構成

## コントリビュート・セキュリティ

- [コントリビュートの仕方](CONTRIBUTING.md)：開発の環境・変更の流れ・PR を出す前に確かめること
- [セキュリティ](SECURITY.md)：脆弱性の報告の仕方

## ライセンス

[MIT](LICENSE)
