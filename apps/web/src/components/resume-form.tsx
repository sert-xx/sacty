"use client";

import { type PauseReason, RESUME_NOTE_MAX, type StepKey } from "@sacty/core";
import { useActionState, useState } from "react";
import { type ResumeState, resumeTaskAction, submitForReviewAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";
import { usd } from "@/lib/labels";

const initial: ResumeState = {};

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-border bg-card px-2 font-mono text-sm disabled:opacity-60";

/**
 * 再開と一緒に変えられる工程の設定の1行（まだ終わっていない工程）。options が undefined なら、候補を確かめられない
 * （設定を読めない）ので選ばせない。agent が undefined の工程（統合レビュー）は、エージェントを変えられない。
 */
export type ResumeStepSetting = {
  step: StepKey;
  image: string;
  imageOptions?: { name: string; description: string }[];
  agent?: { current?: string; options?: { id: string }[] };
};

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
  toReview = false,
  steps = [],
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
  /** 実装の検証が続けて通らずに止まったタスク。人の判断で、レビュー（実装の承認）へ進められる。 */
  toReview?: boolean;
  /** 再開と一緒にイメージ・エージェントを変えられる工程（まだ終わっていない工程）。 */
  steps?: ResumeStepSetting[];
}) {
  const m = useMessages();
  const [state, formAction, pending] = useActionState(resumeTaskAction, initial);
  const needsCap = reason === "budget";
  const suggested = Math.max(capUsd * 2, Math.ceil(usedUsd) + 1);
  const r = m.parts.resume;
  const t = r.tests;
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
        <div className="flex w-full flex-col gap-1.5">
          <span className="flex items-center gap-1">
            <Label htmlFor="resume-note">{r.noteLabel}</Label>
            <Hint text={r.noteHint} />
          </span>
          <Textarea
            id="resume-note"
            name="note"
            maxLength={RESUME_NOTE_MAX}
            rows={3}
            defaultValue={state.note ?? ""}
            placeholder={r.notePlaceholder}
            className="bg-card"
            data-testid="resume-note"
          />
        </div>
        {steps.length > 0 && (
          <ResumeStepSettings
            steps={steps}
            rechoose={Boolean(tests?.rechoose) && testsChoice === ""}
          />
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
      {toReview && <ToReviewForm taskId={taskId} />}
    </section>
  );
}

/**
 * 再開と一緒に変える工程のイメージ・エージェント。普段は変えないので、折りたたんで出す。選択は非制御のまま（自動の更新で、
 * 選んでいる途中の値を消さない）、今の名前を初めに選んでおく（今と同じ名前はデーモンが変えない）。今の名前が候補から
 * 消えていたら、空の選択にして送らない（選び直してもらう）。工程の選択からやり直すときは、変えられないことだけを出す。
 */
function ResumeStepSettings({
  steps,
  rechoose,
}: {
  steps: ResumeStepSetting[];
  rechoose: boolean;
}) {
  const m = useMessages();
  const r = m.parts.resume;
  const unavailable = steps.some(
    (s) => !s.imageOptions || (s.agent !== undefined && !s.agent.options),
  );
  return (
    <details
      className="w-full rounded-md border border-warn-line bg-card"
      data-testid="resume-steps"
    >
      <summary className="flex min-h-9 cursor-pointer items-center gap-1 px-3 text-sm font-medium">
        {r.stepsTitle} <Hint text={r.stepsHint} />
      </summary>
      <div className="flex flex-col gap-2 border-t border-warn-line p-3">
        {rechoose ? (
          <p className="text-sm text-muted-foreground" data-testid="resume-steps-rechoose">
            {r.stepsRechoose}
          </p>
        ) : (
          <>
            {unavailable && (
              <p role="status" className="text-xs text-warn">
                {r.stepsUnavailable}
              </p>
            )}
            <div
              aria-hidden="true"
              className="hidden grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-2 text-xs font-medium text-muted-foreground sm:grid"
            >
              <span />
              <span>{r.stepImage}</span>
              <span>{r.stepAgent}</span>
            </div>
            <ul className="flex flex-col gap-2">
              {steps.map((s) => {
                const label = m.labels.step[s.step];
                const imageKnown = s.imageOptions?.some((o) => o.name === s.image);
                const agentCurrent = s.agent?.current;
                const agentKnown = s.agent?.options?.some((o) => o.id === agentCurrent);
                return (
                  <li
                    key={s.step}
                    className="grid grid-cols-2 items-center gap-x-2 gap-y-1 sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]"
                    data-testid={`resume-step-${s.step}`}
                  >
                    <span className="col-span-2 text-sm font-medium sm:col-span-1">{label}</span>
                    {s.imageOptions ? (
                      <select
                        name={`image:${s.step}`}
                        defaultValue={imageKnown ? s.image : ""}
                        aria-label={m.task.images.label(label)}
                        data-testid={`resume-step-image-${s.step}`}
                        className={SELECT}
                      >
                        {!imageKnown && (
                          <option value="" disabled>
                            {s.image}
                          </option>
                        )}
                        {s.imageOptions.map((o) => (
                          <option key={o.name} value={o.name} title={o.description}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-mono text-sm">{s.image}</span>
                    )}
                    {s.agent?.options ? (
                      <select
                        name={`agent:${s.step}`}
                        defaultValue={agentKnown ? agentCurrent : ""}
                        aria-label={m.task.agents.label(label)}
                        data-testid={`resume-step-agent-${s.step}`}
                        className={SELECT}
                      >
                        {!agentKnown && (
                          <option value="" disabled>
                            {agentCurrent ?? m.task.agents.unknown}
                          </option>
                        )}
                        {s.agent.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.id}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-mono text-sm text-muted-foreground">
                        {s.agent ? (agentCurrent ?? m.task.agents.unknown) : "—"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

/** 実装の検証が続けて通らずに止まったタスクを、人の判断でレビューへ進める。 */
function ToReviewForm({ taskId }: { taskId: string }) {
  const m = useMessages();
  const [state, formAction, pending] = useActionState(submitForReviewAction, {});
  const r = m.parts.resume;
  return (
    <form action={formAction} className="flex flex-col gap-2 border-t border-warn-line pt-3">
      <input type="hidden" name="taskId" value={taskId} />
      <p className="flex items-center gap-1 text-sm leading-6">
        {r.toReviewHelp} <Hint text={r.toReviewHint} />
      </p>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? r.toReviewing : r.toReview}
        </Button>
      </div>
      {state.message && (
        <p role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
