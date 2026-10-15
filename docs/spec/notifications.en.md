[日本語](notifications.md) | **English**

# Notifications

Notifies the project's Slack destination when a person is needed (awaiting approval, Escalation, Pause) and when a task is completed. If sending fails, the task does not
stop.

Related ADR: [Do not include Slack mentions (targets and kinds) in project exports, and reject version 3 files, which included them, with the reason](../adr/20261015-0850-export-without-mentions.md)

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

The project's `notification`. It has `language` (`ja` | `en`; default `ja`) and `mention` (optional).

- Slack API style (`slack-api`): `url` (`chat.postMessage` or a Slack proxy), `channel`, and `token` (optional; a secret reference).
  sacty POSTs `{ channel, username: "Sacty", icon_url, text, unfurl_links: false, unfurl_media: false }` (with `Authorization: Bearer` if there is a token).
  The icon is `https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png`. A response of `{"ok": false}` is a failure even with status 200.
- Incoming Webhook (`slack-webhook`): `webhook` (the URL itself is a secret, so write it as a secret reference). sacty POSTs `{ text }`.
- Both time out after 15 seconds.

Code: `apps/daemon/src/notifier.ts` (`SlackNotifier.send`, `SLACK_USERNAME`, `SLACK_ICON_URL`), `packages/core/src/projects.ts` (`ProjectNotification`)

## Body and mentions

- The body (Slack mrkdwn) includes a link to the task (`/tasks/<ID>` on `SACTY_WEB_URL`, default `http://127.0.0.1:4700`) and the place to approve or decide
  (`/tasks/<ID>/review`). When awaiting approval with a PR, it adds a link to the PR and "merge to approve". For Pause, it includes the reason and the detailed message (up to 300 characters).
- Mention targets (`targets`, 1 to 20) are `U…` and `W…` (users), `S…` (user groups), `@here`, and `@channel`. They are added at the start of the body
  as `<@U…>`, `<!subteam^S…>`, `<!here>`, and `<!channel>` respectively. The default kinds to mention (`kinds`) are `approval`, `escalation`, and
  `paused` (not completion).
- Mentions (`targets`, `kinds`) are not included in project exports ([Export](export.en.md)). In an imported project, set both the targets and the kinds again.

Code: `apps/daemon/src/notifier.ts` (`notificationText`, `mentionText`, `withMention`), `packages/core/src/projects.ts` (`SlackMention`, `SlackMentionTarget`, `DEFAULT_MENTION_KINDS`)

## When sending fails, and test notifications

- The reason sending failed is truncated to 400 characters after redacting secrets (tokens and webhook URLs), kept per project, and shown as a warning in the web UI
  (cleared the next time sending succeeds). It is also written to the daemon log with `[notify]`.
- `POST /api/projects/:id/notification-test` sends a test notification (mentions are added regardless of the kind). If it cannot be sent, the reason is returned.

Code: `apps/daemon/src/notifier.ts` (`SlackNotifier.notify`, `test`, `problems`, `REASON_MAX`), `apps/daemon/src/service.ts` (`testNotification`)
