// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardData, OpenTaskRow } from "@/lib/dashboard-data";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));
vi.mock("@/app/actions", () => ({ followProjectAction: vi.fn(async () => {}) }));

const { I18nProvider } = await import("@/i18n/client");
const { LiveDashboard, DASHBOARD_LIVE_URL } = await import("./dashboard");
const { liveVersion } = await import("@/lib/live-server");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 画面のサーバーの代わり。取り直しの問い合わせに、server の今のデータを返す（版が同じなら中身を送らない）
let server: unknown;
const requests: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (server === "down") return Response.json({ unavailable: true });
      const version = liveVersion(server);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return Response.json(
        headers["x-sacty-live-version"] === version
          ? { unchanged: true }
          : { data: server, version },
      );
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode, locale: "ja" | "en" = "ja") {
  act(() => {
    root.render(h(I18nProvider as unknown as FC<{ locale: "ja" | "en" }>, { locale }, node));
  });
}

async function wait(ms = 3_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const row = (
  id: string,
  projectId: string,
  projectName: string,
  status: OpenTaskRow["status"] = { text: "実行中", tone: "working" },
): OpenTaskRow => ({ id, title: `タスク ${id}`, projectId, projectName, status });

const list = () => container.querySelector('[data-testid="open-tasks-list"]') as HTMLElement | null;
const item = (id: string) => container.querySelector(`[data-testid="open-task-${id}"]`);
const text = () => container.textContent ?? "";

describe("ダッシュボードの終わっていないタスクの欄（PBI-114）", () => {
  it("各タスクに、プロジェクト・状態・タスクの詳細へのリンクを出す", () => {
    const data: DashboardData = {
      projects: 2,
      openTasks: [
        row("a", "p1", "決済", { text: "要求要件の承認待ち", tone: "person" }),
        row("b", "p2", "Webサイト", { text: "一時停止中", tone: "person" }),
      ],
    };
    server = data;
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    expect(container.querySelector("#open-tasks")?.textContent).toBe("終わっていないタスク");
    expect(text()).toContain("2件");
    expect(item("a")?.textContent).toContain("決済");
    expect(item("a")?.textContent).toContain("要求要件の承認待ち");
    expect(item("b")?.textContent).toContain("Webサイト");
    expect(item("b")?.textContent).toContain("一時停止中");
    expect(item("a")?.querySelector("a")?.getAttribute("href")).toBe("/tasks/a");
  });

  it("切り詰めた題とプロジェクトの名前の全文を、ホバー（title）と、行にフォーカスがある間の折り返しで見られる", () => {
    const long = "請求書の PDF の日付の形式をそろえる（明細・合計・発行日・支払期限のすべて）";
    const data: DashboardData = {
      projects: 1,
      openTasks: [
        { ...row("a", "p1", "決済システムの請求まわり"), title: `${long} その1` },
        { ...row("b", "p1", "決済システムの請求まわり"), title: `${long} その2` },
      ],
    };
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    const link = item("b")?.querySelector("a") as HTMLAnchorElement;
    expect(link.title).toBe(`${long} その2`);
    expect(link.className).toContain("truncate");
    expect(link.className).toContain("group-focus-within:whitespace-normal");
    const project = item("b")?.querySelector('span[title="決済システムの請求まわり"]');
    expect(project?.className).toContain("group-focus-within:whitespace-normal");
    expect(item("b")?.className).toContain("group");
  });

  it("件数の補足は言語ごとの文言で組み立てる（英語に「・」を出さない）", () => {
    const data: DashboardData = {
      projects: 2,
      openTasks: [row("a", "p1", "Payments"), row("b", "p2", "Web")],
    };
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }), "en");
    const summary = container.querySelector('[data-testid="open-tasks-summary"]')?.textContent;
    expect(summary).toBe("All projects · 2 tasks");
    act(() => root.unmount());
    root = createRoot(container);
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    expect(container.querySelector('[data-testid="open-tasks-summary"]')?.textContent).toBe(
      "すべてのプロジェクト・2件",
    );
  });

  it("欄の高さは5件分で、それより多ければ欄の中でスクロールする（件数の上限は無い）", () => {
    const data: DashboardData = {
      projects: 1,
      openTasks: Array.from({ length: 30 }, (_, i) => row(`t${i}`, "p1", "決済")),
    };
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    expect(container.querySelectorAll('[data-testid^="open-task-t"]')).toHaveLength(30);
    // 1行が min-h-16（4rem）、欄が max-h-80（20rem）＝5件分。あふれたら欄の中でスクロールする
    expect(list()?.className).toContain("max-h-80");
    expect(list()?.className).toContain("overflow-y-auto");
    expect(item("t0")?.className).toContain("min-h-16");
    // キーボードでもスクロールできる
    expect(list()?.tabIndex).toBe(0);
  });

  it("プロジェクトが無いとき・終わっていないタスクが無いときの表示がある", () => {
    const none: DashboardData = { projects: 0, openTasks: [] };
    render(h(LiveDashboard, { key: "none", initial: none, initialVersion: liveVersion(none) }));
    expect(text()).toContain("プロジェクトがありません。");
    expect(container.querySelector('a[href="/projects"]')).not.toBeNull();
    const empty: DashboardData = { projects: 2, openTasks: [] };
    render(h(LiveDashboard, { key: "empty", initial: empty, initialVersion: liveVersion(empty) }));
    expect(text()).toContain("終わっていないタスクはありません。");
    expect(list()).toBeNull();
  });

  it("画面をリロードせずにデータだけを取り直し、状態の変化・増えたタスク・終わったタスクを反映する", async () => {
    const data: DashboardData = {
      projects: 2,
      openTasks: [row("a", "p1", "決済"), row("b", "p2", "Webサイト")],
    };
    server = data;
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    server = {
      projects: 2,
      openTasks: [
        row("c", "p2", "Webサイト", { text: "実行待ち", tone: "waiting" }),
        row("a", "p1", "決済", { text: "要求要件の承認待ち", tone: "person" }),
      ],
    } satisfies DashboardData;
    await wait();
    expect(requests.every((u) => u === DASHBOARD_LIVE_URL)).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    expect(item("a")?.textContent).toContain("要求要件の承認待ち");
    expect(item("c")?.textContent).toContain("実行待ち");
    // 終わったタスク（b）は消える
    expect(item("b")).toBeNull();
    expect(text()).toContain("2件");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("自動の更新で、欄のスクロールの位置とフォーカスが消えない（同じ要素が残る）", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`t${i}`, "p1", "決済"));
    const data: DashboardData = { projects: 1, openTasks: rows };
    server = data;
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    const before = list() as HTMLElement;
    before.scrollTop = 200;
    before.focus();
    const link = item("t8")?.querySelector("a") as HTMLAnchorElement;
    server = {
      projects: 1,
      openTasks: [row("new", "p1", "決済"), ...rows.slice(0, 11)],
    } satisfies DashboardData;
    await wait();
    expect(item("new")).not.toBeNull();
    expect(item("t11")).toBeNull();
    expect(list()).toBe(before);
    expect(list()?.scrollTop).toBe(200);
    expect(document.activeElement).toBe(before);
    expect(item("t8")?.querySelector("a")).toBe(link);
  });

  it("デーモンに届かない間は表示を残して更新できないことを出し、描いたときに届かなくても届いたら欄を出す", async () => {
    const data: DashboardData = { projects: 1, openTasks: [row("a", "p1", "決済")] };
    server = "down";
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    await wait();
    expect(item("a")).not.toBeNull();
    expect(container.querySelector('[data-testid="live-stale"]')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    render(h(LiveDashboard, { initial: null, error: "デーモンに届きません" }));
    expect(text()).toContain("デーモンに届きません");
    server = data;
    await wait();
    expect(text()).not.toContain("デーモンに届きません");
    expect(item("a")).not.toBeNull();
  });
});

describe("ダッシュボードの Slack の通知を送れなかった理由（PBI-115）", () => {
  const problem = "Slack の通知を送れませんでした：HTTP 500（タスクは止めていません）";
  const box = () => container.querySelector('[data-testid="notification-problems"]');

  it("送れなかった理由を、sacty の設定へのリンクつきで出す。無ければ出さない。取り直しで出る・消える", async () => {
    const ok: DashboardData = { projects: 1, openTasks: [], notificationProblems: [] };
    server = ok;
    render(h(LiveDashboard, { initial: ok, initialVersion: liveVersion(ok) }));
    expect(box()).toBeNull();
    server = { ...ok, notificationProblems: [problem] } satisfies DashboardData;
    await wait();
    expect(box()?.textContent).toContain(problem);
    expect(box()?.querySelector('a[href="/settings"]')?.textContent).toBe(
      "sacty の設定で Slack の通知を確かめる",
    );
    server = ok;
    await wait();
    expect(box()).toBeNull();
  });
});
