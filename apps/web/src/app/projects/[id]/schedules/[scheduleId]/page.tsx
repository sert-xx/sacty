import type { ScheduleView, Task } from "@sacty/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CardSection } from "@/components/card-section";
import { DaemonError } from "@/components/daemon-error";
import { DeleteScheduleButton, ScheduleDialog } from "@/components/schedule-dialog";
import { FollowProject } from "@/components/shell/follow-project";
import { StatusLabelView, StepChipsView } from "@/components/task-bits";
import { Hint } from "@/components/ui/hint";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getSchedule, listProjects } from "@/lib/daemon";
import { formatStamp, statusText, statusTone } from "@/lib/labels";
import { projectSchedulesPath, taskPath } from "@/lib/paths";
import { repoNameOf } from "@/lib/repo-name";
import { ruleText } from "@/lib/schedule-form";

/**
 * スケジュールタスクの詳細。設定（予定・作るタスクの内容）と、このスケジュールタスクが作ったタスクの一覧を出す。
 * 編集・削除もここからする。スケジュールタスクが URL のプロジェクトのものでなければ 404。
 */
export default async function SchedulePage({
  params,
}: {
  params: Promise<{ id: string; scheduleId: string }>;
}) {
  const m = (await getMessages()).schedules;
  return (
    <Suspense fallback={<h1 className="text-2xl font-bold">{m.title}</h1>}>
      <Schedule params={params} />
    </Suspense>
  );
}

async function Schedule({ params }: { params: Promise<{ id: string; scheduleId: string }> }) {
  const { id, scheduleId } = await params;
  const messages = await getMessages();
  const { schedules: m, locale, labels } = messages;
  let project: Awaited<ReturnType<typeof listProjects>>[number] | undefined;
  let found: Awaited<ReturnType<typeof getSchedule>>;
  try {
    const [projects, detail] = await Promise.all([listProjects(), getSchedule(scheduleId)]);
    project = projects.find((p) => p.id === id);
    found = detail;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return (
        <>
          <h1 className="text-2xl font-bold">{m.title}</h1>
          <DaemonError message={error.message} />
        </>
      );
    }
    throw error;
  }
  if (!project || !found || found.schedule.projectId !== project.id) notFound();
  const { schedule, tasks } = found;
  return (
    <>
      <FollowProject projectId={id} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link
            href={projectSchedulesPath(project.id)}
            className="text-sm text-muted-foreground hover:underline"
          >
            ← {m.back}
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
            {schedule.name}
            <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              {schedule.enabled ? m.enabled : m.disabled}
            </span>
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* 保存したら作り直す（ダイアログを閉じ、保存した内容を入力の初めの値にする） */}
          <ScheduleDialog
            key={schedule.updatedAt}
            projectId={project.id}
            projectName={project.name}
            hasTargets={project.targets.length > 0}
            schedule={schedule}
          />
          <DeleteScheduleButton projectId={project.id} schedule={schedule} />
        </div>
      </div>
      {schedule.waitingForNetwork && (
        <div
          role="status"
          className="flex items-center gap-1 rounded-xl border border-warn-line bg-warn-soft p-4 text-sm text-warn"
        >
          {m.detail.waitingForNetwork}
          <Hint text={m.detail.waitingForNetworkHint} />
        </div>
      )}
      {schedule.lastRun?.error && (
        <div
          role="alert"
          className="rounded-xl border border-warn-line bg-warn-soft p-4 text-sm text-warn"
        >
          {m.detail.lastError} {labels.text(schedule.lastRun.error)}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <CardSection id="schedule-settings" title={m.detail.settings}>
          <Fields
            rows={[
              [m.column.rule, ruleText(schedule.rule, m)],
              [
                m.column.next,
                schedule.nextRunAt ? formatStamp(schedule.nextRunAt, locale) : m.none,
              ],
              [
                m.column.last,
                schedule.lastRun ? formatStamp(schedule.lastRun.slot, locale) : m.none,
              ],
              [m.detail.createdAt, formatStamp(schedule.createdAt, locale)],
            ]}
          />
        </CardSection>
        <CardSection id="schedule-content" title={m.detail.content}>
          <TaskContent schedule={schedule} messages={messages} />
        </CardSection>
      </div>
      <CardSection id="schedule-tasks" title={m.detail.tasks} note={String(tasks.length)}>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.detail.tasksEmpty}</p>
        ) : (
          <CreatedTasks tasks={tasks} messages={messages} />
        )}
      </CardSection>
    </>
  );
}

type Messages = Awaited<ReturnType<typeof getMessages>>;

function Fields({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="[overflow-wrap:anywhere] whitespace-pre-wrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 作るタスクの内容（タスクの作成のダイアログの項目）。 */
function TaskContent({ schedule, messages }: { schedule: ScheduleView; messages: Messages }) {
  const m = messages.schedules.detail;
  const { task } = schedule;
  const repo = task.repo ?? m.noRepository;
  if (task.template) {
    return (
      <Fields
        rows={[
          [m.template, messages.labels.template[task.template]],
          [m.repository, repo],
        ]}
      />
    );
  }
  return (
    <Fields
      rows={[
        [m.taskTitle, task.title],
        [m.repository, repo],
        [m.plan, task.plan ? messages.labels.plan[task.plan] : m.planAuto],
        ...(task.body ? [[m.body, task.body] as [string, string]] : []),
      ]}
    />
  );
}

/** このスケジュールタスクが作ったタスク（新しい順）。 */
function CreatedTasks({ tasks, messages }: { tasks: Task[]; messages: Messages }) {
  const { tasks: t, labels, locale, schedules: m } = messages;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2.5 pr-3 font-medium">
              {t.column.task}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {m.detail.slot}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t.column.steps}
            </th>
            <th scope="col" className="py-2.5 pl-3 font-medium">
              {t.column.status}
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const { repoName } = repoNameOf(task);
            return (
              <tr
                key={task.id}
                className="border-t border-border hover:bg-muted"
                data-testid={`schedule-task-${task.id}`}
              >
                <td className="py-3 pr-3">
                  <Link
                    href={taskPath(task.id)}
                    className="font-medium text-foreground hover:underline"
                  >
                    {task.title}
                  </Link>
                  {repoName && (
                    <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                      {repoName}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                  {formatStamp(task.schedule?.slot ?? task.createdAt, locale)}
                </td>
                <td className="px-3 py-3">
                  <StepChipsView steps={task.steps} />
                </td>
                <td className="py-3 pl-3">
                  <StatusLabelView text={statusText(task, labels)} tone={statusTone(task)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
