[日本語](notifications.md) | **English**

# Notifications

Notifies the Slack destination in the sacty settings when a person is needed (awaiting approval, Escalation, Pause) and when a task is completed. Tasks of every
project go to that one destination. If sending fails, the task does not stop.

Related ADR: [Move the Slack notification destination from project settings to the sacty settings, and send notifications of every project to one destination](../adr/20261016-0421-slack-notification-in-sacty-settings.md)

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

`notification` in the sacty settings (`settings` in `sacty.db`). Without it, sacty does not notify. It has `language` (`ja` | `en`; default `ja`) and `mention` (optional).
`PUT /api/settings` validates it on save. sacty reads the sacty settings again for each notification (saved settings take effect from the next notification without restarting the daemon).
Project definitions have no notification field, and a `notification` that an earlier sacty saved in a project is dropped by validation on load (not used).

- Slack API style (`slack-api`): `url` (`chat.postMessage` or a Slack proxy), `channel`, and `token` (optional; a secret reference).
  sacty POSTs `{ channel, username: "Sacty", icon_url, text, unfurl_links: false, unfurl_media: false }` (with `Authorization: Bearer` if there is a token).
  The icon is `https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png`. A response of `{"ok": false}` is a failure even with status 200.
- Incoming Webhook (`slack-webhook`): `webhook` (the URL itself is a secret, so write it as a secret reference). sacty POSTs `{ text }`.
- Both time out after 15 seconds.

Code: `apps/daemon/src/notifier.ts` (`SlackNotifier.send`, `SLACK_USERNAME`, `SLACK_ICON_URL`), `packages/core/src/projects.ts` (`SlackNotification`, `SactySettings`), `apps/daemon/src/main.ts`

## Body and mentions

- The first line of the body (Slack mrkdwn) is `[project name]` and a link to the task (`/tasks/<ID>` on `SACTY_WEB_URL`, default
  `http://127.0.0.1:4700`). If the project is not found, there is no name.
- The second line says what the notification is about, with the step name.

  | Kind | Step | Body (English example) |
  | --- | --- | --- |
  | `approval` | The step awaiting approval (`gate.step`) | `Design is waiting for your approval`. The reproduction decision is `Reproduce: the bug was not reproduced; …` and the integration review decision is `Integration review keeps failing; …`. Without a step, `Waiting for your approval` |
  | `escalation` | The step that escalated (`escalation.step`, or `gate.step` if absent) | `Escalated in Requirements; your decision is needed`. Confirming the step to redo for PR comments is `Escalated in Implement: confirm the step to redo for the PR comments` |
  | `paused` | The step when it stopped (the `active` step) | `Paused in Implement (budget cap)`. Before the steps are decided (no steps), `Paused before the steps were decided (…)`; if the step is unknown, `Paused (…)` |
  | `completed` | None | `Done` |

- It includes the place to approve or decide (`/tasks/<ID>/review`). When awaiting approval with a PR, it adds a link to the PR and "merge to approve". For Pause,
  it includes the detailed message (up to 300 characters).
- Mention targets (`targets`, 1 to 20) are `U…` and `W…` (users), `S…` (user groups), `@here`, and `@channel`. They are added at the start of the body
  as `<@U…>`, `<!subteam^S…>`, `<!here>`, and `<!channel>` respectively. The default kinds to mention (`kinds`) are `approval`, `escalation`, and
  `paused` (not completion).

Code: `apps/daemon/src/notifier.ts` (`notificationText`, `mentionText`, `withMention`), `packages/core/src/projects.ts` (`SlackMention`, `SlackMentionTarget`, `DEFAULT_MENTION_KINDS`), `packages/core/src/projection.ts` (`activeStep`)

## When sending fails, and test notifications

- The reason sending failed is truncated to 400 characters after redacting secrets (tokens and webhook URLs), and sacty keeps the last one for all of sacty and shows it
  as a warning in the web UI (`notify.failed`; cleared the next time sending succeeds, and not shown after the destination is removed). It is also written to the daemon log
  with `[notify]`. It is not recorded in the Activity. If the sacty settings cannot be read, sacty does not send and shows that reason the same way.
- `POST /api/settings/notification-test` sends a test notification to the destination in the saved sacty settings (mentions are added regardless of the kind).
  It returns 409 with `notify.notConfigured` when there is no destination, or with the reason (`notify.failed`) when it cannot be sent.

Code: `apps/daemon/src/notifier.ts` (`SlackNotifier.notify`, `test`, `problems`, `fail`, `REASON_MAX`), `apps/daemon/src/service.ts` (`testNotification`), `apps/daemon/src/server.ts`
