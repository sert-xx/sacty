"use client";

import type { StepKey, StepPlan } from "@sacty/core";
import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { Ref } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import { planStepSettings, type StepChoices, type StepOptions } from "@/lib/step-options";

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60";

/**
 * タスクの作成のダイアログの、基本の入力に置く進め方の工程の並び。工程ごとに指定したものに印を付け、指定の要約と、
 * 工程ごとの設定を開くボタンを出す（工程ごとの選択肢そのものは、別の画面に分けて、基本の入力を短く保つ）。
 */
export function StepFlowSummary({
  id,
  plan,
  customized,
  onOpen,
  openRef,
}: {
  id: string;
  plan: StepPlan;
  customized: readonly StepKey[];
  onOpen: () => void;
  openRef?: Ref<HTMLButtonElement>;
}) {
  const messages = useMessages();
  const t = messages.forms.task;
  return (
    <div
      id={id}
      data-testid="step-flow"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2.5"
    >
      <ol className="flex flex-wrap items-center gap-1 text-xs">
        {planStepSettings(plan).map(({ step }, i) => {
          const custom = customized.includes(step);
          return (
            <li key={step} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden="true" className="text-muted-foreground">
                  →
                </span>
              )}
              <span
                data-customized={custom || undefined}
                className={cn(
                  "rounded px-1.5 py-0.5",
                  custom
                    ? "bg-primary/10 font-medium text-foreground ring-1 ring-primary/40"
                    : "text-muted-foreground",
                )}
              >
                {messages.labels.step[step]}
                {custom && <span className="sr-only">（{t.stepCustomized}）</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs leading-5 text-muted-foreground" data-testid="step-flow-summary">
          {customized.length > 0
            ? t.stepsSummaryCustomized(customized.length)
            : t.stepsSummaryDefault}
        </span>
        <Button
          ref={openRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpen}
          data-testid="step-settings-open"
        >
          {t.steps}
          <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/**
 * 工程ごとの設定（ダイアログの中の別の画面）。進め方の工程を順に並べ、工程ごとにイメージとエージェントを選ぶ。空欄（自動・
 * 既定）は、いつもどおり決める。選んだ値は親が持ち、基本の入力に戻っても残す（作成で送る）。
 */
export function TaskStepSettings({
  plan,
  options,
  images,
  agents,
  onImage,
  onAgent,
  onResetAll,
  onBack,
  headingRef,
}: {
  plan: StepPlan;
  options: StepOptions;
  images: StepChoices;
  agents: StepChoices;
  onImage: (step: StepKey, name: string) => void;
  onAgent: (step: StepKey, name: string) => void;
  onResetAll: () => void;
  onBack: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const messages = useMessages();
  const t = messages.forms.task;
  const m = messages.task;
  const steps = planStepSettings(plan);
  const loaded = options.status === "loaded" ? options : undefined;
  const anyCustom = steps.some(({ step, agent }) => images[step] || (agent && agents[step]));
  return (
    <div className="flex flex-col gap-4" data-testid="step-settings">
      {/* 右上の閉じるボタンと重ならないよう、右を空ける */}
      <div className="flex items-start gap-2 pr-8">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t.stepsBack}
          className="-ml-1 shrink-0"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 flex-col gap-1.5 pt-1">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="font-heading text-base leading-none font-medium outline-none"
          >
            {t.stepsTitle}
          </h3>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {t.stepsPlan(messages.labels.plan[plan])}
            <Hint text={t.stepsHint} className="size-4" />
          </p>
        </div>
      </div>
      {options.status === "loading" && (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {t.stepOptionsLoading}
        </p>
      )}
      {options.status === "failed" && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-warn">
          <p>{t.stepOptionsFailed(options.message)}</p>
          <p className="text-xs">{t.stepOptionsFailedNote}</p>
        </div>
      )}
      {/* 工程を行に、イメージ・エージェントを列にした表（見出しは1回だけ。説明は選んだ項目にだけ出し、行を低く保つ） */}
      <div className="flex flex-col gap-1">
        <p className="text-xs leading-5 text-muted-foreground">{t.stepsLegend}</p>
        <div
          aria-hidden="true"
          className="grid grid-cols-2 gap-x-2 px-2 text-xs font-medium text-muted-foreground sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1.3fr)]"
        >
          <span className="hidden sm:block" />
          <span>{t.stepImage}</span>
          <span>{t.stepAgent}</span>
        </div>
        <ol className="-mx-1 flex max-h-[min(26rem,55vh)] flex-col gap-1 overflow-y-auto px-1">
          {steps.map(({ step, agent }, i) => {
            const image = images[step] ?? "";
            const chosenAgent = agent ? (agents[step] ?? "") : "";
            const custom = Boolean(image || chosenAgent);
            const label = messages.labels.step[step];
            const imageId = `task-step-image-${step}`;
            const agentId = `task-step-agent-${step}`;
            // 選べる候補（読み込めていなければ、選んである値だけ。読み直しで候補から消えても、選んだ値は見せる）
            const imageNames = loaded?.images.map((o) => o.name) ?? [];
            const agentOption = loaded?.agents.find((o) => o.id === chosenAgent);
            const imageNote = loaded?.images.find((o) => o.name === image)?.description;
            const agentNote = agentOption
              ? [agentOption.model, agentOption.reasoningEffort].filter(Boolean).join("・")
              : undefined;
            return (
              <li
                key={step}
                data-testid={`step-setting-${step}`}
                data-customized={custom || undefined}
                className={cn(
                  "grid grid-cols-2 items-start gap-x-2 gap-y-1 rounded-md border-l-2 py-2 pr-2 pl-2 transition-colors sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1.3fr)]",
                  custom ? "border-primary bg-primary/5" : "border-transparent",
                )}
              >
                <div className="col-span-2 flex min-h-9 items-center gap-1.5 sm:col-span-1 sm:flex-col sm:items-start sm:justify-center sm:gap-0">
                  <span className="flex items-baseline gap-1.5 font-medium">
                    <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    {label}
                    {custom && <span className="sr-only">（{t.stepCustomized}）</span>}
                  </span>
                  {custom && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto px-0 text-xs"
                      onClick={() => {
                        onImage(step, "");
                        onAgent(step, "");
                      }}
                      aria-label={`${label}：${t.stepReset}`}
                    >
                      {t.stepReset}
                    </Button>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <select
                    id={imageId}
                    value={image}
                    disabled={!loaded}
                    onChange={(e) => onImage(step, e.target.value)}
                    aria-label={m.images.label(label)}
                    aria-describedby={imageNote ? `${imageId}-note` : undefined}
                    data-testid={imageId}
                    className={SELECT}
                  >
                    <option value="">{t.stepImageAuto}</option>
                    {image && !imageNames.includes(image) && <option value={image}>{image}</option>}
                    {loaded?.images.map((o) => (
                      <option key={o.name} value={o.name} title={o.description}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  {imageNote && (
                    <p
                      id={`${imageId}-note`}
                      className="text-xs leading-5 wrap-anywhere text-muted-foreground"
                    >
                      {imageNote}
                    </p>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {agent ? (
                    <select
                      id={agentId}
                      value={chosenAgent}
                      disabled={!loaded}
                      onChange={(e) => onAgent(step, e.target.value)}
                      aria-label={m.agents.label(label)}
                      aria-describedby={agentNote ? `${agentId}-note` : undefined}
                      data-testid={agentId}
                      className={SELECT}
                    >
                      <option value="">{t.stepAgentDefault(loaded?.stepAgents[step])}</option>
                      {chosenAgent && !agentOption && (
                        <option value={chosenAgent}>{chosenAgent}</option>
                      )}
                      {loaded?.agents.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p
                      className="flex min-h-9 items-center text-xs leading-5 text-muted-foreground"
                      data-testid={agentId}
                    >
                      {t.stepAgentGuardian}
                    </p>
                  )}
                  {agentNote && (
                    <p
                      id={`${agentId}-note`}
                      className="text-xs leading-5 wrap-anywhere text-muted-foreground"
                    >
                      {agentNote}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onResetAll}
          disabled={!anyCustom}
          className="sm:mr-auto"
        >
          {t.stepsResetAll}
        </Button>
        <Button type="button" onClick={onBack} data-testid="step-settings-done">
          {t.stepsDone}
        </Button>
      </DialogFooter>
    </div>
  );
}
