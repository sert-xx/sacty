[日本語](scheduled-tasks.md) | **English**

# Scheduled tasks

A scheduled task creates a task with fixed contents on a fixed schedule.
Because sacty runs on the user's computer, the computer is not always running or online at the scheduled time.
So sacty checks after the scheduled time passes, and if the latest scheduled time has not been handled yet, it creates one task at that point.

Related ADR: [Scheduled tasks create only the latest missed time, once they can](../adr/20261025-1130-scheduled-task-catch-up.md)

## What is stored

Scheduled tasks belong to a project and are kept one per row in the `schedules` table in `sacty.db` (the value is JSON).

| Field | Meaning |
| --- | --- |
| `name` | The name (1 to 100 characters) |
| `enabled` | Whether it is enabled. No tasks are created while it is paused |
| `rule` | How the schedule is defined (the table below) |
| `task` | The contents of the task to create ([The contents of the task](#the-contents-of-the-task)) |
| `since` | Only scheduled times after this are counted. Set to the current time on creation, when the schedule changes, and when a paused one is enabled again |
| `lastRun` | The most recently handled time. The scheduled time `slot`, the time it was handled `at`, and the created task `taskId` or the reason it could not be created `error` |

| `rule.kind` | Schedule |
| --- | --- |
| `daily` | Every day at `time` (HH:MM) |
| `weekly` | At `time` on the `days` (0 is Sunday; at least one) |
| `monthly` | At `time` on day `day` (1 to 31) of every month. If the month has no such day, its last day |

- Scheduled times are counted in the local time of the computer running the daemon.
- Input errors are returned as message codes (`schedule.nameRequired`, `schedule.timeInvalid`, `schedule.daysRequired`, `schedule.dayInvalid`, and so on).
- Deleting a project also deletes its scheduled tasks.
  The tasks they created stay, like other tasks.

Code: `packages/core/src/schedules.ts` (`ScheduleRule`, `ScheduleInput`, `Schedule`), `apps/daemon/src/schedules.ts` (`SqliteScheduleStore`, `ScheduledTasks`)

## The contents of the task

The contents of the task to create use the same fields as "Create task" in the web UI.

- With a template (`template`), the title and description come from the template (no title, description, or plan is kept).
  If the target repository is omitted and the project's targets are exactly one repository, that one is used.
- Without a template, it holds the title (required), the description, the target repository, and the plan (`plan`).
  Without a target repository, the task is created without one (`noRepo`).
- On saving (create or edit), the same checks as "Create task" run.
  If the repository is not in the project's targets, a template has no repository, or the plan cannot be chosen, it returns the reason and does not save (409).
- The created task has `start` set to `schedule` in `TaskCreated`, and `schedule` records the scheduled task's ID and the scheduled time (`slot`).
  The recorder (`actor`) is `sacty`.

Code: `apps/daemon/src/service.ts` (`checkScheduledTask`, `createScheduledTask`, `scheduledTask`, `prepareTask`), `packages/core/src/schedules.ts` (`ScheduledTaskSettings`), `packages/core/src/events.ts` (`TaskCreated`)

## How scheduled times are checked

The daemon starts checking scheduled tasks when it starts intake: once right away, then every minute.
A check does not start until the previous one finishes.
After the computer wakes from sleep, the next check (within a minute) catches up.

In a check, for each enabled scheduled task whose project exists, sacty decides whether to create a task.

1. It finds the most recent scheduled time at or before now (the latest time).
2. If the latest time is at or before `since`, or at or before `lastRun.slot`, it does not create one.
3. If any task is due, it checks whether the network is reachable (whether `github.com` resolves, waiting up to 5 seconds).
   If not, it creates none and checks again on the next check.
   If nothing is due, it does not check the network.
4. Before creating, it checks whether the activity log already has the task for that time.
   If so, it does not create one and records that task in `lastRun` (when the daemon stopped after creating the task but before saving `lastRun`).
5. It creates the task and saves the time and the task in `lastRun`.
   If the task could not be created (for example, the project's targets changed), it saves the reason in `lastRun.error` and does not create that time again.

So however many scheduled times were missed while the computer was off or offline, only the latest one is created, and the same time is never created twice.
Scheduled times before creation and while paused are not made up.

Code: `packages/core/src/schedules.ts` (`latestScheduleSlot`, `nextScheduleSlot`, `dueScheduleSlot`), `apps/daemon/src/schedules.ts` (`ScheduledTasks`, `ScheduleRunner`, `networkReachable`), `apps/daemon/src/main.ts`

## API

| API | Content |
| --- | --- |
| `GET /api/projects/:id/schedules` | The project's scheduled tasks (with the next scheduled time `nextRunAt`; absent while paused). 404 if the project does not exist |
| `POST /api/projects/:id/schedules` | Creates one (201) |
| `GET /api/schedules/:id` | The scheduled task and the tasks it created (`tasks`, newest first, excluding tasks of deleted projects) |
| `PUT /api/schedules/:id` | Changes the name, enabled, the schedule, and the contents of the task. If the schedule changed or it was enabled again, `since` becomes now |
| `DELETE /api/schedules/:id` | Deletes it (the tasks it created stay) |

Code: `apps/daemon/src/server.ts` (`createApp`)

## Web UI

- "Schedules" in the side menu goes to the scheduled task list of the displayed project (`/projects/<ID>/schedules`).
- The list shows the name, the schedule, the next run, the last run, and the state (Enabled or Paused).
  "Create scheduled task" opens the create dialog.
- The create and edit dialog has the name, enabled, the schedule (repeat, time, days, day), and the same task fields as "Create task" (template, target repository, plan, title, description).
  The task fields use the same component as "Create task" (`TaskFields`).
  Saving moves to the details.
- The details (`/projects/<ID>/schedules/<scheduled task ID>`) show the settings, the contents of the task, and the list of tasks this scheduled task created (scheduled time, steps, status), and allow editing and deleting.
  If the task for the last time could not be created, it shows the reason.
- The start of such tasks in the task list and details is shown as "Scheduled task".

Code: `apps/web/src/components/shell/rail.tsx` (`railItems`), `apps/web/src/app/projects/[id]/schedules/page.tsx`, `apps/web/src/app/projects/[id]/schedules/[scheduleId]/page.tsx`, `apps/web/src/components/schedule-dialog.tsx` (`ScheduleDialog`, `DeleteScheduleButton`), `apps/web/src/components/new-task-dialog.tsx` (`TaskFields`), `apps/web/src/lib/schedule-form.ts` (`toScheduleInput`, `ruleText`), `apps/web/src/app/actions.ts` (`saveScheduleAction`, `deleteScheduleAction`)
