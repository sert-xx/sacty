import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

vi.mock("@/lib/daemon", () => ({
  listProjects: async () => [{ id: "p-a", name: "A", targets: [], createdAt: "", updatedAt: "" }],
  listTasks: async () => [],
}));
vi.mock("@/i18n/server", () => ({
  languagePreference: async () => "ja",
  getMessages: async () => messagesFor("ja"),
}));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "p-a",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));

const { AppHeader } = await import("./header");
const { AutoRefresh, RefreshOnVisible } = await import("@/components/auto-refresh");

type Element = { type: unknown; props: { children?: unknown; active?: boolean } };

function flatten(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  return [element, ...flatten(element.props?.children)];
}

describe("ヘッダーの更新（PBI-98）", () => {
  it("実行中のタスクが無くても、タブに戻ってきたときに最新にする（ほかのタブ・CLI・デーモンの変化を出す）", async () => {
    const elements = flatten(await AppHeader());
    expect(elements.find((e) => e.type === AutoRefresh)?.props.active).toBe(false);
    expect(elements.some((e) => e.type === RefreshOnVisible)).toBe(true);
  });
});
