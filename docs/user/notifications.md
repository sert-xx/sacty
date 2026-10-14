<!-- 対応するコード: packages/core/src/projects.ts（ProjectNotification・SlackMention・DEFAULT_MENTION_KINDS）、apps/daemon/src/notifier.ts、apps/web/src/i18n/messages/projects.ts -->

# Slack の通知

人間の出番（承認待ち・エスカレーション・一時停止）とタスクの完了を、プロジェクトごとに Slack に通知する。画面のプロジェクトの設定の
「Slack の通知」で、送り方と言語（日本語・英語。既定は日本語）を選ぶ（設定しなければ通知しない）。

## 送り方

- Slack API（chat.postMessage・Slack Proxy）：送り先の URL（`https://slack.com/api/chat.postMessage` や、認証の要らない Slack Proxy）と
  チャンネル。トークンが要るなら、秘密情報の名前か 1Password の参照を書く（Proxy なら空）。
  - 送り手は、名前 `Sacty`・アイコン [assets/sacty-icon.png](../../assets/sacty-icon.png)（`icon_url` で、このリポジトリの公開の画像を指す）で
    送る。Slack のアプリのボットのトークンに `chat:write.customize` の権限が無いと、Slack はこの指定を無視し、アプリの名前とアイコンで出す。
- Incoming Webhook：Webhook の URL を、秘密情報の名前か 1Password の参照で書く（URL そのものが秘密のため）。

## メンション（任意）

メンションする相手と、メンションする通知の種類を選ぶ。どちらの送り方でも効き、本文の先頭に付ける（テストの通知にも付ける）。
設定しなければメンションしない。

- 相手は ID で書く（Slack は @表示名では届かない）。ユーザーはメンバー ID（`U…`・`W…`。Slack のプロフィールの「メンバー ID をコピー」）、
  ユーザーグループは ID（`S…`）、ほかに `@here`・`@channel`。カンマか空白で区切って、20件まで書ける。
- 本文には、それぞれ `<@U…>`・`<!subteam^S…>`・`<!here>`・`<!channel>` と書く。
- 種類は、承認待ち・エスカレーション・一時停止・完了から選ぶ。既定は人の出番（承認待ち・エスカレーション・一時停止）だけで、完了は
  メンションしない。
- メンションの設定は、プロジェクトのエクスポート・インポートにも含める（ID は秘密情報ではない）。

## 通知の中身と失敗

- 通知には、タスクと承認の窓口（成果物チェックは PR も）へのリンクを入れる。人間が自分で一時停止したときは通知しない。
- 送れなかったときは、タスクは止めずに、タスクの一覧の画面に理由を出す。
- プロジェクトの設定の画面の「テストの通知を送る」で、送れるかを確かめられる（保存してから送れる）。

## 関係するページ

- [プロジェクトの設定](project-settings.md)
- [秘密情報](secrets.md)
