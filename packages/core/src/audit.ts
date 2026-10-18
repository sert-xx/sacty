import { z } from "zod";
import {
  type AuditEvidenceKind,
  AuditTarget,
  type MemoryDeleteReason,
  type StepKey,
} from "./events.js";
import { code, type DaemonText } from "./message-code.js";

/*
 * 完了したタスクの監査（PBI-124）。監査は、完了したタスクの過程（工程の判断から完了まで）を調べ、差し戻し・指摘・
 * 試行錯誤の原因と、それを防ぐ改修の提案を出す。ここは画面とデーモンが共有するデータの形で、PBI-124 では
 * デーモンがモックのデータを返し、PBI-125 で実際の監査の記録（作業履歴の Audit… のイベント）から作る。
 * 宛先（AuditTarget）と根拠の種類（AUDIT_EVIDENCE_KINDS）は、作業履歴のイベントでも使うので events.ts に置く。
 */

/** 1回の監査の、予算の既定の上限（米ドル。config.yaml の budget.default_per_audit_usd で変えられる）。 */
export const DEFAULT_AUDIT_BUDGET_USD = 1;

/**
 * 監査の状態。待ち → 大まかな監査（surveying）→ 深掘り（deepDiving）→ 完了。失敗と、予算で一時停止もある。
 */
export const AUDIT_STATUSES = [
  "waiting",
  "surveying",
  "deepDiving",
  "completed",
  "failed",
  "budgetPaused",
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** 宛先が同じか。 */
export function sameAuditTarget(a: AuditTarget, b: AuditTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "sacty") return true;
  if (a.kind === "repository") return a.repo === (b as typeof a).repo;
  const other = b as typeof a;
  return a.repo === other.repo && a.depth === other.depth;
}

/** 提案を採用する。宛先は提案の宛先の候補から選ぶ。 */
export const AdoptAuditProposalInput = z.object({ target: AuditTarget }).strict();
export type AdoptAuditProposalInput = z.infer<typeof AdoptAuditProposalInput>;

/** 却下の理由の上限（文字数）。 */
export const AUDIT_REJECT_REASON_MAX = 2000;

/** 提案を却下する。理由は必ず書く（以後の監査に渡す）。 */
export const RejectAuditProposalInput = z
  .object({
    reason: z.string().trim().min(1, code("input.required")).max(AUDIT_REJECT_REASON_MAX),
  })
  .strict();
export type RejectAuditProposalInput = z.infer<typeof RejectAuditProposalInput>;

/**
 * 予算で一時停止した監査を、新しい上限（累計）で再開する（タスクの予算と同じ扱い）。上限の金額に上限を設けない：
 * 既定の予算（config.yaml の budget.default_per_audit_usd）は正の数なら何でもよく、再開には使った額より大きい
 * 金額が要るので、ここで上限を設けると、大きい既定の予算で止まった監査を再開できなくなる（PR #134 レビュー指摘）。
 */
export const ResumeAuditInput = z.object({ capUsd: z.number().positive().optional() }).strict();
export type ResumeAuditInput = z.infer<typeof ResumeAuditInput>;

/** 根拠になった出来事。eventId は作業履歴の行、runId はエージェントの実行（セッションログ）。 */
export type AuditEvidence = {
  kind: AuditEvidenceKind;
  at: string;
  text: string;
  step?: StepKey;
  eventId?: string;
  runId?: string;
};

/** 懸念のある工程の深掘り。大まかな監査が挙げた工程ごとに、別のセッションで監査する。 */
export type AuditDeepDive = {
  step: StepKey;
  status: "waiting" | "running" | "completed" | "failed";
  /** 大まかな監査が、この工程を挙げた理由。 */
  reason: string;
  /** 深掘りの結果（Markdown）。 */
  summary?: string;
};

/** 提案への人の判断。採用したら改修のタスクを作る（mock なら作ったことにする）。 */
export type AuditProposalDecision =
  | {
      kind: "adopted";
      at: string;
      target: AuditTarget;
      /** 作った改修のタスク。sacty の既定のコンテキストが宛先なら作らないので無い（PBI-125）。 */
      task?: { taskId: string; title: string; mock?: true };
    }
  | { kind: "rejected"; at: string; reason: string };

/** 改修の提案。 */
export type AuditProposal = {
  id: string;
  causeId: string;
  /** 提案を出した監査のタスク。 */
  taskId: string;
  title: string;
  /** 提案の中身（Markdown）。 */
  body: string;
  /** 監査が選んだ宛先。 */
  target: AuditTarget;
  /** 採用するときに選べる宛先（監査が選んだ宛先を含む）。 */
  targetCandidates: AuditTarget[];
  decision?: AuditProposalDecision;
};

/** 1つのタスクの監査で見つけた原因と、その提案。 */
export type AuditFinding = {
  causeId: string;
  title: string;
  /** 原因の説明（Markdown）。 */
  detail: string;
  step?: StepKey;
  evidence: AuditEvidence[];
  proposals: AuditProposal[];
  /** 改修をマージした後に、また見つかった。 */
  recurred?: true;
};

/** 監査が登録したメモリー（PBI-126）。repo は scope が repository のとき。消したら deleted。 */
export type AuditMemory = {
  id: string;
  scope: "project" | "repository";
  repo?: string;
  title: string;
  summary: string;
  /** 中身（Markdown）。 */
  body: string;
  step: StepKey;
  at: string;
  /** 有効な最終利用日（ISO の時刻。役に立ったと判断されたタスクの完了日。無ければ登録した時刻。PBI-127）。 */
  lastUsefulAt: string;
  deleted?: { at: string; reason: MemoryDeleteReason };
};

/** 監査が、タスクで役に立ったと判断したメモリー（PBI-127）。 */
export type AuditUsefulMemory = {
  id: string;
  scope: "project" | "repository";
  title: string;
};

/** 1つのタスクの監査。 */
export type TaskAudit = {
  taskId: string;
  projectId: string;
  status: AuditStatus;
  startedAt?: string;
  finishedAt?: string;
  budget: { usedUsd: number; capUsd: number };
  /** 失敗の理由（status が failed のとき）。 */
  failure?: DaemonText;
  /** 大まかな監査の結果。 */
  survey?: { summary: string; counts: Record<AuditEvidenceKind, number> };
  deepDives: AuditDeepDive[];
  findings: AuditFinding[];
  /** この監査で登録したメモリー（PBI-126）。 */
  memories: AuditMemory[];
  /** タスクで役に立ったと監査が判断したメモリー（PBI-127）。 */
  usefulMemories: AuditUsefulMemory[];
  /** モックのデータ。 */
  mock?: true;
};

/** 原因の状態。提案あり・採用（改修のタスクを作った）・改修済み（マージした）・再発・却下。 */
export const AUDIT_CAUSE_STATUSES = [
  "proposed",
  "adopted",
  "fixed",
  "recurred",
  "rejected",
] as const;
export type AuditCauseStatus = (typeof AUDIT_CAUSE_STATUSES)[number];

/** プロジェクトの中で、タスクをまたいでまとめた原因。 */
export type AuditCause = {
  id: string;
  projectId: string;
  title: string;
  status: AuditCauseStatus;
  /** この原因が見つかったタスク（新しい順）。 */
  occurrences: { taskId: string; taskTitle: string; at: string }[];
  /** 改修をマージした時刻。 */
  fixedAt?: string;
  /** 改修のマージの後に、また見つかった時刻。 */
  recurredAt?: string;
};

/** 提案の一覧の1行（どのタスクの監査で出たか）。 */
export type ListedAuditProposal = AuditProposal & { taskTitle: string };

/** 監査の一覧の1行。 */
export type AuditRow = {
  taskId: string;
  taskTitle: string;
  status: AuditStatus;
  finishedAt?: string;
  usedUsd: number;
  counts?: Record<AuditEvidenceKind, number>;
};

/** プロジェクトの監査（監査の画面）。プロジェクトをまたいで集約しない。 */
export type ProjectAudits = {
  projectId: string;
  /** モックのデータ。 */
  mock: boolean;
  /** 1回の監査の、予算の既定の上限（config.yaml の budget.default_per_audit_usd）。 */
  defaultCapUsd: number;
  audits: AuditRow[];
  causes: AuditCause[];
  /** 提案。判断待ちを先に、新しい順。 */
  proposals: ListedAuditProposal[];
};

/** ダッシュボードの監査の指標。件数だけで、原因や提案の中身はプロジェクトをまたいで出さない。 */
export type AuditDashboard = {
  mock: boolean;
  projects: {
    projectId: string;
    causes: number;
    recurred: number;
    pending: number;
    adopted: number;
    rejected: number;
  }[];
  /** 週ごとの、監査したタスクの数と、人の差し戻し・PR の指摘の件数（古い順）。 */
  trend: { weekStart: string; tasks: number; remarks: number }[];
};

/** 提案の採用率（採用 ÷ 判断した数）。判断した提案が無ければ null。 */
export function auditAdoptionRate(adopted: number, rejected: number): number | null {
  const decided = adopted + rejected;
  return decided === 0 ? null : adopted / decided;
}

/** 判断待ちの提案か。 */
export function isPendingAuditProposal(proposal: AuditProposal): boolean {
  return proposal.decision === undefined;
}

/** 根拠の件数のうち、人の差し戻しと PR の指摘の件数。 */
export function auditRemarkCount(counts: Record<AuditEvidenceKind, number>): number {
  return counts.changesRequested + counts.pullRequestRemark;
}
