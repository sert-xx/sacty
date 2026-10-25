<!-- Code: packages/core/src/schedules.ts, apps/daemon/src/schedules.ts, apps/web/src/app/projects/[id]/schedules/page.tsx, apps/web/src/app/projects/[id]/schedules/[scheduleId]/page.tsx, apps/web/src/components/schedule-dialog.tsx, apps/web/src/i18n/messages/schedules.ts -->

[日本語](scheduled-tasks.md) | **English**

# Scheduled tasks

You can have Sacty create a task with fixed contents automatically on a schedule (daily, weekly, or monthly).
Use it for recurring work such as regular dependency updates or weekly checks.
Read [Working with tasks](tasks.en.md) first for how tasks are created.

## Create a scheduled task

1. Open "Schedules" in the side menu.
   The scheduled tasks of the displayed project are listed.
2. Click "Create scheduled task".
3. Fill in the fields below and click "Create".

| Field | Content |
| --- | --- |
| Name | The name shown in the list (up to 100 characters) |
| Enabled | Clear it to create it paused |
| Repeat | Daily, Weekly, or Monthly |
| Time | The time to create the task (the clock of the computer running Sacty) |
| Days | For Weekly, choose at least one |
| Day | The day (1 to 31) for Monthly. If the month has no such day (such as the 31st), the task is created on its last day |
| Task to create | The same fields as "Create task" (template, target repository, plan, title, description) |

The contents of the task are checked on saving, in the same way as "Create task".
If they cannot be used, for example the target repository is not in the project's targets, the reason appears and nothing is saved.

## When the computer was off

Sacty runs on your computer, so at a scheduled time the computer may be off, asleep, or offline.
In that case it works as follows.

- When Sacty is running and online (it checks after starting and then every minute), it creates the task for the latest scheduled time that has not been created yet.
- However many scheduled times were missed, it creates only one, for the latest time.
  It never creates one task per missed time.
- It never creates the task for the same scheduled time twice.
- Scheduled times before you created the scheduled task, or while it was paused, are not made up.

### How the connection is checked

Sacty checks whether it is online by resolving the name `github.com`.
While the name does not resolve, it waits without creating tasks.
While waiting, the list shows "Waiting for network" in the state, and the details show "Offline. Waiting to create the task."
The terminal running `sacty up` also shows a line once when waiting starts and once when the connection returns.

If tasks are never created, check on the computer running Sacty that the name resolves, with the command below.

```sh
nslookup github.com
```

In an environment where the name does not resolve (for example, a company network that cannot resolve outside names), scheduled tasks do not create tasks.

## Edit, pause, and delete

Click a name in the list to open the details.

- "Edit" changes the name, the schedule, the contents of the task, and whether it is enabled.
  When you change the schedule, or enable a paused one again, it counts from the scheduled times after that moment.
- "Delete" removes it.
  The tasks it created stay.
- Deleting a project also deletes its scheduled tasks.

## See the tasks it created

"Created tasks" in the details lists the tasks this scheduled task created, newest first.
It shows the scheduled time, the steps, and the status; click a title to open the task.
In the task list, their start is shown as "Scheduled task".

If the task for the last scheduled time could not be created (for example, the project's targets changed), the details show the reason.
After you fix the contents and save, tasks are created from the next scheduled time.
