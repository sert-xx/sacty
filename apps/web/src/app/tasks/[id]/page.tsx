import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { DaemonError } from "@/components/daemon-error";
import { ResumeForm } from "@/components/resume-form";
import { CostMeter, StatusLabel, StepChips } from "@/components/task-bits";
import { DaemonUnavailableError, getTask } from "@/lib/daemon";
import { describeEvent, formatStamp, START_LABEL } from "@/lib/labels";

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <nav aria-label="パンくず" className="text-sm text-muted-foreground">
        <Link href="/" className="text-accent-foreground underline">
          タスク
        </Link>
      </nav>
      <Suspense fallback={<p className="text-sm text-muted-foreground">読み込み中…</p>}>
        <TaskDetail params={params} />
      </Suspense>
    </>
  );
}

async function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let found: Awaited<ReturnType<typeof getTask>>;
  try {
    found = await getTask(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  if (!found) notFound();
  const { task, ledger } = found;
  const lastFailure = [...ledger].reverse().find((e) => e.type === "AgentRunFailed");
  const draft = task.outputs.requirements;

  return (
    <>
      <AutoRefresh active={task.status === "queued" || task.status === "running"} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-balance">{task.title}</h1>
          <StatusLabel task={task} />
        </div>
        <p className="text-sm text-muted-foreground">
          開始地点：{START_LABEL[task.start]} ・ プロジェクト：デフォルト
        </p>
        <CostMeter task={task} />
      </div>

      {task.status === "paused" && task.pausedReason && (
        <ResumeForm
          taskId={task.id}
          reason={task.pausedReason}
          usedUsd={task.budget.usedUsd}
          capUsd={task.budget.capUsd}
          lastFailure={
            task.pausedReason !== "budget" && lastFailure?.type === "AgentRunFailed"
              ? lastFailure.payload.message
              : undefined
          }
        />
      )}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <section
            aria-labelledby="ticket"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="ticket" className="text-[15px] font-semibold">
              チケット
            </h2>
            {task.body ? (
              <p className="leading-7 whitespace-pre-wrap">{task.body}</p>
            ) : (
              <p className="text-sm text-muted-foreground">チケットに内容はありません。</p>
            )}
          </section>
          <section
            aria-labelledby="req"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="req" className="text-[15px] font-semibold">
              要求要件{" "}
              <span className="text-[13px] font-normal text-muted-foreground">
                工程エージェントの下書き
              </span>
            </h2>
            {draft ? (
              <pre className="font-sans text-sm leading-7 break-words whitespace-pre-wrap">
                {draft}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                {task.status === "running"
                  ? "工程エージェントが作成しています…"
                  : "まだ作成されていません。"}
              </p>
            )}
          </section>
          <section
            aria-labelledby="steps"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="steps" className="text-[15px] font-semibold">
              工程{" "}
              <span className="text-[13px] font-normal text-muted-foreground">
                オーケストレーターが選択
              </span>
            </h2>
            <StepChips task={task} />
          </section>
        </div>

        <section
          aria-labelledby="ledger"
          className="flex min-w-0 flex-[1_1_320px] flex-col gap-1 rounded-xl border border-border bg-card p-5"
        >
          <h2 id="ledger" className="pb-2 text-[15px] font-semibold">
            台帳 <span className="text-[13px] font-normal text-muted-foreground">追記専用</span>
          </h2>
          <ol className="flex flex-col">
            {[...ledger].reverse().map((event) => (
              <li
                key={event.id}
                className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-t border-border py-2.5 text-[13px]"
              >
                <time
                  dateTime={event.at}
                  className="font-mono text-xs text-muted-foreground tabular-nums"
                >
                  {formatStamp(event.at)}
                </time>
                <span>{describeEvent(event)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
