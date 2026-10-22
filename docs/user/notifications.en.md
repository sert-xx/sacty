<!-- Code: packages/core/src/projects.ts (SactySettings, SlackNotification, SlackMention, DEFAULT_MENTION_KINDS), apps/daemon/src/notifier.ts, apps/web/src/components/notification-settings.tsx, apps/web/src/i18n/messages/settings.ts -->

[日本語](notifications.md) | **English**

# Slack notifications

sacty notifies Slack when you are needed (awaiting approval, Escalation, Pause) and when a task finishes. In "Slack notifications" in the "Sacty settings" of the web UI (user menu), choose how to send and the language (Japanese or English. Japanese by default), and save. If you do not set it up, sacty sends nothing.

There is one destination. sacty sends notifications for tasks in every project to it. Project settings have no notification fields.

**Before you set it up, make sure that everyone who can see the destination (channel) may receive notifications from every project.**
Notifications include project names and task titles and links, and depending on the kind of notification, step names too. You can no longer use a different destination per project as before. Notifications from projects meant for different audiences also go to the same channel.

## How to send

- Slack API (chat.postMessage, Slack Proxy)
  - Write the URL to send to (`https://slack.com/api/chat.postMessage`, or a Slack Proxy that needs no authentication) and the channel.
  - If a token is needed, write a secret name or a 1Password reference (leave it empty for a Proxy).
  - The sender name is `Sacty` and the icon is [assets/sacty-icon.png](../../assets/sacty-icon.png) (`icon_url` points to the public image in this repository). If the bot token of your Slack app does not have the `chat:write.customize` scope, Slack ignores these and shows the app's name and icon.
- Incoming Webhook
  - Write the webhook URL as a secret name or a 1Password reference (because the URL itself is a secret).

## Mentions (optional)

Choose who to mention and which kinds of notifications mention them. Mentions work with either way of sending and go at the start of the message (test notifications include them too). If you do not set it up, nobody is mentioned.

- Write the people as IDs (Slack does not deliver to @display names). Separate them with commas or spaces, up to 20.

| Who | What to write | Form in the message |
| --- | --- | --- |
| User | Member ID (`U…` or `W…`. "Copy member ID" in the Slack profile) | `<@U…>` |
| User group | ID (`S…`) | `<!subteam^S…>` |
| here | `@here` | `<!here>` |
| channel | `@channel` | `<!channel>` |

- Choose the kinds from awaiting approval, Escalation, Pause, and completion. By default, only the ones where you are needed (awaiting approval, Escalation, Pause) mention; completion does not.

## Notification content and failures

- The first line has `[project name]` and a link to the task (so you can tell which project the task belongs to).
- The second line says which step the notification is about.
  - For example: "Design is waiting for your approval", "Paused in Implement (budget cap)", and "Escalated in Requirements; your decision is needed"
  - Completion notifications and a Pause before the steps are decided ("Paused before the steps were decided") have no step name.
- Notifications also include a link to the approval page (and to the PR for steps approved on a PR).
- Nothing is sent when you pause a task yourself.
- If a notification cannot be sent, sacty does not stop the task and shows the reason as a warning. The warning disappears the next time sending succeeds. It appears in these places.
  - The dashboard (with a link to the "Sacty settings")
  - The "Slack notifications" section of the "Sacty settings"
  - The task list page (it is a warning for all of sacty, so it appears in the list of every project)
- Use "Send a test notification" in the "Sacty settings" to check that sending works (you can send after saving).

## If you used an earlier sacty

An earlier sacty set notifications per project. Notifications set in projects are no longer used and are not moved. Set the destination again in the "Sacty settings" (nothing is sent until you do).

## Related pages

- [Importing issues, PRs, and tickets](intake.en.md) (the other items in the "Sacty settings")
- [Project settings](project-settings.en.md)
- [Secrets](secrets.en.md)
