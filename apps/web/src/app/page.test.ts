import { createElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const listProjects = vi.fn();
const listProjectRepositories = vi.fn();
vi.mock("@/lib/daemon", () => ({
  DaemonUnavailableError: class extends Error {},
  listProjects,
  listProjectRepositories,
  listTasks: async () => [],
  getStatus: async () => ({ problems: [] }),
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/app/actions", () => ({ createTaskAction: async () => ({}) }));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "p1",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));

const { default: TasksPage } = await import("./page");
const { NewTask, NewTaskPlaceholder } = await import("@/components/new-task");
const { NewTaskDialog } = await import("@/components/new-task-dialog");

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children)];
}

const t = messagesFor("ja").forms.task;
const orgProject = {
  id: "p1",
  name: "決済",
  targets: [{ kind: "org", owner: "acme" }],
  createdAt: "",
  updatedAt: "",
};

beforeEach(() => {
  listProjects.mockReset();
  listProjectRepositories.mockReset();
  listProjects.mockResolvedValue([orgProject]);
  // Org の対象は gh で GitHub に問い合わせる（遅いことがある）
  listProjectRepositories.mockResolvedValue({ repositories: ["acme/api"], errors: [] });
});

describe("タスクの一覧の「タスクを作成」ボタン（PBI-109）", () => {
  it("プロジェクトを読む前（Suspense の待ち）も、同じ大きさの押せないボタンを出す（何も出さないと、後から出てずれる）", async () => {
    const tree = elements(await TasksPage());
    const suspense = tree.find(
      (e) => e.type === Suspense && elements(e.props.children).some((c) => c.type === NewTask),
    );
    expect(suspense).toBeDefined();
    const fallback = suspense?.props.fallback as Element;
    expect(fallback?.type).toBe(NewTaskPlaceholder);
    const html = renderToStaticMarkup(fallback as never);
    expect(html).toContain(t.create);
    expect(html).toContain(' disabled=""');
    // ダイアログのボタンと同じ大きさ（size lg の高さ）
    const dialog = renderToStaticMarkup(
      createElement(NewTaskDialog, { projectId: "p1", projectName: "決済", hasTargets: true }),
    );
    const height = (s: string) => s.match(/\bh-9\b/)?.[0];
    expect(height(html)).toBe("h-9");
    expect(height(dialog)).toBe("h-9");
  });

  it("ボタンは、リポジトリの候補の取得を待たずに出す（描画で候補を読まない）", async () => {
    // 候補の取得が終わらなくても、ボタンが出る
    listProjectRepositories.mockReturnValue(new Promise(() => {}));
    const element = (await NewTask()) as Element;
    expect(element.type).toBe(NewTaskDialog);
    expect(element.props).toEqual({ projectId: "p1", projectName: "決済", hasTargets: true });
    expect(listProjectRepositories).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(element as never);
    expect(html).toContain(t.create);
    expect(html).not.toContain(' disabled=""');
  });

  it("画面の自動の更新（描き直し）を何度くり返しても、リポジトリの候補を問い合わせない", async () => {
    for (let i = 0; i < 5; i++) await NewTask();
    await TasksPage();
    expect(listProjects).toHaveBeenCalledTimes(5);
    expect(listProjectRepositories).not.toHaveBeenCalled();
  });

  it("表示しているプロジェクトが無い・デーモンにつながらないときは、今と同じくボタンを出さない", async () => {
    listProjects.mockResolvedValue([]);
    expect(await NewTask()).toBeNull();
    listProjects.mockRejectedValue(new Error("unreachable"));
    expect(await NewTask()).toBeNull();
  });
});
