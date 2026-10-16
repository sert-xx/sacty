"use client";

import { isCompleted, type Task } from "@sacty/core";
import { cn } from "cn";
import { CardSection } from "@/components/card-section";
import { Markdown } from "@/components/markdown";
import { SelfReviewNote } from "@/components/self-review";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import {
  addedTestsResult,
  formatStamp,
  judgedByGoalForCurrent,
  verificationResults,
} from "@/lib/labels";

const OK = "border-accent-line bg-accent text-accent-foreground";
const NG = "border-warn-line bg-warn-soft text-warn";
const NONE = "border-input text-muted-foreground";

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={cn("max-w-full rounded-full border px-2 py-0.5 text-xs", tone)}>
      {children}
    </span>
  );
}

/**
 * 実装の成果物。実装の説明と、「観点 → テスト → 実行結果」の対応、
 * sacty が実行したテストの結果、ゴールガーディアンの最終レビューを出す。
 */
export function Implementation({ task }: { task: Task }) {
  const messages = useMessages();
  const m = messages.parts.implementation;
  const step = task.steps.find((s) => s.key === "implement");
  const viewpoints = task.approved.design?.testViewpoints ?? [];
  // 今の提出の検証のものだけを対応表に出し、前の提出のものは「前の提出の」と区別して出す（PR #105 再レビュー指摘）
  const { tests, testsCurrent, review, reviewCurrent: reviewIsCurrent } = verificationResults(task);
  const mapped = new Map(task.testMap.map((entry) => [entry.viewpointId, entry.tests]));
  const running = task.status === "running" && step?.state === "active";
  // テストの仕組みが無いタスク（PBI-94）は、テストではなく目的から判定することを出す
  const noTests = task.noTestsReason;
  // 最新の検証で、実装が用意したテストを実行したか（飛ばしていなければ、テストの結果が最新の検証のもの）
  // 合格のときだけ「検証しました」と成功の色、不合格なら失敗をはっきり示す（PR #105 再レビュー指摘）
  const added = addedTestsResult(task);
  // 今の提出のテストがまだなら「検証待ち」（前の提出の結果を出さない。PR #105 再々レビュー指摘）
  const noTestsTitle =
    added === "passed"
      ? m.noTestsAddedTitle
      : added === "failed"
        ? m.noTestsAddedFailedTitle
        : added === "pending"
          ? m.noTestsAddedPendingTitle
          : m.noTestsTitle;

  return (
    <CardSection
      id="deliverable-implement"
      title={m.title}
      note={step?.state === "done" ? m.passed : m.working}
      // 承認された（タスクが完了した）実装は折りたたむ
      collapsed={isCompleted(task)}
    >
      {task.repository && (
        <p className="text-xs break-all text-muted-foreground">
          {m.repository(task.repository.url, task.repository.baseBranch)}
          <span className="font-mono">{task.repository.baseCommit.slice(0, 7)}</span>
        </p>
      )}
      {noTests && (
        <div
          role="note"
          aria-label={noTestsTitle}
          className={cn(
            "flex flex-col gap-1 rounded-lg border p-3.5 text-sm leading-6",
            added === "passed"
              ? "border-accent-line"
              : added === "failed"
                ? "border-destructive bg-destructive/10"
                : added === "pending"
                  ? "border-border"
                  : "border-warn-line bg-warn-soft",
          )}
        >
          <p
            className={cn(
              "font-semibold",
              added === "failed" ? "text-destructive" : added === undefined && "text-warn",
            )}
          >
            {noTestsTitle}
          </p>
          <p className="break-words">
            {tests && added === "passed"
              ? m.noTestsAdded(tests.command)
              : tests && added === "failed"
                ? m.noTestsAddedFailed(tests.command, tests.exitCode)
                : added === "pending"
                  ? m.noTestsAddedPending(task.addedTestCommand ?? "")
                  : m.noTestsSkipped}
            {added === "pending" && <Hint text={m.noTestsAddedPendingHint} />}
          </p>
          <p className="text-xs break-words text-muted-foreground">{m.noTestsReason(noTests)}</p>
        </div>
      )}
      {/* 提出の前のセルフレビュー（PBI-120） */}
      {task.outputs.implement && <SelfReviewNote task={task} step="implement" />}
      {task.outputs.implement ? (
        <Markdown>{task.outputs.implement}</Markdown>
      ) : (
        <p className="text-sm text-muted-foreground">{running ? m.running : m.notYet}</p>
      )}

      {task.outputs.implement && (
        <>
          <h3 className="pt-2 text-sm font-semibold">
            {m.mapTitle} <Hint text={m.mapHint} />
          </h3>
          <ol className="flex flex-col gap-2.5">
            {viewpoints.map((v) => {
              const list = mapped.get(v.id) ?? [];
              const judged = reviewIsCurrent
                ? review?.viewpoints.find((r) => r.viewpointId === v.id)
                : undefined;
              return (
                <li key={v.id} className="rounded-lg border border-border p-3.5 text-sm leading-6">
                  <p className="flex flex-wrap items-baseline gap-2 font-medium">
                    <span className="font-mono text-xs text-muted-foreground">{v.id}</span>
                    {v.title}
                  </p>
                  <dl className="mt-1.5 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <dt className="pt-0.5 text-xs text-muted-foreground">{m.tests}</dt>
                    <dd className="break-words">
                      {list.length > 0 ? (
                        <ul className="flex flex-col">
                          {list.map((t) => (
                            <li key={t} className="font-mono text-xs leading-6">
                              {t}
                            </li>
                          ))}
                        </ul>
                      ) : noTests ? (
                        <span className="text-muted-foreground">{m.judgedByGoal}</span>
                      ) : (
                        <span className="text-warn">{m.noTests}</span>
                      )}
                    </dd>
                    <dt className="pt-0.5 text-xs text-muted-foreground">{m.result}</dt>
                    <dd className="flex flex-col gap-1">
                      <span className="flex flex-wrap gap-1.5">
                        {noTests && list.length === 0 && judgedByGoalForCurrent(task) ? (
                          <Pill tone={NONE}>{m.judgedByGoal}</Pill>
                        ) : !tests || !testsCurrent || (noTests && list.length === 0) ? (
                          <Pill tone={NONE}>{m.notRun}</Pill>
                        ) : tests.exitCode === 0 && list.length > 0 ? (
                          <Pill tone={OK}>{m.testsPassed}</Pill>
                        ) : (
                          <Pill tone={NG}>{m.testsFailed}</Pill>
                        )}
                        {judged && (
                          <Pill tone={judged.verified ? OK : NG}>
                            {judged.verified ? m.verified : m.notVerified}
                          </Pill>
                        )}
                      </span>
                      {judged && (
                        <span className="break-words">{messages.labels.text(judged.reason)}</span>
                      )}
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {tests && (
        <details className="rounded-lg border border-border p-3.5 text-sm">
          <summary className="cursor-pointer">
            <span className="font-semibold">{testsCurrent ? m.testRun : m.previousTestRun}</span>
            {!testsCurrent && <Hint text={m.previousHint} />}{" "}
            <Pill tone={tests.passed ? OK : NG}>{tests.passed ? m.pass : m.fail}</Pill>{" "}
            <span className="text-xs text-muted-foreground">
              {m.runMeta(tests.exitCode, (tests.durationMs / 1000).toFixed(1))}
              {formatStamp(tests.at, messages.locale)}
            </span>
          </summary>
          <p className="mt-2 font-mono text-xs break-all">{tests.command}</p>
          {tests.note && <p className="mt-2 text-warn">{messages.labels.text(tests.note)}</p>}
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border bg-muted px-4 py-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
            {tests.output || m.noOutput}
          </pre>
        </details>
      )}

      {review && (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-lg border p-3.5 text-sm leading-6",
            !reviewIsCurrent
              ? "border-border text-muted-foreground"
              : review.passed
                ? "border-accent-line"
                : "border-warn-line",
          )}
        >
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              {reviewIsCurrent ? m.finalReview : m.previousFinalReview}
            </span>
            {!reviewIsCurrent && <Hint text={m.previousHint} />}
            <Pill tone={review.passed ? OK : NG}>{review.passed ? m.pass : m.fail}</Pill>
            <span className="text-xs text-muted-foreground">
              {m.reviewer}
              {formatStamp(review.at, messages.locale)}
            </span>
          </p>
          {review.summary && <p className="break-words">{messages.labels.text(review.summary)}</p>}
          {review.remarks.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">{m.recurrence}</p>
              <ul className="flex flex-col gap-1.5">
                {review.remarks.map((r) => (
                  <li key={r.remarkId} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{r.remarkId}</span>
                    <Pill tone={r.notRecurred ? OK : NG}>
                      {r.notRecurred ? m.notRecurred : m.recurred}
                    </Pill>
                    <span className="break-words">{messages.labels.text(r.reason)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </CardSection>
  );
}
