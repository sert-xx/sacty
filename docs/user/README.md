**日本語** | [English](README.en.md)

# ユーザードキュメント

sacty を使う方に向けて、インストール・設定・コマンド・画面の使い方を説明します。
はじめての方は、[はじめに](getting-started.md) から読んでください。仕組みの詳細は [仕様書](../spec/README.md) にあります。

## 目次

1. [はじめに](getting-started.md)：インストール・起動・最初のプロジェクトとタスク・データの置き場所
2. [config.yaml の設定](config.md)：項目の一覧・エージェントと認証方式・工程ごとのモデル・予算
3. [秘密情報](secrets.md)：キーチェーン・1Password・起動のときに取り出すもの
4. [プロジェクトの設定](project-settings.md)：対象・GitHub アカウント・コンテキストリポジトリの指定・エクスポート
5. [Issue・PR・チケットの取り込み](intake.md)：sacty の設定・PR のレビュー・JIRA・タスクの並行実行
6. [タスクを進める](tasks.md)：タスクの作り方・PR での承認・オーケストレーターへの質問・一時停止と中止
7. [コンテキストリポジトリ](context.md)：雛形・置くファイル・sacty-context.yaml・mcp.yaml・platforms.yaml・プレビュー
8. [ゲートウェイ](gateway.md)：AI の呼び出しの中継・providers・ホストの MCP サーバー・組織内 PF の API
9. [コンテナイメージ](images.md)：プライベートのレジストリ・言語ごとのイメージ
10. [docker compose のサービス](compose.md)：DB・モック API・共用の compose
11. [成果の書き出し](result-export.md)：Confluence・Notion などへの書き出し
12. [Slack の通知](notifications.md)：sacty の設定の送り先・メンション
13. [マージの後の監視](deployment-watch.md)：実装の後の工程。CI/CD とデプロイ後のアプリの確認・スキルの置き方・修正のタスクの自動の登録
14. [CLI](cli.md)：sacty コマンドとオプション
15. [困ったとき](troubleshooting.md)：よくある止まり方と確かめること
