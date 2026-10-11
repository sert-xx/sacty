"use client";

import { startTransition, useActionState, useId, useState } from "react";
import { type SaveSettingsState, saveSettingsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";

const initial: SaveSettingsState = {};

/** sacty 全体の設定の編集（取り込むラベル。PBI-26）。 */
export function SettingsForm({ intakeLabel }: { intakeLabel: string }) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, initial);
  const t = useMessages().settings;
  const uid = useId();
  const [label, setLabel] = useState(intakeLabel);
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
        <p className="text-xs leading-5 text-muted-foreground">{t.intakeHelp}</p>
        <p className={intakeLabel ? "text-sm" : "text-sm text-warn"}>
          {intakeLabel ? t.intakeOn(intakeLabel) : t.intakeOff}
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
