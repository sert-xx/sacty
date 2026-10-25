**日本語** | [English](README.en.md)

# ユーザードキュメント

sacty を使う方に向けて、インストール・設定・コマンド・画面の使い方を説明します。
はじめての方は、[はじめに](getting-started.md) から読んでください。
仕組みの詳細は [仕様書](../spec/README.md) にあります。

sacty の全体像は次のとおりです。

![sacty の全体像](images/overview.svg)

## 目次

1. [はじめに](getting-started.md)：インストール・起動・最初のプロジェクトとタスク・データの置き場所
2. [ダッシュボード](dashboard.md)：欄の中身・期間の数え方・空のときの表示
3. [config.yaml の設定](config.md)：項目の一覧・接続先と単価・認証方式・既定のエージェントと上書き・工程ごとのモデル・予算
4. [秘密情報](secrets.md)：キーチェーン・1Password・起動のときに取り出すもの
5. [プロジェクトの設定](project-settings.md)：対象・GitHub アカウント・コンテキストリポジトリの指定・エクスポート・削除
6. [Issue・PR・チケットの取り込み](intake.md)：Sacty の設定・PR のレビュー・JIRA・タスクの並行実行
7. [タスクを進める](tasks.md)：タスクの作り方・PR での承認・オーケストレーターへの質問・一時停止と中止
8. [コンテキストリポジトリ](context.md)：雛形・置くファイル・sacty-context.yaml・mcp.yaml・platforms.yaml・プレビュー
9. [ゲートウェイ](gateway.md)：AI の呼び出しの中継・OpenAI 互換の接続先・ホストの MCP サーバー・組織内 PF の API
10. [コンテナイメージ](images.md)：プライベートのレジストリ・言語ごとのイメージ
11. [docker compose のサービス](compose.md)：DB・モック API・共用の compose
12. [成果の書き出し](result-export.md)：Confluence・Notion などへの書き出し
13. [Slack の通知](notifications.md)：Sacty の設定の送り先・メンション
14. [マージの後の監視](deployment-watch.md)：実装の後の工程。
    CI/CD とデプロイ後のアプリの確認・スキルの置き方・修正のタスクの自動の登録
15. [CLI](cli.md)：sacty コマンドとオプション
16. [困ったとき](troubleshooting.md)：よくある止まり方と確かめること
17. [監査](audit.md)：完了したタスクの監査・改修の提案の採用と却下・監査の画面・レポート
18. [スケジュールタスク](scheduled-tasks.md)：決めた予定でタスクを作る・PC が止まっていたときの動き・編集と削除・作ったタスク
