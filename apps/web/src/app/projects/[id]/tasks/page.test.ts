import { createElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const { DaemonUnavailableError } = vi.hoisted(() => ({
  DaemonUnavailableError: class extends Error {},
}));
const listProjects = vi.fn();
const listProjectRepositories = vi.fn();
const listTasks = vi.fn();
vi.mock("@/lib/daemon", () => ({
  DaemonUnavailableError,
  listProjects,
  listProjectRepositories,
  listTasks,
  getStatus: async () => ({ problems: [] }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/app/actions", () => ({ createTaskAction: async () => ({}) }));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "p1",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));
const params = Promise.resolve({ id: "p1" });

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
  listTasks.mockReset();
  listTasks.mockResolvedValue([]);
  // Org の対象は gh で GitHub に問い合わせる（遅いことがある）
  listProjectRepositories.mockResolvedValue({ repositories: ["acme/api"], errors: [] });
});

describe("タスクの一覧の「タスクを作成」ボタン（PBI-109）", () => {
  it("プロジェクトを読む前（Suspense の待ち）も、同じ大きさの押せないボタンを出す（何も出さないと、後から出てずれる）", async () => {
    const tree = elements(await TasksPage({ params }));
    const suspense = tree.find(
      (e) =>
        e.type === Suspense &&
        elements(e.props.children).some((c) => (c.type as { name?: string }).name === "NewTaskFor"),
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
    const element = (await NewTask({ projectId: "p1" })) as Element;
    expect(element.type).toBe(NewTaskDialog);
    expect(element.props).toEqual({ projectId: "p1", projectName: "決済", hasTargets: true });
    expect(listProjectRepositories).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(element as never);
    expect(html).toContain(t.create);
    expect(html).not.toContain(' disabled=""');
  });

  it("画面の自動の更新（描き直し）を何度くり返しても、リポジトリの候補を問い合わせない", async () => {
    for (let i = 0; i < 5; i++) await NewTask({ projectId: "p1" });
    await TasksPage({ params });
    expect(listProjects).toHaveBeenCalledTimes(5);
    expect(listProjectRepositories).not.toHaveBeenCalled();
  });

  it("表示しているプロジェクトが無い・デーモンにつながらないときは、今と同じくボタンを出さない", async () => {
    listProjects.mockResolvedValue([]);
    expect(await NewTask({ projectId: "p1" })).toBeNull();
    listProjects.mockRejectedValue(new Error("unreachable"));
    expect(await NewTask({ projectId: "p1" })).toBeNull();
  });
});

const { FollowProject } = await import("@/components/shell/follow-project");
const { LiveTaskList } = await import("@/components/task-list");

/** 一覧のページの、名前 name の部品（Suspense の中）を、URL のプロジェクト id で描く。 */
async function part(name: string, id: string): Promise<unknown> {
  const tree = elements(await TasksPage({ params: Promise.resolve({ id }) }));
  const el = tree.find((e) => (e.type as { name?: string }).name === name);
  if (!el) throw new Error(`no ${name}`);
  return (el.type as (props: unknown) => Promise<unknown>)(el.props);
}

describe("プロジェクトのタスクの一覧の URL（PBI-114）", () => {
  const other = { ...orgProject, id: "p2", name: "Webサイト" };
  const task = (id: string, projectId: string) => ({
    id,
    projectId,
    title: id,
    start: "sacty",
    status: "queued",
    steps: [],
    proposals: [],
    budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
    updatedAt: "",
  });

  beforeEach(() => {
    listProjects.mockResolvedValue([orgProject, other]);
    listTasks.mockResolvedValue([task("a", "p1"), task("b", "p2")]);
  });

  it("表示するプロジェクトは URL の ID で決める（cookie のプロジェクトではない）。cookie を URL に合わせる", async () => {
    // cookie は p1、URL は p2
    const tree = elements(await part("Tasks", "p2"));
    const list = tree.find((e) => e.type === LiveTaskList);
    expect(list?.props.projectId).toBe("p2");
    const initial = list?.props.initial as { projectId: string; rows: { id: string }[] };
    expect(initial.projectId).toBe("p2");
    expect(initial.rows.map((r) => r.id)).toEqual(["b"]);
    // ヘッダーの選択（cookie）を URL のプロジェクトに合わせる
    expect(tree.find((e) => e.type === FollowProject)?.props.projectId).toBe("p2");
    // プロジェクトの名前と作成先も URL のプロジェクト
    expect(renderToStaticMarkup((await part("ProjectName", "p2")) as never)).toContain("Webサイト");
    const button = (await part("NewTaskFor", "p2")) as Element;
    expect(
      ((await (button.type as (p: unknown) => Promise<unknown>)(button.props)) as Element).props,
    ).toMatchObject({ projectId: "p2", projectName: "Webサイト" });
  });

  it("存在しないプロジェクトの ID なら 404", async () => {
    await expect(part("Tasks", "gone")).rejects.toThrow("notFound");
    expect(await part("ProjectName", "gone")).toBeNull();
    expect(await NewTask({ projectId: "gone" })).toBeNull();
  });

  it("デーモンに届かないときは、届かないことを出し、URL のプロジェクトを取り直す", async () => {
    listTasks.mockRejectedValue(new DaemonUnavailableError("デーモンに届きません"));
    const list = (await part("Tasks", "p2")) as Element;
    expect(list.type).toBe(LiveTaskList);
    expect(list.props).toMatchObject({
      projectId: "p2",
      initial: null,
      error: "デーモンに届きません",
    });
  });
});
