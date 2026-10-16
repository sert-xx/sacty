// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/app/actions", () => ({ setLanguageAction: vi.fn(async () => {}) }));

const { I18nProvider } = await import("@/i18n/client");
const { RailNav } = await import("./rail");
const { HeaderFallback } = await import("./header");
const { NotificationsMenu, ProjectMenu } = await import("./menus");
const { LiveHeaderMenus, selectedProject } = await import("./live-header");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(node: ReactNode) {
  act(() => {
    root.render(h(I18nProvider as unknown as FC<{ locale: "ja" }>, { locale: "ja" }, node));
  });
}

// サイドメニューの名称の、折り返す位置の幅の無い空白は除いて比べる
const label = (a: Element) => a.textContent?.replace(/\u200b/g, "").trim();
const hrefs = () =>
  [...document.querySelectorAll("a")].map((a) => [label(a), a.getAttribute("href")]);
const current = () => [...container.querySelectorAll('nav a[aria-current="page"]')].map(label);

describe("サイドメニューのリンクと強調（PBI-114）", () => {
  it("プロジェクトの画面では、ダッシュボード・表示しているプロジェクトのタスクの一覧・設定へ移る", () => {
    for (const p of [
      "/projects/p1/tasks",
      "/projects/p1/settings",
      "/tasks/t1",
      "/tasks/t1/runs/r1",
    ]) {
      render(h(RailNav, { pathname: p }));
      expect(hrefs(), p).toEqual([
        ["ダッシュボード", "/dashboard"],
        ["タスク", "/projects/current/tasks"],
        ["設定", "/projects/current"],
      ]);
    }
  });

  it("「すべてのプロジェクト」の画面では、タスクを出さず、設定はプロジェクトの一覧へ移る（どのプロジェクトにも飛ばない）", () => {
    for (const p of ["/dashboard", "/projects", "/settings"]) {
      render(h(RailNav, { pathname: p }));
      expect(hrefs(), p).toEqual([
        ["ダッシュボード", "/dashboard"],
        ["設定", "/projects"],
      ]);
    }
  });

  it.each([
    ["/dashboard", "ダッシュボード"],
    ["/projects/p1/tasks", "タスク"],
    ["/tasks/t1", "タスク"],
    ["/tasks/t1/review", "タスク"],
    ["/projects/p1/settings", "設定"],
    ["/projects", "設定"],
  ])("%s では「%s」を強調する", (pathname, label) => {
    render(h(RailNav, { pathname }));
    expect(current()).toEqual([label]);
  });

  it("タスクという名前のプロジェクトの設定は、設定を強調する（ID の部分で見分けない）", () => {
    render(h(RailNav, { pathname: "/projects/tasks/settings" }));
    expect(current()).toEqual(["設定"]);
  });
});

describe("ヘッダーのリンク（PBI-114）", () => {
  it("ロゴはダッシュボードへ移る", () => {
    render(HeaderFallback({ language: "ja" }));
    expect(container.querySelector("header a")?.getAttribute("href")).toBe("/dashboard");
  });

  it("プロジェクトの切り替えは、先頭の「すべてのプロジェクト」がダッシュボードへ、個別のプロジェクトがそのタスクの一覧へ移る", () => {
    const projects = [
      { id: "p1", name: "決済", needsYou: 0 },
      { id: "p 2", name: "Webサイト", needsYou: 1 },
    ];
    render(h(ProjectMenu, { projects, current: projects[0] as (typeof projects)[0] }));
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    const links = hrefs();
    expect(links[0]).toEqual(["すべてのプロジェクト", "/dashboard"]);
    expect(links).toContainEqual(["決済", "/switch?project=p1&to=%2Fprojects%2Fp1%2Ftasks"]);
    expect(links).toContainEqual([
      "Webサイト対応待ち 1",
      "/switch?project=p%202&to=%2Fprojects%2Fp%25202%2Ftasks",
    ]);
    expect(links).toContainEqual(["プロジェクトを管理する", "/projects"]);
  });

  it("お知らせは、そのプロジェクトに切り替えてからタスクを開く", () => {
    const notice = {
      taskId: "t1",
      title: "承認待ち",
      projectId: "p2",
      projectName: "Webサイト",
      status: "要求要件の承認待ち",
      href: "/tasks/t1/review",
    };
    render(h(NotificationsMenu, { others: [notice], here: [], currentName: "決済" }));
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(document.querySelector('a[href^="/switch"]')?.getAttribute("href")).toBe(
      "/switch?project=p2&to=%2Ftasks%2Ft1%2Freview",
    );
  });
});

describe("ヘッダーの切り替えの、画面ごとの選んだ表示（PBI-114）", () => {
  const data = {
    projects: [
      { id: "p1", name: "決済", needsYou: 1 },
      { id: "p 2", name: "Webサイト", needsYou: 2 },
    ],
    // 表示しているプロジェクト（cookie）
    current: { id: "p1", name: "決済", needsYou: 1 },
    notices: [
      {
        taskId: "t1",
        title: "決済の承認待ち",
        projectId: "p1",
        projectName: "決済",
        status: "要求要件の承認待ち",
        href: "/tasks/t1/review",
      },
      {
        taskId: "t2",
        title: "Webサイトの承認待ち",
        projectId: "p 2",
        projectName: "Webサイト",
        status: "設計の承認待ち",
        href: "/tasks/t2/review",
      },
    ],
  };

  it.each([
    ["/dashboard", null],
    ["/projects", null],
    ["/settings", null],
    // URL のプロジェクト（cookie の p1 ではない）
    ["/projects/p%202/tasks", "p 2"],
    ["/projects/p%202/settings", "p 2"],
    // タスクの詳細・レビュー・実行のログは、画面が合わせた表示しているプロジェクト
    ["/tasks/t1", "p1"],
    ["/tasks/t1/review", "p1"],
    ["/tasks/t1/runs/r1", "p1"],
    // 無いプロジェクトの画面（404）は、どのプロジェクトも選ばない
    ["/projects/gone/tasks", null],
  ])("%s では %s を選んだ表示にする", (path, id) => {
    expect(selectedProject(data, path)?.id ?? null).toBe(id);
  });

  it("ダッシュボードでは「すべてのプロジェクト」を選んだ表示で、件数はすべての合計。お知らせは分けずに出す", () => {
    pathname = "/dashboard";
    render(h(LiveHeaderMenus, { initial: data, language: "ja" }));
    const trigger = container.querySelector('[data-testid="project-menu"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain("すべてのプロジェクト");
    expect(trigger.textContent).toContain("3");
    act(() => trigger.click());
    expect(document.querySelector('[aria-current="true"]')?.textContent).toBe(
      "すべてのプロジェクト",
    );
  });

  it("「すべてのプロジェクト」の間のお知らせは、分けずにすべて出し、どれもそのタスクのプロジェクトに切り替えて開く", () => {
    pathname = "/dashboard";
    render(h(LiveHeaderMenus, { initial: data, language: "ja" }));
    const bell = container.querySelector('button[aria-label^="お知らせ"]') as HTMLButtonElement;
    act(() => bell.click());
    const popup = document.body.textContent ?? "";
    expect(popup).not.toContain("ほかのプロジェクト");
    expect(popup).not.toContain("このプロジェクト");
    expect(
      [...document.querySelectorAll('a[href^="/switch"]')].map((a) => a.getAttribute("href")),
    ).toEqual([
      "/switch?project=p1&to=%2Ftasks%2Ft1%2Freview",
      "/switch?project=p%202&to=%2Ftasks%2Ft2%2Freview",
    ]);
  });

  it("プロジェクトの画面では、URL のプロジェクトを選んだ表示にし、お知らせはそのプロジェクトとほかに分ける", () => {
    pathname = "/projects/p%202/tasks";
    render(h(LiveHeaderMenus, { initial: data, language: "ja" }));
    const trigger = container.querySelector('[data-testid="project-menu"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain("Webサイト");
    act(() => trigger.click());
    expect(document.querySelector('[aria-current="true"]')?.textContent).toContain("Webサイト");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const bell = container.querySelector('button[aria-label^="お知らせ"]') as HTMLButtonElement;
    act(() => bell.click());
    expect(document.body.textContent).toContain("このプロジェクト（Webサイト）");
  });
});
