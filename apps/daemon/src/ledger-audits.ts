import {
  type AuditCause,
  type AuditDashboard,
  type AuditFinding,
  type AuditProposalDecision,
  type AuditRow,
  auditRemarkCount,
  isAuditTarget,
  isPendingAuditProposal,
  type ListedAuditProposal,
  nextAuditDive,
  type Project,
  type ProjectAudits,
  type Task,
  type TaskAudit,
  type TaskAuditFinding,
} from "@sacty/core";
import { type AuditService, causeStatus, sortCauses, weekStart } from "./audits.js";

/*
 * 完了したタスクの監査を、作業履歴の記録（タスクの監査の状態。Audit… のイベントを畳み込んだもの）から組み立てる（PBI-125）。
 * 原因はプロジェクトの中で原因の鍵（causeKey）ごとにまとめ、改修のタスクの PR のマージより後に同じ原因が見つかれば再発にする。
 * プロジェクトをまたいで集約しない。
 */

/** 監査の記録を読み、操作を任せる先（TaskService）。 */
export type AuditLedger = {
  list(): Task[];
  listProjects(): Project[];
  auditBudgetUsd(): number;
  auditRunning(taskId: string): boolean;
  adoptAuditProposal(proposalId: string, raw: unknown): Task;
  rejectAuditProposal(proposalId: string, raw: unknown): Task;
  resumeAudit(taskId: string, raw: unknown): Task;
};

/** 原因の鍵ごとの、まとめた情報。 */
type CauseInfo = {
  title: string;
  findings: { task: Task; finding: TaskAuditFinding }[];
  fixedAt?: string;
  recurredAt?: string;
};

export class LedgerAuditService implements AuditService {
  constructor(private readonly ledger: AuditLedger) {}

  /** プロジェクトの、監査のある完了したタスク（完了した順）。 */
  private audited(projectId: string, tasks: readonly Task[]): Task[] {
    return tasks
      .filter((t) => t.projectId === projectId && isAuditTarget(t) && t.audit)
      .sort((a, b) => (a.audit?.queuedAt ?? "").localeCompare(b.audit?.queuedAt ?? ""));
  }

  /** プロジェクトの原因を、原因の鍵ごとにまとめる。改修のマージの時刻と、その後に見つかった時刻を決める。 */
  private causeInfo(projectId: string, tasks: readonly Task[]): Map<string, CauseInfo> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const causes = new Map<string, CauseInfo>();
    for (const task of this.audited(projectId, tasks)) {
      for (const finding of task.audit?.findings ?? []) {
        const info = causes.get(finding.causeKey) ?? { title: finding.title, findings: [] };
        info.findings.push({ task, finding });
        causes.set(finding.causeKey, info);
      }
    }
    for (const info of causes.values()) {
      const merges = info.findings.flatMap(({ finding }) =>
        finding.proposals.flatMap((p) => {
          const id = p.decision?.kind === "adopted" ? p.decision.fixTaskId : undefined;
          const at = id ? byId.get(id)?.pullRequestMerge?.at : undefined;
          return at ? [at] : [];
        }),
      );
      const fixedAt = merges.sort()[0];
      if (!fixedAt) continue;
      info.fixedAt = fixedAt;
      const after = info.findings.map(({ finding }) => finding.at).filter((at) => at > fixedAt);
      const recurredAt = after.sort()[0];
      if (recurredAt) info.recurredAt = recurredAt;
    }
    return causes;
  }

  private decisionOf(
    decision: TaskAuditFinding["proposals"][number]["decision"],
    byId: ReadonlyMap<string, Task>,
  ): AuditProposalDecision | undefined {
    if (!decision) return undefined;
    if (decision.kind === "rejected") return decision;
    const fix = decision.fixTaskId ? byId.get(decision.fixTaskId) : undefined;
    return {
      kind: "adopted",
      at: decision.at,
      target: decision.target,
      ...(decision.fixTaskId
        ? { task: { taskId: decision.fixTaskId, title: fix?.title ?? decision.fixTaskId } }
        : {}),
    };
  }

  private findingView(
    task: Task,
    finding: TaskAuditFinding,
    info: CauseInfo | undefined,
    byId: ReadonlyMap<string, Task>,
  ): AuditFinding {
    const recurred = info?.fixedAt !== undefined && finding.at > info.fixedAt;
    return {
      causeId: finding.causeKey,
      title: finding.title,
      detail: finding.detail,
      ...(finding.step ? { step: finding.step } : {}),
      evidence: finding.evidence.map((e) => ({ ...e, at: finding.at })),
      proposals: finding.proposals.map((p) => {
        const decision = this.decisionOf(p.decision, byId);
        return {
          id: p.id,
          causeId: finding.causeKey,
          taskId: task.id,
          title: p.title,
          body: p.body,
          target: p.target,
          targetCandidates: p.candidates,
          ...(decision ? { decision } : {}),
        };
      }),
      ...(recurred ? { recurred: true as const } : {}),
    };
  }

  /** タスクの監査の状態を、画面の形にする。 */
  private view(task: Task, causes: Map<string, CauseInfo>, byId: Map<string, Task>): TaskAudit {
    const audit = task.audit;
    if (!audit) throw new Error("the task has no audit");
    const running = this.ledger.auditRunning(task.id);
    const status: TaskAudit["status"] = audit.failed
      ? "failed"
      : audit.completedAt
        ? "completed"
        : audit.paused
          ? "budgetPaused"
          : !audit.survey
            ? running
              ? "surveying"
              : "waiting"
            : "deepDiving";
    const next = nextAuditDive(audit);
    const finishedAt = audit.completedAt ?? audit.failed?.at;
    return {
      taskId: task.id,
      projectId: task.projectId,
      status,
      startedAt: audit.queuedAt,
      ...(finishedAt ? { finishedAt } : {}),
      budget: { usedUsd: audit.usedUsd, capUsd: audit.capUsd },
      ...(audit.failed ? { failure: audit.failed.reason } : {}),
      ...(audit.survey
        ? { survey: { summary: audit.survey.summary, counts: audit.survey.counts } }
        : {}),
      deepDives: (audit.survey?.concerns ?? []).map((c) => {
        const done = audit.dives.find((d) => d.step === c.step);
        return {
          step: c.step,
          reason: c.reason,
          status: done
            ? ("completed" as const)
            : audit.failed?.step === c.step
              ? ("failed" as const)
              : c.step === next && running
                ? ("running" as const)
                : ("waiting" as const),
          ...(done ? { summary: done.summary } : {}),
        };
      }),
      findings: audit.findings.map((f) => this.findingView(task, f, causes.get(f.causeKey), byId)),
    };
  }

  taskAudit(taskId: string): TaskAudit | null {
    const tasks = this.ledger.list();
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !isAuditTarget(task) || !task.audit) return null;
    return this.view(
      task,
      this.causeInfo(task.projectId, tasks),
      new Map(tasks.map((t) => [t.id, t])),
    );
  }

  projectAudits(projectId: string): ProjectAudits | null {
    if (!this.ledger.listProjects().some((p) => p.id === projectId)) return null;
    const tasks = this.ledger.list();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const causes = this.causeInfo(projectId, tasks);
    const audited = this.audited(projectId, tasks);
    const views = audited.map((t) => ({ task: t, audit: this.view(t, causes, byId) }));
    const rows: AuditRow[] = views
      .map(({ task, audit }) => ({
        taskId: task.id,
        taskTitle: task.title,
        status: audit.status,
        ...(audit.finishedAt ? { finishedAt: audit.finishedAt } : {}),
        usedUsd: audit.budget.usedUsd,
        ...(audit.survey ? { counts: audit.survey.counts } : {}),
      }))
      .reverse();
    const proposals: ListedAuditProposal[] = views
      .flatMap(({ task, audit }) =>
        audit.findings.flatMap((f) => f.proposals.map((p) => ({ ...p, taskTitle: task.title }))),
      )
      .reverse()
      .sort((a, b) => Number(isPendingAuditProposal(b)) - Number(isPendingAuditProposal(a)));
    const causeList: AuditCause[] = [...causes.entries()].map(([id, info]) => {
      const occurrences = new Map<string, { taskId: string; taskTitle: string; at: string }>();
      for (const { task, finding } of info.findings) {
        const seen = occurrences.get(task.id);
        if (!seen || seen.at < finding.at) {
          occurrences.set(task.id, { taskId: task.id, taskTitle: task.title, at: finding.at });
        }
      }
      const all = info.findings.flatMap(({ finding }) =>
        finding.proposals.map((p) => {
          const decision = this.decisionOf(p.decision, byId);
          return decision ? { decision } : {};
        }),
      );
      return {
        id,
        projectId,
        title: info.title,
        status: causeStatus(all, info.fixedAt, info.recurredAt),
        occurrences: [...occurrences.values()].sort((a, b) => b.at.localeCompare(a.at)),
        ...(info.fixedAt ? { fixedAt: info.fixedAt } : {}),
        ...(info.recurredAt ? { recurredAt: info.recurredAt } : {}),
      };
    });
    return {
      projectId,
      mock: false,
      defaultCapUsd: this.ledger.auditBudgetUsd(),
      audits: rows,
      causes: sortCauses(causeList),
      proposals,
    };
  }

  dashboard(): AuditDashboard {
    const projects = this.ledger.listProjects().flatMap((p) => {
      const data = this.projectAudits(p.id);
      if (!data) return [];
      const decided = (kind: "adopted" | "rejected") =>
        data.proposals.filter((x) => x.decision?.kind === kind).length;
      return [
        {
          projectId: p.id,
          causes: data.causes.length,
          recurred: data.causes.filter((c) => c.status === "recurred").length,
          pending: data.proposals.filter(isPendingAuditProposal).length,
          adopted: decided("adopted"),
          rejected: decided("rejected"),
        },
      ];
    });
    const weeks = new Map<string, { tasks: number; remarks: number }>();
    const ids = new Set(this.ledger.listProjects().map((p) => p.id));
    for (const task of this.ledger.list()) {
      const audit = task.audit;
      if (!ids.has(task.projectId) || !isAuditTarget(task) || !audit?.completedAt) continue;
      if (!audit.survey) continue;
      const week = weekStart(audit.completedAt);
      const sum = weeks.get(week) ?? { tasks: 0, remarks: 0 };
      sum.tasks += 1;
      sum.remarks += auditRemarkCount(audit.survey.counts);
      weeks.set(week, sum);
    }
    return {
      mock: false,
      projects: projects.filter((p) => p.causes > 0 || p.pending > 0),
      trend: [...weeks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-8)
        .map(([week, sum]) => ({ weekStart: week, ...sum })),
    };
  }

  /** 操作の後の提案（画面に返す）。 */
  private proposalAfter(task: Task, proposalId: string): ListedAuditProposal {
    const found = this.projectAudits(task.projectId)?.proposals.find((p) => p.id === proposalId);
    if (!found) throw new Error("the proposal is missing after the operation");
    return found;
  }

  adopt(proposalId: string, input: unknown): ListedAuditProposal {
    return this.proposalAfter(this.ledger.adoptAuditProposal(proposalId, input), proposalId);
  }

  reject(proposalId: string, input: unknown): ListedAuditProposal {
    return this.proposalAfter(this.ledger.rejectAuditProposal(proposalId, input), proposalId);
  }

  resume(taskId: string, input: unknown): TaskAudit {
    this.ledger.resumeAudit(taskId, input);
    const audit = this.taskAudit(taskId);
    if (!audit) throw new Error("the audit is missing after resuming");
    return audit;
  }
}
