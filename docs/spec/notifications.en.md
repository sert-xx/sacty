[日本語](notifications.md) | **English**

# Notifications

sacty notifies the Slack destination in the sacty settings and the browser's desktop notifications when a person is needed (awaiting approval, Escalation, Pause) and when a task is completed. Tasks of every project go to that one destination. If sending fails, the task does not stop.

Related ADR:

- [Move the Slack notification destination from project settings to the sacty settings, and send notifications of every project to one destination](../adr/20261016-0421-slack-notification-in-sacty-settings.md)
- [Add browser desktop notifications, and let Slack notifications be turned off while keeping their settings](../adr/20261026-1315-desktop-notifications-and-notification-switches.md)

## When to notify

Each time the Activity is appended to, sacty compares the task before and after the append to decide (it does not wait for sending).

| Kind | Condition |
| --- | --- |
| `escalation` | Became `escalated` |
| `approval` | Became `awaiting_approval`, or the step awaiting approval or the submission number changed |
| `paused` | Became `paused` (no notification when the reason is `manual`, that is, when a person paused it) |
| `completed` | Completed |

Code: `apps/daemon/src/notifier.ts` (`notificationFor`), `apps/daemon/src/service.ts` (`append`), `packages/core/src/projects.ts` (`NotificationKind`)

## Destination

The destination is written in `notification` in the sacty settings (`settings` in `sacty.db`). Without it, sacty does not notify. `notification` has `language` (`ja` | `en`; default `ja`), `mention` (optional), and `off` (optional). When `off` is `true`, sacty does not send (the destination and other fields are kept). `off` is absent when sending (the default); the checkbox value `on` from the web UI is also accepted.

`PUT /api/settings` validates it on save. sacty reads the sacty settings again for each notification, so saved settings take effect from the next notification without restarting the daemon. Project definitions have no notification field, and a `notification` that an earlier sacty saved in a project is dropped by validation on load (not used).

- Slack API style (`slack-api`)
  - The fields are `url` (`chat.postMessage` or a Slack proxy), `channel`, and `token` (optional; a secret reference).
  - sacty POSTs `{ channel, username: "Sacty", icon_url, text, unfurl_links: false, unfurl_media: false }`. If there is a token, it adds `Authorization: Bearer`.
  - The icon is `https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png`.
  - A response of `{"ok": false}` is a failure even with status 200.
- Incoming Webhook (`slack-webhook`)
  - The field is `webhook`. The URL itself is a secret, so write it as a secret reference.
  - sacty POSTs `{ text }`.
- Both time out after 15 seconds.

Code: `apps/daemon/src/notifier.ts` (`SlackNotifier.send`, `SLACK_USERNAME`, `SLACK_ICON_URL`), `packages/core/src/projects.ts` (`SlackNotification`, `SactySettings`), `apps/daemon/src/main.ts`

## Body and mentions

- The first line of the body (Slack mrkdwn) is `[project name]` and a link to the task (`/tasks/<ID>` on `SACTY_WEB_URL`, default `http://127.0.0.1:4700`). If the project is not found, there is no name.
- The second line says what the notification is about, with the step name.

  | Kind | Step | Body (English example) |
  | --- | --- | --- |
  | `approval` | The step awaiting approval (`gate.step`) | `Design is waiting for your approval`. The reproduction decision is `Reproduce: the bug was not reproduced; …` and the integration review decision is `Integration review keeps failing; …`. Without a step, `Waiting for your approval` |
  | `escalation` | The step that escalated (`escalation.step`, or `gate.step` if absent) | `Escalated in Requirements; your decision is needed`. Confirming the step to redo for PR comments is `Escalated in Implement: confirm the step to redo for the PR comments` |
  | `paused` | The step when it stopped (the `active` step) | `Paused in Implement (budget cap)`. Before the steps are decided (no steps), `Paused before the steps were decided (…)`; if the step is unknown, `Paused (…)` |
  | `completed` | None | `Done` |

- It includes the place to approve or decide (`/tasks/<ID>/review`). When awaiting approval with a PR, it adds a link to the PR and "merge to approve". For Pause, it includes the detailed message (up to 300 characters).
- Mention targets (`targets`, 1 to 20) and the form added at the start of the body are as follows.
  - `U…` and `W…` (users): `<@U…>`
  - `S…` (user groups): `<!subteam^S…>`
  - `@here`: `<!here>`
  - `@channel`: `<!channel>`
- The default kinds to mention (`kinds`) are `approval`, `escalation`, and `paused` (not completion).

Code: `apps/daemon/src/notifier.ts` (`notificationText`, `mentionText`, `withMention`), `packages/core/src/projects.ts` (`SlackMention`, `SlackMentionTarget`, `DEFAULT_MENTION_KINDS`), `packages/core/src/projection.ts` (`activeStep`)

## When sending fails, and test notifications

- sacty shows the reason sending failed as a warning in the web UI (`notify.failed`).
  - It redacts secrets (tokens and webhook URLs), then truncates the reason to 400 characters.
  - It keeps the last one for all of sacty. The next successful send clears it, and it is not shown after the destination is removed or set to `off`.
  - The web UI shows it on the dashboard, in the notification section of the sacty settings, and on the task list (`notificationProblems`).
  - It is also written to the daemon log with `[notify]`. It is not recorded in the Activity.
  - If the sacty settings cannot be read, sacty does not send and shows that reason the same way.
- Notifications are sent after the Activity is written. So even when the settings or the project cannot be read or the body cannot be built, sacty does not throw; it keeps the reason as a failure to send (it is not passed to the task operation).
- Only the latest result for the current destination is kept.
  - Sends are numbered in the order they start, and the result of a send started earlier does not overwrite that of a send started later.
  - Results of an old destination that finish after the destination changed are not applied.
  - The reason is kept with its destination and is not shown if it differs from the current one.
- When saving the sacty settings changes the destination, sacty discards the kept reason and does not apply results of sends started before that either. Even if the destination goes A → B → A, the failure from before the change is not shown.
- `POST /api/settings/notification-test` sends a test notification to the destination in the saved sacty settings (mentions are added regardless of the kind; it is sent even when `off`). It returns 409 with `notify.notConfigured` when there is no destination, or with the reason (`notify.failed`) when it cannot be sent.

Code: `apps/daemon/src/notifier.ts` (`SlackNotifier.notify`, `test`, `problems`, `fail`, `settingsChanged`, `REASON_MAX`), `apps/daemon/src/service.ts` (`testNotification`, `saveSettings`), `apps/daemon/src/server.ts`, `apps/web/src/lib/notification-problems.ts` (`notificationProblems`)

## Desktop notifications

The same notifications as Slack (the four kinds in [When to notify](#when-to-notify)) are also shown as browser desktop notifications, regardless of the Slack destination and `off`.

- For each notification, the daemon keeps `{ seq, at, taskId, kind }` in memory (up to the latest 100).
  - `seq` is a number counted from 1. Restarting the daemon empties the list and starts counting again.
  - `boot` is a value that changes on each start.
- `GET /api/notifications?after=<number>` returns `{ boot, latest, items }`. `items` are the notifications numbered after `after` (oldest first). Without `after`, or with a malformed one, `items` is empty and only the last number (`latest`) is returned.
- The web server's `GET /live/notifications?after=<number>` reads the task and project of each notification and returns `{ seq, title, body, href }` in the UI language.
  - `title` is the task title, `body` is the kind text such as `[project name] Waiting for your approval`, and `href` is the task detail (`/tasks/<ID>`).
  - Notifications for tasks that no longer exist are not returned.
  - When the daemon cannot be reached, it returns `{ unavailable: true }` with 200.
- The web UI (on any page) polls every 5 seconds only while all of the following hold.
  - It is on in this browser (`sacty-desktop-notifications` in `localStorage` is `on`; off by default).
  - The browser can show notifications (`Notification` exists and the page is on https or localhost).
  - Notifications are allowed (`Notification.permission` is `granted`).
- It keeps polling while the tab is hidden. Browsers throttle timers in hidden tabs, so notifications may be delayed (unverified: throttling depends on the browser).
- The first poll (without `after`) shows nothing and remembers the last number (notifications from before the page was opened or turned on are not shown). When `boot` changes, it polls again from `after=0`.
- Across tabs in the same browser, `sacty-desktop-notifications-seen` (`<boot>:<seq>`) in `localStorage` makes each notification appear only once.
- Clicking a notification brings that tab to the front and opens the task detail.
- It is turned on and off under "Desktop notifications (this browser)" on the sacty settings page. The switch takes effect immediately and is not saved in the sacty settings. Turning it on asks the browser for permission. If permission is denied, it stays off and shows how to allow it.

Code: `apps/daemon/src/notification-feed.ts` (`NotificationFeed`), `apps/daemon/src/service.ts` (`append`, `notificationFeed`), `apps/daemon/src/server.ts`, `apps/web/src/app/live/notifications/route.ts`, `apps/web/src/lib/desktop-notifications-data.ts` (`loadDesktopFeed`), `apps/web/src/lib/desktop-notifications.ts` (`advanceFeed`, `claimDesktopItem`, `DESKTOP_INTERVAL_MS`), `apps/web/src/components/shell/desktop-notifications.tsx` (`DesktopNotifications`), `apps/web/src/components/desktop-notification-settings.tsx`
