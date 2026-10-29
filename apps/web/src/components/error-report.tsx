"use client";

import {
  type ActivityEvent,
  errorAnalysisBlocked,
  failureKind,
  pendingErrorAnalysis,
  type Task,
} from "@sacty/core";
import { cn } from "cn";
import { useActionState } from "react";
import { analyzeErrorsAction, type TaskControlState } from "@/app/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import { formatStamp } from "@/lib/labels";
import { errorReportPath } from "@/lib/paths";

const initial: TaskControlState = {};

/** エラーレポートの欄を出すか。エラーの記録があるか、前に分析させたタスクだけ。 */
export function showErrorReport(task: Task, activity: readonly ActivityEvent[]): boolean {
  return task.errorAnalyses.length > 0 || activity.some((e) => failureKind(e) !== undefined);
}

/**
 * エラーレポート。Sacty の処理・各工程のエージェントの動き・エラーの詳細を、Markdown のファイルでダウンロードする
 * （通信できない環境でも、ファイルとして渡せる）。オーケストレーターに分析させると、原因の推定と次にすることをレポートに足す。
 */
export function ErrorReportCard({
  task,
  activity,
}: {
  task: Task;
  activity: readonly ActivityEvent[];
}) {
  const messages = useMessages();
  const { labels, locale } = messages;
  const m = messages.task.errorReport;
  const [state, action, pending] = useActionState(analyzeErrorsAction, initial);
  const count = activity.filter((e) => failureKind(e) !== undefined).length;
  const analyzing = pendingErrorAnalysis(task) !== undefined;
  const blocked = errorAnalysisBlocked(task);
  const latest = task.errorAnalyses.at(-1);
  const done = [...task.errorAnalyses].reverse().find((a) => a.result?.text !== undefined);
  return (
    <section
      aria-labelledby="error-report"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <h2 id="error-report" className="text-sm font-semibold">
        {m.title}{" "}
        {count > 0 && (
          <span className="text-xs font-normal text-muted-foreground">{m.note(count)}</span>
        )}{" "}
        <Hint text={m.hint} />
      </h2>
      <a
        href={errorReportPath(task.id)}
        download
        className={cn(buttonVariants({ variant: "outline" }), "min-h-10 self-start")}
      >
        {m.download}
      </a>
      <form action={action} className="flex flex-col gap-2">
        <input type="hidden" name="taskId" value={task.id} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="outline"
            disabled={pending || blocked !== undefined}
            className="min-h-10"
          >
            {pending || analyzing ? m.analyzing : done ? m.reanalyze : m.analyze}
          </Button>
          <Hint text={m.analyzeHint} />
        </div>
        {done?.result && !analyzing && (
          <p className="text-xs text-muted-foreground">
            {m.analyzed(formatStamp(done.result.at, locale))}
          </p>
        )}
        {latest?.result?.failed !== undefined && !analyzing && (
          <p className="text-sm text-warn [overflow-wrap:anywhere]">
            {m.failed(labels.text(latest.result.failed))}
          </p>
        )}
        {blocked !== undefined && !analyzing ? (
          <p className="text-xs text-muted-foreground">{labels.text(blocked)}</p>
        ) : (
          !analyzing && <p className="text-xs text-muted-foreground">{m.analyzeHelp}</p>
        )}
        {state.message && (
          <p role="alert" className="text-sm text-warn">
            {state.message}
          </p>
        )}
      </form>
    </section>
  );
}
