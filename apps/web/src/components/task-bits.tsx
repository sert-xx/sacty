import type { Task } from "@sacty/core";
import { cn } from "cn";
import { Check } from "lucide-react";
import { getMessages } from "@/i18n/server";
import { type StatusTone, statusText, statusTone, usd } from "@/lib/labels";

const STEP_STYLE: Record<Task["steps"][number]["state"], string> = {
  todo: "border-input bg-card text-muted-foreground",
  active: "border-primary bg-primary text-primary-foreground font-semibold",
  done: "border-accent-line bg-accent text-accent-foreground",
  skip: "border-dashed border-input bg-transparent text-muted-foreground line-through",
};

export async function StepChips({ task }: { task: Task }) {
  const m = await getMessages();
  // 工程は、タスクの開始時にオーケストレーターが選ぶ（PBI-17）
  if (task.steps.length === 0) {
    return <p className="text-xs text-muted-foreground">{m.parts.bits.choosing}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={m.parts.bits.steps}>
      {task.steps.map((step) => (
        <li
          key={step.key}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap",
            STEP_STYLE[step.state],
          )}
        >
          {m.labels.step[step.key]}
        </li>
      ))}
    </ul>
  );
}

const STATUS_STYLE: Record<StatusTone, { text: string; mark: string }> = {
  working: { text: "text-accent-foreground", mark: "size-2 rounded-full bg-primary" },
  waiting: { text: "text-muted-foreground", mark: "size-2 rounded-full bg-muted-foreground/60" },
  person: { text: "text-warn", mark: "size-2 rounded-full bg-warn" },
  completed: { text: "text-ok", mark: "size-3.5 text-ok" },
  // 中止は、待っている（灰の点）と見分けられるよう、中を抜いた輪にする
  cancelled: {
    text: "text-muted-foreground",
    mark: "size-2 rounded-full border border-muted-foreground/70",
  },
};

export async function StatusLabel({ task }: { task: Task }) {
  const m = await getMessages();
  const tone = statusTone(task);
  const style = STATUS_STYLE[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap",
        style.text,
      )}
    >
      {tone === "completed" ? (
        <Check aria-hidden="true" strokeWidth={3} className={style.mark} />
      ) : (
        <span aria-hidden="true" className={style.mark} />
      )}
      {statusText(task, m.labels)}
    </span>
  );
}

export async function CostMeter({ task }: { task: Task }) {
  const m = await getMessages();
  const { usedUsd, capUsd, estimated } = task.budget;
  const ratio = Math.min(1, usedUsd / capUsd);
  const over = usedUsd >= capUsd;
  return (
    <div className="flex flex-wrap items-center gap-3 text-[13px]">
      <span className="text-muted-foreground">{m.parts.bits.cost}</span>
      <meter className="sr-only" min={0} max={capUsd} value={Math.min(usedUsd, capUsd)}>
        {m.parts.bits.costMeter}
      </meter>
      <div
        aria-hidden="true"
        className="h-2 w-56 max-w-full overflow-hidden rounded-full bg-border"
      >
        <div
          className={cn("h-full", over ? "bg-warn" : "bg-primary")}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <span className="font-mono tabular-nums">
        {usd(usedUsd)} / {usd(capUsd)}
      </span>
      {estimated && (
        <span className="rounded-full border border-input px-2 py-0.5 text-xs text-muted-foreground">
          {m.parts.bits.estimated}
        </span>
      )}
      <span className="text-muted-foreground">{m.parts.bits.budgetNote}</span>
    </div>
  );
}
