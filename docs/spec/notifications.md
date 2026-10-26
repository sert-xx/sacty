**日本語** | [English](notifications.en.md)

# 通知

人間の出番（承認待ち・エスカレーション・一時停止）とタスクの完了を、sacty の設定の Slack の送り先と、ブラウザのデスクトップ通知に知らせる。
すべてのプロジェクトのタスクを1つの送り先に送る。
送れなくてもタスクは止めない。

関係する ADR:

- [Slack の通知先を、プロジェクトの設定から sacty の設定に移し、すべてのプロジェクトの通知を1つの送り先に送る](../adr/20261016-0421-slack-notification-in-sacty-settings.md)
- [ブラウザのデスクトップ通知を足し、Slack の通知は設定を残したまま止められるようにする](../adr/20261026-1315-desktop-notifications-and-notification-switches.md)

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

送り先は、sacty の設定（`sacty.db` の `settings`）の `notification` に書く。
無ければ通知しない。
`notification` は `language`（`ja`｜`en`。既定 `ja`）と `mention`（任意）と `off`（任意）を持つ。
`off` が `true` なら送らない（送り先などの項目は残す）。
`off` は、送るとき（既定）は持たない（画面のチェックボックスの `on` も受け付ける）。

保存のときに `PUT /api/settings` が検査する。
sacty は通知のたびに sacty の設定を読み直すので、保存した設定は、デーモンを再起動せずに次の通知から効く。
プロジェクトの定義には通知先の項目が無い。
以前の sacty がプロジェクトに保存した `notification` は、読み込みの検査で捨てる（使わない）。

- Slack API の形（`slack-api`）
  - 項目は `url`（`chat.postMessage` や Slack Proxy）・`channel`・`token`（任意。秘密情報の参照）。
  - `{ channel, username: "Sacty", icon_url, text, unfurl_links: false, unfurl_media: false }` を POST する。
    トークンがあれば `Authorization: Bearer` を付ける。
  - アイコンは `https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png`。
  - 200 でも `{"ok": false}` なら失敗とする。
- Incoming Webhook（`slack-webhook`）
  - 項目は `webhook`。
    URL そのものが秘密なので、秘密情報の参照で書く。
  - `{ text }` を POST する。
- どちらも15秒で打ち切る。

コード: `apps/daemon/src/notifier.ts`（`SlackNotifier.send`・`SLACK_USERNAME`・`SLACK_ICON_URL`）、`packages/core/src/projects.ts`（`SlackNotification`・`SactySettings`）、`apps/daemon/src/main.ts`

## 本文とメンション

- 本文（Slack の mrkdwn）の1行目は、`[プロジェクトの名前]` と、タスクへのリンク（`SACTY_WEB_URL`、既定 `http://127.0.0.1:4700` の `/tasks/<ID>`）。
  プロジェクトが見つからなければ、名前を付けない。
- 2行目に、何の通知かを工程の名前とともに書く。

  | 種類 | 工程 | 本文（日本語の例） |
  | --- | --- | --- |
  | `approval` | 承認を待つ工程（`gate.step`） | `設計の承認を待っています`。再現の判断は `再現の工程で再現できなかったため、…`、統合レビューの判断は `統合レビューに通らないため、…`。工程が無ければ `承認を待っています` |
  | `escalation` | エスカレーションした工程（`escalation.step`。無ければ `gate.step`） | `要求要件でエスカレーションしました。判断してください`。PR の指摘の戻し先の確認は `実装でエスカレーションしました。PR の指摘の戻し先を確かめてください` |
  | `paused` | 止まったときの工程（`active` の工程） | `実装で一時停止しました（予算の上限）`。工程を決める前（工程が無い）は `工程を決める前に一時停止しました（…）`、工程が分からなければ `一時停止しました（…）` |
  | `completed` | 入れない | `完了しました` |

- 承認・判断の窓口（`/tasks/<ID>/review`）を入れる。
  承認待ちで PR があれば、PR へのリンクと「マージで承認」を添える。
  一時停止は詳しい文（300 文字まで）を入れる。
- メンションの相手（`targets`、1〜20件）と、本文の先頭に付ける形は次のとおり。
  - `U…`・`W…`（ユーザー）：`<@U…>`
  - `S…`（ユーザーグループ）：`<!subteam^S…>`
  - `@here`：`<!here>`
  - `@channel`：`<!channel>`
- メンションする種類（`kinds`）の既定は `approval`・`escalation`・`paused`（完了はしない）。

コード: `apps/daemon/src/notifier.ts`（`notificationText`・`mentionText`・`withMention`）、`packages/core/src/projects.ts`（`SlackMention`・`SlackMentionTarget`・`DEFAULT_MENTION_KINDS`）、`packages/core/src/projection.ts`（`activeStep`）

## 送れなかったとき・テストの通知

- 送れなかった理由は、画面の警告に出す（`notify.failed`）。
  - 秘密情報（トークン・Webhook の URL）を伏せてから、400 文字に切り詰める。
  - sacty 全体で最後の1つを持つ。
    次に送れたら消す。
    通知先を外したら・`off` にしたら出さない。
  - 画面は、ダッシュボード・sacty の設定の通知の区画・タスクの一覧に出す（`notificationProblems`）。
  - デーモンのログにも `[notify]` で出す。
    作業履歴には記録しない。
  - sacty の設定を読めなければ、送らずに、その理由を同じように出す。
- 通知は作業履歴に書いた後に送る。
  このため、設定・プロジェクトを読めない・本文を作れないときも例外にせず、送れなかった理由として持つ（タスクの操作には伝えない）。
- 理由を持つのは、今の送り先の最新の結果だけ。
  - 送り始めた順に番号を付け、後に始めた送信の結果を、先に始めた送信の結果で上書きしない。
  - 送り先が変わった後に終わった、古い送り先の結果は反映しない。
  - 理由は送り先とともに持ち、今の送り先と違えば出さない。
- sacty の設定の保存で通知先が変わったら、持っている理由を捨て、それまでに始めた送信の結果も反映しない。
  送り先を A → B → A と戻しても、変える前の失敗を出さない。
- `POST /api/settings/notification-test` は、保存した sacty の設定の送り先にテストの通知を送る（メンションは種類によらず付ける。`off` でも送る）。
  通知先が無ければ `notify.notConfigured`、送れなければ理由（`notify.failed`）を 409 で返す。

コード: `apps/daemon/src/notifier.ts`（`SlackNotifier.notify`・`test`・`problems`・`fail`・`settingsChanged`・`REASON_MAX`）、`apps/daemon/src/service.ts`（`testNotification`・`saveSettings`）、`apps/daemon/src/server.ts`、`apps/web/src/lib/notification-problems.ts`（`notificationProblems`）

## デスクトップ通知

Slack と同じ通知（[いつ通知するか](#いつ通知するか) の4種類）を、ブラウザのデスクトップ通知でも出す。
Slack の送り先・`off` によらない。

- デーモンは、通知のたびに `{ seq, at, taskId, kind }` をメモリーに持つ（最近の 100 件まで）。
  - `seq` は 1 から数える番号。
    デーモンを起動し直すと空に戻り、数え直す。
  - `boot` は起動ごとに変わる値。
- `GET /api/notifications?after=<番号>` は、`{ boot, latest, items }` を返す。
  `items` は、番号が `after` より後の通知（古い順）。
  `after` が無い・形が違えば、`items` は空で、最後の番号（`latest`）だけを返す。
- 画面のサーバーの `GET /live/notifications?after=<番号>` は、タスク（作業履歴を含まない一覧を一度だけ取る）とプロジェクトを読み、通知ごとに画面の言語の `{ seq, title, body, href }` にして返す。
  通知が無ければ、タスクは取らない。
  - `title` はタスクの題名、`body` は `[プロジェクトの名前] 承認を待っています` などの種類の文、`href` はタスクの詳細（`/tasks/<ID>`）。
  - 無くなったタスクの通知は返さない。
  - デーモンに届かなければ 200 で `{ unavailable: true }` を返す。
- 画面（どのページでも）は、次のときだけ、5秒ごとに取り直す。
  - このブラウザで On にしている（`localStorage` の `sacty-desktop-notifications` が `on`。既定は Off）。
  - ブラウザが通知を出せる（`Notification` があり、https か localhost の画面）。
  - 通知が許可されている（`Notification.permission` が `granted`）。
- 1回の取り直し（本文を読むまで）は10秒で打ち切り、次の間隔でまた取り直す。
- On/Off を変えたら、取り直しの途中でも打ち切り、最初の問い合わせからやり直す（途中だった取り直しの結果は捨てる。Off の間の通知を出さない）。
- タブが隠れている間も取り直す。
  ブラウザが隠れたタブのタイマーを間引くので、遅れることがある（未確認：間引き方はブラウザによる）。
- 最初の取り直し（`after` 無し）では出さず、最後の番号を覚える（画面を開く前・On にする前の通知は出さない）。
  `boot` が変わったら、`after=0` から取り直す。
- 同じブラウザの複数のタブでは、`localStorage` の `sacty-desktop-notifications-seen`（`<boot>:<seq>`）で、同じ通知を1回だけ出す。
  確認・記録・通知を出すまでを、Web Locks（`sacty-desktop-notifications`）でタブの間で1つずつ行う。
  Web Locks が無いブラウザでは排他しない（同時に受け取ったタブが、同じ通知を出すことがある）。
- 通知を押すと、そのタブを前に出し、タスクの詳細を開く。
- On/Off は sacty の設定の画面の「デスクトップ通知（このブラウザー）」で切り替える。
  切り替えはすぐに効き、sacty の設定には保存しない。
  On にするときに、ブラウザに通知の許可を求める。
  拒否されていれば On にせず、許可の仕方を出す。
  許可の状態は、権限が変わったとき（`navigator.permissions` が知らせるブラウザ）と、画面に戻ったときに読み直す（サイトの設定で許可した後、画面を読み直さなくても On にできる）。

コード: `apps/daemon/src/notification-feed.ts`（`NotificationFeed`）、`apps/daemon/src/service.ts`（`append`・`notificationFeed`）、`apps/daemon/src/server.ts`、`apps/web/src/app/live/notifications/route.ts`、`apps/web/src/lib/desktop-notifications-data.ts`（`loadDesktopFeed`）、`apps/web/src/lib/desktop-notifications.ts`（`advanceFeed`・`claimDesktopItem`・`withDesktopLock`・`DESKTOP_INTERVAL_MS`・`DESKTOP_TIMEOUT_MS`）、`apps/web/src/components/shell/desktop-notifications.tsx`（`DesktopNotifications`）、`apps/web/src/components/desktop-notification-settings.tsx`
