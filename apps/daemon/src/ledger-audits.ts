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
import { redactLog } from "./ci.js";
import { lastUsefulAt, usefulDates } from "./memory.js";

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
  rejectAuditProposal(proposalId: string, raw: unknown): Promise<Task>;
  resumeAudit(taskId: string, raw: unknown): Task;
  deleteAuditMemory(memoryId: string): Task;
  /** 監査の画面・レポートに出す文（元のタスクの題など）の秘密情報を伏せる関数（プロジェクトごと）。 */
  auditHide(projectId: string): Promise<(text: string) => string>;
};

/** メモリーの有効な最終利用日と、登録したメモリー（ほかのタスクの監査が登録したものを含む。PBI-127）。 */
type MemoryIndex = {
  dates: Map<string, string>;
  registered: Map<string, NonNullable<Task["audit"]>["memories"][number]>;
};

/** すべてのタスクから、メモリーの集計を作る（画面の形を作るときに1回だけ）。 */
function memoryIndex(tasks: readonly Task[]): MemoryIndex {
  return {
    dates: usefulDates(tasks),
    registered: new Map(
      tasks.flatMap((t) => (t.audit?.memories ?? []).map((m) => [m.id, m] as const)),
    ),
  };
}

/** 監査の画面・レポートに出す文の、秘密情報を伏せる関数。 */
type Hide = (text: string) => string;

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
    hide: Hide,
  ): AuditProposalDecision | undefined {
    if (!decision) return undefined;
    // 却下の理由は記録する前に伏せている。それより前の記録のために、画面に出す前にも、よくある秘密情報の形を伏せる
    // （PR #135 再レビュー指摘）
    if (decision.kind === "rejected")
      return { ...decision, reason: redactLog(decision.reason, []) };
    const fix = decision.fixTaskId ? byId.get(decision.fixTaskId) : undefined;
    return {
      kind: "adopted",
      at: decision.at,
      target: decision.target,
      ...(decision.fixTaskId
        ? { task: { taskId: decision.fixTaskId, title: hide(fix?.title ?? decision.fixTaskId) } }
        : {}),
    };
  }

  private findingView(
    task: Task,
    finding: TaskAuditFinding,
    info: CauseInfo | undefined,
    byId: ReadonlyMap<string, Task>,
    hide: Hide,
  ): AuditFinding {
    const recurred = info?.fixedAt !== undefined && finding.at > info.fixedAt;
    return {
      causeId: finding.causeKey,
      title: finding.title,
      detail: finding.detail,
      ...(finding.step ? { step: finding.step } : {}),
      evidence: finding.evidence.map((e) => ({ ...e, at: finding.at })),
      proposals: finding.proposals.map((p) => {
        const decision = this.decisionOf(p.decision, byId, hide);
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
  private view(
    task: Task,
    causes: Map<string, CauseInfo>,
    byId: Map<string, Task>,
    hide: Hide,
    memory: MemoryIndex,
  ): TaskAudit {
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
    const { dates, registered } = memory;
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
      findings: audit.findings.map((f) =>
        this.findingView(task, f, causes.get(f.causeKey), byId, hide),
      ),
      memories: audit.memories.map((m) => ({
        id: m.id,
        scope: m.scope,
        ...(m.scope === "repository" ? { repo: m.repo } : {}),
        title: m.title,
        summary: m.summary,
        body: m.body,
        step: m.step,
        at: m.at,
        lastUsefulAt: lastUsefulAt(m.at, dates.get(m.id)),
        ...(m.deleted ? { deleted: m.deleted } : {}),
      })),
      usefulMemories: (audit.survey?.usefulMemories ?? []).flatMap((id) => {
        const m = registered.get(id);
        return m ? [{ id, scope: m.scope, title: m.title }] : [];
      }),
    };
  }

  async taskAudit(taskId: string): Promise<TaskAudit | null> {
    const task = this.ledger.list().find((t) => t.id === taskId);
    if (!task) return null;
    return this.taskAuditWith(taskId, await this.ledger.auditHide(task.projectId));
  }

  private taskAuditWith(taskId: string, hide: Hide): TaskAudit | null {
    const tasks = this.ledger.list();
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !isAuditTarget(task) || !task.audit) return null;
    return this.view(
      task,
      this.causeInfo(task.projectId, tasks),
      new Map(tasks.map((t) => [t.id, t])),
      hide,
      memoryIndex(tasks),
    );
  }

  async projectAudits(projectId: string): Promise<ProjectAudits | null> {
    if (!this.ledger.listProjects().some((p) => p.id === projectId)) return null;
    return this.projectAuditsWith(projectId, await this.ledger.auditHide(projectId));
  }

  /**
   * プロジェクトの監査の画面の形。元のタスクの題は、監査の画面・レポートに出すので hide で伏せる（元のタスクは変えない。
   * PR #135 再レビュー指摘）。
   */
  private projectAuditsWith(projectId: string, hide: Hide): ProjectAudits | null {
    if (!this.ledger.listProjects().some((p) => p.id === projectId)) return null;
    const tasks = this.ledger.list();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const causes = this.causeInfo(projectId, tasks);
    const audited = this.audited(projectId, tasks);
    // メモリーの集計は、一覧の中で1回だけ行う（監査のタスクごとに全タスクを走査し直さない。PR #137 レビュー指摘）
    const memory = memoryIndex(tasks);
    const views = audited.map((t) => ({
      task: t,
      audit: this.view(t, causes, byId, hide, memory),
    }));
    const rows: AuditRow[] = views
      .map(({ task, audit }) => ({
        taskId: task.id,
        taskTitle: hide(task.title),
        status: audit.status,
        ...(audit.finishedAt ? { finishedAt: audit.finishedAt } : {}),
        usedUsd: audit.budget.usedUsd,
        ...(audit.survey ? { counts: audit.survey.counts } : {}),
      }))
      .reverse();
    const proposals: ListedAuditProposal[] = views
      .flatMap(({ task, audit }) =>
        audit.findings.flatMap((f) =>
          f.proposals.map((p) => ({ ...p, taskTitle: hide(task.title) })),
        ),
      )
      .reverse()
      .sort((a, b) => Number(isPendingAuditProposal(b)) - Number(isPendingAuditProposal(a)));
    const causeList: AuditCause[] = [...causes.entries()].map(([id, info]) => {
      const occurrences = new Map<string, { taskId: string; taskTitle: string; at: string }>();
      for (const { task, finding } of info.findings) {
        const seen = occurrences.get(task.id);
        if (!seen || seen.at < finding.at) {
          occurrences.set(task.id, {
            taskId: task.id,
            taskTitle: hide(task.title),
            at: finding.at,
          });
        }
      }
      const all = info.findings.flatMap(({ finding }) =>
        finding.proposals.map((p) => {
          const decision = this.decisionOf(p.decision, byId, hide);
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
      // 件数だけを出すので、題は伏せなくてよい
      const data = this.projectAuditsWith(p.id, (text) => text);
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
  private async proposalAfter(task: Task, proposalId: string): Promise<ListedAuditProposal> {
    const found = (await this.projectAudits(task.projectId))?.proposals.find(
      (p) => p.id === proposalId,
    );
    if (!found) throw new Error("the proposal is missing after the operation");
    return found;
  }

  async adopt(proposalId: string, input: unknown): Promise<ListedAuditProposal> {
    return this.proposalAfter(this.ledger.adoptAuditProposal(proposalId, input), proposalId);
  }

  async reject(proposalId: string, input: unknown): Promise<ListedAuditProposal> {
    return this.proposalAfter(await this.ledger.rejectAuditProposal(proposalId, input), proposalId);
  }

  async deleteMemory(memoryId: string): Promise<TaskAudit> {
    const task = this.ledger.deleteAuditMemory(memoryId);
    const audit = await this.taskAudit(task.id);
    if (!audit) throw new Error("the audit is missing after deleting the memory");
    return audit;
  }

  async resume(taskId: string, input: unknown): Promise<TaskAudit> {
    this.ledger.resumeAudit(taskId, input);
    const audit = await this.taskAudit(taskId);
    if (!audit) throw new Error("the audit is missing after resuming");
    return audit;
  }
}
