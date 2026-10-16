import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const { DaemonUnavailableError, loadTaskDetail } = vi.hoisted(() => ({
  DaemonUnavailableError: class extends Error {},
  loadTaskDetail: vi.fn(),
}));
vi.mock("@/lib/daemon", () => ({ DaemonUnavailableError }));
vi.mock("@/lib/task-detail-data", () => ({ loadTaskDetail }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
// ここで確かめるのは、一覧へ戻るリンクだけ
vi.mock("@/components/task-detail", () => ({ LiveTaskDetail: () => null }));
vi.mock("@/components/shell/follow-project", () => ({ FollowProject: () => null }));

const { default: TaskPage } = await import("./page");

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children), ...elements(el.props.fallback)];
}

/** 名前 name の部品（サーバーの部品）を描いた結果の、要素の木。 */
async function render(node: unknown, name: string): Promise<Element[]> {
  const el = elements(node).find((e) => (e.type as { name?: string }).name === name);
  if (!el) throw new Error(`no ${name}`);
  return elements(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
}

/** 一覧へ戻るリンクの href。 */
async function breadcrumb(tree: Element[]): Promise<string | null> {
  const el = tree.find((e) => (e.type as { name?: string }).name === "Breadcrumb");
  if (!el) return null;
  const html = renderToStaticMarkup(
    (await (el.type as (p: unknown) => Promise<unknown>)(el.props)) as never,
  );
  return html.match(/href="([^"]*)"/)?.[1] ?? null;
}

const params = Promise.resolve({ id: "t1" });

beforeEach(() => {
  loadTaskDetail.mockReset();
});

describe("タスクの詳細から一覧へ戻るリンク（PBI-114）", () => {
  it("タスクのプロジェクトのタスクの一覧へ戻る", async () => {
    loadTaskDetail.mockResolvedValue({ task: { id: "t1", projectId: "p 2" } });
    const tree = await render(await TaskPage({ params }), "TaskDetail");
    expect(await breadcrumb(tree)).toBe("/projects/p%202/tasks");
  });

  it("読み込み中・デーモンに届かないときは、表示しているプロジェクトのタスクの一覧へ戻る", async () => {
    const page = await TaskPage({ params });
    expect(await breadcrumb(elements(page))).toBe("/projects/current/tasks");
    loadTaskDetail.mockImplementation(async () => {
      throw new DaemonUnavailableError("down");
    });
    expect(await breadcrumb(await render(page, "TaskDetail"))).toBe("/projects/current/tasks");
  });

  it("タスクが無ければ 404", async () => {
    loadTaskDetail.mockResolvedValue(null);
    await expect(render(await TaskPage({ params }), "TaskDetail")).rejects.toThrow("notFound");
  });
});
