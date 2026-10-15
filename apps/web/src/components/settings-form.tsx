"use client";

import { DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS_LIMIT } from "@sacty/core";
import { startTransition, useActionState, useId, useState } from "react";
import { type SaveSettingsState, saveSettingsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";

const initial: SaveSettingsState = {};

/**
 * sacty 全体の設定の編集（取り込むラベル。PBI-26。同時に実行するタスクの数。PBI-30）。取り込みは「Issue の取り込み」と
 * 「PR のレビューの取り込み」に分ける（PR を取り込むのはレビューだけ。PBI-99）。
 */
export function SettingsForm({
  intakeLabel,
  reviewLabel: savedReviewLabel,
  reviewRequested: savedReviewRequested,
  triageOff = [],
  ticketLabel: savedTicketLabel = "",
  maxParallelTasks,
}: {
  intakeLabel: string;
  /** PR のレビューの取り込み（PBI-44）。 */
  reviewLabel: string;
  reviewRequested: boolean;
  /** Off にしたトリアージの種類（PBI-53）。 */
  triageOff?: string[];
  /** チケットの取り込むラベル（PBI-52）。 */
  ticketLabel?: string;
  /** 設定していなければ undefined（既定の数で実行する）。 */
  maxParallelTasks?: number;
}) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, initial);
  const t = useMessages().settings;
  const uid = useId();
  const [label, setLabel] = useState(intakeLabel);
  const [reviewLabel, setReviewLabel] = useState(savedReviewLabel);
  const [reviewRequested, setReviewRequested] = useState(savedReviewRequested);
  // トリアージの種類ごとの On/Off（PBI-53）。ラベルは残したまま Off にできる
  const savedOn = {
    issues: !triageOff.includes("issues"),
    reviewLabel: !triageOff.includes("reviewLabel"),
    tickets: !triageOff.includes("tickets"),
  };
  const [on, setOn] = useState(savedOn);
  const [ticketLabel, setTicketLabel] = useState(savedTicketLabel);
  const toggle = (kind: keyof typeof on, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={`triage-${kind}`}
        checked={on[kind]}
        onChange={(e) => setOn((current) => ({ ...current, [kind]: e.target.checked }))}
        className="size-4"
      />
      {label}
    </label>
  );
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
        <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
          {t.intakeHelp}
        </p>
        {toggle("issues", t.triageIssues)}
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
        <p className={intakeLabel && savedOn.issues ? "text-sm" : "text-sm text-warn"}>
          {intakeLabel && savedOn.issues ? t.intakeOn(intakeLabel) : t.intakeOff}
        </p>
      </section>
      <section
        aria-labelledby={`${uid}-review`}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
      >
        <h2 id={`${uid}-review`} className="text-[15px] font-semibold">
          {t.reviewTitle}{" "}
          <span className="text-[13px] font-normal text-muted-foreground">{t.reviewNote}</span>
        </h2>
        <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
          {t.reviewHelp}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="reviewRequested"
            checked={reviewRequested}
            onChange={(e) => setReviewRequested(e.target.checked)}
            className="size-4"
          />
          {t.reviewRequested}
        </label>
        {toggle("reviewLabel", t.triageReviewLabel)}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-review-label`}>{t.reviewLabel}</Label>
          <Input
            id={`${uid}-review-label`}
            name="reviewLabel"
            value={reviewLabel}
            maxLength={50}
            placeholder={t.reviewPlaceholder}
            onChange={(e) => setReviewLabel(e.target.value)}
            className="max-w-xs"
          />
        </div>
        <p
          className={
            savedReviewRequested || (savedReviewLabel && savedOn.reviewLabel)
              ? "text-sm"
              : "text-sm text-muted-foreground"
          }
        >
          {savedReviewRequested || (savedReviewLabel && savedOn.reviewLabel)
            ? t.reviewOn(savedReviewRequested, savedOn.reviewLabel ? savedReviewLabel : "")
            : t.reviewOff}
        </p>
      </section>
      <section
        aria-labelledby={`${uid}-tickets`}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
      >
        <h2 id={`${uid}-tickets`} className="text-[15px] font-semibold">
          {t.ticketsTitle}{" "}
          <span className="text-[13px] font-normal text-muted-foreground">{t.ticketsNote}</span>
        </h2>
        <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
          {t.ticketsHelp}
        </p>
        {toggle("tickets", t.triageTickets)}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-ticket-label`}>{t.ticketLabel}</Label>
          <Input
            id={`${uid}-ticket-label`}
            name="ticketLabel"
            value={ticketLabel}
            maxLength={50}
            placeholder={t.intakePlaceholder}
            onChange={(e) => setTicketLabel(e.target.value)}
            className="max-w-xs"
          />
        </div>
        <p
          className={
            savedTicketLabel && savedOn.tickets ? "text-sm" : "text-sm text-muted-foreground"
          }
        >
          {savedTicketLabel && savedOn.tickets ? t.ticketsOn(savedTicketLabel) : t.ticketsOff}
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
        <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
          {t.parallelHelp(DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS_LIMIT)}
        </p>
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
