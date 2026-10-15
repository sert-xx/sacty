**日本語** | [English](notifications.en.md)

# 通知

人間の出番（承認待ち・エスカレーション・一時停止）とタスクの完了を、プロジェクトごとの Slack の送り先に通知する。送れなくてもタスクは
止めない。

関係する ADR: [プロジェクトのエクスポートに Slack のメンション（相手と種類）を含めず、含んでいた版 3 のファイルは理由を示して断る](../adr/20261015-0850-export-without-mentions.md)

## いつ通知するか

作業履歴に追記するたびに、追記の前と後のタスクを比べて決める（送るのを待たない）。

| 種類 | 条件 |
| --- | --- |
| `escalation` | `escalated` になった |
| `approval` | `awaiting_approval` になった、または承認待ちの工程か提出の回が変わった |
| `paused` | `paused` になった（理由が `manual`、つまり人が止めたときは通知しない） |
| `completed` | 完了した |

コード: `apps/daemon/src/notifier.ts`（`notificationFor`）、`apps/daemon/src/service.ts`（`append`）、`packages/core/src/projects.ts`（`NotificationKind`）

## 送り先

プロジェクトの `notification`。`language`（`ja`｜`en`。既定 `ja`）と `mention`（任意）を持つ。

- Slack API の形（`slack-api`）：`url`（`chat.postMessage` や Slack Proxy）・`channel`・`token`（任意。秘密情報の参照）。
  `{ channel, username: "Sacty", icon_url, text, unfurl_links: false, unfurl_media: false }` を POST する（トークンがあれば `Authorization: Bearer`）。
  アイコンは `https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png`。200 でも `{"ok": false}` なら失敗。
- Incoming Webhook（`slack-webhook`）：`webhook`（URL そのものが秘密なので、秘密情報の参照で書く）。`{ text }` を POST する。
- どちらも15秒で打ち切る。

コード: `apps/daemon/src/notifier.ts`（`SlackNotifier.send`・`SLACK_USERNAME`・`SLACK_ICON_URL`）、`packages/core/src/projects.ts`（`ProjectNotification`）

## 本文とメンション

- 本文（Slack の mrkdwn）には、タスクへのリンク（`SACTY_WEB_URL`、既定 `http://127.0.0.1:4700` の `/tasks/<ID>`）と、承認・判断の窓口
  （`/tasks/<ID>/review`）を入れる。承認待ちで PR があれば、PR へのリンクと「マージで承認」を添える。一時停止は理由と詳しい文（300 文字まで）を入れる。
- メンションの相手（`targets`、1〜20件）は `U…`・`W…`（ユーザー）・`S…`（ユーザーグループ）・`@here`・`@channel`。本文の先頭に、
  それぞれ `<@U…>`・`<!subteam^S…>`・`<!here>`・`<!channel>` で付ける。メンションする種類（`kinds`）の既定は `approval`・`escalation`・
  `paused`（完了はしない）。
- メンション（`targets`・`kinds`）は、プロジェクトのエクスポートに含めない（[書き出し](export.md)）。インポートしたプロジェクトでは、設定し直す。

コード: `apps/daemon/src/notifier.ts`（`notificationText`・`mentionText`・`withMention`）、`packages/core/src/projects.ts`（`SlackMention`・`SlackMentionTarget`・`DEFAULT_MENTION_KINDS`）

## 送れなかったとき・テストの通知

- 送れなかった理由は、秘密情報（トークン・Webhook の URL）を伏せてから 400 文字に切り詰め、プロジェクトごとに持って画面の警告に出す
  （次に送れたら消す）。デーモンのログにも `[notify]` で出す。
- `POST /api/projects/:id/notification-test` でテストの通知を送る（メンションは種類によらず付ける）。送れなければ理由を返す。

コード: `apps/daemon/src/notifier.ts`（`SlackNotifier.notify`・`test`・`problems`・`REASON_MAX`）、`apps/daemon/src/service.ts`（`testNotification`）
