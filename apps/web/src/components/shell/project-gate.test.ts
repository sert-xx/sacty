import { beforeEach, describe, expect, it, vi } from "vitest";

const listProjects = vi.fn();
const listTasks = vi.fn();
vi.mock("@/lib/daemon", () => ({
  listProjects,
  listTasks,
  getStatus: async () => ({ images: [] }),
}));
vi.mock("@/i18n/server", async () => {
  const { messagesFor } = await import("@/i18n");
  return {
    languagePreference: async () => "ja",
    getMessages: async () => messagesFor("ja"),
  };
});
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "",
  resolveProject: (projects: { id: string }[]) => projects[0],
}));
// クライアントの部品は、何を出すかだけを確かめる
vi.mock("@/components/project-editor", () => ({ ProjectEditor: () => null }));
vi.mock("@/components/import-project-form", () => ({ ImportProjectForm: () => null }));
vi.mock("@/components/shell/rail", () => ({ AppRail: () => null }));

const { ProjectGate, RailGate } = await import("./project-gate");
const { AppHeader, HeaderFallback } = await import("./header");
const { ProjectEditor } = await import("@/components/project-editor");
const { ImportProjectForm } = await import("@/components/import-project-form");
const { AppRail } = await import("@/components/shell/rail");

const project = { id: "p1", name: "決済", targets: [] };

/** 描画した要素の木から、部品（関数）の要素を集める。 */
function components(node: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) components(child, found);
  } else if (node && typeof node === "object" && "props" in node) {
    const el = node as { type: unknown; props: { children?: unknown } };
    if (typeof el.type === "function") found.push(el.type);
    components(el.props.children, found);
  }
  return found;
}

describe("プロジェクトが無いときの画面（PBI-22）", () => {
  beforeEach(() => {
    listProjects.mockReset();
    listTasks.mockReset();
    listTasks.mockResolvedValue([]);
  });

  it("プロジェクトが無ければ、どの画面でも作成とインポートだけを出し、サイドメニューとプロジェクトの切り替えを出さない", async () => {
    listProjects.mockResolvedValue([]);
    const page = "表示しようとした画面";
    const gated = await ProjectGate({ children: page });
    expect(components(gated)).toEqual([ProjectEditor, ImportProjectForm]);
    expect(JSON.stringify(gated)).not.toContain(page);
    expect(JSON.stringify(gated)).toContain("最初のプロジェクトを作る");
    expect(await RailGate()).toBeNull();
    const header = (await AppHeader()) as { type: unknown };
    expect(header.type).toBe(HeaderFallback);
  });

  it("プロジェクトがあれば、開いた画面とサイドメニューをそのまま出す", async () => {
    listProjects.mockResolvedValue([project]);
    const page = "表示しようとした画面";
    expect(await ProjectGate({ children: page })).toBe(page);
    expect((await RailGate())?.type).toBe(AppRail);
  });

  it("デーモンにつながらなければ、開いた画面をそのまま出す（画面がつながらないことを示す）", async () => {
    listProjects.mockRejectedValue(new Error("unreachable"));
    const page = "表示しようとした画面";
    expect(await ProjectGate({ children: page })).toBe(page);
    expect((await RailGate())?.type).toBe(AppRail);
  });
});
