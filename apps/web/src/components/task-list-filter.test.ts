// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE, EMPTY_FILTER, filterOptions, matchesFilter, NO_REPO } from "@/lib/task-filter";
import type { TaskListData, TaskRow } from "@/lib/task-list-data";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/p1/tasks",
}));
vi.mock("@/app/actions", () => {
  const action = vi.fn(async () => ({}));
  return { createTaskAction: action, followProjectAction: action, setLanguageAction: action };
});

const { I18nProvider } = await import("@/i18n/client");
const { LiveTaskList } = await import("./task-list");
const { liveVersion } = await import("@/lib/live-server");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (patch: Partial<TaskRow>): TaskRow => ({
  id: "t1",
  title: "題",
  child: false,
  start: "sacty",
  repoless: false,
  steps: [],
  status: { text: "実行待ち", tone: "waiting" },
  // 画面のタイムゾーンで日がずれないよう、日の真ん中にする
  createdAt: "2026-10-01T12:00:00",
  ...patch,
});

const rows: TaskRow[] = [
  row({ id: "a", title: "ログインを直す", repoName: "web", createdAt: "2026-09-10T12:00:00" }),
  row({
    id: "b",
    title: "取り込んだ Issue",
    start: "github_issue",
    repoName: "api",
    status: { text: "完了", tone: "completed" },
    createdAt: "2026-10-01T12:00:00",
  }),
  row({
    id: "c",
    title: "Login の文書",
    repoless: true,
    status: { text: "要求要件の承認待ち", tone: "person" },
    createdAt: "2026-10-20T12:00:00",
  }),
];

const ids = (filter: Partial<typeof EMPTY_FILTER>) =>
  rows.filter((r) => matchesFilter(r, { ...EMPTY_FILTER, ...filter })).map((r) => r.id);

describe("タスクの一覧の絞り込み", () => {
  it("条件が空なら、すべてを出す", () => {
    expect(ids({})).toEqual(["a", "b", "c"]);
  });

  it("題の検索は、大文字と小文字を区別しない", () => {
    expect(ids({ query: "login" })).toEqual(["c"]);
    expect(ids({ query: " ログイン " })).toEqual(["a"]);
  });

  it("開始時期は、作った日で絞り込み、両端の日を含む", () => {
    expect(ids({ from: "2026-10-01" })).toEqual(["b", "c"]);
    expect(ids({ to: "2026-10-01" })).toEqual(["a", "b"]);
    expect(ids({ from: "2026-10-01", to: "2026-10-01" })).toEqual(["b"]);
  });

  it("開始地点・リポジトリ・状態で絞り込む。リポジトリが決まっていないタスクも選べる", () => {
    expect(ids({ start: "github_issue" })).toEqual(["b"]);
    expect(ids({ repo: "web" })).toEqual(["a"]);
    expect(ids({ repo: NO_REPO })).toEqual(["c"]);
    expect(ids({ status: "person" })).toEqual(["c"]);
    expect(ids({ status: ACTIVE })).toEqual(["a", "c"]);
    expect(ids({ repo: "web", status: "completed" })).toEqual([]);
  });

  it("選択肢は、一覧にある開始地点とリポジトリだけ（リポジトリは名前の順、決まっていないものは最後）", () => {
    expect(filterOptions(rows)).toEqual({
      starts: ["sacty", "github_issue"],
      repos: ["api", "web", NO_REPO],
    });
    expect(filterOptions([rows[0]]).repos).toEqual(["web"]);
  });
});

describe("タスクの一覧の絞り込みの操作", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    // 取り直しは、このテストでは返さない（絞り込みだけを確かめる）
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (data: TaskListData) =>
    act(() =>
      root.render(
        h(
          I18nProvider as unknown as FC<{ locale: "ja"; children: ReactNode }>,
          { locale: "ja" },
          h(LiveTaskList, { projectId: "p1", initial: data, initialVersion: liveVersion(data) }),
        ),
      ),
    );
  const shown = () =>
    [...container.querySelectorAll('[data-testid^="task-row-"]')].map((e) =>
      e.getAttribute("data-testid")?.replace("task-row-", ""),
    );
  /** React の制御された入力に、利用者が入力したように値を入れる。 */
  const change = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
    act(() => {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(
        new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
      );
    });
  const select = (label: string) =>
    [...container.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith(label))
      ?.querySelector("select") as HTMLSelectElement;

  it("条件を変えると行を絞り込み、件数を出し、クリアで戻す", () => {
    render({ projectId: "p1", needsYou: [], rows });
    const bar = container.querySelector('[data-testid="task-filter"]');
    expect(bar).not.toBeNull();
    expect(shown()).toEqual(["a", "b", "c"]);
    expect(container.querySelector('[data-testid="task-filter-count"]')?.textContent).toBe(
      "3件中 3件",
    );

    change(select("リポジトリ"), "web");
    expect(shown()).toEqual(["a"]);
    change(select("リポジトリ"), "");
    change(select("状態"), ACTIVE);
    expect(shown()).toEqual(["a", "c"]);
    change(container.querySelector('input[type="date"]') as HTMLInputElement, "2026-10-01");
    expect(shown()).toEqual(["c"]);
    expect(container.querySelector('[data-testid="task-filter-count"]')?.textContent).toBe(
      "3件中 1件",
    );
    change(container.querySelector('input[type="search"]') as HTMLInputElement, "見つからない");
    expect(shown()).toEqual([]);
    expect(container.textContent).toContain("条件に合うタスクはありません。");

    const clear = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "条件をクリア",
    );
    act(() => clear?.click());
    expect(shown()).toEqual(["a", "b", "c"]);
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent === "条件をクリア"),
    ).toBe(false);
  });

  it("タスクが無いときは、絞り込みを出さない", () => {
    render({ projectId: "p1", needsYou: [], rows: [] });
    expect(container.querySelector('[data-testid="task-filter"]')).toBeNull();
    expect(container.textContent).toContain("タスクはまだありません。");
  });
});
