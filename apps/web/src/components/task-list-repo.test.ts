// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { type FC, createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { repoNameOf } from "@/lib/repo-name";
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

const task = (patch: Partial<Task>) => patch as Task;

describe("タスクの一覧のリポジトリ名（PBI-141）", () => {
  it("作業するリポジトリの名前は repo だけ。選んだリポジトリ → 取り込み元 → 準備したリポジトリの順に決める", () => {
    expect(repoNameOf(task({ repo: "https://github.com/acme/web" }))).toEqual({ repoName: "web" });
    expect(
      repoNameOf(task({ source: { repo: "https://github.com/acme/api", number: 7 } as never })),
    ).toEqual({ repoName: "api" });
    expect(
      repoNameOf(task({ repository: { url: "https://ghe.example.com/corp/tools.git" } as never })),
    ).toEqual({ repoName: "tools" });
    // 選んだリポジトリ（子タスク・チケット・後から決めたもの）を、取り込み元より優先する
    expect(
      repoNameOf(
        task({
          repo: "https://github.com/acme/web",
          source: { repo: "https://github.com/acme/api", number: 7 } as never,
        }),
      ),
    ).toEqual({ repoName: "web" });
    // まだ決まっていなければ出さない
    expect(repoNameOf(task({}))).toEqual({});
  });

  it("一覧の各行で、題の下にリポジトリ名（repo だけ）を出し、取り込み元は番号だけを出す", () => {
    const row = (patch: Partial<TaskRow>): TaskRow => ({
      id: "t1",
      title: "題",
      child: false,
      depth: 0,
      start: "sacty",
      repoless: false,
      steps: [],
      status: { text: "実行待ち", tone: "waiting" },
      createdAt: "2026-10-01T12:00:00.000Z",
      ...patch,
    });
    const data: TaskListData = {
      projectId: "p1",
      needsYou: [],
      rows: [
        row({ id: "t1", title: "ログインを直す", repoName: "web" }),
        row({
          id: "t2",
          title: "取り込んだ Issue",
          start: "github_issue",
          source: { repo: "https://github.com/acme/api", number: 7 },
          repoName: "api",
        }),
        row({ id: "t3", title: "リポジトリなし", repoless: true }),
      ],
    };
    const div = document.createElement("div");
    div.innerHTML = renderToStaticMarkup(
      h(
        I18nProvider as unknown as FC<{ locale: "ja" }>,
        { locale: "ja" },
        h(LiveTaskList, { projectId: "p1", initial: data, initialVersion: liveVersion(data) }),
      ),
    );
    const cell = (id: string) => div.querySelector(`[data-testid="task-row-${id}"] td`);
    expect(cell("t1")?.querySelector('[data-testid="task-repo-t1"]')?.textContent).toBe("web");
    expect(cell("t2")?.querySelector('[data-testid="task-repo-t2"]')?.textContent).toBe("api");
    expect(div.querySelector('[data-testid="task-repo-t3"]')).toBeNull();
    const t2 = div.querySelector('[data-testid="task-row-t2"]')?.textContent ?? "";
    expect(t2).toContain("#7");
    expect(t2).not.toContain("acme/api");
    expect(div.textContent).not.toContain("https://github.com");
  });
  it("子タスクは親の下に字下げし、分割の子のレビューの子はもう一段深く字下げする（PBI-341）", () => {
    const row = (patch: Partial<TaskRow>): TaskRow => ({
      id: "t1",
      title: "題",
      child: false,
      depth: 0,
      start: "sacty",
      repoless: false,
      steps: [],
      status: { text: "実行待ち", tone: "waiting" },
      createdAt: "2026-10-01T12:00:00.000Z",
      ...patch,
    });
    const data: TaskListData = {
      projectId: "p1",
      needsYou: [],
      rows: [
        row({ id: "p", title: "親" }),
        row({ id: "a", title: "分割の子", child: true, depth: 1, parentId: "p" }),
        row({ id: "r", title: "[PR #2] 分割の子のレビュー", child: true, depth: 2, parentId: "a" }),
        // 親が別のプロジェクトにある（一覧に無い）子は字下げしない
        row({ id: "o", title: "親の無いレビュー", child: true, depth: 0, parentId: "x" }),
      ],
    };
    const div = document.createElement("div");
    div.innerHTML = renderToStaticMarkup(
      h(
        I18nProvider as unknown as FC<{ locale: "ja" }>,
        { locale: "ja" },
        h(LiveTaskList, { projectId: "p1", initial: data, initialVersion: liveVersion(data) }),
      ),
    );
    const cell = (id: string) => div.querySelector(`[data-testid="task-row-${id}"] td`);
    expect(cell("p")?.className).not.toContain("pl-");
    expect(cell("a")?.className).toContain("pl-10");
    expect(cell("r")?.className).toContain("pl-16");
    expect(cell("r")?.textContent).toContain("↳");
    // 字下げは読み上げられないので、読み上げ用の文で親を伝える
    expect(cell("r")?.querySelector(".sr-only")?.textContent).toBe("（分割の子 の子タスク）");
    expect(cell("p")?.querySelector(".sr-only")).toBeNull();
    expect(cell("o")?.className).not.toContain("pl-");
    expect(cell("o")?.textContent).not.toContain("↳");
    expect(cell("o")?.querySelector(".sr-only")).toBeNull();
  });
});
