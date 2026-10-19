<!-- Code: apps/web/src/components/dashboard.tsx, apps/web/src/lib/dashboard-data.ts, apps/web/src/i18n/messages/dashboard.ts, packages/core/src/dashboard.ts, apps/daemon/src/service.ts -->

[日本語](dashboard.md) | **English**

# Reading the dashboard

The dashboard (`/dashboard`) shows, across all projects, what needs you, how the factory is doing, the cost, and the quality in one place.
You can act here before opening individual tasks. While it is open, it updates to the latest state without reloading the screen ([Working with tasks](tasks.en.md)).

Hover over or tap the mark (i) next to a heading to see what the numbers mean and where the periods start.

## Sections

| Section | What it shows | When empty |
| --- | --- | --- |
| Needs you | Tasks awaiting approval, paused, or escalated, longest wait first. Press a title to go to the screen where you decide | "Nothing needs you right now." |
| Why tasks are paused | Paused tasks counted by reason. Press a row to expand that reason's tasks inside the section. Usage limit and authentication are highlighted because one fix usually resumes all of them | "No tasks are paused." |
| Open tasks | All tasks except completed and cancelled ones. With more than 5 tasks, the section scrolls inside | "There are no open tasks." |
| Cost and budget | The cost for today and the last 7 days, billed and estimated separately. Also the tasks that used 80% or more of their budget or reached the cap | "No task is near its budget." |
| Step queue | The number of running tasks against the parallel limit, and the number of tasks waiting to run. When more tasks than the limit have been waiting for 10 minutes, it is highlighted with a link to the Sacty settings | 0 |
| Intake | For issues, PR reviews, and tickets: the time of the last intake, how many tasks it created, and what could not be imported. "Run intake now" is also here | That intake is not set or cannot be read, with a link to the Sacty settings |
| Throughput | Completed and cancelled counts for the last 7 and 30 days, and the median time from creation to completion | 0 and "—" |
| Quality signals | For the last 30 days: changes requested by a person, rework from PR feedback, goal guardian misses, integration review failures, fix tasks from the post-merge watch, and rework counted by step | 0 times |
| Audit | Per project, the causes, recurred and needing-decision counts and the adoption rate, and, per week, the changes requested and PR remarks per task. Press a project name to open its audit page ([Audits](audit.en.md)). The card is hidden when the audit data cannot be read | "No audit results yet." |

Sections sit side by side when there is room and stack otherwise. The same sections appear at phone width.

## Periods and counting

- "Today", "last 7 days", and "last 30 days" are split by the date of the machine running sacty, not by the UI language. The last 7 and 30 days include today.
- The cost includes completed and cancelled tasks. An estimate is a converted value (such as a subscription), not an actual charge.
- The waiting time counts from the record that made the task await approval, pause, or escalate.
- Tasks of deleted projects are neither shown nor counted in any section.
- If the daemon cannot be reached when you open the page, the error is shown instead of the sections. The sections appear once it can be reached.
- If the daemon becomes unreachable after the sections were shown, they keep what was last fetched and a notice above them says updates are
  paused. Even though the sections are visible, their numbers are not current during that time. Updates resume once it can be reached.

## Related pages

- [Getting started](getting-started.en.md)
- [Working with tasks](tasks.en.md)
- [Intake of issues, PRs, and tickets](intake.en.md)
- [config.yaml settings](config.en.md)
