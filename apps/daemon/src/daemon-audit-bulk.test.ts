import { join } from "node:path";
import type { ActivityEvent, EventInput } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { ConfigResult } from "./config.js";
import { LedgerAuditService } from "./ledger-audits.js";
import { MemoryProjectStore } from "./projects.js";
import type { TaskService } from "./service.js";
import {
  agent,
  configOf,
  dbPath,
  dir,
  FakeGitHub,
  makeService,
  useTempDir,
} from "./testing/daemon.js";

/*
 * 提案のまとめての却下（PBI-443）。完了して監査を終えたタスクの記録を作業履歴に直接書いておき、本物の TaskService で
 * まとめて却下する。記録の形（提案ごとに 1 件・同じ bulk）、秘密情報の伏せ方、一部の失敗、2,000 件の一括却下が終わること、
 * 以後の監査に渡す量を確かめる。
 */

useTempDir();

type Seed = {
  id: string;
  title?: string;
  /** 対象リポジトリの URL。 */
  repo?: string;
  /** 原因ごとの提案の題。causeKey が memory: で始まる原因はメモリーをコンテキストにする提案。 */
  causes: { key: string; proposals: string[] }[];
};

const run = { agentId: "a", auditCostUsd: 0.25, estimated: false };
const counts = {
  changesRequested: 0,
  pullRequestRemark: 0,
  pause: 0,
  retry: 0,
  toolFailure: 0,
  escalation: 0,
};

/** 完了して監査を終えた（提案が判断待ちの）タスクを、作業履歴に書く。 */
function seed(activity: SqliteActivityStore, seeds: Seed[]) {
  const person = (event: EventInput) => ({ actor: "sacty" as const, event });
  for (const s of seeds) {
    const findings = s.causes.map((c) => ({
      causeKey: c.key,
      title: `原因 ${c.key}`,
      detail: "",
      evidence: [],
      proposals: c.proposals.map((title, i) => ({
        id: `${s.id}:${c.key}:${i}`,
        title,
        body: "",
        target: { kind: "sacty" as const },
        candidates: [{ kind: "sacty" as const }],
      })),
    }));
    activity.append({
      taskId: s.id,
      projectId: "default",
      events: [
        person({
          type: "TaskCreated",
          payload: {
            title: s.title ?? `タスク ${s.id}`,
            body: "",
            start: "sacty",
            ...(s.repo ? { repo: s.repo } : {}),
          },
        } as EventInput),
        person({ type: "StepsChosen", payload: { steps: ["document"] } } as EventInput),
        person({
          type: "AgentRunStarted",
          payload: { runId: `r-${s.id}`, step: "document", agentId: "a", authMode: "stub" },
        } as EventInput),
        person({
          type: "AgentRunCompleted",
          payload: {
            runId: `r-${s.id}`,
            step: "document",
            agentId: "a",
            authMode: "stub",
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
            costUsd: 0.5,
            estimated: false,
            output: "x",
          },
        } as EventInput),
        person({
          type: "StepCompleted",
          payload: { step: "document", next: "idle" },
        } as EventInput),
        person({ type: "AuditQueued", payload: { auditId: `a-${s.id}`, capUsd: 1 } }),
        person({
          type: "AuditSurveyed",
          payload: {
            auditId: `a-${s.id}`,
            summary: "要約",
            counts,
            concerns: [{ step: "document", reason: "理由" }],
            ...run,
          },
        } as EventInput),
        person({
          type: "AuditDeepDived",
          payload: {
            auditId: `a-${s.id}`,
            step: "document",
            summary: "",
            findings,
            ...run,
          },
        } as EventInput),
        person({ type: "AuditCompleted", payload: { auditId: `a-${s.id}` } }),
      ],
    });
  }
}

const rejectedEvents = (activity: SqliteActivityStore, taskId: string): ActivityEvent[] =>
  activity.forTask(taskId).filter((e) => e.type === "AuditProposalRejected");

const open = (seeds: Seed[], options: Parameters<typeof makeService>[2] = {}) => {
  const activity = new SqliteActivityStore(dbPath);
  seed(activity, seeds);
  const made = makeService(activity, [], { audit: true, ...options });
  return { ...made, activity };
};

const idsOf = (service: TaskService, taskId: string) =>
  (service.get(taskId)?.task.audit?.findings ?? []).flatMap((f) => f.proposals.map((p) => p.id));

describe("提案のまとめての却下の記録（PBI-443）", () => {
  it("元のタスクが別の 3 件を理由「不要」で却下すると、元のタスクごとに人の操作の記録が提案 1 件に 1 件ずつ、同じ bulk（count: 3）で書かれる。1 件だけなら count: 1", async () => {
    const { service, activity } = open([
      { id: "t1", causes: [{ key: "c1", proposals: ["A", "B"] }] },
      { id: "t2", causes: [{ key: "c1", proposals: ["C"] }] },
      { id: "t3", causes: [{ key: "c2", proposals: ["D"] }] },
    ]);
    const result = await service.rejectAuditProposals({
      projectId: "default",
      proposalIds: ["t1:c1:0", "t1:c1:1", "t2:c1:0"],
      reason: "不要",
    });
    expect(result.failed).toEqual([]);
    expect(result.rejectedIds.sort()).toEqual(["t1:c1:0", "t1:c1:1", "t2:c1:0"]);
    const events = [...rejectedEvents(activity, "t1"), ...rejectedEvents(activity, "t2")];
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ proposalId: "t1:c1:0", reason: "不要" }),
      expect.objectContaining({ proposalId: "t1:c1:1", reason: "不要" }),
      expect.objectContaining({ proposalId: "t2:c1:0", reason: "不要" }),
    ]);
    expect(events.every((e) => e.actor === "person")).toBe(true);
    const bulks = events.map((e) => (e.payload as { bulk: { id: string; count: number } }).bulk);
    expect(new Set(bulks.map((b) => b.id)).size).toBe(1);
    expect(bulks.every((b) => b.count === 3)).toBe(true);
    // 選ばなかった提案には記録が無い
    expect(rejectedEvents(activity, "t3")).toEqual([]);
    // 状態にも、提案ごとの却下（印つき）として載る
    expect(service.get("t2")?.task.audit?.findings[0]?.proposals[0]?.decision).toMatchObject({
      kind: "rejected",
      reason: "不要",
      bulk: { count: 3 },
    });

    // 1 件だけ選んだときも印を付ける（count: 1）
    const single = await service.rejectAuditProposals({
      projectId: "default",
      proposalIds: ["t3:c2:0"],
      reason: "不要",
    });
    expect(single.rejectedIds).toEqual(["t3:c2:0"]);
    expect(rejectedEvents(activity, "t3")[0]?.payload).toMatchObject({ bulk: { count: 1 } });
  });

  it("1 件ずつの却下は、これまでと同じ形（bulk の無い記録）で書かれる", async () => {
    const { service, activity } = open([{ id: "t1", causes: [{ key: "c1", proposals: ["A"] }] }]);
    await service.rejectAuditProposal("t1:c1:0", { reason: "理由" });
    const [event] = rejectedEvents(activity, "t1");
    expect(event?.payload).toEqual({ proposalId: "t1:c1:0", reason: "理由" });
  });

  it("理由は記録の前に、設定の秘密情報の値と各リポジトリの GitHub のトークンを伏せる（リポジトリの異なる元のタスク 2 件）", async () => {
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "repo", target: "https://ghe.example.com/acme/lib" },
      ],
      githubAccounts: { "github.com": "me", "ghe.example.com": "corp" },
    });
    const base = configOf(agent());
    const config = (): ConfigResult => base();
    const { service, activity } = open(
      [
        {
          id: "t1",
          repo: "https://github.com/acme/app",
          causes: [{ key: "c1", proposals: ["A"] }],
        },
        {
          id: "t2",
          repo: "https://ghe.example.com/acme/lib",
          causes: [{ key: "c1", proposals: ["B"] }],
        },
      ],
      {
        projects,
        config,
        github: new FakeGitHub({ me: "ghp_secret", "ghe.example.com/corp": "ghe-token-9f2k" }),
        secrets: { "claude-oauth-token": "oauth-secret", "github-token": "ghp_secret" },
      },
    );
    const reason = "oauth-secret と ghp_secret と ghe-token-9f2k を書いてしまった";
    const result = await service.rejectAuditProposals({
      projectId: "default",
      proposalIds: ["t1:c1:0", "t2:c1:0"],
      reason,
    });
    expect(result.failed).toEqual([]);
    const reasons = [...rejectedEvents(activity, "t1"), ...rejectedEvents(activity, "t2")].map(
      (e) => (e.payload as { reason: string }).reason,
    );
    expect(reasons).toHaveLength(2);
    for (const r of reasons) {
      expect(r).not.toContain("oauth-secret");
      expect(r).not.toContain("ghp_secret");
      expect(r).not.toContain("ghe-token-9f2k");
      // 1 件ずつの却下と同じ形で伏せる
      expect(r).toBe("[REDACTED] と [REDACTED] と [REDACTED] を書いてしまった");
    }
  });

  it("一部が却下できなかったとき：判断済み・中止済みの提案は failed に理由つきで入り、却下できた分だけが count になる。先に却下した提案の記録は 1 件のまま", async () => {
    const { service, activity } = open([
      { id: "t1", causes: [{ key: "c1", proposals: ["A", "B"] }] },
      { id: "t2", causes: [{ key: "c1", proposals: ["C"] }] },
    ]);
    await service.rejectAuditProposal("t1:c1:0", { reason: "先に却下" });
    await service.cancel("t2");
    const result = await service.rejectAuditProposals({
      projectId: "default",
      proposalIds: ["t1:c1:0", "t1:c1:1", "t2:c1:0"],
      reason: "まとめて",
    });
    expect(result.rejectedIds).toEqual(["t1:c1:1"]);
    expect(result.failed).toEqual([
      { proposalId: "t1:c1:0", messages: [{ code: "audit.alreadyDecided" }] },
      { proposalId: "t2:c1:0", messages: [{ code: "audit.notAdoptable" }] },
    ]);
    const t1 = rejectedEvents(activity, "t1");
    expect(t1.map((e) => (e.payload as { proposalId: string }).proposalId)).toEqual([
      "t1:c1:0",
      "t1:c1:1",
    ]);
    // 先に却下した提案の記録は元のまま（bulk なし・理由もそのまま）
    expect(t1[0]?.payload).toEqual({ proposalId: "t1:c1:0", reason: "先に却下" });
    expect(t1[1]?.payload).toMatchObject({ bulk: { count: 1 } });
    expect(rejectedEvents(activity, "t2")).toEqual([]);
  });

  it("2 つ目の元のタスクの書き込みが失敗しても（例外の種類を問わず）、書けた分は rejected で返し、失敗した分は failed に入れて投げない", async () => {
    const { service, activity } = open([
      { id: "t1", causes: [{ key: "c1", proposals: ["A"] }] },
      { id: "t2", causes: [{ key: "c1", proposals: ["B", "C"] }] },
    ]);
    const append = (service as unknown as { append: (...args: unknown[]) => unknown }).append;
    let calls = 0;
    vi.spyOn(service as unknown as { append: typeof append }, "append").mockImplementation(
      function (this: unknown, ...args: unknown[]) {
        calls += 1;
        if (calls === 2) throw new Error("disk full");
        return append.apply(this, args);
      },
    );
    const result = await service.rejectAuditProposals({
      projectId: "default",
      proposalIds: ["t1:c1:0", "t2:c1:0", "t2:c1:1"],
      reason: "不要",
    });
    expect(result.rejectedIds).toEqual(["t1:c1:0"]);
    expect(result.failed).toEqual([
      { proposalId: "t2:c1:0", messages: [{ code: "audit.bulkWriteFailed" }] },
      { proposalId: "t2:c1:1", messages: [{ code: "audit.bulkWriteFailed" }] },
    ]);
    expect(rejectedEvents(activity, "t1")).toHaveLength(1);
    expect(rejectedEvents(activity, "t2")).toEqual([]);
  });

  it("別のプロジェクトの提案・無い提案は proposalNotFound で failed に入れ、記録を書かない。全件が通らなければ何も書かない", async () => {
    const { service, activity } = open([{ id: "t1", causes: [{ key: "c1", proposals: ["A"] }] }]);
    const before = activity.all().length;
    const result = await service.rejectAuditProposals({
      projectId: "other",
      proposalIds: ["t1:c1:0", "missing"],
      reason: "理由",
    });
    expect(result.rejectedIds).toEqual([]);
    expect(result.failed).toEqual([
      { proposalId: "t1:c1:0", messages: [{ code: "audit.proposalNotFound" }] },
      { proposalId: "missing", messages: [{ code: "audit.proposalNotFound" }] },
    ]);
    expect(activity.all().length).toBe(before);
  });

  it("入力の誤り（空・重複・2,001 件・理由が空）は、どの提案にも記録を書かずに拒む", async () => {
    const { service, activity } = open([{ id: "t1", causes: [{ key: "c1", proposals: ["A"] }] }]);
    const before = activity.all().length;
    const base = { projectId: "default", reason: "理由" };
    for (const input of [
      { ...base, proposalIds: [] },
      { ...base, proposalIds: ["t1:c1:0", "t1:c1:0"] },
      { ...base, proposalIds: Array.from({ length: 2001 }, (_, i) => `x${i}`) },
      { projectId: "default", reason: " ", proposalIds: ["t1:c1:0"] },
    ]) {
      await expect(service.rejectAuditProposals(input)).rejects.toThrow();
    }
    expect(activity.all().length).toBe(before);
  });

  it("画面・ダッシュボードの状態は、同じ提案を 1 件ずつ却下したときと同じになる（却下の印と、読み込んだ記録の再生を除く）", async () => {
    const seeds: Seed[] = [
      {
        id: "t1",
        causes: [
          { key: "c1", proposals: ["A", "B"] },
          { key: "c2", proposals: ["C"] },
        ],
      },
      { id: "t2", causes: [{ key: "c1", proposals: ["D"] }] },
    ];
    const ids = ["t1:c1:0", "t1:c2:0", "t2:c1:0"];
    const bulk = open(seeds);
    await bulk.service.rejectAuditProposals({
      projectId: "default",
      proposalIds: ids,
      reason: "不要",
    });
    const bulkAudits = new LedgerAuditService(bulk.service);
    const bulkView = await bulkAudits.projectAudits("default");
    const bulkDash = bulkAudits.dashboard();
    bulk.activity.close();

    const single = (() => {
      const activity = new SqliteActivityStore(join(dir, "single.db"));
      seed(activity, seeds);
      return { activity, ...makeService(activity, [], { audit: true }) };
    })();
    for (const id of ids) await single.service.rejectAuditProposal(id, { reason: "不要" });
    const singleAudits = new LedgerAuditService(single.service);
    const singleView = await singleAudits.projectAudits("default");

    const strip = (v: typeof bulkView) =>
      v?.proposals.map(({ decision, ...p }) => ({
        id: p.id,
        kind: decision?.kind,
        reason: decision?.kind === "rejected" ? decision.reason : undefined,
      }));
    expect(strip(bulkView)).toEqual(strip(singleView));
    expect(bulkView?.causes.map((c) => [c.id, c.status])).toEqual(
      singleView?.causes.map((c) => [c.id, c.status]),
    );
    expect(bulkDash.projects).toEqual(singleAudits.dashboard().projects);
    expect(bulkDash.projects[0]).toMatchObject({ pending: 1, rejected: 3, adopted: 0 });
    // 画面の提案には、まとめての印と件数が付く
    expect(bulkView?.proposals.find((p) => p.id === "t1:c1:0")?.decision).toMatchObject({
      kind: "rejected",
      bulk: { count: 3 },
    });
    expect(singleView?.proposals.find((p) => p.id === "t1:c1:0")?.decision).not.toHaveProperty(
      "bulk",
    );
  });
});

describe("まとめて却下 2,000 件が終わり、組み直しが 1 回で済む（PBI-443）", () => {
  it("元のタスク 50 件にまたがる 2,000 件を 1 回で却下し、全件を返す。秘密情報の値の取り出しはプロジェクトで 1 回、画面の形の組み直しは 1 回", async () => {
    const seeds: Seed[] = Array.from({ length: 50 }, (_, t) => ({
      id: `t${t}`,
      causes: Array.from({ length: 8 }, (_, c) => ({
        key: `c${c}`,
        proposals: Array.from({ length: 5 }, (_, p) => `提案 ${t}-${c}-${p}`),
      })),
    }));
    const github = new FakeGitHub({ me: "ghp_secret" });
    const { service } = open(seeds, {
      projects: (() => {
        const projects = new MemoryProjectStore();
        projects.put("default", {
          name: "デフォルト",
          targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
          githubAccounts: { "github.com": "me" },
        });
        return projects;
      })(),
      github,
      secrets: { "claude-oauth-token": "oauth-secret", "github-token": "ghp_secret" },
    });
    const all = seeds.flatMap((s) => idsOf(service, s.id));
    expect(all).toHaveLength(2000);
    const audits = new LedgerAuditService(service);
    // 返す提案を作るための組み直しの回数（1 回だけ画面の形を作る）
    let rebuilds = 0;
    const internals = audits as unknown as {
      projectAuditsWith(projectId: string, hide: (text: string) => string): unknown;
    };
    const original = internals.projectAuditsWith.bind(audits);
    internals.projectAuditsWith = (projectId, hide) => {
      rebuilds += 1;
      return original(projectId, hide);
    };
    github.requested.length = 0;
    const started = performance.now();
    const result = await audits.rejectMany({
      projectId: "default",
      proposalIds: all,
      reason: "まとめて片付ける",
    });
    const elapsed = performance.now() - started;
    expect(result.failed).toEqual([]);
    expect(result.rejected).toHaveLength(2000);
    expect(result.rejected.every((p) => p.decision?.kind === "rejected")).toBe(true);
    // gh のトークンの取り出しはプロジェクトの GitHub のアカウント 1 つにつき 1 回
    expect(github.requested).toEqual(["me"]);
    expect(rebuilds).toBe(1);
    // 本体を 2 乗にしても時間切れ（60 秒）に届かないので、遅い機械にも十分な余裕の上限（30 秒。通常は 1.5 秒未満）で時間の検査を残す
    expect(elapsed).toBeLessThan(30_000);
    console.info(`bulk reject 2000 proposals / 50 tasks: ${Math.round(elapsed)} ms`);
  }, 60_000);
});

describe("以後の監査に渡す、まとめて却下した提案の量（PBI-443）", () => {
  it("1 件ずつの却下 2 件と、メモリーの提案 20 件を含む 300 件のまとめての却下 1 回で、「却下された提案と理由」は 3 行。メモリーの提案は含まない", async () => {
    // 1 回の深掘りの記録は、原因 10 件・原因ごとの提案 5 件までなので、280 件は 6 つのタスクに分ける
    const ordinary = Array.from({ length: 280 }, (_, i) => `通常 ${String(i).padStart(3, "0")}`);
    const seeds: Seed[] = [
      { id: "s", causes: [{ key: "single", proposals: ["個別 1", "個別 2"] }] },
    ];
    for (let t = 0; t < 6; t++) {
      const chunk = ordinary.slice(t * 50, (t + 1) * 50);
      seeds.push({
        id: `b${t}`,
        causes: Array.from({ length: Math.ceil(chunk.length / 5) }, (_, c) => ({
          key: `bulk-${t}-${c}`,
          proposals: chunk.slice(c * 5, c * 5 + 5),
        })),
      });
    }
    for (let t = 0; t < 2; t++) {
      seeds.push({
        id: `m${t}`,
        causes: Array.from({ length: 10 }, (_, c) => ({
          key: `memory:m${t}-${c}`,
          proposals: [`メモリー ${t}-${c}`],
        })),
      });
    }
    const { service } = open(seeds);
    await service.rejectAuditProposal("s:single:0", { reason: "個別の理由 1" });
    await service.rejectAuditProposal("s:single:1", { reason: "個別の理由 2" });
    const selected = seeds.filter((s) => s.id !== "s").flatMap((s) => idsOf(service, s.id));
    expect(selected).toHaveLength(300);
    const result = await service.rejectAuditProposals({
      projectId: "default",
      proposalIds: selected,
      reason: "まとめての理由",
    });
    expect(result.rejectedIds).toHaveLength(300);
    const known = (
      service as unknown as {
        knownAuditCauses(projectId: string): { rejected: { title: string; reason: string }[] };
      }
    ).knownAuditCauses("default");
    expect(known.rejected).toHaveLength(3);
    expect(known.rejected.slice(0, 2)).toEqual([
      { title: "個別 1", reason: "個別の理由 1" },
      { title: "個別 2", reason: "個別の理由 2" },
    ]);
    // 300 件のうち、メモリーの提案 20 件を除いた 280 件を 1 行に束ねる。題は先頭の 3 件と「ほか 277 件」だけ
    expect(known.rejected[2]).toEqual({
      title: "まとめて却下（280 件。例：通常 000／通常 001／通常 002 ほか 277 件）",
      reason: "まとめての理由",
    });
    expect(JSON.stringify(known.rejected)).not.toContain("メモリー");
  });
});
