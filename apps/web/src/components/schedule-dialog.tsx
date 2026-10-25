"use client";

import type { ScheduleView, StepPlan, TaskTemplate } from "@sacty/core";
import { useActionState, useState } from "react";
import {
  type DeleteScheduleState,
  deleteScheduleAction,
  type ScheduleFormState,
  saveScheduleAction,
} from "@/app/actions";
import { CandidatesProblems, TaskFields } from "@/components/new-task-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";
import { candidatesLoader, type RepositoryCandidates } from "@/lib/repository-candidates";
import {
  EMPTY_SCHEDULE_FORM,
  type ScheduleFormValues,
  scheduleFormValues,
} from "@/lib/schedule-form";

const initial: ScheduleFormState = {};

const SELECT =
  "h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** 項目の誤り（あれば項目の下に出す）。 */
function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} className="text-sm text-warn">
      {text}
    </p>
  );
}

/**
 * スケジュールタスクの作成（schedule が無いとき）と編集のダイアログ。作るタスクの内容は、タスクの作成のダイアログと同じ
 * 項目（テンプレート・対象リポジトリ・進め方・題・内容）で、それに名前・有効・予定を足す。
 */
export function ScheduleDialog({
  projectId,
  projectName,
  hasTargets,
  schedule,
}: {
  projectId: string;
  projectName: string;
  hasTargets: boolean;
  schedule?: ScheduleView;
}) {
  const [state, formAction, pending] = useActionState(saveScheduleAction, initial);
  const messages = useMessages();
  const t = messages.schedules.form;
  const task = messages.forms.task;
  const saved = schedule ? scheduleFormValues(schedule) : EMPTY_SCHEDULE_FORM;
  // 送信して理由を返したときは、入力した値のまま直せるようにする
  const values: ScheduleFormValues = state.values ?? saved;
  const errors = state.fieldErrors ?? {};
  const [candidates, setCandidates] = useState<RepositoryCandidates>({ status: "loading" });
  const [loadCandidates] = useState(() => candidatesLoader());
  const [kind, setKind] = useState(values.kind);
  const [template, setTemplate] = useState<TaskTemplate | "">(values.template);
  const [plan, setPlan] = useState<StepPlan | "">(values.plan);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) return;
        setKind(saved.kind);
        setTemplate(saved.template);
        setPlan(saved.plan);
        loadCandidates(projectId, hasTargets, task.repositoriesNoAnswer, setCandidates);
      }}
    >
      <DialogTrigger
        render={
          <Button size={schedule ? "default" : "lg"} variant={schedule ? "outline" : "default"} />
        }
      >
        {schedule ? t.edit : t.create}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="projectId" value={projectId} />
          {schedule && <input type="hidden" name="scheduleId" value={schedule.id} />}
          <DialogHeader>
            <DialogTitle>{schedule ? t.editTitle : t.create}</DialogTitle>
            <DialogDescription>{task.description(projectName)}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="schedule-name">{t.name}</Label>
            <Input
              id="schedule-name"
              name="name"
              defaultValue={values.name}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "schedule-name-error" : undefined}
              autoFocus
            />
            <FieldError id="schedule-name-error" text={errors.name} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={values.enabled} />
            {t.enabled}
            <Hint text={t.enabledHint} />
          </label>
          <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">{t.schedule}</legend>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="schedule-kind">{t.kind}</Label>
                <select
                  id="schedule-kind"
                  name="kind"
                  className={SELECT}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ScheduleFormValues["kind"])}
                >
                  <option value="daily">{t.kindDaily}</option>
                  <option value="weekly">{t.kindWeekly}</option>
                  <option value="monthly">{t.kindMonthly}</option>
                </select>
              </div>
              {kind === "monthly" && (
                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-1">
                    <Label htmlFor="schedule-day">{t.day}</Label>
                    <Hint text={t.dayHint} />
                  </span>
                  <Input
                    id="schedule-day"
                    name="day"
                    type="number"
                    min={1}
                    max={31}
                    defaultValue={values.day}
                    className="w-20"
                    aria-invalid={Boolean(errors.day)}
                    aria-describedby={errors.day ? "schedule-day-error" : undefined}
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-1">
                  <Label htmlFor="schedule-time">{t.time}</Label>
                  <Hint text={t.timeHint} />
                </span>
                <Input
                  id="schedule-time"
                  name="time"
                  type="time"
                  required
                  defaultValue={values.time}
                  className="w-32"
                  aria-invalid={Boolean(errors.time)}
                  aria-describedby={errors.time ? "schedule-time-error" : undefined}
                />
              </div>
            </div>
            {kind === "weekly" && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">{t.days}</legend>
                <div className="flex flex-wrap gap-3">
                  {messages.schedules.weekdays.map((label, day) => (
                    <label key={label} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        name="days"
                        value={day}
                        defaultChecked={values.days.includes(day)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <FieldError id="schedule-day-error" text={errors.day} />
            <FieldError id="schedule-time-error" text={errors.time} />
            <FieldError id="schedule-days-error" text={errors.days} />
          </fieldset>
          <fieldset className="flex flex-col gap-4 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">{t.taskSection}</legend>
            {hasTargets && <CandidatesProblems candidates={candidates} />}
            <TaskFields
              idPrefix="schedule-task"
              projectId={projectId}
              hasTargets={hasTargets}
              candidates={candidates}
              template={template}
              onTemplate={setTemplate}
              plan={plan}
              onPlan={setPlan}
              repoDefault={values.repo}
              titleDefault={values.title}
              bodyDefault={values.body}
              titleError={errors.title}
              bodyError={errors.body}
            />
          </fieldset>
          {state.message && (
            <p role="alert" className="text-sm text-warn">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {task.close}
            </DialogClose>
            <Button type="submit" disabled={pending || !hasTargets}>
              {pending ? t.saving : schedule ? t.submitEdit : t.submitCreate}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const deleteInitial: DeleteScheduleState = {};

/** スケジュールタスクの削除（確かめるダイアログを出す。作ったタスクは残る）。 */
export function DeleteScheduleButton({
  projectId,
  schedule,
}: {
  projectId: string;
  schedule: Pick<ScheduleView, "id" | "name">;
}) {
  const t = useMessages().schedules.delete;
  const close = useMessages().forms.task.close;
  const [state, formAction, pending] = useActionState(deleteScheduleAction, deleteInitial);
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>{t.open}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="scheduleId" value={schedule.id} />
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription>{t.confirm(schedule.name)}</DialogDescription>
          </DialogHeader>
          {state.message && (
            <p role="alert" className="text-sm text-warn">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>{close}</DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? t.deleting : t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
