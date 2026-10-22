"use client";

import type { PauseReason } from "@sacty/core";
import { useActionState, useState } from "react";
import { type ResumeState, resumeTaskAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";
import { usd } from "@/lib/labels";

const initial: ResumeState = {};

export function ResumeForm({
  taskId,
  reason,
  usedUsd,
  capUsd,
  lastFailure,
  repositories,
  repoLabel,
  repoOptional = false,
  chosenRepo,
  tests,
}: {
  taskId: string;
  reason: PauseReason;
  usedUsd: number;
  capUsd: number;
  lastFailure?: string;
  /** チケットのタスクで、リポジトリが決まっていなければ、選べる候補（PBI-52）。 */
  repositories?: string[];
  /** 前に人が選んだリポジトリ（選び直せる）。 */
  chosenRepo?: string;
  /** リポジトリの選択の見出し（チケットのタスクか、リポジトリを指定せずに作ったタスクか。PBI-73）。 */
  repoLabel?: string;
  /**
   * リポジトリを選ばずにも再開できる（PBI-73。リポジトリを指定せずに作ったタスク。選ばなければ、オーケストレーターが
   * もう一度決める・決めたリポジトリのまま再開する）。
   */
  repoOptional?: boolean;
  /**
   * テストのコマンドが決まらずに止まったタスク。再開のときに、テストのコマンドを指定するか、テストなしで進めるかを選べる。
   * bugfix：不具合の修正（テストなしにできない）。rechoose：決めずに再開すると、工程の選択からやり直す。
   */
  tests?: { bugfix: boolean; rechoose: boolean };
}) {
  const m = useMessages();
  const [state, formAction, pending] = useActionState(resumeTaskAction, initial);
  const needsCap = reason === "budget";
  const suggested = Math.max(capUsd * 2, Math.ceil(usedUsd) + 1);
  const t = m.parts.resume.tests;
  const [testsChoice, setTestsChoice] = useState<"" | "command" | "none">(state.tests ?? "");

  return (
    <section
      aria-labelledby="paused"
      className="flex flex-col gap-3 rounded-xl border border-warn-line bg-warn-soft p-5"
    >
      <h2 id="paused" className="text-[15px] font-semibold text-warn">
        {m.labels.pause[reason]}
      </h2>
      <p className="text-sm leading-6">{m.labels.pauseHelp[reason]}</p>
      {lastFailure && (
        <p className="rounded-md bg-card px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
          {lastFailure}
        </p>
      )}
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="taskId" value={taskId} />
        {repositories && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="flex items-center gap-1">
              <Label htmlFor="ticket-repo">{repoLabel ?? m.parts.resume.ticketRepo}</Label>
              {repoOptional && <Hint text={m.parts.resume.repoKeepHint} />}
            </span>
            {repositories.length > 0 ? (
              <select
                id="ticket-repo"
                name="repo"
                required={!repoOptional}
                defaultValue={chosenRepo ?? ""}
                className="h-9 max-w-full rounded-md border border-border bg-card px-2 font-mono text-sm"
              >
                {repoOptional && <option value="">{m.parts.resume.repoKeep}</option>}
                {repositories.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-warn">{m.parts.resume.ticketNoRepo}</p>
            )}
          </div>
        )}
        {tests && (
          <fieldset className="flex w-full flex-col gap-1.5">
            <legend className="pb-1 text-sm font-medium">{t.legend}</legend>
            <label className="flex min-h-9 items-start gap-2 text-sm leading-6">
              <input
                type="radio"
                name="tests"
                value=""
                checked={testsChoice === ""}
                onChange={() => setTestsChoice("")}
                className="mt-1.5 size-4 accent-primary"
              />
              <span>
                {t.keep} {tests.rechoose && <Hint text={t.keepRechooseHint} />}
              </span>
            </label>
            <label className="flex min-h-9 items-start gap-2 text-sm leading-6">
              <input
                type="radio"
                name="tests"
                value="command"
                checked={testsChoice === "command"}
                onChange={() => setTestsChoice("command")}
                className="mt-1.5 size-4 accent-primary"
              />
              <span>{t.command}</span>
            </label>
            {testsChoice === "command" && (
              <div className="flex flex-col gap-1.5 pl-6">
                <span className="flex items-center gap-1">
                  <Label htmlFor="test-command">{t.commandLabel}</Label>
                  <Hint text={t.commandHint} />
                </span>
                <Input
                  id="test-command"
                  name="testCommand"
                  required
                  maxLength={1000}
                  defaultValue={state.testCommand ?? ""}
                  placeholder="npm ci && npm test"
                  className="bg-card font-mono"
                />
              </div>
            )}
            <label className="flex min-h-9 items-start gap-2 text-sm leading-6">
              <input
                type="radio"
                name="tests"
                value="none"
                disabled={tests.bugfix}
                checked={testsChoice === "none"}
                onChange={() => setTestsChoice("none")}
                className="mt-1.5 size-4 accent-primary"
              />
              <span>
                {t.none} <Hint text={t.noneHint} />
                {tests.bugfix && (
                  <span className="block text-xs text-muted-foreground">{t.noneBugfix}</span>
                )}
              </span>
            </label>
            {testsChoice === "none" && (
              <div className="flex flex-col gap-1.5 pl-6">
                <span className="flex items-center gap-1">
                  <Label htmlFor="no-tests-reason">{t.reasonLabel}</Label>
                  <Hint text={t.reasonHint} />
                </span>
                <Textarea
                  id="no-tests-reason"
                  name="noTestsReason"
                  required
                  maxLength={2000}
                  rows={2}
                  defaultValue={state.noTestsReason ?? t.reasonDefault}
                  className="bg-card"
                />
              </div>
            )}
          </fieldset>
        )}
        {needsCap && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-usd">{m.parts.resume.newCap(usd(usedUsd))}</Label>
            <div className="flex items-center gap-2">
              <span className="font-mono">$</span>
              <Input
                id="cap-usd"
                name="capUsd"
                type="number"
                step="0.01"
                min={0.01}
                required
                defaultValue={state.capUsd ?? String(suggested)}
                className="w-32 bg-card font-mono"
                aria-invalid={Boolean(state.message)}
                aria-describedby={state.message ? "resume-error" : undefined}
              />
            </div>
          </div>
        )}
        <Button type="submit" disabled={pending || (!repoOptional && repositories?.length === 0)}>
          {pending
            ? m.parts.resume.resuming
            : needsCap
              ? m.parts.resume.resumeWithCap
              : m.parts.resume.resume}
        </Button>
      </form>
      {state.message && (
        <p id="resume-error" role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
      {needsCap && <p className="text-xs text-muted-foreground">{m.parts.resume.capNote}</p>}
    </section>
  );
}
