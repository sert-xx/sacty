"use client";

import { DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS_LIMIT } from "@sacty/core";
import { startTransition, useActionState, useId, useState } from "react";
import { type SaveSettingsState, saveSettingsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";

const initial: SaveSettingsState = {};

/** sacty 全体の設定の編集（取り込むラベル。PBI-26。同時に実行するタスクの数。PBI-30）。 */
export function SettingsForm({
  intakeLabel,
  maxParallelTasks,
}: {
  intakeLabel: string;
  /** 設定していなければ undefined（既定の数で実行する）。 */
  maxParallelTasks?: number;
}) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, initial);
  const t = useMessages().settings;
  const uid = useId();
  const [label, setLabel] = useState(intakeLabel);
  const [parallel, setParallel] = useState(
    maxParallelTasks === undefined ? "" : String(maxParallelTasks),
  );
  return (
    <form
      // 送信は自分で呼び出す（action に渡すと、送信の後に React がフォームをリセットするため）
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className="flex flex-col gap-6"
    >
      <section
        aria-labelledby={`${uid}-intake`}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
      >
        <h2 id={`${uid}-intake`} className="text-[15px] font-semibold">
          {t.intakeTitle}{" "}
          <span className="text-[13px] font-normal text-muted-foreground">{t.intakeNote}</span>
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-label`}>{t.intakeLabel}</Label>
          <Input
            id={`${uid}-label`}
            name="intakeLabel"
            value={label}
            maxLength={50}
            placeholder={t.intakePlaceholder}
            onChange={(e) => setLabel(e.target.value)}
            className="max-w-xs"
          />
        </div>
        <p className="text-xs leading-5 text-muted-foreground whitespace-pre-line">
          {t.intakeHelp}
        </p>
        <p className={intakeLabel ? "text-sm" : "text-sm text-warn"}>
          {intakeLabel ? t.intakeOn(intakeLabel) : t.intakeOff}
        </p>
      </section>
      <section
        aria-labelledby={`${uid}-parallel`}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
      >
        <h2 id={`${uid}-parallel`} className="text-[15px] font-semibold">
          {t.parallelTitle}{" "}
          <span className="text-[13px] font-normal text-muted-foreground">{t.parallelNote}</span>
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-parallel-input`}>{t.parallelLabel}</Label>
          <Input
            id={`${uid}-parallel-input`}
            name="maxParallelTasks"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_PARALLEL_TASKS_LIMIT}
            step={1}
            value={parallel}
            placeholder={String(DEFAULT_MAX_PARALLEL_TASKS)}
            onChange={(e) => setParallel(e.target.value)}
            className="max-w-32"
          />
        </div>
        <p className="text-xs leading-5 whitespace-pre-line text-muted-foreground">
          {t.parallelHelp(DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS_LIMIT)}
        </p>
        <p className="text-sm">
          {t.parallelCurrent(
            maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS,
            maxParallelTasks === undefined,
          )}
        </p>
      </section>
      {state.message && (
        <p role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
      {state.saved && !state.message && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.saved}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-fit">
        {t.save}
      </Button>
    </form>
  );
}
