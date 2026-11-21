// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listProjects = vi.fn();
const listTasks = vi.fn();
vi.mock("@/lib/daemon", () => ({
  DaemonUnavailableError: class extends Error {},
  listProjects,
  listProjectRepositories: vi.fn(),
  listTasks,
  getStatus: async () => ({ problems: [] }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), bfcacheId: "one" }),
  usePathname: () => "/projects/p1/tasks",
}));
vi.mock("@/i18n/server", async () => {
  const { messagesFor } = await import("@/i18n");
  return { getMessages: async () => messagesFor("ja") };
});
vi.mock("@/app/actions", () => {
  const action = vi.fn(async () => ({}));
  return { createTaskAction: action, followProjectAction: action, setLanguageAction: action };
});
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "p1",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));

const { default: TasksPage } = await import("./page");
const { LiveTaskList } = await import("@/components/task-list");
const { I18nProvider } = await import("@/i18n/client");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children)];
}

const task = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
  id,
  projectId: "p1",
  title,
  start: "sacty",
  status: "queued",
  steps: [],
  proposals: [],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
  createdAt: "2026-11-05T12:00:00",
  updatedAt: "",
  ...patch,
});

beforeEach(() => {
  listProjects.mockResolvedValue([
    { id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" },
  ]);
  listTasks.mockResolvedValue([
    task("a", "決済を直す", { repos: ["https://github.com/acme/web"] }),
    task("b", "決済の Issue", {
      start: "github_issue",
      repos: ["https://github.com/acme/web"],
      createdAt: "2026-11-05T12:00:00",
    }),
    task("c", "別件", { createdAt: "2026-11-20T12:00:00" }),
  ]);
});
afterEach(() => vi.restoreAllMocks());

/** ページの `Tasks` 部品を、URL のクエリで描いた要素（LiveTaskList）。 */
async function listFor(query: Record<string, string | string[]>) {
  const tree = elements(
    await TasksPage({
      params: Promise.resolve({ id: "p1" }),
      searchParams: Promise.resolve(query),
    }),
  );
  const part = tree.find((e) => (e.type as { name?: string }).name === "Tasks");
  if (!part) throw new Error("no Tasks");
  const rendered = await (part.type as (p: unknown) => Promise<unknown>)(part.props);
  const list = elements(rendered).find((e) => e.type === LiveTaskList);
  if (!list) throw new Error("no list");
  return list;
}
const wrap = (list: Element) =>
  h(I18nProvider as unknown as FC<{ locale: "ja" }>, { locale: "ja" }, list as never);
const rowIds = (root: ParentNode) =>
  [...root.querySelectorAll('[data-testid^="task-row-"]')].map((e) =>
    e.getAttribute("data-testid")?.replace("task-row-", ""),
  );

async function serverThenHydrate(query: Record<string, string | string[]>) {
  const list = await listFor(query);
  const html = renderToString(wrap(list));
  const server = document.createElement("div");
  server.innerHTML = html;
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(container, wrap(list));
  });
  return { server, container, errors, unmount: () => act(() => root?.unmount()) };
}

describe("URL の絞り込みで、サーバーが描いた画面とハイドレーションが食い違わない", () => {
  it("URL の絞り込みの行と欄の値を、サーバーの HTML から出し、ハイドレーションの後も同じで、警告が出ない", async () => {
    const { server, container, errors, unmount } = await serverThenHydrate({
      q: "決済",
      start: "github_issue",
      repo: "web",
      status: "all",
    });
    expect(rowIds(server)).toEqual(["b"]);
    expect(
      server.querySelector<HTMLSelectElement>('select option[value="github_issue"]'),
    ).not.toBeNull();
    expect(rowIds(container)).toEqual(["b"]);
    const count = (root: ParentNode) =>
      root.querySelector('[data-testid="task-filter-count"]')?.textContent;
    expect(count(server)).toBe("3件中 1件");
    expect(count(container)).toBe(count(server));
    expect(container.querySelectorAll("select")[0]?.value).toBe("github_issue");
    expect(container.querySelectorAll("select")[2]?.value).toBe("");
    expect(errors).not.toHaveBeenCalled();
    unmount();
  });

  it("クエリが無ければ最初の表示（終わっていない）で描く", async () => {
    const { server, container, errors, unmount } = await serverThenHydrate({});
    expect(rowIds(server)).toEqual(["a", "b", "c"]);
    expect(container.querySelectorAll("select")[2]?.value).toBe("active");
    expect(errors).not.toHaveBeenCalled();
    unmount();
  });

  it("開始時期が URL にあるときは、サーバーでは表の所を読み込み中にし、描き直しの後に、ブラウザーの日で合う行を出す", async () => {
    const { server, container, errors, unmount } = await serverThenHydrate({
      from: "2026-11-01",
      to: "2026-11-10",
    });
    expect(rowIds(server)).toEqual([]);
    expect(server.textContent).toContain("読み込み中…");
    expect(rowIds(container)).toEqual(["a", "b"]);
    expect(container.textContent).not.toContain("読み込み中…");
    expect(container.querySelector('[data-testid="task-filter-count"]')?.textContent).toBe(
      "3件中 2件",
    );
    expect(errors).not.toHaveBeenCalled();
    unmount();
  });

  it("別の絞り込みの一覧が先に見えない（知らない値の指定は、サーバーでも指定なしとして描く）", async () => {
    const { server, errors, unmount } = await serverThenHydrate({
      status: "foo",
      from: "2026-13-40",
      q: ["x", "y"],
    });
    expect(rowIds(server)).toEqual(["a", "b", "c"]);
    expect(errors).not.toHaveBeenCalled();
    unmount();
  });
});
