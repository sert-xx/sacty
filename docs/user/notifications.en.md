<!-- Code: packages/core/src/projects.ts (SactySettings, SlackNotification, SlackMention, DEFAULT_MENTION_KINDS), apps/daemon/src/notifier.ts, apps/web/src/components/notification-settings.tsx, apps/web/src/i18n/messages/settings.ts -->

[日本語](notifications.md) | **English**

# Slack notifications

sacty notifies Slack when you are needed (awaiting approval, Escalation, Pause) and when a task finishes. In "Slack notifications" in the
"Sacty settings" of the web UI (user menu), choose how to send and the language (Japanese or English. Japanese by default), and save. If you do not set it up, nothing is sent.

There is one destination, and tasks in every project are notified to it. Project settings have no notification fields.

**Before you set it up, make sure that everyone who can see the destination (channel) may receive notifications from every project.**
Notifications include project names and task titles and links, and depending on the kind of notification, step names too. You can no longer use a different destination per project as before, so
notifications from projects meant for different audiences also go to the same channel.

## How to send

- Slack API (chat.postMessage, Slack Proxy): write the URL to send to (`https://slack.com/api/chat.postMessage`, or a Slack Proxy that needs no authentication) and
  the channel. If a token is needed, write a secret name or a 1Password reference (leave it empty for a Proxy).
  - Messages are sent with the name `Sacty` and the icon [assets/sacty-icon.png](../../assets/sacty-icon.png) (`icon_url` points to the public image in this repository).
    If the bot token of your Slack app does not have the `chat:write.customize` scope, Slack ignores these and shows the app's name and icon.
- Incoming Webhook: write the webhook URL as a secret name or a 1Password reference (because the URL itself is a secret).

## Mentions (optional)

Choose who to mention and which kinds of notifications mention them. This works with either way of sending, and the mentions go at the start of the message (test notifications include them too).
If you do not set it up, nobody is mentioned.

- Write the people as IDs (Slack does not deliver to @display names). For users, the member ID (`U…` or `W…`. "Copy member ID" in the Slack profile);
  for user groups, the ID (`S…`); you can also write `@here` and `@channel`. Separate them with commas or spaces, up to 20.
- In the message they are written as `<@U…>`, `<!subteam^S…>`, `<!here>`, and `<!channel>`.
- Choose the kinds from awaiting approval, Escalation, Pause, and completion. By default, only the ones where you are needed (awaiting approval, Escalation, Pause) mention; completion
  does not.

## Notification content and failures

- The first line of a notification has `[project name]` and a link to the task (so you can tell which project the task belongs to).
- The second line says which step the notification is about. For example: "Design is waiting for your approval", "Paused in Implement (budget cap)", and
  "Escalated in Requirements; your decision is needed". Completion notifications and a Pause before the steps are decided ("Paused before the steps were decided") have
  no step name.
- Notifications also include a link to the approval page (and to the PR for steps approved on a PR). Nothing is sent when you pause a task yourself.
- If a notification cannot be sent, the task is not stopped, and the reason is shown as a warning. It appears on the dashboard (with a link to the "Sacty settings"), in the
  "Slack notifications" section of the "Sacty settings", and on the task list page (it is a warning for all of sacty, so it appears in the list of every project). It disappears the next time sending succeeds.
- Use "Send a test notification" in the "Sacty settings" to check that sending works (you can send after saving).

## If you used an earlier sacty

An earlier sacty set notifications per project. Notifications set in projects are no longer used and are not moved.
Set the destination again in the "Sacty settings" (nothing is sent until you do).

## Related pages

- [Importing issues, PRs, and tickets](intake.en.md) (the other items in the "Sacty settings")
- [Project settings](project-settings.en.md)
- [Secrets](secrets.en.md)
