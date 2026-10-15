import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

let daemonUp = true;
vi.mock("@/lib/daemon", () => ({
  listProjects: async () => {
    if (!daemonUp) throw new Error("unreachable");
    return [{ id: "p-a", name: "A", targets: [], createdAt: "", updatedAt: "" }];
  },
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

const { AppHeader, HeaderFallback } = await import("./header");
const { AutoRefresh, RefreshOnVisible, watchVisible } = await import("@/components/auto-refresh");

type Element = { type: unknown; props: { children?: unknown; active?: boolean } };

function flatten(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  return [element, ...flatten(element.props?.children)];
}

/** visibilityState を変えて visibilitychange を送れる、document の代わり。 */
function fakeDocument() {
  const target = new EventTarget();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return doc;
}

describe("ヘッダーの更新（PBI-98）", () => {
  it("実行中のタスクが無くても、タブに戻ってきたときに最新にする（ほかのタブ・CLI・デーモンの変化を出す）", async () => {
    daemonUp = true;
    const elements = flatten(await AppHeader());
    expect(elements.find((e) => e.type === AutoRefresh)?.props.active).toBe(false);
    expect(elements.some((e) => e.type === RefreshOnVisible)).toBe(true);
  });

  it("デーモンにつながらなかったときのヘッダーも、タブに戻ってきたときに描き直す（レビュー指摘）", async () => {
    daemonUp = false;
    const element = (await AppHeader()) as Element;
    expect(element.type).toBe(HeaderFallback);
    // フォールバックの中身（Frame の子）に置いている
    const frame = HeaderFallback({ language: "ja" }) as Element;
    expect(flatten(frame.props.children).some((e) => e.type === RefreshOnVisible)).toBe(true);
  });

  it("隠れた状態から見える状態に戻ったときに1回だけ最新にし、隠れるほうでは最新にしない（レビュー指摘）", () => {
    const doc = fakeDocument();
    const refresh = vi.fn();
    const stop = watchVisible(doc, refresh);
    doc.set("hidden");
    expect(refresh).not.toHaveBeenCalled();
    doc.set("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    // 止めた後は呼ばない
    stop();
    doc.set("hidden");
    doc.set("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
