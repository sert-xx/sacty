<!-- 対応するコード: packages/core/src/projects.ts（ProjectNotification・SlackMention・DEFAULT_MENTION_KINDS）、apps/daemon/src/notifier.ts、apps/web/src/i18n/messages/projects.ts -->

**日本語** | [English](notifications.en.md)

# Slack の通知

人間の出番（承認待ち・エスカレーション・一時停止）とタスクの完了を、プロジェクトごとに Slack に通知します。画面のプロジェクトの設定の
「Slack の通知」で、送り方と言語（日本語・英語。既定は日本語）を選びます（設定しなければ通知しません）。

## 送り方

- Slack API（chat.postMessage・Slack Proxy）：送り先の URL（`https://slack.com/api/chat.postMessage` や、認証の要らない Slack Proxy）と
  チャンネルを書きます。トークンが要るなら、秘密情報の名前か 1Password の参照を書きます（Proxy なら空にします）。
  - 送り手は、名前 `Sacty`・アイコン [assets/sacty-icon.png](../../assets/sacty-icon.png)（`icon_url` で、このリポジトリの公開の画像を指す）で
    送ります。Slack のアプリのボットのトークンに `chat:write.customize` の権限が無いと、Slack はこの指定を無視し、アプリの名前とアイコンで出します。
- Incoming Webhook：Webhook の URL を、秘密情報の名前か 1Password の参照で書きます（URL そのものが秘密のため）。

## メンション（任意）

メンションする相手と、メンションする通知の種類を選びます。どちらの送り方でも効き、本文の先頭に付けます（テストの通知にも付けます）。
設定しなければメンションしません。

- 相手は ID で書きます（Slack は @表示名では届きません）。ユーザーはメンバー ID（`U…`・`W…`。Slack のプロフィールの「メンバー ID をコピー」）、
  ユーザーグループは ID（`S…`）、ほかに `@here`・`@channel` を書けます。カンマか空白で区切って、20件まで書けます。
- 本文には、それぞれ `<@U…>`・`<!subteam^S…>`・`<!here>`・`<!channel>` と書きます。
- 種類は、承認待ち・エスカレーション・一時停止・完了から選びます。既定は人の出番（承認待ち・エスカレーション・一時停止）だけで、完了は
  メンションしません。
- メンションの設定（相手と種類）は、プロジェクトのエクスポートに含めません。相手は使う人や環境ごとに違うためです。インポートした
  プロジェクトでは、プロジェクトの設定の画面で、相手と種類の両方を必要に応じて設定し直してください
  （種類は既定に戻ります。[エクスポート・インポート](project-settings.md#エクスポートインポート)）。

## 通知の中身と失敗

- 通知には、タスクと承認の窓口（PR で承認する工程は PR も）へのリンクを入れます。人間が自分で一時停止したときは通知しません。
- 送れなかったときは、タスクは止めずに、タスクの一覧の画面に理由を出します。
- プロジェクトの設定の画面の「テストの通知を送る」で、送れるかを確かめられます（保存してから送れます）。

## 関係するページ

- [プロジェクトの設定](project-settings.md)
- [秘密情報](secrets.md)
