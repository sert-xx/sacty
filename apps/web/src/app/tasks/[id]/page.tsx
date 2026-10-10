import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DaemonError } from "@/components/daemon-error";
import { StatusLabel, StepChips } from "@/components/task-bits";
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

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-balance">{task.title}</h1>
          <StatusLabel task={task} />
        </div>
        <p className="text-sm text-muted-foreground">
          開始地点：{START_LABEL[task.start]} ・ プロジェクト：デフォルト
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <section
            aria-labelledby="req"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="req" className="text-[15px] font-semibold">
              要求要件
            </h2>
            {task.body ? (
              <p className="leading-7 whitespace-pre-wrap">{task.body}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                チケットに内容はありません。要求要件の工程で、オーケストレーターが作成します。
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
