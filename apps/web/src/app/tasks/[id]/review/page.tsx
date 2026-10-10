import { changeRounds, MAX_CHANGE_REQUESTS, type TaskRemark } from "@sacty/core";
import { cn } from "cn";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { voidRemarkAction } from "@/app/actions";
import { DaemonError } from "@/components/daemon-error";
import { GateForm } from "@/components/gate-form";
import { DaemonUnavailableError, getTask } from "@/lib/daemon";
import { STEP_LABEL } from "@/lib/labels";

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">読み込み中…</p>}>
      <Review params={params} />
    </Suspense>
  );
}

async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let found: Awaited<ReturnType<typeof getTask>>;
  try {
    found = await getTask(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  if (!found) notFound();
  const { task } = found;
  const step = task.gate?.step ?? task.escalation?.step;

  if (!step) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">{task.title}</h1>
        <p className="text-sm text-muted-foreground">このタスクは承認待ちではありません。</p>
        <Link href={`/tasks/${task.id}`} className="text-sm text-accent-foreground underline">
          タスクの詳細に戻る
        </Link>
      </div>
    );
  }

  const rounds = changeRounds(task, step);
  const latestRound = rounds;
  const remarks = task.remarks
    .filter((r) => r.step === step)
    .sort((a, b) => b.round - a.round || a.id.localeCompare(b.id));
  const submission = task.gate?.submission ?? task.submissions[step] ?? 1;

  return (
    <>
      <div className="flex flex-col gap-2">
        <nav aria-label="パンくず" className="text-sm text-muted-foreground">
          <Link href={`/tasks/${task.id}`} className="text-accent-foreground underline">
            {task.title}
          </Link>{" "}
          / 成果物チェック
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-balance">{STEP_LABEL[step]}の承認</h1>
          <span className="rounded-full border border-back-line bg-back-soft px-2.5 py-0.5 text-xs font-semibold text-back">
            {submission}回目の提出
            {rounds > 0 ? ` ・ 差し戻し${rounds}回` : ""}
          </span>
          {task.status === "escalated" && (
            <span className="rounded-full border border-warn-line bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">
              エスカレーション
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-6">
          {remarks.length > 0 && (
            <section
              aria-labelledby="history"
              className="flex flex-col gap-3 rounded-xl border border-back-line bg-card p-5"
            >
              <h2 id="history" className="text-[15px] font-semibold">
                これまでの指摘への対応
              </h2>
              <ol className="flex flex-col gap-2.5">
                {remarks.map((remark) => (
                  <RemarkItem
                    key={remark.id}
                    remark={remark}
                    taskId={task.id}
                    current={remark.round === latestRound}
                  />
                ))}
              </ol>
            </section>
          )}
          <section
            aria-labelledby="deliverable"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="deliverable" className="text-[15px] font-semibold">
              成果物{" "}
              <span className="text-[13px] font-normal text-muted-foreground">
                {STEP_LABEL[step]}
              </span>
            </h2>
            <pre className="rounded-lg border border-border bg-muted px-5 py-4 font-sans text-sm leading-7 break-words whitespace-pre-wrap">
              {task.outputs[step] ?? "（出力がありません）"}
            </pre>
          </section>
        </div>

        <section
          aria-labelledby="decision"
          className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 rounded-xl border border-border bg-card p-5"
        >
          <h2 id="decision" className="text-[15px] font-semibold">
            判断
          </h2>
          <GateForm
            taskId={task.id}
            step={step}
            escalated={task.status === "escalated"}
            maxChanges={MAX_CHANGE_REQUESTS}
            pendingComments={task.escalation?.pendingRemarks.map((r) => r.text) ?? []}
          />
        </section>
      </div>
    </>
  );
}

function RemarkItem({
  remark,
  taskId,
  current,
}: {
  remark: TaskRemark;
  taskId: string;
  current: boolean;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border p-3.5 text-sm leading-6",
        current ? "border-2 border-back-line" : "border-border",
        remark.voided && "opacity-60",
      )}
    >
      <span className="pt-0.5 text-xs text-muted-foreground">指摘</span>
      <span className="flex flex-wrap items-center gap-2">
        <span className={cn(remark.voided && "line-through")}>{remark.text}</span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs",
            current
              ? "border-back-line bg-back-soft font-semibold text-back"
              : "border-input text-muted-foreground",
          )}
        >
          {remark.round}回目の差し戻し{current ? " ・ 今回" : ""}
        </span>
        {remark.voided && (
          <span className="rounded-full border border-input px-2 py-0.5 text-xs text-muted-foreground">
            無効
          </span>
        )}
        <span className="font-mono text-xs text-muted-foreground">{remark.id}</span>
      </span>
      <span className="pt-0.5 text-xs text-muted-foreground">対応</span>
      <span className={cn(!remark.response && "text-muted-foreground")}>
        {remark.response ?? "（エージェントの対応の記載なし）"}
      </span>
      {!remark.voided && (
        <form action={voidRemarkAction} className="col-start-2">
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="remarkId" value={remark.id} />
          <button
            type="submit"
            className="min-h-8 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            この指摘を無効にする（前提が変わったため、以降エージェントに渡さない）
          </button>
        </form>
      )}
    </li>
  );
}
