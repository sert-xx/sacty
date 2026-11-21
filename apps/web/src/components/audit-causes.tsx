"use client";

import {
  AUDIT_BULK_REJECT_MAX,
  AUDIT_REJECT_REASON_MAX,
  isPendingAuditProposal,
  type ListedAuditProposal,
  type ProjectAudits,
} from "@sacty/core";
import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { memo, useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type BulkRejectState, rejectAuditProposalsAction } from "@/app/actions";
import { ProposalView } from "@/components/audit";
import { CardSection } from "@/components/card-section";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";
import { auditCauseTitle } from "@/lib/audit";
import {
  AUDIT_CAUSE_FILTERS,
  AUDIT_CAUSE_PROPOSALS_PAGE,
  AUDIT_CAUSE_TASKS_SHOWN,
  AUDIT_CAUSES_PAGE,
  type AuditView,
  auditScreenHref,
} from "@/lib/audit-view";
import { formatStamp } from "@/lib/labels";
import { projectAuditPath, taskPath } from "@/lib/paths";

/** 原因の状態の色。再発は目立たせる（警告の色）。 */
const CAUSE_STYLE: Record<ProjectAudits["causes"][number]["status"], string> = {
  recurred: "border-warn-line bg-warn-soft text-warn font-semibold",
  proposed: "border-accent-line bg-accent text-accent-foreground",
  adopted: "border-ok-line bg-ok-soft text-ok",
  fixed: "border-ok-line bg-ok-soft text-ok",
  rejected: "border-input text-muted-foreground",
};

const initial: BulkRejectState = {};

/**
 * 監査の画面の、原因と提案（PBI-443）。原因ごとに束ね、畳んだ行で出す。開くと該当するタスクとその原因の提案を出し、
 * 提案の判断は開いた中だけで行う。判断待ちの提案は複数選び、1 つの理由でまとめて却下できる。
 * 開いている原因・選んでいる提案はクライアントで持つので、判断の後の描き直しでも保たれる。
 * 絞り込みと出す件数は URL（?causes=・?shown=）に残し、区切りは画面のサーバーの側で行う。
 */
export function AuditCauses({ data, view }: { data: ProjectAudits; view: AuditView }) {
  const messages = useMessages();
  const m = messages.audit;
  const base = projectAuditPath(data.projectId);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [state, action, pending] = useActionState(rejectAuditProposalsAction, initial);
  // 確定したときの提案の題の写し（描き直しで原因が一覧から外れても、失敗した提案の題を出せるように）
  const [submitted, setSubmitted] = useState<ReadonlyMap<string, string>>(new Map());
  const resultRef = useRef<HTMLDivElement>(null);

  const byCause = useMemo(() => {
    const map = new Map<string, ListedAuditProposal[]>();
    for (const p of data.proposals) {
      const list = map.get(p.causeId) ?? [];
      list.push(p);
      map.set(p.causeId, list);
    }
    return map;
  }, [data.proposals]);

  const proposalInfo = useMemo(() => {
    const info = new Map<string, { title: string; causeId: string; pending: boolean }>();
    for (const cause of data.causes) {
      for (const p of byCause.get(cause.id) ?? []) {
        info.set(p.id, { title: p.title, causeId: cause.id, pending: isPendingAuditProposal(p) });
      }
    }
    return info;
  }, [data.causes, byCause]);

  // 判断済みになった・絞り込みや件数で出なくなった提案は、選択から外す
  const chosen = useMemo(
    () => new Set([...selected].filter((id) => proposalInfo.get(id)?.pending)),
    [selected, proposalInfo],
  );
  useEffect(() => {
    if (chosen.size !== selected.size) setSelected(chosen);
  }, [chosen, selected]);

  // まとめて却下の結果：1 件でも却下できたら選択を空にし、確認のダイアログを閉じる
  useEffect(() => {
    if (!state.result) return;
    setDialogOpen(false);
    setReason("");
    if (state.result.rejectedIds.length > 0) {
      setSelected(new Set());
      // 開いたボタンは選択が空で押せなくなるので、フォーカスを結果の領域に移す
      requestAnimationFrame(() => resultRef.current?.focus());
    }
  }, [state.result]);

  const toggleOpen = useCallback(
    (id: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const setChosen = useCallback(
    (ids: readonly string[], on: boolean) =>
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      }),
    [],
  );
  // 原因ごとに、選んでいる提案の ID の並び（文字列）。選択が変わった原因の行だけを描き直すための印
  const chosenKeys = useMemo(() => {
    const keys = new Map<string, string[]>();
    for (const id of chosen) {
      const cause = proposalInfo.get(id)?.causeId;
      if (cause === undefined) continue;
      keys.set(cause, [...(keys.get(cause) ?? []), id]);
    }
    return new Map([...keys].map(([cause, ids]) => [cause, JSON.stringify(ids.sort())]));
  }, [chosen, proposalInfo]);

  const overLimit = chosen.size > AUDIT_BULK_REJECT_MAX;
  const noteText = view.total > 0 ? m.screen.causesNote(view.total, data.causes.length) : undefined;
  return (
    <CardSection
      id="audit-causes"
      title={m.screen.causes}
      hint={m.screen.causesHint}
      note={view.projectCauses > 0 ? noteText : undefined}
    >
      {view.projectCauses === 0 ? (
        <p className="text-sm text-muted-foreground">{m.screen.causesNone}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <nav aria-label={m.screen.filterLabel} className="flex flex-wrap gap-2">
            {AUDIT_CAUSE_FILTERS.map((f) => (
              <Link
                key={f}
                href={auditScreenHref(base, f, AUDIT_CAUSES_PAGE)}
                replace
                scroll={false}
                aria-current={view.filter === f ? "true" : undefined}
                data-testid={`audit-filter-${f}`}
                className={cn(
                  buttonVariants({ variant: view.filter === f ? "secondary" : "outline" }),
                  "min-h-9",
                )}
              >
                {m.screen.filter[f]}
              </Link>
            ))}
          </nav>

          {view.projectPending > 0 && (
            <div
              data-testid="audit-bulk-bar"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span data-testid="audit-selected-count" className="text-sm tabular-nums">
                {m.bulk.selected(chosen.size)}
              </span>
              {overLimit && (
                <span role="alert" className="text-sm text-warn">
                  {m.bulk.overLimit(AUDIT_BULK_REJECT_MAX)}
                </span>
              )}
              <Dialog
                open={dialogOpen}
                onOpenChange={(next) => {
                  // 送信中は閉じない（結果が届いたときに、選び直した選択や理由が消えないように）
                  if (!next && pending) return;
                  setDialogOpen(next);
                }}
              >
                <DialogTrigger
                  render={
                    <Button
                      variant="outline"
                      className="min-h-10"
                      disabled={chosen.size === 0}
                      data-testid="audit-bulk-reject"
                    >
                      {m.bulk.reject}
                    </Button>
                  }
                />
                <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
                  <form
                    action={action}
                    onSubmit={() =>
                      setSubmitted(
                        new Map([...chosen].map((id) => [id, proposalInfo.get(id)?.title ?? ""])),
                      )
                    }
                    className="flex min-w-0 flex-col gap-4"
                  >
                    <input type="hidden" name="projectId" value={data.projectId} />
                    {[...chosen].map((id) => (
                      <input key={id} type="hidden" name="proposalId" value={id} />
                    ))}
                    <DialogHeader>
                      <DialogTitle>{m.bulk.dialogTitle}</DialogTitle>
                      <DialogDescription>
                        {m.bulk.dialogCount(chosen.size)} {m.bulk.irreversible}
                      </DialogDescription>
                    </DialogHeader>
                    <SelectedList
                      data={data}
                      byCause={byCause}
                      chosen={chosen}
                      causeTitle={(id, title) => auditCauseTitle(id, title, m)}
                    />
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="audit-bulk-reason" className="text-sm font-medium">
                        {m.bulk.reason}
                      </label>
                      <Textarea
                        id="audit-bulk-reason"
                        name="reason"
                        required
                        maxLength={AUDIT_REJECT_REASON_MAX}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        aria-describedby="audit-bulk-reason-hint"
                      />
                      <p id="audit-bulk-reason-hint" className="text-xs text-muted-foreground">
                        {m.bulk.reasonHint}
                      </p>
                    </div>
                    {state.message && (
                      <p role="alert" className="text-sm text-warn">
                        {state.message}
                      </p>
                    )}
                    <DialogFooter>
                      <DialogClose render={<Button variant="outline" disabled={pending} />}>
                        {m.bulk.cancel}
                      </DialogClose>
                      <Button
                        type="submit"
                        disabled={pending || overLimit || chosen.size === 0 || reason.trim() === ""}
                        className="bg-warn text-white hover:bg-warn/90 dark:text-background"
                      >
                        {pending ? m.bulk.rejecting : m.bulk.confirm}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          )}

          <BulkResult state={state} titleOf={(id) => submitted.get(id)} resultRef={resultRef} />

          {data.causes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.screen.filterNone}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.causes.map((cause) => (
                <CauseRow
                  key={cause.id}
                  cause={cause}
                  proposals={byCause.get(cause.id) ?? []}
                  open={open.has(cause.id)}
                  onToggle={toggleOpen}
                  chosenKey={chosenKeys.get(cause.id) ?? "[]"}
                  onChoose={setChosen}
                />
              ))}
            </ul>
          )}

          {view.total > data.causes.length && (
            <div>
              <Link
                href={auditScreenHref(base, view.filter, view.shown + AUDIT_CAUSES_PAGE)}
                replace
                scroll={false}
                data-testid="audit-show-more"
                className={cn(buttonVariants({ variant: "outline" }), "min-h-10")}
              >
                {m.screen.more}
              </Link>
            </div>
          )}
        </div>
      )}
    </CardSection>
  );
}

/** まとめて却下の結果。全部成功か、一部（または全部）できなかったかを、できた件数・できなかった件数と一緒に出す。 */
function BulkResult({
  state,
  titleOf,
  resultRef,
}: {
  state: BulkRejectState;
  titleOf: (proposalId: string) => string | undefined;
  resultRef: React.RefObject<HTMLDivElement | null>;
}) {
  const m = useMessages().audit.bulk;
  const result = state.result;
  if (!result) return null;
  const ok = result.rejectedIds.length;
  const ng = result.failed.length;
  return (
    <div
      ref={resultRef}
      tabIndex={-1}
      role="status"
      data-testid="audit-bulk-result"
      className="flex flex-col gap-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className={ng > 0 ? "font-medium text-warn" : "text-ok"}>
        {ng === 0 ? m.done(ok) : ok === 0 ? m.none(ng) : m.partial(ok, ng)}
      </p>
      {ng > 0 && (
        <ul className="flex flex-col gap-0.5 text-[13px] [overflow-wrap:anywhere]">
          {result.failed.map((f) => (
            <li key={f.proposalId}>
              {m.failedItem(titleOf(f.proposalId) ?? m.failedUnknown, f.message)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 確認のダイアログの、選んだ提案の題（原因ごとに分ける。多いときはダイアログの中でスクロールする）。 */
function SelectedList({
  data,
  byCause,
  chosen,
  causeTitle,
}: {
  data: ProjectAudits;
  byCause: ReadonlyMap<string, ListedAuditProposal[]>;
  chosen: ReadonlySet<string>;
  causeTitle: (id: string, title: string) => string;
}) {
  return (
    <div
      data-testid="audit-bulk-list"
      className="flex max-h-60 flex-col gap-3 overflow-y-auto rounded-lg border border-border px-3 py-2"
    >
      {data.causes.flatMap((cause) => {
        const items = (byCause.get(cause.id) ?? []).filter((p) => chosen.has(p.id));
        if (items.length === 0) return [];
        return [
          <section key={cause.id} className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold [overflow-wrap:anywhere] text-muted-foreground">
              {causeTitle(cause.id, cause.title)}
            </h3>
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[13px] [overflow-wrap:anywhere]">
              {items.map((p) => (
                <li key={p.id}>{p.title}</li>
              ))}
            </ul>
          </section>,
        ];
      })}
    </div>
  );
}

/** 提案の表示は、提案が変わらなければ描き直さない（選択の操作のたびに、開いた提案を全部描き直さない）。 */
const MemoProposalView = memo(ProposalView);

/** 原因の 1 行。畳んだ行で、状態・題・見つかった回数・判断待ちの数を読める。開くと該当するタスクと提案を出す。 */
const CauseRow = memo(function CauseRow({
  cause,
  proposals,
  open,
  onToggle,
  chosenKey,
  onChoose,
}: {
  cause: ProjectAudits["causes"][number];
  proposals: ListedAuditProposal[];
  open: boolean;
  onToggle: (id: string) => void;
  /** 選んでいる提案の ID の並び（JSON）。選択が変わった原因の行だけを描き直す。 */
  chosenKey: string;
  onChoose: (ids: readonly string[], on: boolean) => void;
}) {
  const chosen = useMemo(() => new Set<string>(JSON.parse(chosenKey) as string[]), [chosenKey]);
  const messages = useMessages();
  const m = messages.audit;
  const title = auditCauseTitle(cause.id, cause.title, m);
  const pendingCount = proposals.filter(isPendingAuditProposal).length;
  const panelId = `audit-cause-panel-${cause.id}`;
  return (
    <li
      data-testid={`audit-cause-${cause.id}`}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5",
        cause.status === "recurred" ? "border-warn-line" : "border-border",
      )}
    >
      <h3 className="m-0 text-base font-normal">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(cause.id)}
          className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
          />
          <span
            data-testid="audit-cause-status"
            className={cn("rounded-full border px-2 py-0.5 text-xs", CAUSE_STYLE[cause.status])}
          >
            {m.screen.causeStatus[cause.status]}
          </span>
          <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{title}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {m.screen.occurrences(cause.occurrences.length)}
          </span>
          <span
            data-testid="audit-cause-pending"
            className="text-xs text-muted-foreground tabular-nums"
          >
            {m.screen.pendingCount(pendingCount)}
          </span>
        </button>
      </h3>
      {open && (
        <CausePanel
          id={panelId}
          cause={cause}
          title={title}
          proposals={proposals}
          chosen={chosen}
          onChoose={onChoose}
        />
      )}
    </li>
  );
});

/** 開いた原因の中身：改修・再発の日時、該当するタスク（5 件まで）、提案（判断待ちを先に。10 件ずつ）。 */
function CausePanel({
  id,
  cause,
  title,
  proposals,
  chosen,
  onChoose,
}: {
  id: string;
  cause: ProjectAudits["causes"][number];
  title: string;
  proposals: ListedAuditProposal[];
  chosen: ReadonlySet<string>;
  onChoose: (ids: readonly string[], on: boolean) => void;
}) {
  const messages = useMessages();
  const m = messages.audit;
  const [allTasks, setAllTasks] = useState(false);
  const [limit, setLimit] = useState(AUDIT_CAUSE_PROPOSALS_PAGE);
  const tasks = allTasks ? cause.occurrences : cause.occurrences.slice(0, AUDIT_CAUSE_TASKS_SHOWN);
  const hiddenTasks = cause.occurrences.length - tasks.length;
  const shown = proposals.slice(0, limit);
  const hiddenProposals = proposals.length - shown.length;
  // 「判断待ちをすべて選ぶ」の範囲は、いま出している判断待ちの提案だけ
  const selectable = shown.filter(isPendingAuditProposal).map((p) => p.id);
  const picked = selectable.filter((pid) => chosen.has(pid)).length;
  return (
    <section id={id} aria-label={m.screen.causeDetailLabel(title)} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {cause.fixedAt && (
          <span>
            {m.screen.fixedAt}{" "}
            <time dateTime={cause.fixedAt} className="font-mono">
              {formatStamp(cause.fixedAt, messages.locale)}
            </time>
          </span>
        )}
        {cause.recurredAt && (
          <span className="text-warn">
            {m.screen.recurredAt}{" "}
            <time dateTime={cause.recurredAt} className="font-mono">
              {formatStamp(cause.recurredAt, messages.locale)}
            </time>
          </span>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="text-muted-foreground">{m.screen.tasks}</span>
        {tasks.map((o) => (
          <Link
            key={o.taskId}
            href={taskPath(o.taskId)}
            className="text-accent-foreground underline [overflow-wrap:anywhere]"
          >
            {o.taskTitle}
          </Link>
        ))}
        {hiddenTasks > 0 && (
          <button
            type="button"
            onClick={() => setAllTasks(true)}
            className="rounded-md text-muted-foreground underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {m.screen.moreTasks(hiddenTasks)}
          </button>
        )}
      </p>
      {selectable.length > 0 && (
        <label className="flex w-fit items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            aria-label={m.bulk.selectAllLabel(title)}
            checked={picked === selectable.length}
            ref={(el) => {
              if (el) el.indeterminate = picked > 0 && picked < selectable.length;
            }}
            onChange={(e) => onChoose(selectable, e.target.checked)}
            className="size-5 accent-[var(--color-accent-foreground)]"
          />
          {m.bulk.selectAll}
        </label>
      )}
      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.screen.proposalsNone}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((p) => (
            <li key={p.id} className="flex items-start gap-2">
              {isPendingAuditProposal(p) && (
                <input
                  type="checkbox"
                  aria-label={m.bulk.selectOne(title, p.title)}
                  checked={chosen.has(p.id)}
                  onChange={(e) => onChoose([p.id], e.target.checked)}
                  className="mt-3 size-5 shrink-0 accent-[var(--color-accent-foreground)]"
                />
              )}
              <div className="min-w-0 flex-1">
                <MemoProposalView proposal={p} from={{ taskId: p.taskId, title: p.taskTitle }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {hiddenProposals > 0 && (
        <div>
          <Button
            type="button"
            variant="outline"
            className="min-h-9"
            onClick={() => setLimit((n) => n + AUDIT_CAUSE_PROPOSALS_PAGE)}
          >
            {m.screen.moreProposals(hiddenProposals)}
          </Button>
        </div>
      )}
    </section>
  );
}
