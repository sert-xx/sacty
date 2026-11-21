import {
  type AuditCause,
  isPendingAuditProposal,
  type ListedAuditProposal,
  type ProjectAudits,
} from "@sacty/core";

/*
 * 監査の画面の、原因ごとに束ねた出し方（PBI-443）。絞り込み・区切りは画面のサーバーの側で行い、出す原因とその提案だけを
 * クライアントに渡す（提案の全件をブラウザに送らない）。絞り込みと出す件数は URL に残す（?causes=…&shown=…）。
 */

/** 原因を開いたときに出す件数と、「さらに表示」で足す件数。 */
export const AUDIT_CAUSES_PAGE = 20;
/** 出す件数の上限（URL に大きな値を書かれても、1 回に描く量を抑える）。 */
export const AUDIT_CAUSES_SHOWN_MAX = 10_000;
/** 開いた原因で、最初に出す該当するタスクの数。残りは「ほか N 件」で開く。 */
export const AUDIT_CAUSE_TASKS_SHOWN = 5;
/** 開いた原因で、最初に出す提案の数と、「ほか N 件」で足す数。 */
export const AUDIT_CAUSE_PROPOSALS_PAGE = 10;

export const AUDIT_CAUSE_FILTERS = ["all", "pending", "recurred"] as const;
export type AuditCauseFilter = (typeof AUDIT_CAUSE_FILTERS)[number];

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v);

/** URL の絞り込み。無い値・知らない値は「すべて」。 */
export function parseCauseFilter(value: Param): AuditCauseFilter {
  const v = first(value);
  return v === "pending" || v === "recurred" ? v : "all";
}

/** URL の、出す原因の件数。正の整数でなければ 20 件。20 件ずつ（切り上げ）に整える。 */
export function parseShown(value: Param): number {
  const v = first(value);
  if (v === undefined || !/^\d{1,9}$/.test(v)) return AUDIT_CAUSES_PAGE;
  const n = Number(v);
  if (n < AUDIT_CAUSES_PAGE) return AUDIT_CAUSES_PAGE;
  return Math.min(AUDIT_CAUSES_SHOWN_MAX, Math.ceil(n / AUDIT_CAUSES_PAGE) * AUDIT_CAUSES_PAGE);
}

/** 画面の URL（絞り込みと件数の指定。既定の値は書かない）。 */
export function auditScreenHref(base: string, filter: AuditCauseFilter, shown: number): string {
  const query = new URLSearchParams();
  if (filter !== "all") query.set("causes", filter);
  if (shown !== AUDIT_CAUSES_PAGE) query.set("shown", String(shown));
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

/** 絞り込みと区切りの結果。 */
export type AuditView = {
  filter: AuditCauseFilter;
  /** 出すと指定された原因の件数（20 の倍数）。 */
  shown: number;
  /** 絞り込みに合う原因の総数。 */
  total: number;
  /** 絞り込む前の、プロジェクトの原因の総数。 */
  projectCauses: number;
  /** プロジェクトの判断待ちの提案の総数（まとめて却下の帯を出すかを決める）。 */
  projectPending: number;
};

/**
 * 監査のデータを、絞り込み・区切りをして、出す原因とその提案だけにする。原因の並びは変えない（デーモンの並び）。
 * 「判断待ちあり」は、判断待ちの提案が 1 件以上ある原因（再発・改修済みの原因にも残りうるので、状態の「提案あり」とは違う）。
 */
export function sliceAudits(
  data: ProjectAudits,
  filter: AuditCauseFilter,
  shown: number,
): { data: ProjectAudits; view: AuditView } {
  const pendingByCause = new Map<string, number>();
  let projectPending = 0;
  for (const p of data.proposals) {
    if (!isPendingAuditProposal(p)) continue;
    projectPending += 1;
    pendingByCause.set(p.causeId, (pendingByCause.get(p.causeId) ?? 0) + 1);
  }
  const matches = (c: AuditCause) =>
    filter === "pending"
      ? (pendingByCause.get(c.id) ?? 0) > 0
      : filter === "recurred"
        ? c.status === "recurred"
        : true;
  const matched = data.causes.filter(matches);
  const causes = matched.slice(0, shown);
  const ids = new Set(causes.map((c) => c.id));
  const proposals: ListedAuditProposal[] = data.proposals.filter((p) => ids.has(p.causeId));
  return {
    data: { ...data, causes, proposals },
    view: {
      filter,
      shown,
      total: matched.length,
      projectCauses: data.causes.length,
      projectPending,
    },
  };
}
