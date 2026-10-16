**日本語** | [English](notifications.en.md)

# 通知

人間の出番（承認待ち・エスカレーション・一時停止）とタスクの完了を、sacty の設定の Slack の送り先に通知する。すべてのプロジェクトの
タスクを1つの送り先に送る。送れなくてもタスクは止めない。

関係する ADR: [Slack の通知先を、プロジェクトの設定から sacty の設定に移し、すべてのプロジェクトの通知を1つの送り先に送る](../adr/20261016-0421-slack-notification-in-sacty-settings.md)

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

sacty の設定（`sacty.db` の `settings`）の `notification`。無ければ通知しない。`language`（`ja`｜`en`。既定 `ja`）と `mention`（任意）を持つ。
保存のときに `PUT /api/settings` が検査する。通知のたびに sacty の設定を読み直す（保存した設定は、デーモンを再起動せずに次の通知から効く）。
プロジェクトの定義には通知先の項目が無く、以前の sacty がプロジェクトに保存した `notification` は、読み込みの検査で捨てる（使わない）。

- Slack API の形（`slack-api`）：`url`（`chat.postMessage` や Slack Proxy）・`channel`・`token`（任意。秘密情報の参照）。
  `{ channel, username: "Sacty", icon_url, text, unfurl_links: false, unfurl_media: false }` を POST する（トークンがあれば `Authorization: Bearer`）。
  アイコンは `https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png`。200 でも `{"ok": false}` なら失敗。
- Incoming Webhook（`slack-webhook`）：`webhook`（URL そのものが秘密なので、秘密情報の参照で書く）。`{ text }` を POST する。
- どちらも15秒で打ち切る。

コード: `apps/daemon/src/notifier.ts`（`SlackNotifier.send`・`SLACK_USERNAME`・`SLACK_ICON_URL`）、`packages/core/src/projects.ts`（`SlackNotification`・`SactySettings`）、`apps/daemon/src/main.ts`

## 本文とメンション

- 本文（Slack の mrkdwn）の1行目は、`[プロジェクトの名前]` と、タスクへのリンク（`SACTY_WEB_URL`、既定 `http://127.0.0.1:4700` の
  `/tasks/<ID>`）。プロジェクトが見つからなければ、名前を付けない。
- 2行目に、何の通知かを工程の名前とともに書く。

  | 種類 | 工程 | 本文（日本語の例） |
  | --- | --- | --- |
  | `approval` | 承認を待つ工程（`gate.step`） | `設計の承認を待っています`。再現の判断は `再現の工程で再現できなかったため、…`、統合レビューの判断は `統合レビューに通らないため、…`。工程が無ければ `承認を待っています` |
  | `escalation` | エスカレーションした工程（`escalation.step`。無ければ `gate.step`） | `要求要件でエスカレーションしました。判断してください`。PR の指摘の戻し先の確認は `実装でエスカレーションしました。PR の指摘の戻し先を確かめてください` |
  | `paused` | 止まったときの工程（`active` の工程） | `実装で一時停止しました（予算の上限）`。工程を決める前（工程が無い）は `工程を決める前に一時停止しました（…）`、工程が分からなければ `一時停止しました（…）` |
  | `completed` | 入れない | `完了しました` |

- 承認・判断の窓口（`/tasks/<ID>/review`）を入れる。承認待ちで PR があれば、PR へのリンクと「マージで承認」を添える。一時停止は詳しい文
  （300 文字まで）を入れる。
- メンションの相手（`targets`、1〜20件）は `U…`・`W…`（ユーザー）・`S…`（ユーザーグループ）・`@here`・`@channel`。本文の先頭に、
  それぞれ `<@U…>`・`<!subteam^S…>`・`<!here>`・`<!channel>` で付ける。メンションする種類（`kinds`）の既定は `approval`・`escalation`・
  `paused`（完了はしない）。

コード: `apps/daemon/src/notifier.ts`（`notificationText`・`mentionText`・`withMention`）、`packages/core/src/projects.ts`（`SlackMention`・`SlackMentionTarget`・`DEFAULT_MENTION_KINDS`）、`packages/core/src/projection.ts`（`activeStep`）

## 送れなかったとき・テストの通知

- 送れなかった理由は、秘密情報（トークン・Webhook の URL）を伏せてから 400 文字に切り詰め、sacty 全体で最後の1つを持って画面の警告に出す
  （`notify.failed`。次に送れたら消す。通知先を外したら出さない）。画面は、ダッシュボード・sacty の設定の通知の区画・タスクの一覧に出す
  （`notificationProblems`）。デーモンのログにも `[notify]` で出す。作業履歴には記録しない。
  sacty の設定を読めなければ、送らずに、その理由を同じように出す。
- 通知は、作業履歴に書いた後に送るので、設定・プロジェクトを読めない・本文を作れないときも例外にせず、送れなかった理由として持つ
  （タスクの操作には伝えない）。
- 理由を持つのは、今の送り先の最新の結果だけ。送り始めた順に番号を付け、後に始めた送信の結果を、先に始めた送信の結果で上書きしない。
  送り先が変わった後に終わった、古い送り先の結果は反映しない。理由は送り先とともに持ち、今の送り先と違えば出さない。
- sacty の設定の保存で通知先が変わったら、持っている理由を捨て、それまでに始めた送信の結果も反映しない（送り先を A → B → A と戻しても、
  変える前の失敗を出さない）。
- `POST /api/settings/notification-test` で、保存した sacty の設定の送り先にテストの通知を送る（メンションは種類によらず付ける）。
  通知先が無ければ `notify.notConfigured`、送れなければ理由（`notify.failed`）を 409 で返す。

コード: `apps/daemon/src/notifier.ts`（`SlackNotifier.notify`・`test`・`problems`・`fail`・`settingsChanged`・`REASON_MAX`）、`apps/daemon/src/service.ts`（`testNotification`・`saveSettings`）、`apps/daemon/src/server.ts`、`apps/web/src/lib/notification-problems.ts`（`notificationProblems`）
