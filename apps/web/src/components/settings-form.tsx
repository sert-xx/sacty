"use client";

import {
  DEFAULT_INTAKE_INTERVAL_SEC,
  DEFAULT_MAX_PARALLEL_TASKS,
  MAX_PARALLEL_TASKS_LIMIT,
  MIN_INTAKE_INTERVAL_SEC,
  type SlackNotification,
} from "@sacty/core";
import { startTransition, useActionState, useId, useState } from "react";
import { type SaveSettingsState, saveSettingsAction } from "@/app/actions";
import { NotificationSettings } from "@/components/notification-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";

const initial: SaveSettingsState = {};

/**
 * sacty 全体の設定の編集（取り込むラベル。PBI-26。同時に実行するタスクの数。PBI-30）。取り込みは「Issue の取り込み」と
 * 「PR のレビューの取り込み」に分ける（PR を取り込むのはレビューだけ。PBI-99）。取り込みの間隔は種類ごと（PBI-100）。
 * Slack の通知先も、ここで設定する（PBI-115。以前はプロジェクトごと）。
 */
export function SettingsForm({
  intakeLabel,
  reviewLabel: savedReviewLabel,
  reviewRequested: savedReviewRequested,
  triageOff = [],
  ticketLabel: savedTicketLabel = "",
  maxParallelTasks,
  issueIntervalSec,
  reviewIntervalSec,
  ticketIntervalSec,
  notification,
  notificationProblems = [],
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
  /** 取り込みの種類ごとの間隔（秒。PBI-100）。設定していなければ undefined（既定の間隔）。 */
  issueIntervalSec?: number;
  reviewIntervalSec?: number;
  ticketIntervalSec?: number;
  /** Slack の通知先（PBI-115）。設定していなければ undefined（通知しない）。 */
  notification?: SlackNotification;
  /** Slack の通知を送れなかった理由（画面の言語の文。PBI-115）。 */
  notificationProblems?: string[];
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
  const [intervals, setIntervals] = useState({
    issueIntervalSec: issueIntervalSec === undefined ? "" : String(issueIntervalSec),
    reviewIntervalSec: reviewIntervalSec === undefined ? "" : String(reviewIntervalSec),
    ticketIntervalSec: ticketIntervalSec === undefined ? "" : String(ticketIntervalSec),
  });
  // 取り込みの間隔（PBI-100）。空なら既定の間隔
  // 取り込みが止まっている（ラベルが無いか Off）種類は、「始めると」の文にする（止まっている表示と食い違わないように）
  const interval = (name: keyof typeof intervals, saved: number | undefined, running: boolean) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${uid}-${name}`}>{t.intervalLabel}</Label>
      <Input
        id={`${uid}-${name}`}
        name={name}
        type="number"
        inputMode="numeric"
        min={MIN_INTAKE_INTERVAL_SEC}
        step={1}
        value={intervals[name]}
        placeholder={String(DEFAULT_INTAKE_INTERVAL_SEC)}
        onChange={(e) => setIntervals((current) => ({ ...current, [name]: e.target.value }))}
        className="max-w-32"
      />
      <p className="text-sm text-muted-foreground">
        {t.intervalHelp(MIN_INTAKE_INTERVAL_SEC, DEFAULT_INTAKE_INTERVAL_SEC)}{" "}
        {(running ? t.intervalCurrent : t.intervalWhenOn)(
          saved ?? DEFAULT_INTAKE_INTERVAL_SEC,
          saved === undefined,
        )}
      </p>
    </div>
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
      // 入力の誤りは、ブラウザの言語ではなく画面の言語の文で出す（デーモンが検査する。PBI-100）
      noValidate
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
        {interval("issueIntervalSec", issueIntervalSec, Boolean(intakeLabel) && savedOn.issues)}
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
        {interval(
          "reviewIntervalSec",
          reviewIntervalSec,
          savedReviewRequested || (Boolean(savedReviewLabel) && savedOn.reviewLabel),
        )}
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
        {interval(
          "ticketIntervalSec",
          ticketIntervalSec,
          Boolean(savedTicketLabel) && savedOn.tickets,
        )}
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
      <NotificationSettings saved={notification} problems={notificationProblems} />
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
