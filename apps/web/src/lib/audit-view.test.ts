import type { AuditCause, ListedAuditProposal, ProjectAudits } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { auditScreenHref, parseCauseFilter, parseShown, sliceAudits } from "./audit-view";

/*
 * 監査の画面の絞り込みと区切り（PBI-443）。URL の指定の読み方と、出す原因とその提案だけにする処理。
 */

const cause = (id: string, status: AuditCause["status"] = "proposed"): AuditCause => ({
  id,
  projectId: "p1",
  title: `原因 ${id}`,
  status,
  occurrences: [{ taskId: `t-${id}`, taskTitle: `タスク ${id}`, at: "2026-10-01T00:00:00Z" }],
});

const proposal = (cause: string, n: number, decided = false): ListedAuditProposal => ({
  id: `${cause}:${n}`,
  causeId: cause,
  taskId: `t-${cause}`,
  title: `提案 ${cause}-${n}`,
  body: "",
  target: { kind: "sacty" },
  targetCandidates: [{ kind: "sacty" }],
  taskTitle: `タスク ${cause}`,
  ...(decided
    ? { decision: { kind: "rejected" as const, at: "2026-10-02T00:00:00Z", reason: "r" } }
    : {}),
});

const data = (causes: AuditCause[], proposals: ListedAuditProposal[]): ProjectAudits => ({
  projectId: "p1",
  mock: false,
  defaultCapUsd: 1,
  audits: [],
  causes,
  proposals,
});

describe("URL の絞り込みと件数の読み方（PBI-443）", () => {
  it("causes は pending・recurred だけを認め、無い値・知らない値・複数の指定は「すべて」か先頭の値で読む", () => {
    expect(parseCauseFilter("pending")).toBe("pending");
    expect(parseCauseFilter("recurred")).toBe("recurred");
    expect(parseCauseFilter(undefined)).toBe("all");
    expect(parseCauseFilter("xyz")).toBe("all");
    expect(parseCauseFilter("")).toBe("all");
    expect(parseCauseFilter(["recurred", "pending"])).toBe("recurred");
  });

  it("shown は 20 件ずつに整え、正の整数でない値・小さい値は 20 件、大きすぎる値は上限に抑える", () => {
    expect(parseShown(undefined)).toBe(20);
    expect(parseShown("40")).toBe(40);
    expect(parseShown("45")).toBe(60);
    expect(parseShown("0")).toBe(20);
    expect(parseShown("-5")).toBe(20);
    expect(parseShown("abc")).toBe(20);
    expect(parseShown("1.5")).toBe(20);
    expect(parseShown("99999999999")).toBe(20);
    expect(parseShown("9999999")).toBe(10_000);
  });

  it("画面の URL には既定の値を書かない。絞り込みを変えるときは件数の指定を外す", () => {
    const base = "/projects/p1/audit";
    expect(auditScreenHref(base, "all", 20)).toBe(base);
    expect(auditScreenHref(base, "pending", 20)).toBe(`${base}?causes=pending`);
    expect(auditScreenHref(base, "all", 40)).toBe(`${base}?shown=40`);
    expect(auditScreenHref(base, "recurred", 60)).toBe(`${base}?causes=recurred&shown=60`);
  });
});

describe("絞り込みと区切り（PBI-443）", () => {
  const causes = Array.from({ length: 45 }, (_, i) => cause(`c${String(i).padStart(2, "0")}`));

  it("原因 45 件は、並びのまま先頭 20 件・40 件・45 件になり、総数が分かる。出す原因の提案だけを渡す", () => {
    const proposals = causes.flatMap((c) => [proposal(c.id, 0), proposal(c.id, 1)]);
    const all = data(causes, proposals);
    const first = sliceAudits(all, "all", 20);
    expect(first.data.causes.map((c) => c.id)).toEqual(causes.slice(0, 20).map((c) => c.id));
    expect(first.view).toMatchObject({
      total: 45,
      projectCauses: 45,
      projectPending: 90,
      shown: 20,
    });
    expect(first.data.proposals).toHaveLength(40);
    expect(new Set(first.data.proposals.map((p) => p.causeId))).toEqual(
      new Set(first.data.causes.map((c) => c.id)),
    );
    expect(sliceAudits(all, "all", 40).data.causes).toHaveLength(40);
    expect(sliceAudits(all, "all", 60).data.causes).toHaveLength(45);
  });

  it("0 件・1 件・ちょうど 20 件・21 件の原因の数", () => {
    for (const [n, shown] of [
      [0, 0],
      [1, 1],
      [20, 20],
      [21, 20],
    ] as const) {
      const list = causes.slice(0, n);
      const sliced = sliceAudits(data(list, []), "all", 20);
      expect(sliced.data.causes).toHaveLength(shown);
      expect(sliced.view.total).toBe(n);
    }
  });

  it("「判断待ちあり」は、判断待ちの提案が 1 件以上ある原因（再発・改修済みの原因も含む）。「再発だけ」は再発の原因", () => {
    const list = [
      cause("recurred-pending", "recurred"),
      cause("recurred-done", "recurred"),
      cause("fixed-pending", "fixed"),
      cause("adopted", "adopted"),
      cause("proposed-pending", "proposed"),
    ];
    const proposals = [
      proposal("recurred-pending", 0),
      proposal("recurred-done", 0, true),
      proposal("fixed-pending", 0),
      proposal("adopted", 0, true),
      proposal("proposed-pending", 0),
    ];
    const all = data(list, proposals);
    expect(sliceAudits(all, "pending", 20).data.causes.map((c) => c.id)).toEqual([
      "recurred-pending",
      "fixed-pending",
      "proposed-pending",
    ]);
    expect(sliceAudits(all, "recurred", 20).data.causes.map((c) => c.id)).toEqual([
      "recurred-pending",
      "recurred-done",
    ]);
    expect(sliceAudits(all, "all", 20).data.causes).toHaveLength(5);
    // 合う原因が無ければ 0 件（プロジェクトの原因の数は残る）
    const none = sliceAudits(data([cause("a")], [proposal("a", 0)]), "recurred", 20);
    expect(none.view).toMatchObject({ total: 0, projectCauses: 1 });
    expect(none.data.causes).toEqual([]);
  });

  it("提案が 1 件も無い原因も出す（判断待ちが無いので「判断待ちあり」には入らない）", () => {
    const all = data([cause("a", "rejected")], []);
    expect(sliceAudits(all, "all", 20).data.causes).toHaveLength(1);
    expect(sliceAudits(all, "pending", 20).data.causes).toHaveLength(0);
  });
});
