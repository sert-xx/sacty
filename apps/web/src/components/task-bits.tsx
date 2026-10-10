import type { Task } from "@sacty/core";
import { cn } from "cn";
import { getMessages } from "@/i18n/server";
import { statusText, usd } from "@/lib/labels";

const STEP_STYLE: Record<Task["steps"][number]["state"], string> = {
  todo: "border-input bg-card text-muted-foreground",
  active: "border-primary bg-primary text-primary-foreground font-semibold",
  done: "border-accent-line bg-accent text-accent-foreground",
  skip: "border-dashed border-input bg-transparent text-muted-foreground line-through",
};

export async function StepChips({ task }: { task: Task }) {
  const m = await getMessages();
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

const STATUS_STYLE: Record<Task["status"], { text: string; dot: string }> = {
  queued: { text: "text-muted-foreground", dot: "bg-muted-foreground/60" },
  running: { text: "text-accent-foreground", dot: "bg-primary" },
  idle: { text: "text-muted-foreground", dot: "bg-muted-foreground/60" },
  paused: { text: "text-warn", dot: "bg-warn" },
  awaiting_approval: { text: "text-warn", dot: "bg-warn" },
  escalated: { text: "text-warn", dot: "bg-warn" },
};

export async function StatusLabel({ task }: { task: Task }) {
  const m = await getMessages();
  const style = STATUS_STYLE[task.status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap",
        style.text,
      )}
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", style.dot)} />
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
