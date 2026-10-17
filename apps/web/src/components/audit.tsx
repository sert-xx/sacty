"use client";

import {
  AUDIT_EVIDENCE_KINDS,
  type AuditEvidence,
  type AuditMemory,
  type AuditMovedMemory,
  type AuditProposal,
  type AuditTarget,
  type AuditUsefulMemory,
  type TaskAudit,
} from "@sacty/core";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  type AuditProposalState,
  adoptAuditProposalAction,
  type DeleteAuditMemoryState,
  deleteAuditMemoryAction,
  type ResumeAuditState,
  rejectAuditProposalAction,
  resumeAuditAction,
} from "@/app/actions";
import { CardSection } from "@/components/card-section";
import { Markdown } from "@/components/markdown";
import { StatusLabelView } from "@/components/task-bits";
import { Button } from "@/components/ui/button";
import { Hint, WithHint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";
import { auditStatusTone, auditTargetText, auditTargetValue, suggestedAuditCap } from "@/lib/audit";
import { formatStamp, usd } from "@/lib/labels";
import { taskPath } from "@/lib/paths";

/** モックのデータの印（PBI-124）。 */
export function MockBadge() {
  const m = useMessages().audit;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-back-line bg-back-soft px-2 py-0.5 text-xs font-medium text-back">
      {m.mock}
      <Hint text={m.mockHint} />
    </span>
  );
}

/** 監査の状態（タスクの状態と同じ色と印）。 */
export function AuditStatusLabel({ status }: { status: TaskAudit["status"] }) {
  const m = useMessages().audit;
  return <StatusLabelView text={m.status[status]} tone={auditStatusTone(status)} />;
}

/** 宛先の表示。 */
export function AuditTargetView({ target }: { target: AuditTarget }) {
  const m = useMessages().audit.target;
  const text = auditTargetText(target, m);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className="font-medium">{text.kind}</span>
      {target.kind === "sacty" && <Hint text={m.sactyHint} />}
      {text.detail && (
        <span className="font-mono text-xs break-all text-muted-foreground">{text.detail}</span>
      )}
    </span>
  );
}

/**
 * タスクの詳細の監査の欄（PBI-124）。完了したタスクで、監査の状態・大まかな監査・懸念のある工程の深掘り・原因と改修の
 * 提案・費用を出す。予算で一時停止していれば、新しい上限で再開できる。
 */
export function TaskAuditCard({ audit }: { audit: TaskAudit | null }) {
  const messages = useMessages();
  const m = messages.audit;
  if (!audit) {
    return (
      <CardSection id="audit" title={m.title} hint={m.card.hint}>
        <p className="text-sm text-muted-foreground">{m.none}</p>
      </CardSection>
    );
  }
  return (
    <CardSection
      id="audit"
      title={m.title}
      hint={m.card.hint}
      note={
        <span className="inline-flex flex-wrap items-center gap-2 align-middle">
          <AuditStatusLabel status={audit.status} />
          {audit.mock && <MockBadge />}
        </span>
      }
    >
      <p className="text-[13px] text-muted-foreground" data-testid="audit-cost">
        <WithHint hint={m.card.costHint}>
          {m.card.cost(usd(audit.budget.usedUsd), usd(audit.budget.capUsd))}
        </WithHint>
      </p>
      {audit.status === "failed" && audit.failure && (
        <p
          role="alert"
          className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-sm text-warn"
        >
          {messages.labels.text(audit.failure)}
        </p>
      )}
      {audit.status === "budgetPaused" && <AuditResumeForm audit={audit} />}
      {audit.survey && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{m.survey.title}</h3>
          <Markdown>{audit.survey.summary}</Markdown>
          <dl
            aria-label={m.survey.counts}
            className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1 text-sm"
          >
            {AUDIT_EVIDENCE_KINDS.map((kind) => (
              <div key={kind} className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{m.evidence[kind]}</dt>
                <dd data-testid={`audit-count-${kind}`} className="font-semibold tabular-nums">
                  {m.times(audit.survey?.counts[kind] ?? 0)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {audit.deepDives.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            <WithHint hint={m.deepDives.hint}>{m.deepDives.title}</WithHint>
          </h3>
          <ul className="flex flex-col gap-2">
            {audit.deepDives.map((d) => (
              <li
                key={d.step}
                data-testid={`audit-deep-dive-${d.step}`}
                className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{messages.labels.step[d.step]}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.deepDives.status[d.status]}
                  </span>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  <span className="mr-2">{m.deepDives.reason}</span>
                  <span className="text-foreground">{d.reason}</span>
                </p>
                {d.summary && <Markdown>{d.summary}</Markdown>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(audit.status === "completed" || audit.findings.length > 0) && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{m.findings.title}</h3>
          {audit.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.findings.none}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {audit.findings.map((f) => (
                <li
                  key={f.causeId}
                  data-testid={`audit-finding-${f.causeId}`}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{f.title}</span>
                    {f.step && (
                      <span className="text-xs text-muted-foreground">
                        {messages.labels.step[f.step]}
                      </span>
                    )}
                    {f.recurred && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-xs font-semibold text-warn">
                        {m.findings.recurred}
                        <Hint text={m.findings.recurredHint} />
                      </span>
                    )}
                  </div>
                  <Markdown>{f.detail}</Markdown>
                  <Evidence taskId={audit.taskId} items={f.evidence} />
                  <ul className="flex flex-col gap-2">
                    {f.proposals.map((p) => (
                      <li key={p.id}>
                        <ProposalView proposal={p} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {audit.usefulMemories.length > 0 && <UsefulMemories memories={audit.usefulMemories} />}
      {audit.movedMemories.length > 0 && <MovedMemories memories={audit.movedMemories} />}
      {audit.memories.length > 0 && <AuditMemories memories={audit.memories} />}
    </CardSection>
  );
}

/** タスクで役に立ったと監査が判断したメモリー（PBI-127）。 */
function UsefulMemories({ memories }: { memories: AuditUsefulMemory[] }) {
  const m = useMessages().audit.memories;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        <WithHint hint={m.usefulHint}>{m.usefulTitle}</WithHint>
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {memories.map((memory) => (
          <li
            key={memory.id}
            data-testid={`audit-useful-memory-${memory.id}`}
            className="min-w-0 [overflow-wrap:anywhere]"
          >
            <span className="font-medium">{memory.title}</span>{" "}
            <span className="text-xs text-muted-foreground">
              {memory.scope === "project" ? m.project : m.repository}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 監査が別の階層に移したメモリー（PBI-128）。 */
function MovedMemories({ memories }: { memories: AuditMovedMemory[] }) {
  const m = useMessages().audit.memories;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        <WithHint hint={m.movedHint}>{m.movedTitle}</WithHint>
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {memories.map((memory) => (
          <li
            key={memory.id}
            data-testid={`audit-moved-memory-${memory.id}`}
            className="min-w-0 [overflow-wrap:anywhere]"
          >
            <span className="font-medium">{memory.title}</span>{" "}
            <span className="text-xs text-muted-foreground">
              {m.movedTo(memory.scope === "project" ? m.project : m.repository)}
            </span>
            {memory.repo && (
              <span className="ml-1.5 font-mono text-xs break-all text-muted-foreground">
                {memory.repo}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 監査が登録したメモリー（PBI-126）。人は誤ったものを消せる（登録はできない）。 */
function AuditMemories({ memories }: { memories: AuditMemory[] }) {
  const m = useMessages().audit.memories;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        <WithHint hint={m.hint}>{m.title}</WithHint>
      </h3>
      <ul className="flex flex-col gap-2">
        {memories.map((memory) => (
          <li
            key={memory.id}
            data-testid={`audit-memory-${memory.id}`}
            className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              {/* 空白の無い長い題・概要（識別子・パス・URL）も、狭い画面で折り返す（PR #136 レビュー指摘） */}
              <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{memory.title}</span>
              <span className="text-xs text-muted-foreground">
                {memory.scope === "project" ? m.project : m.repository}
              </span>
              {memory.repo && (
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {memory.repo}
                </span>
              )}
              {memory.deleted && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-back-soft px-2 py-0.5 text-xs text-muted-foreground">
                  {memory.deleted.reason === "person"
                    ? m.deleted
                    : memory.deleted.reason === "capacity"
                      ? m.deletedByCapacity
                      : memory.deleted.reason === "expired"
                        ? m.deletedByExpiry
                        : m.deletedByPromotion}
                  {memory.deleted.reason === "capacity" && <Hint text={m.deletedHint} />}
                  {memory.deleted.reason === "expired" && <Hint text={m.deletedByExpiryHint} />}
                  {memory.deleted.reason === "promoted" && <Hint text={m.deletedByPromotionHint} />}
                </span>
              )}
            </div>
            <p className="min-w-0 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
              {memory.summary}
            </p>
            {!memory.deleted && (
              <p
                className="text-xs text-muted-foreground"
                data-testid={`audit-memory-useful-${memory.id}`}
              >
                {m.lastUseful(memory.lastUsefulAt.slice(0, 10))}
              </p>
            )}
            {!memory.deleted && (
              <>
                <Markdown>{memory.body}</Markdown>
                <AuditMemoryDeleteForm memoryId={memory.id} />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const initialDeleteMemoryState: DeleteAuditMemoryState = {};

/** メモリーを消すフォーム。消すと戻せないので、確定のボタンを開いてから消す。 */
function AuditMemoryDeleteForm({ memoryId }: { memoryId: string }) {
  const m = useMessages().audit.memories;
  const [state, action, deleting] = useActionState(
    deleteAuditMemoryAction,
    initialDeleteMemoryState,
  );
  const [open, setOpen] = useState(false);
  // 開いたら確定のボタンへ、やめたら「消す」へフォーカスを移す（押したボタンが消えるため）。人が開閉したときだけ移す
  const toggled = useRef(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (open ? confirmRef.current : openRef.current)?.focus();
  }, [open]);
  const toggle = (next: boolean) => {
    toggled.current = true;
    setOpen(next);
  };
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="memoryId" value={memoryId} />
      {open ? (
        <>
          <p className="text-[13px] text-muted-foreground">{m.deleteNote}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={confirmRef}
              type="submit"
              variant="outline"
              disabled={deleting}
              className="min-h-9"
            >
              {deleting ? m.deleting : m.deleteConfirm}
            </Button>
            <Button type="button" variant="ghost" className="min-h-9" onClick={() => toggle(false)}>
              {m.cancel}
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button
            ref={openRef}
            type="button"
            variant="outline"
            className="min-h-9"
            onClick={() => toggle(true)}
          >
            {m.delete}
          </Button>
        </div>
      )}
      {state.message && (
        <p role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** 根拠の一覧。作業履歴の行と、エージェントの実行のログへたどれる。 */
function Evidence({ taskId, items }: { taskId: string; items: AuditEvidence[] }) {
  const messages = useMessages();
  const m = messages.audit;
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold text-muted-foreground">{m.findings.evidence}</h4>
      <ul className="flex flex-col gap-1 text-[13px]">
        {items.map((e) => (
          <li key={`${e.kind}-${e.at}-${e.text}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-muted-foreground">{m.evidence[e.kind]}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{e.text}</span>
            {e.eventId && (
              // 同じページの作業履歴の行へ移る。画面の中の移動（Link）では :target が付かず、行を強調できないので a にする
              <a
                href={`#event-${encodeURIComponent(e.eventId)}`}
                className="text-xs whitespace-nowrap text-accent-foreground underline"
              >
                {m.findings.openEvent}
              </a>
            )}
            {e.runId && (
              <Link
                href={`${taskPath(taskId)}/runs/${encodeURIComponent(e.runId)}`}
                className="text-xs whitespace-nowrap text-accent-foreground underline"
              >
                {m.findings.openRun}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 改修の提案。宛先と中身を出し、判断待ちなら採用（宛先を選べる）・却下（理由が必須）ができる。判断した提案は、採用なら
 * 改修のタスク、却下なら理由を出す。
 */
export function ProposalView({
  proposal,
  from,
}: {
  proposal: AuditProposal;
  /** 提案が出た監査のタスク（監査の画面で出す）。 */
  from?: { taskId: string; title: string };
}) {
  const messages = useMessages();
  const m = messages.audit.proposal;
  const decision = proposal.decision;
  return (
    <div
      data-testid={`audit-proposal-${proposal.id}`}
      className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{proposal.title}</span>
        <span
          data-testid="audit-proposal-state"
          className={
            decision?.kind === "adopted"
              ? "rounded-full border border-ok-line bg-ok-soft px-2 py-0.5 text-xs text-ok"
              : decision?.kind === "rejected"
                ? "rounded-full border border-input px-2 py-0.5 text-xs text-muted-foreground"
                : "rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-xs text-warn"
          }
        >
          {decision?.kind === "adopted"
            ? m.adopted
            : decision?.kind === "rejected"
              ? m.rejected
              : m.pending}
        </span>
      </div>
      {from && (
        <p className="text-xs text-muted-foreground">
          {m.from}{" "}
          <Link href={taskPath(from.taskId)} className="text-accent-foreground underline">
            {from.title}
          </Link>
        </p>
      )}
      <Markdown>{proposal.body}</Markdown>
      {/* 判断待ちの間は、宛先を採用のフォームの選択で出す（同じ宛先を2回出さない） */}
      {decision && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className="text-muted-foreground">{messages.audit.target.label}</span>
          <AuditTargetView
            target={decision.kind === "adopted" ? decision.target : proposal.target}
          />
        </p>
      )}
      {decision?.kind === "adopted" && (
        <p className="text-[13px]">
          <span className="mr-2 text-muted-foreground">{m.task}</span>
          {!decision.task ? (
            // sacty の既定のコンテキストが宛先の提案は、利用者のプロジェクトにタスクを作らない（PBI-125）
            <span className="text-muted-foreground">{m.noTaskForSacty}</span>
          ) : decision.task.mock ? (
            <span>
              {decision.task.title}
              <span className="ml-2 text-xs text-muted-foreground">{m.mockTask}</span>
            </span>
          ) : (
            <Link
              href={taskPath(decision.task.taskId)}
              className="text-accent-foreground underline"
            >
              {decision.task.title}
            </Link>
          )}
          <time dateTime={decision.at} className="ml-2 font-mono text-xs text-muted-foreground">
            {formatStamp(decision.at, messages.locale)}
          </time>
        </p>
      )}
      {decision?.kind === "rejected" && (
        <p className="text-[13px] [overflow-wrap:anywhere]">
          <span className="mr-2 text-muted-foreground">{m.rejectedReason}</span>
          {decision.reason}
          <time dateTime={decision.at} className="ml-2 font-mono text-xs text-muted-foreground">
            {formatStamp(decision.at, messages.locale)}
          </time>
        </p>
      )}
      {!decision && <ProposalDecisionForms proposal={proposal} />}
    </div>
  );
}

const initialProposalState: AuditProposalState = {};

/** 判断待ちの提案の、採用と却下のフォーム。却下は理由の入力を開いてから確定する。 */
function ProposalDecisionForms({ proposal }: { proposal: AuditProposal }) {
  const messages = useMessages();
  const m = messages.audit.proposal;
  const [adoptState, adoptAction, adopting] = useActionState(
    adoptAuditProposalAction,
    initialProposalState,
  );
  const [rejectState, rejectAction, rejecting] = useActionState(
    rejectAuditProposalAction,
    initialProposalState,
  );
  const [rejectOpen, setRejectOpen] = useState(false);
  // 却下の入力を開いたら理由の欄へ、やめたら「却下する」へフォーカスを移す（フォームごと入れ替わり、押したボタンが
  // 消えるため。PR #134 レビュー指摘）。人が開閉したときだけ移す（最初の表示では移さない）
  const toggled = useRef(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (rejectOpen ? reasonRef.current : rejectButtonRef.current)?.focus();
  }, [rejectOpen]);
  const toggleReject = (open: boolean) => {
    toggled.current = true;
    setRejectOpen(open);
  };
  const selectId = `audit-target-${proposal.id}`;
  const reasonId = `audit-reason-${proposal.id}`;
  return (
    <div className="flex flex-col gap-2">
      {!rejectOpen && (
        <form action={adoptAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="proposalId" value={proposal.id} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-1">
              <Label htmlFor={selectId}>{messages.audit.target.label}</Label>
              <Hint text={m.adoptHint} />
            </span>
            <select
              id={selectId}
              name="target"
              defaultValue={auditTargetValue(proposal.target)}
              className="h-9 max-w-full min-w-0 rounded-md border border-border bg-card px-2 text-sm"
            >
              {proposal.targetCandidates.map((c) => {
                const text = auditTargetText(c, messages.audit.target);
                return (
                  <option key={auditTargetValue(c)} value={auditTargetValue(c)}>
                    {text.detail ? `${text.kind}: ${text.detail}` : text.kind}
                  </option>
                );
              })}
            </select>
          </div>
          <Button type="submit" disabled={adopting} className="min-h-9">
            {adopting ? m.adopting : m.adopt}
          </Button>
          <Button
            ref={rejectButtonRef}
            type="button"
            variant="outline"
            className="min-h-9"
            onClick={() => toggleReject(true)}
          >
            {m.reject}
          </Button>
        </form>
      )}
      {adoptState.message && !rejectOpen && (
        <p role="alert" className="text-sm text-warn">
          {adoptState.message}
        </p>
      )}
      {rejectOpen && (
        <form action={rejectAction} className="flex flex-col gap-2">
          <input type="hidden" name="proposalId" value={proposal.id} />
          <span className="flex items-center gap-1">
            <Label htmlFor={reasonId}>{m.reason}</Label>
            <Hint text={m.reasonHint} />
          </span>
          <Textarea
            ref={reasonRef}
            id={reasonId}
            name="reason"
            required
            maxLength={2000}
            defaultValue={rejectState.reason ?? ""}
            placeholder={m.reasonPlaceholder}
            className="bg-card"
            aria-invalid={Boolean(rejectState.message)}
          />
          {rejectState.message && (
            <p role="alert" className="text-sm text-warn">
              {rejectState.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" disabled={rejecting} className="min-h-9">
              {rejecting ? m.rejecting : m.rejectConfirm}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-9"
              onClick={() => toggleReject(false)}
            >
              {m.cancel}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

const initialResumeState: ResumeAuditState = {};

/** 予算で一時停止した監査を、新しい上限（累計）で再開する。 */
function AuditResumeForm({ audit }: { audit: TaskAudit }) {
  const m = useMessages().audit.resume;
  const [state, action, pending] = useActionState(resumeAuditAction, initialResumeState);
  const suggested = suggestedAuditCap(audit.budget.usedUsd, audit.budget.capUsd);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-soft p-3">
      <p className="text-sm text-warn">{m.help}</p>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="taskId" value={audit.taskId} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-cap-usd">{m.newCap(usd(audit.budget.usedUsd))}</Label>
          <div className="flex items-center gap-2">
            <span className="font-mono">$</span>
            <Input
              id="audit-cap-usd"
              name="capUsd"
              type="number"
              step="0.01"
              min={0.01}
              required
              defaultValue={state.capUsd ?? String(suggested)}
              className="w-32 bg-card font-mono"
              aria-invalid={Boolean(state.message)}
            />
          </div>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? m.resuming : m.resume}
        </Button>
      </form>
      {state.message && (
        <p role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
    </div>
  );
}
