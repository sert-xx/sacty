import type { Task } from "@sacty/core";
import { cn } from "cn";
import { STATUS_LABEL, STEP_LABEL } from "@/lib/labels";

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

export function StatusLabel({ task }: { task: Task }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground">
      <span aria-hidden="true" className="size-2 rounded-full bg-muted-foreground/60" />
      {STATUS_LABEL[task.status]}
    </span>
  );
}
