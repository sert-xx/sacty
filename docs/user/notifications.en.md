<!-- Code: packages/core/src/projects.ts (ProjectNotification, SlackMention, DEFAULT_MENTION_KINDS), apps/daemon/src/notifier.ts, apps/web/src/i18n/messages/projects.ts -->

[日本語](notifications.md) | **English**

# Slack notifications

sacty notifies Slack, per project, when you are needed (awaiting approval, Escalation, Pause) and when a task finishes. In "Slack notifications" in the
project settings of the web UI, choose how to send and the language (Japanese or English. Japanese by default). If you do not set it up, nothing is sent.

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
- Mention settings are also included in project export and import (the IDs are not secrets).

## Notification content and failures

- Notifications include links to the task and to the approval page (and to the PR for Deliverable review). Nothing is sent when you pause a task yourself.
- If a notification cannot be sent, the task is not stopped, and the reason is shown on the task list page.
- Use "Send a test notification" in the project settings page to check that sending works (you can send after saving).

## Related pages

- [Project settings](project-settings.en.md)
- [Secrets](secrets.en.md)
