// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const followProjectAction = vi.fn(async (_id: string) => {});
vi.mock("@/app/actions", () => {
  const action = vi.fn(async () => ({}));
  return {
    gateAction: action,
    voidRemarkAction: action,
    runIntakeAction: action,
    followProjectAction,
  };
});

// デーモンの代わり（実行のログの画面のルートが呼ぶ）。ログは、渡した位置（バイト）より後だけを返す
const daemon = vi.hoisted(() => ({
  events: "",
  finishedAt: undefined as string | undefined,
  filesFail: false,
  down: false,
  /** タスクが無い（プロジェクトを削除した）。 */
  gone: false,
  /** 応答しない（中断されるまで終わらない）。中断されたら aborted に数える。 */
  hang: false,
  aborted: 0,
  /** 1回の読み出しで返したバイト数（全体を読み直していないかを確かめる）。 */
  reads: [] as number[],
}));
vi.mock("@/lib/daemon", () => ({
  getTask: async () => {
    if (daemon.down) throw new Error("unreachable");
    if (daemon.gone) return null;
    return { task: { id: "t1", title: "認証の設計", projectId: "p1" }, activity: [] };
  },
  getRunLog: async (_id: string, _run: string, from: { events?: number } = {}) => {
    if (daemon.down) throw new Error("unreachable");
    if (daemon.hang) {
      const { currentDaemonSignal } = await import("@/lib/daemon-signal");
      const signal = currentDaemonSignal();
      await new Promise((_, reject) =>
        signal?.addEventListener("abort", () => {
          daemon.aborted += 1;
          reject(new Error("aborted"));
        }),
      );
    }
    const buf = Buffer.from(daemon.events, "utf8");
    const start = from.events ?? 0;
    const begin = !daemon.finishedAt && start > 0 && start <= buf.length ? start : 0;
    daemon.reads.push(buf.length - begin);
    return {
      meta: {
        runId: "r1",
        taskId: "t1",
        role: "requirements",
        agentId: "stub",
        runtime: "claude-code",
        authMode: "stub",
        startedAt: "2026-10-15T00:00:00.000Z",
        limits: { events: { head: 1000, tail: 1000 }, stderr: { head: 1000, tail: 1000 } },
        ...(daemon.finishedAt ? { finishedAt: daemon.finishedAt } : {}),
      },
      events: buf.subarray(begin).toString("utf8"),
      stderr: "",
      offsets: { events: { from: begin, next: buf.length }, stderr: { from: 0, next: 0 } },
    };
  },
  getAgentFiles: async () => {
    if (daemon.filesFail) throw new Error("daemon responded 500");
    return {
      runId: "r1",
      role: "requirements",
      agentId: "stub",
      runtime: "claude-code",
      limitBytes: 1000,
      skipped: [],
      archivedAt: "2026-10-15T00:01:00.000Z",
      files: [],
    };
  },
}));

const { I18nProvider } = await import("@/i18n/client");
const { LiveRunLog, applyChunk } = await import("./run-log");
const { LiveReview } = await import("./review");
const { LiveProjectList } = await import("./project-list");
const { liveVersion } = await import("@/lib/live-server");
const { GET: runLogRoute } = await import("@/app/live/tasks/[id]/runs/[runId]/route");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const requests: string[] = [];
let handler: (url: string, headers: Record<string, string>) => unknown;
/** 画面の認証が無い（sacty を起動し直した）。Proxy が 401 を返す（PBI-129）。 */
let signedOut = false;

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
  signedOut = false;
  followProjectAction.mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (signedOut) return new Response("<!doctype html>", { status: 401 });
      // 実行のログは、画面のサーバーのルートをそのまま通す
      if (url.startsWith("/live/tasks/t1/runs/r1")) {
        return runLogRoute(new Request(`http://web${url}`, { headers: init?.headers }), {
          params: Promise.resolve({ id: "t1", runId: "r1" }),
        });
      }
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

describe("実行のログ：実行中は、足された行だけを取って後ろに足す（PBI-108・PR #119 レビュー指摘）", () => {
  const initial = (): RunLogData => {
    const bytes = Buffer.byteLength(daemon.events, "utf8");
    return {
      taskId: "t1",
      taskTitle: "認証の設計",
      projectId: "p1",
      rows: [],
      log: {
        meta: {
          runId: "r1",
          taskId: "t1",
          role: "requirements",
          agentId: "stub",
          runtime: "claude-code",
          authMode: "stub",
          startedAt: "2026-10-15T00:00:00.000Z",
          limits: { events: { head: 1000, tail: 1000 }, stderr: { head: 1000, tail: 1000 } },
        },
        events: daemon.events,
        stderr: "",
        offsets: { events: { from: 0, next: bytes }, stderr: { from: 0, next: 0 } },
      },
      agentFiles: null,
    };
  };
  let scrollTo: ReturnType<typeof vi.fn>;
  let scrollY = 0;

  beforeEach(() => {
    daemon.events = say("始めます") + tool("ls");
    daemon.finishedAt = undefined;
    daemon.filesFail = false;
    daemon.down = false;
    daemon.gone = false;
    daemon.hang = false;
    daemon.aborted = 0;
    daemon.reads.length = 0;
    scrollY = 0;
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
  });

  it("新しい行が、操作しなくても間隔のうちに出る。デーモンからも足された分だけを読み、開いた欄はそのまま", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    const first = container.querySelector("ol li") as HTMLElement;
    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    const before = Buffer.byteLength(daemon.events, "utf8");
    const added = say("要求要件を書きました");
    daemon.events += added;
    await wait();
    expect(text()).toContain("要求要件を書きました");
    // 持っている分の終わり（バイト）を伝え、デーモンも足された分だけを読む
    expect(requests.at(-1)).toContain(`events=${before}`);
    expect(daemon.reads.at(-1)).toBe(Buffer.byteLength(added, "utf8"));
    expect(container.querySelector("ol li")).toBe(first);
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("読んでいる途中（一番下でない）ならスクロールの位置を動かさず、一番下を見ているときだけ新しい行についていく", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    scrollY = 300; // 800 + 300 < 2000
    daemon.events += say("1行目");
    await wait();
    expect(text()).toContain("1行目");
    expect(scrollTo).not.toHaveBeenCalled();
    scrollY = 1_200; // 一番下
    daemon.events += say("2行目");
    await wait();
    expect(text()).toContain("2行目");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("実行が終わったら（閉じるときに書き直されうるので全体を受け取り）、ログの取り直しを止め、タスクがあるかだけを確かめる", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    daemon.events = say("書き直した全体") + say("完了しました");
    daemon.finishedAt = "2026-10-15T00:01:00.000Z";
    await wait();
    expect(text()).toContain("完了しました");
    expect(text()).not.toContain("始めます");
    const count = requests.length;
    const reads = daemon.reads.length;
    await wait(15_000);
    expect(requests.length).toBeGreaterThan(count);
    expect(requests.slice(count).every((u) => u.endsWith("?check=1"))).toBe(true);
    // ログは読み直さない
    expect(daemon.reads).toHaveLength(reads);
  });

  it("開いている間にタスクが無くなったら（プロジェクトの削除。PR #204 レビュー指摘）、実行が終わった後でも描き直す", async () => {
    refresh.mockClear();
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    daemon.finishedAt = "2026-10-15T00:01:00.000Z";
    await wait();
    await wait();
    expect(refresh).not.toHaveBeenCalled();
    daemon.gone = true;
    await wait();
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockClear();
  });

  it("終わった直後にファイルの一覧だけが読めなくても、ログと終わったことは出し、一覧だけを取り直す", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    daemon.events += say("完了しました");
    daemon.finishedAt = "2026-10-15T00:01:00.000Z";
    daemon.filesFail = true;
    await wait();
    expect(text()).toContain("完了しました");
    expect(container.querySelector("#run-agent-files")).toBeNull();
    expect(container.querySelector('[data-testid="live-stale"]')).toBeNull();
    // 一覧が読めるようになったら出して、止める
    daemon.filesFail = false;
    await wait();
    expect(container.querySelector("#run-agent-files")).not.toBeNull();
    const count = requests.length;
    await wait(15_000);
    expect(requests.slice(count).every((u) => u.endsWith("?check=1"))).toBe(true);
  });

  it("更新できない間は、表示を残したまま更新が止まっていることを出し、つながったら消す", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    daemon.down = true;
    await wait();
    expect(text()).toContain("始めます");
    expect(container.querySelector('[data-testid="live-stale"]')?.textContent).toContain(
      "デーモンに届きません",
    );
    daemon.down = false;
    daemon.events += say("戻りました");
    await wait();
    expect(text()).toContain("戻りました");
    expect(container.querySelector('[data-testid="live-stale"]')).toBeNull();
  });

  it("画面の認証が無くなったら、届かないのではなく入り直すよう出す（PR #141 レビュー提案）", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    signedOut = true;
    await wait();
    expect(text()).toContain("始めます");
    expect(container.querySelector('[data-testid="live-stale"]')?.textContent).toContain(
      "端末に表示された新しい URL を開いてください",
    );
    signedOut = false;
    await wait();
    expect(container.querySelector('[data-testid="live-stale"]')).toBeNull();
  });

  it("デーモンが応答しないと、画面のサーバーの期限でデーモンへの問い合わせも止め、問い合わせを溜めない（PR #119 再レビュー指摘）", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    daemon.hang = true;
    await wait(3_000);
    expect(daemon.aborted).toBe(0);
    await wait(8_000);
    expect(daemon.aborted).toBe(1);
    expect(container.querySelector('[data-testid="live-stale"]')).not.toBeNull();
    // 次の取り直しも同じく止める（終わらない問い合わせが増え続けない）
    await wait(11_000);
    expect(daemon.aborted).toBe(2);
  });

  it("ファイルの一覧を読めない間は、そのことと取り直していることを出す（無いことと見分けられる）", async () => {
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: initial() }));
    daemon.finishedAt = "2026-10-15T00:01:00.000Z";
    daemon.filesFail = true;
    await wait();
    expect(container.querySelector('[data-testid="agent-files-failed"]')?.textContent).toContain(
      "一覧を読めませんでした。取り直しています",
    );
    daemon.filesFail = false;
    await wait();
    expect(container.querySelector('[data-testid="agent-files-failed"]')).toBeNull();
    expect(container.querySelector("#run-agent-files")).not.toBeNull();
  });

  it("描いたときに届かず、後から出たログのプロジェクトを、表示しているプロジェクトにする", async () => {
    daemon.down = true;
    render(h(LiveRunLog, { taskId: "t1", runId: "r1", initial: null, error: "届きません" }));
    await wait();
    expect(followProjectAction).not.toHaveBeenCalled();
    daemon.down = false;
    await wait();
    expect(text()).toContain("始めます");
    expect(followProjectAction).toHaveBeenCalledWith("p1");
  });

  it("足された分の合わせ方：位置が合えば後ろに足し、0 なら置き換え、合わなければ使わない", () => {
    expect(applyChunk("abc", 3, { from: 3, text: "def", next: 6 })).toBe("abcdef");
    expect(applyChunk("abc", 3, { from: 0, text: "new", next: 3 })).toBe("new");
    expect(applyChunk("abc", 3, { from: 5, text: "x", next: 6 })).toBeUndefined();
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
  errorAnalyses: [],
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

describe("レビューとプロジェクトの一覧：更新できない間・描いたときに届かなかったとき（PR #119 レビュー指摘）", () => {
  it("レビュー：描いたときに届かず後から出たタスクのプロジェクトに合わせ、更新できない間はそれを出す", async () => {
    let down = true;
    const server = task();
    handler = () => (down ? { unavailable: true } : { data: server, version: liveVersion(server) });
    render(h(LiveReview, { id: "t1", initial: null, error: "届きません" }));
    await wait();
    expect(text()).toContain("届きません");
    expect(followProjectAction).not.toHaveBeenCalled();
    down = false;
    await wait();
    expect(document.getElementById("gate-comments")).not.toBeNull();
    expect(followProjectAction).toHaveBeenCalledWith("p1");
    down = true;
    await wait();
    expect(container.querySelector('[data-testid="live-stale"]')).not.toBeNull();
    expect(document.getElementById("gate-comments")).not.toBeNull();
    down = false;
    await wait();
    expect(container.querySelector('[data-testid="live-stale"]')).toBeNull();
  });

  it("レビュー：描いたときに届いていれば、プロジェクトを合わせ直さない（サーバーの FollowProject が合わせる）", async () => {
    const server = task();
    handler = () => ({ data: server, version: liveVersion(server) });
    render(h(LiveReview, { id: "t1", initial: server, initialVersion: liveVersion(server) }));
    await wait();
    expect(followProjectAction).not.toHaveBeenCalled();
  });

  it("プロジェクトの一覧：更新できない間は、それを出す", async () => {
    const data: ProjectListData = {
      projects: [{ id: "p1", name: "Acme", targets: [], createdAt: "", updatedAt: "" }],
      status: { intake: null },
    };
    let down = false;
    handler = () => (down ? { unavailable: true } : { data, version: liveVersion(data) });
    render(h(LiveProjectList, { initial: data, initialVersion: liveVersion(data) }));
    down = true;
    await wait();
    expect(container.querySelector('[data-testid="live-stale"]')).not.toBeNull();
    expect(text()).toContain("Acme");
  });
});

describe("成果物のレビュー：開いている間に対象が無くなったとき（プロジェクトの削除。PR #204 レビュー指摘）", () => {
  it("取り直しで対象が無ければ、描き直す（サーバーが 404 にする）", async () => {
    refresh.mockClear();
    const server = task();
    let missing = false;
    handler = (_url, headers) => {
      if (missing) return { missing: true };
      const version = liveVersion(server);
      return headers["x-sacty-live-version"] === version
        ? { unchanged: true }
        : { data: server, version };
    };
    render(h(LiveReview, { id: "t1", initial: server, initialVersion: liveVersion(server) }));
    await wait();
    expect(refresh).not.toHaveBeenCalled();
    missing = true;
    await wait();
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockClear();
  });
});
