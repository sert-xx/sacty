import { AUDIT_STATUSES, type ProjectAudits } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { messagesFor } from "@/i18n";
import {
  auditStatusTone,
  auditTargetText,
  auditTargetValue,
  perTask,
  suggestedAuditCap,
} from "./audit";
import { auditReport, reportPeriod, reportStamp } from "./audit-report";
import { pageScope } from "./page-scope";

describe("監査の表示（PBI-124）", () => {
  it("監査の状態の色は、タスクの状態と同じ5つの種類のどれか", () => {
    expect(Object.fromEntries(AUDIT_STATUSES.map((s) => [s, auditStatusTone(s)]))).toEqual({
      waiting: "waiting",
      surveying: "working",
      deepDiving: "working",
      completed: "completed",
      failed: "person",
      budgetPaused: "person",
    });
  });

  it("宛先の選択肢の値は、キーの並びにかかわらず同じ宛先なら同じ", () => {
    expect(auditTargetValue({ depth: 1, repo: "r", kind: "context" } as never)).toBe(
      auditTargetValue({ kind: "context", repo: "r", depth: 1 }),
    );
    expect(JSON.parse(auditTargetValue({ kind: "repository", repo: "r" }))).toEqual({
      kind: "repository",
      repo: "r",
    });
  });

  it("宛先の表示：コンテキストは層（プロジェクトの層・上位 n 層）を添える。日本語と英語", () => {
    const ja = messagesFor("ja").audit.target;
    const en = messagesFor("en").audit.target;
    expect(auditTargetText({ kind: "context", repo: "r", depth: 0 }, ja)).toEqual({
      kind: "コンテキスト（プロジェクトの層）",
      detail: "r",
    });
    expect(auditTargetText({ kind: "context", repo: "r", depth: 2 }, en).kind).toBe(
      "Context (2 layers up)",
    );
    expect(auditTargetText({ kind: "sacty" }, ja)).toEqual({ kind: "Sacty の既定のコンテキスト" });
  });

  it("再開の上限の初期値と、1件あたりの件数", () => {
    expect(suggestedAuditCap(1, 1)).toBe(2);
    expect(suggestedAuditCap(3.2, 1)).toBe(5);
    expect(perTask(5, 2)).toBe(2.5);
    expect(perTask(1, 3)).toBe(0.3);
    expect(perTask(0, 0)).toBeNull();
  });

  it("監査の画面は、プロジェクトの画面（ヘッダーの切り替え・サイドメニューがそのプロジェクトに合わせる）", () => {
    expect(pageScope("/projects/p1/audit")).toEqual({ kind: "project", id: "p1" });
    expect(pageScope("/projects/p%201/audit/report")).toEqual({ kind: "project", id: "p 1" });
  });
});

describe("監査のレポート（PBI-124）", () => {
  it("期間は日付で、終了日の終わりまで含む。日付でない・開始が終了より後なら null", () => {
    expect(reportPeriod("2026-10-01", "2026-10-01")).toEqual({
      from: "2026-10-01",
      to: "2026-10-01",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-10-02T00:00:00.000Z",
    });
    expect(reportPeriod("2026-10-02", "2026-10-01")).toBeNull();
    expect(reportPeriod("2026/10/01", "2026-10-02")).toBeNull();
    expect(reportPeriod(null, "2026-10-02")).toBeNull();
    expect(reportPeriod("2026-13-01", "2026-10-02")).toBeNull();
    // 実在しない日付は、翌月へ繰り越さずに断る（PR #134 レビュー指摘）
    expect(reportPeriod("2026-02-30", "2026-03-03")).toBeNull();
    expect(reportPeriod("2026-02-01", "2026-02-29")).toBeNull();
    expect(reportPeriod("2026-04-31", "2026-05-01")).toBeNull();
    expect(reportPeriod("2028-02-29", "2028-03-01")?.start).toBe("2028-02-29T00:00:00.000Z");
  });

  const zero = {
    changesRequested: 0,
    pullRequestRemark: 0,
    pause: 0,
    retry: 0,
    toolFailure: 0,
    escalation: 0,
  };
  const data: ProjectAudits = {
    projectId: "p1",
    mock: false,
    defaultCapUsd: 1,
    audits: [
      {
        taskId: "in",
        taskTitle: "期間内 | 表",
        status: "completed",
        finishedAt: "2026-10-05T10:00:00.000Z",
        usedUsd: 0.5,
        counts: { ...zero, changesRequested: 1, pullRequestRemark: 2 },
      },
      {
        taskId: "out",
        taskTitle: "期間外",
        status: "completed",
        finishedAt: "2026-09-01T00:00:00.000Z",
        usedUsd: 0.4,
        counts: zero,
      },
      { taskId: "running", taskTitle: "監査中", status: "deepDiving", usedUsd: 0.1 },
    ],
    causes: [
      {
        id: "c1",
        projectId: "p1",
        title: "原因 A",
        status: "recurred",
        occurrences: [
          { taskId: "in", taskTitle: "期間内 | 表", at: "2026-10-05T10:00:00.000Z" },
          { taskId: "out", taskTitle: "期間外", at: "2026-09-01T00:00:00.000Z" },
        ],
        fixedAt: "2026-09-10T00:00:00.000Z",
        recurredAt: "2026-10-05T10:00:00.000Z",
      },
      {
        id: "c2",
        projectId: "p1",
        title: "期間外だけの原因",
        status: "proposed",
        occurrences: [{ taskId: "out", taskTitle: "期間外", at: "2026-09-01T00:00:00.000Z" }],
      },
    ],
    proposals: [
      {
        id: "x1",
        causeId: "c1",
        taskId: "in",
        taskTitle: "期間内 | 表",
        title: "提案 1",
        body: "本文 1",
        target: { kind: "repository", repo: "https://github.com/a/b" },
        targetCandidates: [],
        decision: { kind: "rejected", at: "2026-10-06T00:00:00.000Z", reason: "変えない" },
      },
      {
        id: "x3",
        causeId: "c1",
        taskId: "in",
        taskTitle: "期間内 | 表",
        title: "提案 3",
        body: "本文 3",
        target: { kind: "sacty" },
        targetCandidates: [],
        decision: {
          kind: "adopted",
          at: "2026-10-06T00:00:00.000Z",
          target: { kind: "sacty" },
          note: { kind: "supplement", text: "既にある設定に足す" },
        },
      },
      {
        id: "x2",
        causeId: "c2",
        taskId: "out",
        taskTitle: "期間外",
        title: "期間外の提案",
        body: "",
        target: { kind: "sacty" },
        targetCandidates: [],
      },
    ],
  };

  it("期間に完了した監査の原因・提案・判断だけをまとめる（期間外・監査中は入れない）", () => {
    const period = reportPeriod("2026-10-01", "2026-10-17");
    if (!period) throw new Error("period");
    const md = auditReport(data, "決済", period, messagesFor("ja"));
    expect(md).toContain("# 監査: 決済");
    expect(md).toContain("- 監査したタスク: 1");
    expect(md).toContain("- 差し戻し・指摘: 3");
    expect(md).toContain("### 原因 A");
    expect(md).toContain("- 再発: 2026-10-05 10:00 UTC");
    expect(md).not.toContain("期間外だけの原因");
    expect(md).not.toContain("期間外の提案");
    expect(md).toContain("- 却下の理由: 変えない");
    // 採用に添えた手入れも出す（PBI-151）
    expect(md).toContain("- 人の補足: 既にある設定に足す");
    expect(md).toContain("- 採用率: 50%");
    // 表の中の | は、表を崩さないようにエスケープする
    expect(md).toContain("| 期間内 \\| 表 | 3 | $0.5000 | 2026-10-05 10:00 UTC |");
    expect(md).not.toContain("監査中");
    expect(md).not.toContain("モック");
  });

  it("英語の画面なら見出しは英語。監査の結果の文は訳さない。モックなら印を付ける", () => {
    const period = reportPeriod("2026-10-01", "2026-10-17");
    if (!period) throw new Error("period");
    const md = auditReport({ ...data, mock: true }, "Pay", period, messagesFor("en"));
    expect(md).toContain("# Audit: Pay");
    expect(md).toContain("## Causes");
    expect(md).toContain("### 原因 A");
    expect(md).toContain("> Mock:");
  });

  it("期間に監査が無ければ、無いことを書き、採用率は —", () => {
    const period = reportPeriod("2026-01-01", "2026-01-02");
    if (!period) throw new Error("period");
    const md = auditReport(data, "決済", period, messagesFor("ja"));
    expect(md).toContain("- 監査したタスク: 0");
    expect(md).toContain("原因はまだありません。");
    expect(md).toContain("- 採用率: —");
  });

  it("レポートの日時は年を含めた UTC", () => {
    expect(reportStamp("2026-10-05T10:00:59.000Z")).toBe("2026-10-05 10:00 UTC");
  });
});

describe("レポートの、メモリーをコンテキストにする原因と元のメモリー（PR #138 再レビュー指摘）", () => {
  const data: ProjectAudits = {
    projectId: "p1",
    mock: false,
    defaultCapUsd: 1,
    audits: [
      {
        taskId: "t1",
        taskTitle: "タスク",
        status: "completed",
        finishedAt: "2026-10-05T10:00:00.000Z",
        usedUsd: 0.1,
      },
    ],
    causes: [
      {
        id: "memory:m1",
        projectId: "p1",
        title: "lint は biome",
        status: "proposed",
        occurrences: [{ taskId: "t1", taskTitle: "タスク", at: "2026-10-05T10:00:00.000Z" }],
      },
    ],
    proposals: [
      {
        id: "t1:a:memory:m1",
        causeId: "memory:m1",
        taskId: "t1",
        taskTitle: "タスク",
        title: "AGENTS.md に書く",
        body: "AGENTS.md に書く",
        target: { kind: "repository", repo: "https://github.com/a/b" },
        targetCandidates: [],
        memoryOriginal: {
          title: "lint は biome",
          summary: "lint の道具",
          body: "biome check を使う",
        },
      },
    ],
  };
  const period = reportPeriod("2026-10-01", "2026-10-17");

  it("定型の題と説明を画面の言語で出し、元のメモリーの題・概要・中身を出す", () => {
    if (!period) throw new Error("period");
    const ja = auditReport(data, "決済", period, messagesFor("ja"));
    expect(ja).toContain("### メモリーをコンテキストにする：lint は biome");
    expect(ja).toContain("マージで元のメモリーは消えます。");
    expect(ja).toContain("#### 元のメモリー");
    expect(ja).toContain("**lint は biome**");
    expect(ja).toContain("lint の道具");
    expect(ja).toContain("biome check を使う");
    const en = auditReport(data, "Pay", period, messagesFor("en"));
    expect(en).toContain("### Make memory context: lint は biome");
    expect(en).toContain("Merging the fix deletes the memory.");
    expect(en).toContain("#### Original memory");
    expect(en).not.toContain("メモリーをコンテキストにする");
  });
});
