import type { ProjectAudits, TaskAudit } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({
  adoptAuditProposalAction: vi.fn(),
  rejectAuditProposalAction: vi.fn(),
  deleteAuditMemoryAction: vi.fn(),
  resumeAuditAction: vi.fn(),
}));

const { TaskAuditCard } = await import("./audit");
const { AuditScreen } = await import("./audit-screen");

const zero = {
  changesRequested: 0,
  pullRequestRemark: 0,
  pause: 0,
  retry: 0,
  toolFailure: 0,
  escalation: 0,
};

const audit = (patch: Partial<TaskAudit>): TaskAudit => ({
  taskId: "t1",
  projectId: "p1",
  status: "completed",
  budget: { usedUsd: 0.25, capUsd: 1 },
  deepDives: [],
  findings: [],
  memories: [],
  usefulMemories: [],
  movedMemories: [],
  ...patch,
});

const proposal = {
  id: "t1:c1:0",
  causeId: "c1",
  taskId: "t1",
  title: "規約に書く",
  body: "**太字**の本文",
  target: { kind: "context", repo: "https://github.com/a/ctx", depth: 0 } as const,
  targetCandidates: [
    { kind: "repository", repo: "https://github.com/a/app" } as const,
    { kind: "context", repo: "https://github.com/a/ctx", depth: 0 } as const,
    { kind: "sacty" } as const,
  ],
};

const render = (a: TaskAudit | null) =>
  renderToStaticMarkup(createElement(TaskAuditCard, { audit: a }));

describe("タスクの詳細の監査の欄（PBI-124）", () => {
  it("監査が無ければ「まだ監査はありません」", () => {
    locale = "ja";
    expect(render(null)).toContain("まだ監査はありません。");
  });

  it("監査済み：状態・費用・根拠の件数・原因・判断待ちの提案（宛先の候補を選べる）を出す。モックなら印", () => {
    locale = "ja";
    const html = render(
      audit({
        mock: true,
        survey: { summary: "要約", counts: { ...zero, changesRequested: 2 } },
        findings: [
          {
            causeId: "c1",
            title: "原因の題",
            detail: "原因の説明",
            step: "design",
            recurred: true,
            evidence: [
              { kind: "toolFailure", at: "", text: "失敗した", eventId: "e1", runId: "r1" },
            ],
            proposals: [proposal],
          },
        ],
      }),
    );
    expect(html).toContain("監査済み");
    expect(html).toContain("モック");
    expect(html).toContain("費用 $0.2500 / $1.00");
    expect(html).toMatch(/data-testid="audit-count-changesRequested"[^>]*>2 件</);
    expect(html).toContain("原因の題");
    expect(html).toContain("再発");
    expect(html).toContain('href="#event-e1"');
    expect(html).toContain('href="/tasks/t1/runs/r1"');
    expect(html).toContain("<strong>太字</strong>");
    expect(html).toContain("判断待ち");
    // 監査が選んだ宛先を初期値にして、候補をすべて出す
    expect(html).toContain('<option value="{&quot;kind&quot;:&quot;sacty&quot;}">');
    expect(html).toMatch(/<option value="[^"]*ctx[^"]*" selected="">/);
    expect(html).toContain("採用する");
    expect(html).toContain("却下する");
  });

  it("判断した提案はフォームを出さず、採用なら改修のタスク（モックならリンクにしない）、却下なら理由を出す", () => {
    locale = "ja";
    const html = render(
      audit({
        findings: [
          {
            causeId: "c1",
            title: "原因",
            detail: "",
            evidence: [],
            proposals: [
              {
                ...proposal,
                id: "a",
                decision: {
                  kind: "adopted",
                  at: "2026-10-01T00:00:00Z",
                  target: { kind: "sacty" },
                  task: { taskId: "mock-a", title: "改修：規約", mock: true },
                },
              },
              {
                ...proposal,
                id: "b",
                decision: { kind: "rejected", at: "2026-10-01T00:00:00Z", reason: "変えない" },
              },
              {
                ...proposal,
                id: "c",
                decision: {
                  kind: "adopted",
                  at: "2026-10-01T00:00:00Z",
                  target: { kind: "sacty" },
                  task: { taskId: "real-1", title: "本物" },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(html).not.toContain("採用する");
    expect(html).toContain("改修：規約");
    expect(html).toContain("モックのため、タスクは作っていません");
    expect(html).not.toContain('href="/tasks/mock-a"');
    expect(html).toContain('href="/tasks/real-1"');
    expect(html).toContain("変えない");
    // 採用した提案の宛先は、人が選んだ宛先
    expect(html).toContain("Sacty の既定のコンテキスト");
  });

  it("監査済みで原因が無ければ、無いことを出す", () => {
    locale = "ja";
    expect(render(audit({ survey: { summary: "", counts: zero } }))).toContain(
      "改修が要る原因は見つかりませんでした。",
    );
  });

  it("失敗は理由を、予算で一時停止は再開のフォームを出す。深掘りは工程と状態を出す", () => {
    locale = "ja";
    const failed = render(
      audit({
        status: "failed",
        failure: { code: "audit.runFailed", params: { detail: "読めない" } },
      }),
    );
    expect(failed).toContain("監査を実行できませんでした：読めない");
    const paused = render(
      audit({
        status: "budgetPaused",
        budget: { usedUsd: 1, capUsd: 1 },
        deepDives: [{ step: "implement", status: "running", reason: "失敗が多い" }],
      }),
    );
    expect(paused).toContain("予算で一時停止");
    expect(paused).toContain("新しい上限（使用済み $1.00）");
    expect(paused).toContain('value="2"');
    expect(paused).toContain("深掘り中");
    expect(paused).toContain("失敗が多い");
    // 完了していない監査には、原因と提案の欄を出さない
    expect(paused).not.toContain("原因と改修の提案");
  });

  it("英語の画面でも、監査の結果の文は訳さない", () => {
    locale = "en";
    const html = render(audit({ survey: { summary: "日本語の要約", counts: zero } }));
    expect(html).toContain("Audited");
    expect(html).toContain("日本語の要約");
    locale = "ja";
  });
});

describe("プロジェクトの監査の画面（PBI-124）", () => {
  const data: ProjectAudits = {
    projectId: "p 1",
    mock: false,
    defaultCapUsd: 1.5,
    audits: [
      {
        taskId: "t1",
        taskTitle: "タスク 1",
        status: "completed",
        finishedAt: "2026-10-01T00:00:00Z",
        usedUsd: 0.5,
        counts: { ...zero, changesRequested: 1, pullRequestRemark: 2 },
      },
      { taskId: "t2", taskTitle: "タスク 2", status: "waiting", usedUsd: 0 },
    ],
    causes: [
      {
        id: "c1",
        projectId: "p 1",
        title: "再発した原因",
        status: "recurred",
        occurrences: [{ taskId: "t1", taskTitle: "タスク 1", at: "" }],
        fixedAt: "2026-09-01T00:00:00Z",
        recurredAt: "2026-10-01T00:00:00Z",
      },
    ],
    proposals: [{ ...proposal, taskTitle: "タスク 1" }],
  };

  it("原因（再発を目立たせる）・判断待ちの件数・監査したタスク・レポートの出力を出す", () => {
    locale = "ja";
    const html = renderToStaticMarkup(createElement(AuditScreen, { data, today: "2026-10-17" }));
    expect(html).toContain("1回の監査の予算 $1.50");
    expect(html).not.toContain("モック");
    expect(html).toContain("再発した原因");
    expect(html).toMatch(/data-testid="audit-cause-status"[^>]*>再発</);
    expect(html).toContain("判断待ち 1 件");
    expect(html).toContain("出た監査");
    expect(html).toContain('href="/tasks/t1#audit"');
    expect(html).toMatch(/data-testid="audit-row-t1"[\s\S]*?>3</);
    expect(html).toContain('action="/projects/p%201/audit/report"');
    expect(html).toContain('value="2026-09-17"');
    expect(html).toContain('value="2026-10-17"');
  });

  it("原因・提案・監査が無ければ、無いことを出す", () => {
    locale = "ja";
    const html = renderToStaticMarkup(
      createElement(AuditScreen, {
        data: { ...data, audits: [], causes: [], proposals: [] },
        today: "2026-10-17",
      }),
    );
    expect(html).toContain("原因はまだありません。");
    expect(html).toContain("提案はまだありません。");
    expect(html).toContain("完了したタスクはまだありません。");
  });
});

describe("監査が登録したメモリー（PBI-126）", () => {
  const memory = {
    id: "m1",
    scope: "repository" as const,
    repo: "https://github.com/a/app",
    title: "lint は biome",
    summary: "lint の道具",
    body: "**biome** を使う",
    step: "implement" as const,
    at: "2026-10-01T00:00:00.000Z",
    lastUsefulAt: "2026-10-05T00:00:00.000Z",
  };

  it("登録したメモリーの題・階層・概要・中身と、消すボタンを出す", () => {
    locale = "ja";
    const html = render(audit({ memories: [memory] }));
    expect(html).toContain("登録したメモリー");
    expect(html).toContain("lint は biome");
    expect(html).toContain("リポジトリ");
    expect(html).toContain("https://github.com/a/app");
    expect(html).toContain("lint の道具");
    expect(html).toContain("<strong>biome</strong>");
    expect(html).toContain('data-testid="audit-memory-m1"');
    expect(html).toContain("消す");
    // 空白の無い長い題・概要も折り返す（PR #136 レビュー指摘）
    expect(html).toMatch(
      /<span class="[^"]*\[overflow-wrap:anywhere\][^"]*">lint は biome<\/span>/,
    );
    expect(html).toMatch(/<p class="[^"]*\[overflow-wrap:anywhere\][^"]*">lint の道具<\/p>/);
  });

  it("消したメモリーは印を出し、中身と消すボタンを出さない。上限で消したものは理由の補足を出す", () => {
    locale = "ja";
    const html = render(
      audit({
        memories: [
          { ...memory, deleted: { at: "2026-10-02T00:00:00.000Z", reason: "person" } },
          {
            ...memory,
            id: "m2",
            scope: "project",
            repo: undefined,
            deleted: { at: "2026-10-02T00:00:00.000Z", reason: "capacity" },
          },
        ],
      }),
    );
    expect(html).toContain("消した");
    expect(html).toContain("上限で消した");
    expect(html).toContain("有効な最終利用日の古いものから消しました");
    expect(html).not.toContain("<strong>biome</strong>");
    expect(html).not.toContain(">消す<");
  });

  it("メモリーが無ければ欄を出さない。英語の画面", () => {
    locale = "ja";
    expect(render(audit({}))).not.toContain("登録したメモリー");
    locale = "en";
    expect(render(audit({ memories: [memory] }))).toContain("Registered memories");
    locale = "ja";
  });
});

describe("役に立ったメモリーと期限での削除（PBI-127）", () => {
  const memory = {
    id: "m1",
    scope: "project" as const,
    title: "知見",
    summary: "概要",
    body: "中身",
    step: "implement" as const,
    at: "2026-10-01T00:00:00.000Z",
    lastUsefulAt: "2026-10-05T00:00:00.000Z",
  };

  it("役に立ったメモリーの欄と、登録したメモリーの有効な最終利用日を出す", () => {
    locale = "ja";
    const html = render(
      audit({
        memories: [memory],
        usefulMemories: [{ id: "m9", scope: "repository", title: "前の知見" }],
      }),
    );
    expect(html).toContain("役に立ったメモリー");
    expect(html).toContain('data-testid="audit-useful-memory-m9"');
    expect(html).toContain("前の知見");
    expect(html).toContain("有効な最終利用日：2026-10-05");
    expect(render(audit({}))).not.toContain("役に立ったメモリー");
  });

  it("期限で消したメモリーは印と理由の補足を出す", () => {
    locale = "ja";
    const html = render(
      audit({
        memories: [{ ...memory, deleted: { at: "2026-12-01T00:00:00.000Z", reason: "expired" } }],
      }),
    );
    expect(html).toContain("期限で消した");
    expect(html).toContain("メモリーを残す日数");
    expect(html).not.toContain("有効な最終利用日：");
  });
});

describe("移したメモリーとコンテキストにしたメモリー（PBI-128）", () => {
  it("移したメモリーの欄と、コンテキストにして消した印を出す", () => {
    locale = "ja";
    const html = render(
      audit({
        movedMemories: [
          {
            id: "m1",
            title: "lint は biome",
            scope: "repository",
            repo: "https://github.com/a/app",
          },
        ],
        memories: [
          {
            id: "m2",
            scope: "project",
            title: "知見",
            summary: "概要",
            body: "中身",
            step: "implement",
            at: "2026-10-01T00:00:00.000Z",
            lastUsefulAt: "2026-10-01T00:00:00.000Z",
            deleted: { at: "2026-10-09T00:00:00.000Z", reason: "promoted" },
          },
        ],
      }),
    );
    expect(html).toContain("移したメモリー");
    expect(html).toContain('data-testid="audit-moved-memory-m1"');
    expect(html).toContain("→ リポジトリ");
    expect(html).toContain("コンテキストにした");
    expect(render(audit({}))).not.toContain("移したメモリー");
  });
});

describe("メモリーをコンテキストにする原因の表示（PR #138 レビュー指摘）", () => {
  const finding = {
    causeId: "memory:m1",
    title: "lint は biome",
    detail: "",
    evidence: [],
    proposals: [
      {
        ...proposal,
        id: "t1:a:memory:m1",
        causeId: "memory:m1",
        body: "AGENTS.md に書く",
        memoryOriginal: {
          title: "lint は biome",
          summary: "lint の道具",
          body: "**biome** を使う",
        },
      },
    ],
  };

  it("定型の題と説明は画面の言語で出し、元のメモリーは訳さずに提案と別に出す", () => {
    locale = "ja";
    const ja = render(audit({ findings: [finding] }));
    expect(ja).toContain("メモリーをコンテキストにする：lint は biome");
    expect(ja).toContain("マージで元のメモリーは消えます。");
    expect(ja).toContain('data-testid="audit-proposal-memory-t1:a:memory:m1"');
    expect(ja).toContain("元のメモリー");
    expect(ja).toContain("<strong>biome</strong>");
    locale = "en";
    const en = render(audit({ findings: [finding] }));
    expect(en).toContain("Make memory context: lint は biome");
    expect(en).toContain("Original memory");
    expect(en).not.toContain("メモリーをコンテキストにする");
    locale = "ja";
  });
});
