import type { Task } from "@sacty/core";
import { cn } from "cn";
import { STEP_LABEL, statusText, usd } from "@/lib/labels";

const STEP_STYLE: Record<Task["steps"][number]["state"], string> = {
  todo: "border-input bg-card text-muted-foreground",
  active: "border-primary bg-primary text-primary-foreground font-semibold",
  done: "border-accent-line bg-accent text-accent-foreground",
  skip: "border-dashed border-input bg-transparent text-muted-foreground line-through",
};

export function StepChips({ task }: { task: Task }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="工程">
      {task.steps.map((step) => (
        <li
          key={step.key}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap",
            STEP_STYLE[step.state],
          )}
        >
          {STEP_LABEL[step.key]}
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
};

export function StatusLabel({ task }: { task: Task }) {
  const style = STATUS_STYLE[task.status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap",
        style.text,
      )}
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", style.dot)} />
      {statusText(task)}
    </span>
  );
}

export function CostMeter({ task }: { task: Task }) {
  const { usedUsd, capUsd, estimated } = task.budget;
  const ratio = Math.min(1, usedUsd / capUsd);
  const over = usedUsd >= capUsd;
  return (
    <div className="flex flex-wrap items-center gap-3 text-[13px]">
      <span className="text-muted-foreground">費用</span>
      <meter className="sr-only" min={0} max={capUsd} value={Math.min(usedUsd, capUsd)}>
        予算に対する費用
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
          換算値（実際の請求ではありません）
        </span>
      )}
      <span className="text-muted-foreground">80%で通知、上限で自動的に一時停止</span>
    </div>
  );
}
