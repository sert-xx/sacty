// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunLogMeta } from "@/lib/daemon";
import type { ProjectListData } from "@/lib/project-list-data";
import type { RunLogData } from "@/lib/run-log-data";

// 実行のログ・レビュー・プロジェクトの一覧も、画面をリロードせずに取り直す（PBI-108 の PO の確かめで足した分）
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/app/actions", () => {
  const action = vi.fn(async () => ({}));
  return { gateAction: action, voidRemarkAction: action, runIntakeAction: action };
});

const { I18nProvider } = await import("@/i18n/client");
const { LiveRunLog, applyChunk } = await import("./run-log");
const { LiveReview } = await import("./review");
const { LiveProjectList } = await import("./project-list");
const { liveVersion } = await import("@/lib/live-server");
const { appendedText, textMark } = await import("@/lib/run-log-data");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const requests: string[] = [];
let handler: (url: string, headers: Record<string, string>) => unknown;

function render(node: ReactNode) {
  act(() => {
    // createElement の3つ目の引数で子を渡す（I18nProvider の型は children を必須にしている）
    root.render(h(I18nProvider as unknown as FC<{ locale: "ja" }>, { locale: "ja" }, node));
  });
}

async function wait(ms = 3_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      return Response.json(handler(url, (init?.headers ?? {}) as Record<string, string>));
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const say = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const tool = (command: string) =>
  line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: command, name: "Bash", input: { command } }] },
  });

const meta = (patch: Partial<RunLogMeta> = {}): RunLogMeta => ({
  runId: "r1",
  taskId: "t1",
  role: "requirements",
  agentId: "stub",
  runtime: "claude-code",
  authMode: "stub",
  startedAt: "2026-10-15T00:00:00.000Z",
  limits: { events: { head: 1000, tail: 1000 }, stderr: { head: 1000, tail: 1000 } },
  ...patch,
});

describe("実行のログ：実行中は、足された行だけを取って後ろに足す（PBI-108）", () => {
  // 画面のサーバーの代わり（/live/tasks/<ID>/runs/<runId> と同じ計算）
  let events = "";
  let finishedAt: string | undefined;
  function serve() {
    handler = (url) => {
      const q = new URL(url, "http://web").searchParams;
      const m = meta(finishedAt ? { finishedAt } : {});
      return {
        data: {
          taskTitle: "認証の設計",
          rows: [],
          meta: m,
          events: appendedText(events, Number(q.get("events")), q.get("eventsMark") ?? undefined),
          stderr: appendedText("", 0, undefined),
          finished: Boolean(finishedAt),
        },
        version: liveVersion({ m, e: textMark(events), finishedAt }),
      };
    };
  }
  const initial = (): RunLogData => ({
    taskId: "t1",
    taskTitle: "認証の設計",
    projectId: "p1",
    rows: [],
    log: { meta: meta(), events, stderr: "" },
    agentFiles: null,
  });
  const marks = () => ({ events: textMark(events), stderr: textMark("") });
  let scrollTo: ReturnType<typeof vi.fn>;
  let scrollY = 0;

  beforeEach(() => {
    events = say("始めます") + tool("ls");
    finishedAt = undefined;
    serve();
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
  });

  it("新しい行が、操作しなくても間隔のうちに出る。足された分だけを受け取り、開いた欄はそのまま", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial(), initialMarks: marks() }));
    const first = container.querySelector("ol li") as HTMLElement;
    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    const before = events.length;
    events += say("要求要件を書きました");
    await wait();
    expect(text()).toContain("要求要件を書きました");
    // 持っている分の長さを伝え、足された分だけを受け取る
    expect(requests.at(-1)).toContain(`events=${before}`);
    expect(container.querySelector("ol li")).toBe(first);
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("読んでいる途中（一番下でない）ならスクロールの位置を動かさず、一番下を見ているときだけ新しい行についていく", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial(), initialMarks: marks() }));
    scrollY = 300; // 800 + 300 < 2000
    events += say("1行目");
    await wait();
    expect(text()).toContain("1行目");
    expect(scrollTo).not.toHaveBeenCalled();
    scrollY = 1_200; // 一番下
    events += say("2行目");
    await wait();
    expect(text()).toContain("2行目");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("ファイルが書き直された（途中を省いた形など）ときは、全体を置き換える", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial(), initialMarks: marks() }));
    events = say("書き直した全体");
    await wait();
    expect(text()).toContain("書き直した全体");
    expect(text()).not.toContain("始めます");
  });

  it("実行が終わったら、取り直しを止める", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial(), initialMarks: marks() }));
    events += say("完了しました");
    finishedAt = "2026-10-15T00:01:00.000Z";
    await wait();
    expect(text()).toContain("完了しました");
    const count = requests.length;
    await wait(15_000);
    expect(requests).toHaveLength(count);
  });

  it("足された分の計算：先頭が同じなら続きだけ、違えば全体", () => {
    const full = "abcdef";
    expect(appendedText(full, 3, textMark("abc"))).toMatchObject({ from: 3, text: "def" });
    expect(appendedText(full, 3, textMark("xyz"))).toMatchObject({ from: 0, text: "abcdef" });
    expect(appendedText(full, 9, textMark("abc"))).toMatchObject({ from: 0 });
    expect(applyChunk("abc", { from: 3, text: "def", mark: "" })).toBe("abcdef");
    expect(applyChunk("abc", { from: 0, text: "new", mark: "" })).toBe("new");
  });
});

const task = (patch: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "p1",
  title: "認証の設計",
  body: "",
  start: "sacty",
  status: "awaiting_approval",
  gate: { step: "requirements", submission: 1 } as Task["gate"],
  steps: [
    { key: "requirements", state: "active" },
    { key: "design", state: "todo" },
  ],
  outputs: { requirements: "要求要件の下書き" },
  testViewpoints: [],
  approved: {},
  proposals: [],
  testMap: [],
  reviewComments: [],
  reproductionTests: [],
  verifyFailures: 0,
  integrationFailures: 0,
  misses: [],
  importedFeedback: [],
  questions: [],
  exports: {},
  stepPullRequests: [],
  stepBranches: [],
  submissions: {},
  remarks: [],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...patch,
});

describe("成果物のレビュー：タスクだけを取り直し、書きかけのコメントを消さない（PBI-108）", () => {
  it("中身が変わってもコメントは残り、ほかのタブで承認したら承認待ちでないことが出る", async () => {
    let server: Task = task();
    handler = (_url, headers) => {
      const version = liveVersion(server);
      return headers["x-sacty-live-version"] === version
        ? { unchanged: true }
        : { data: server, version };
    };
    render(h(LiveReview, { id: "t1", initial: server, initialVersion: liveVersion(server) }));
    const comments = document.getElementById("gate-comments") as HTMLTextAreaElement;
    comments.value = "受け入れ条件を足してください";
    comments.focus();
    server = task({ outputs: { requirements: "要求要件の下書き（エージェントが直した）" } });
    await wait();
    expect(text()).toContain("エージェントが直した");
    expect(document.getElementById("gate-comments")).toBe(comments);
    expect(comments.value).toBe("受け入れ条件を足してください");
    expect(document.activeElement).toBe(comments);

    server = task({ status: "running", gate: undefined });
    await wait();
    expect(document.getElementById("gate-comments")).toBeNull();
    expect(text()).toContain("このタスクは承認待ちではありません");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("プロジェクトの一覧：取り込みの状況を取り直す（PBI-108）", () => {
  it("取り込みが動くと、直近の取り込みが操作しなくても変わる", async () => {
    const at = (iso: string, imported: number): ProjectListData => ({
      projects: [{ id: "p1", name: "Acme", targets: [], createdAt: "", updatedAt: "" }],
      status: {
        intake: {
          label: "sacty",
          runs: { issues: { lastRunAt: iso, imported } },
        } as unknown as ProjectListData["status"]["intake"],
      },
    });
    let server = at("2026-10-15T00:00:00.000Z", 0);
    handler = () => ({ data: server, version: liveVersion(server) });
    render(h(LiveProjectList, { initial: server, initialVersion: liveVersion(server) }));
    const before = text();
    server = at("2026-10-15T00:05:00.000Z", 2);
    await wait();
    expect(text()).not.toBe(before);
    expect(text()).toContain("2件");
    expect(refresh).not.toHaveBeenCalled();
  });
});
