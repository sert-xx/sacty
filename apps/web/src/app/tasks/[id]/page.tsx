import { appliedProposalFor, openProposal, type StepKey, type Task } from "@sacty/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { DaemonError } from "@/components/daemon-error";
import { Proposals } from "@/components/proposals";
import { ResumeForm } from "@/components/resume-form";
import { CostMeter, StatusLabel, StepChips } from "@/components/task-bits";
import { TestViewpoints } from "@/components/test-viewpoints";
import { DaemonUnavailableError, getTask } from "@/lib/daemon";
import {
  describeEvent,
  formatStamp,
  isWorking,
  personAction,
  START_LABEL,
  STEP_LABEL,
  statusText,
} from "@/lib/labels";

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
  const proposal = openProposal(task);
  const action = personAction(task);

  return (
    <>
      <AutoRefresh active={isWorking(task)} />
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

      {(task.status === "awaiting_approval" || task.status === "escalated") && (
        <section
          aria-labelledby="gate"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn-line bg-warn-soft p-5"
        >
          <div className="flex flex-col gap-1">
            <h2 id="gate" className="text-[15px] font-semibold text-warn">
              {proposal
                ? "ゴールガーディアンが変更の申し出を判定できませんでした（エスカレーション）"
                : task.status === "escalated"
                  ? "差し戻しが上限に達しました（エスカレーション）"
                  : statusText(task)}
            </h2>
            <p className="text-sm">
              {proposal
                ? "申し出の理由と根拠を確認し、変更を認めるかどうかを判断してください。"
                : task.status === "escalated"
                  ? "このまま承認するか、上限を超えて差し戻すかを判断してください。"
                  : "成果物を確認し、承認するか差し戻してください。"}
            </p>
          </div>
          <Link
            href={action.href}
            className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
          >
            {action.label}
          </Link>
        </section>
      )}

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
          <Deliverable task={task} step="requirements" />
          {(task.outputs.design ||
            task.steps.some((s) => s.key === "design" && s.state !== "todo")) && (
            <Deliverable task={task} step="design" />
          )}
          {(task.approved.requirements || task.proposals.length > 0) && <Proposals task={task} />}
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

/**
 * 工程の成果物。承認済みなら凍結した版を、そうでなければ工程エージェントの最新の下書きを出す。
 */
function Deliverable({ task, step }: { task: Task; step: StepKey }) {
  const approved = task.approved[step];
  const output = approved?.output ?? task.outputs[step];
  const viewpoints = approved?.testViewpoints ?? task.testViewpoints;
  // 前の工程に差し戻されて、まだ実行対象になっていない工程の下書き
  const stale = !approved && task.steps.find((s) => s.key === step)?.state === "todo";
  const fromProposal = approved ? undefined : appliedProposalFor(task, step);
  const running =
    task.status === "running" && task.steps.some((s) => s.key === step && s.state === "active");
  return (
    <section
      aria-labelledby={`deliverable-${step}`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id={`deliverable-${step}`} className="text-[15px] font-semibold">
        {STEP_LABEL[step]}{" "}
        <span className="text-[13px] font-normal text-muted-foreground">
          {approved
            ? `人間が承認済み（${approved.submission}回目の提出・凍結）`
            : fromProposal
              ? `${fromProposal.id}で申し出られた変更案（人間の再承認待ち）`
              : stale
                ? "前回の下書き（前の工程が承認されたあと、作り直します）"
                : "工程エージェントの下書き"}
        </span>
      </h2>
      {output ? (
        <pre className="font-sans text-sm leading-7 break-words whitespace-pre-wrap">{output}</pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          {running ? "工程エージェントが作成しています…" : "まだ作成されていません。"}
        </p>
      )}
      {step === "design" && output && (
        <>
          <h3 className="pt-2 text-sm font-semibold">
            テスト観点{" "}
            <span className="text-[13px] font-normal text-muted-foreground">
              {viewpoints.length}件・最終レビューの基準
            </span>
          </h3>
          <TestViewpoints viewpoints={viewpoints} />
        </>
      )}
    </section>
  );
}
