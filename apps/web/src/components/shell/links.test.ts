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
  it("プロジェクトの画面では、表示しているプロジェクトのタスクの一覧・監査・設定へ移る（ダッシュボードは出さない。PBI-141）", () => {
    for (const p of [
      "/projects/p1/tasks",
      "/projects/p1/settings",
      "/projects/p1/audit",
      "/projects/p1/schedules",
      "/projects/p1/schedules/s1",
      "/tasks/t1",
      "/tasks/t1/runs/r1",
    ]) {
      render(h(RailNav, { pathname: p }));
      expect(hrefs(), p).toEqual([
        ["タスク", "/projects/current/tasks"],
        ["スケジュール", "/projects/current/schedules"],
        ["監査", "/projects/current/audit"],
        ["プロジェクトの設定", "/projects/current"],
        ["Sacty の設定", "/settings"],
      ]);
    }
  });

  it("「すべてのプロジェクト」の画面では、タスク・監査を出さず、設定はプロジェクトの一覧へ移る（どのプロジェクトにも飛ばない。ダッシュボードは出さない）", () => {
    for (const p of ["/dashboard", "/projects", "/settings"]) {
      render(h(RailNav, { pathname: p }));
      expect(hrefs(), p).toEqual([
        ["プロジェクト", "/projects"],
        ["Sacty の設定", "/settings"],
      ]);
    }
  });

  it("ダッシュボードの画面では、サイドメニューのどれも強調しない（PBI-141）", () => {
    for (const pathname of ["/dashboard", "/"]) {
      render(h(RailNav, { pathname }));
      expect(current(), pathname).toEqual([]);
    }
  });

  it.each([
    ["/projects/p1/tasks", "タスク"],
    ["/tasks/t1", "タスク"],
    ["/tasks/t1/review", "タスク"],
    ["/projects/p1/settings", "プロジェクトの設定"],
    ["/projects", "プロジェクト"],
    ["/settings", "Sacty の設定"],
    ["/projects/p1/audit", "監査"],
    ["/projects/p1/schedules", "スケジュール"],
    ["/projects/p1/schedules/s1", "スケジュール"],
  ])("%s では「%s」だけを強調する", (pathname, label) => {
    render(h(RailNav, { pathname }));
    expect(current()).toEqual([label]);
  });

  it("狭いサイドメニューの名称は、幅の無い空白の所でだけ折り返す", () => {
    render(h(RailNav, { pathname: "/projects/p1/tasks" }));
    const name = container.querySelector(
      'nav a[href="/projects/current/tasks"] span',
    ) as HTMLElement;
    expect(name.className).toContain("[word-break:keep-all]");
    expect(container.querySelector('nav a[href="/dashboard"]')).toBeNull();
  });

  it("英語の画面では、プロジェクトの画面の 5 項目と、すべてのプロジェクトの画面の 2 項目を呼び分ける", () => {
    const en = (node: ReactNode) =>
      act(() => {
        root.render(h(I18nProvider as unknown as FC<{ locale: "en" }>, { locale: "en" }, node));
      });
    en(h(RailNav, { pathname: "/projects/p1/tasks" }));
    expect(hrefs()).toEqual([
      ["Tasks", "/projects/current/tasks"],
      ["Schedules", "/projects/current/schedules"],
      ["Audit", "/projects/current/audit"],
      ["Project settings", "/projects/current"],
      ["Sacty settings", "/settings"],
    ]);
    en(h(RailNav, { pathname: "/dashboard" }));
    expect(hrefs()).toEqual([
      ["Projects", "/projects"],
      ["Sacty settings", "/settings"],
    ]);
  });

  it("/settings では「Sacty の設定」だけを強調し、「プロジェクト」は強調しない", () => {
    render(h(RailNav, { pathname: "/settings" }));
    expect(current()).toEqual(["Sacty の設定"]);
    const projects = container.querySelector('nav a[href="/projects"]');
    expect(projects?.hasAttribute("aria-current")).toBe(false);
  });

  it("/projects/p1/settings では「Sacty の設定」を強調しない", () => {
    render(h(RailNav, { pathname: "/projects/p1/settings" }));
    const sacty = container.querySelector('nav a[href="/settings"]');
    expect(sacty?.hasAttribute("aria-current")).toBe(false);
  });

  it("タスクという名前のプロジェクトの設定は、設定を強調する（ID の部分で見分けない）", () => {
    render(h(RailNav, { pathname: "/projects/tasks/settings" }));
    expect(current()).toEqual(["プロジェクトの設定"]);
    render(h(RailNav, { pathname: "/projects/audit/settings" }));
    expect(current()).toEqual(["プロジェクトの設定"]);
    render(h(RailNav, { pathname: "/projects/schedules/settings" }));
    expect(current()).toEqual(["プロジェクトの設定"]);
  });
});

describe("ヘッダーのリンク（PBI-114）", () => {
  it("ロゴはダッシュボードへ移る", () => {
    render(HeaderFallback({ language: "ja" }));
    expect(container.querySelector("header a")?.getAttribute("href")).toBe("/dashboard");
  });

  it("人のアイコンのメニューにも、「Sacty の設定」（/settings）が残っている", () => {
    render(HeaderFallback({ language: "ja" }));
    act(() => (container.querySelector("header button[aria-label]") as HTMLButtonElement).click());
    expect(hrefs()).toContainEqual(["Sacty の設定", "/settings"]);
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
      group: "decision" as const,
      waitingSince: "2026-11-01T00:00:00.000Z",
      href: "/tasks/t1/review",
    };
    render(h(NotificationsMenu, { notices: [notice] }));
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
        group: "decision" as const,
        waitingSince: "2026-11-01T00:00:00.000Z",
        href: "/tasks/t1/review",
      },
      {
        taskId: "t2",
        title: "Webサイトの承認待ち",
        projectId: "p 2",
        projectName: "Webサイト",
        status: "設計の承認待ち",
        group: "decision" as const,
        waitingSince: "2026-11-01T00:00:00.000Z",
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

  it("プロジェクトの画面では、URL のプロジェクトを選んだ表示にし、お知らせは「すべてのプロジェクト」の画面と同じ並びで、プロジェクトでは分けない", () => {
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
});

describe("ヘッダーのお知らせ：種類の 2 つの組と、待っている時間（PBI-442）", () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const notice = (
    taskId: string,
    group: "decision" | "paused",
    minutes: number,
    projectId = "p1",
  ) => ({
    taskId,
    title: `題 ${taskId}`,
    projectId,
    projectName: projectId === "p1" ? "決済" : "Webサイト",
    status: group === "decision" ? "要求要件の承認待ち" : "一時停止中",
    group,
    waitingSince: ago(minutes),
    href: `/tasks/${taskId}/review`,
  });
  // データの順が、ダッシュボードと同じ並び（上の組 → 下の組。組の中は古い順）
  const notices = [
    notice("d1", "decision", 3 * 24 * 60),
    notice("d2", "decision", 125, "p2"),
    notice("p1", "paused", 600),
    notice("p2", "paused", 45, "p2"),
  ];
  const data = {
    projects: [
      { id: "p1", name: "決済", needsYou: 2 },
      { id: "p2", name: "Webサイト", needsYou: 2 },
    ],
    current: { id: "p1", name: "決済", needsYou: 2 },
    notices,
  };

  it.each([
    ["すべてのプロジェクト", "/dashboard"],
    ["プロジェクトを選んだ画面", "/projects/p2/tasks"],
  ])(
    "%s でも、組の見出しの下に同じ順で行が出て、各行に待っている時間が出る。プロジェクトの組分けは出ない",
    (_name, path) => {
      pathname = path;
      render(h(LiveHeaderMenus, { initial: data, language: "ja" }));
      act(() =>
        (container.querySelector('button[aria-label^="お知らせ"]') as HTMLButtonElement).click(),
      );
      const groups = [...document.querySelectorAll('[data-testid^="notices-"]')];
      expect(groups.map((g) => g.getAttribute("data-testid"))).toEqual([
        "notices-decision",
        "notices-paused",
      ]);
      expect(groups[0]?.textContent).toContain("判断で進むタスク");
      expect(groups[1]?.textContent).toContain("再開を待つタスク");
      expect(
        [...document.querySelectorAll('[data-testid^="notice-waiting-"]')].map((e) => [
          e.getAttribute("data-testid"),
          e.textContent,
        ]),
      ).toEqual([
        ["notice-waiting-d1", "待っている時間：3日"],
        ["notice-waiting-d2", "待っている時間：2時間"],
        ["notice-waiting-p1", "待っている時間：10時間"],
        ["notice-waiting-p2", "待っている時間：45分"],
      ]);
      const popup = document.body.textContent ?? "";
      expect(popup).not.toContain("ほかのプロジェクト");
      expect(popup).not.toContain("このプロジェクト");
    },
  );

  it("0 件のときは件数を出さず、空の文を出す。片方の組だけのとき、もう片方の見出しは出ない", () => {
    pathname = "/dashboard";
    render(h(LiveHeaderMenus, { initial: { ...data, notices: [] }, language: "ja" }));
    const bell = container.querySelector('button[aria-label^="お知らせ"]') as HTMLButtonElement;
    expect(bell.getAttribute("aria-label")).toBe("お知らせ");
    act(() => bell.click());
    expect(document.body.textContent).toContain("対応待ちはありません。");
    expect(document.querySelector('[data-testid^="notices-"]')).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    act(() => root.unmount());
    root = createRoot(container);
    render(
      h(LiveHeaderMenus, {
        initial: { ...data, notices: notices.filter((n) => n.group === "paused") },
        language: "ja",
      }),
    );
    act(() =>
      (container.querySelector('button[aria-label^="お知らせ"]') as HTMLButtonElement).click(),
    );
    expect(document.querySelector('[data-testid="notices-decision"]')).toBeNull();
    expect(document.querySelector('[data-testid="notices-paused"]')).not.toBeNull();
  });
});
