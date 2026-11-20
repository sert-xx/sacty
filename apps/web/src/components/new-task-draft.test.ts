// @vitest-environment jsdom
import { act, Component, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const createTask = vi.fn();
vi.mock("@/lib/daemon", () => ({ createTask, CONTEXT_CHECK_PARAM: "contextCheck" }));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
const getMessages = vi.fn(async () => messagesFor("ja"));
vi.mock("@/i18n/server", () => ({ getMessages }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
// 本物の redirect と unstable_rethrow を使い、redirect は呼ばれた URL を確かめる spy にとどめる
const redirect = vi.fn();
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  redirect.mockImplementation(actual.redirect);
  return { ...actual, redirect };
});
vi.mock("@/lib/repository-candidates", () => ({
  candidatesLoader: () => Object.assign(() => {}, { cancel: () => {} }),
}));
vi.mock("@/lib/step-options", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stepOptionsLoader: () => Object.assign(() => {}, { cancel: () => {} }),
}));

const { NewTaskDialog } = await import("./new-task-dialog");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = messagesFor("ja").forms.task;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const props = { projectId: "p", projectName: "P", hasTargets: true };
const fieldOf = (name: string) =>
  document.querySelector<HTMLInputElement & HTMLTextAreaElement>(`[name="${name}"]`);
const trigger = () => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === t.create,
  );
  if (!found) throw new Error("trigger missing");
  return found;
};
const dialogButton = (label: string) => {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
  ).find((b) => b.textContent === label);
  if (!found) throw new Error(`button missing: ${label}`);
  return found;
};
const open = () => act(async () => trigger().click());
const type = async (name: string, value: string) => {
  const el = fieldOf(name);
  if (!el) throw new Error(`${name} missing`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(() => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const isOpen = () => document.querySelector("[role=dialog]") !== null;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 50)));

const closers: Record<string, () => Promise<void>> = {
  Esc: () =>
    act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    }),
  外側のクリック: () =>
    act(async () => {
      const backdrop = document.querySelector("[data-slot=dialog-overlay]");
      if (!backdrop) throw new Error("overlay missing");
      backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }),
  フッターの閉じる: () => act(async () => dialogButton(t.close).click()),
  "右上の ×": () => act(async () => dialogButton("閉じる").click()),
};

beforeEach(() => {
  redirect.mockClear();
  getMessages.mockClear();
  createTask.mockReset().mockResolvedValue({ ok: false, message: "failed" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("タスク作成の書きかけ", () => {
  describe.each(Object.keys(closers))("%s で閉じる", (how) => {
    it("題と内容は、開き直すと戻る", async () => {
      await act(async () => root.render(h(NewTaskDialog, props)));
      await open();
      await type("title", "書きかけの題");
      await type("body", "長い依頼文\n二行目");
      await closers[how]?.();
      await settle();
      expect(isOpen()).toBe(false);
      await open();
      expect(fieldOf("title")?.value).toBe("書きかけの題");
      expect(fieldOf("body")?.value).toBe("長い依頼文\n二行目");
    });

    it("内容だけでも戻る", async () => {
      await act(async () => root.render(h(NewTaskDialog, props)));
      await open();
      await type("body", "内容だけ");
      await closers[how]?.();
      await settle();
      await open();
      expect(fieldOf("title")?.value).toBe("");
      expect(fieldOf("body")?.value).toBe("内容だけ");
    });
  });

  it.each(Object.keys(closers))(
    "空（空白だけも含む）なら、%s で確認なしにすぐ閉じ、開き直しても空",
    async (how) => {
      await act(async () => root.render(h(NewTaskDialog, props)));
      await open();
      await type("title", "  ");
      await type("body", "\n ");
      await closers[how]?.();
      await settle();
      expect(isOpen()).toBe(false);
      await open();
      expect(fieldOf("title")?.value).toBe("  ");
      expect(fieldOf("body")?.value).toBe("\n ");
    },
  );

  it("作成に成功すると redirect の例外が届き、部品が作り直されて、開き直すと空。失敗の理由は出ない", async () => {
    createTask.mockResolvedValue({ ok: true, task: { id: "t1" } });
    const caught: unknown[] = [];
    // 本物の redirect を受ける境界と同じく、例外を受けて子を作り直す
    class Boundary extends Component<{ children: ReactNode }, { generation: number }> {
      state = { generation: 0 };
      static getDerivedStateFromError() {
        return null;
      }
      componentDidCatch(error: unknown) {
        caught.push(error);
        this.setState((prev) => ({ generation: prev.generation + 1 }));
      }
      render() {
        return h("div", { key: this.state.generation }, this.props.children);
      }
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(h(Boundary, null, h(NewTaskDialog, props))));
    await open();
    await type("title", "作る");
    await type("body", "本文");
    await act(async () => document.querySelector("form")?.requestSubmit());
    await settle();
    spy.mockRestore();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/tasks/t1");
    expect(caught).toHaveLength(1);
    expect((caught[0] as { digest: string }).digest).toMatch(/^NEXT_REDIRECT/);
    expect(document.querySelector("[role=alert]")).toBeNull();
    await open();
    expect(fieldOf("title")?.value).toBe("");
    expect(fieldOf("body")?.value).toBe("");
  });

  it.each([
    ["Error", new Error("Failed to fetch")],
    ["文字列", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["digest の無いオブジェクト", { code: 500 }],
  ])("作成の処理が %s を投げても、部品は外れず、理由が出て、入力が残る", async (_name, thrown) => {
    getMessages.mockRejectedValueOnce(thrown);
    await act(async () => root.render(h(NewTaskDialog, props)));
    await open();
    await type("title", "投げられた題");
    await type("body", "投げられた本文");
    await act(async () => document.querySelector("form")?.requestSubmit());
    await settle();
    expect(isOpen()).toBe(true);
    expect(document.querySelector("[role=alert]")?.textContent).toBe(t.createFailed);
    expect(fieldOf("title")?.value).toBe("投げられた題");
    expect(fieldOf("body")?.value).toBe("投げられた本文");
  });

  it("作成に失敗したら、入力が残り、閉じて開き直しても残る", async () => {
    await act(async () => root.render(h(NewTaskDialog, props)));
    await open();
    await type("title", "失敗する題");
    await type("body", "失敗する本文");
    await act(async () => document.querySelector("form")?.requestSubmit());
    await settle();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("failed");
    expect(fieldOf("title")?.value).toBe("失敗する題");
    expect(fieldOf("body")?.value).toBe("失敗する本文");
    await closers.Esc?.();
    await settle();
    await open();
    expect(fieldOf("title")?.value).toBe("失敗する題");
    expect(fieldOf("body")?.value).toBe("失敗する本文");
  });

  it("作成の処理が例外で失敗しても、部品は外れず、理由が出て、入力が残る", async () => {
    // action 自体が reject する（サーバーの停止・古い action の ID など）
    getMessages.mockRejectedValueOnce(new Error("Failed to fetch"));
    await act(async () => root.render(h(NewTaskDialog, props)));
    await open();
    await type("title", "例外の題");
    await type("body", "例外の本文");
    await act(async () => document.querySelector("form")?.requestSubmit());
    await settle();
    expect(isOpen()).toBe(true);
    expect(document.querySelector("[role=alert]")?.textContent).toBe(t.createFailed);
    expect(fieldOf("title")?.value).toBe("例外の題");
    await closers.Esc?.();
    await settle();
    await open();
    expect(fieldOf("title")?.value).toBe("例外の題");
    expect(fieldOf("body")?.value).toBe("例外の本文");
  });

  it("画面の自動の更新（同じ key で props が変わる）でも、書きかけが残る", async () => {
    const render = (name: string) =>
      act(async () => root.render(h(NewTaskDialog, { ...props, projectName: name, key: "p" })));
    await render("P");
    await open();
    await type("title", "更新中の題");
    await type("body", "更新中の本文");
    await render("P2");
    expect(fieldOf("title")?.value).toBe("更新中の題");
    await closers.Esc?.();
    await settle();
    await render("P3");
    await open();
    expect(fieldOf("title")?.value).toBe("更新中の題");
    expect(fieldOf("body")?.value).toBe("更新中の本文");
  });

  it("「工程ごとに設定」へ行って戻っても、題と内容が残る", async () => {
    await act(async () => root.render(h(NewTaskDialog, props)));
    await open();
    await type("title", "往復の題");
    await type("body", "往復の本文");
    const plan = document.querySelector<HTMLSelectElement>("select[name=plan]");
    if (!plan) throw new Error("plan missing");
    await act(async () => {
      plan.value = "standard";
      plan.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const click = (id: string) => {
      const el = document.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
      if (!el) throw new Error(`${id} missing`);
      return act(async () => el.click());
    };
    await click("step-settings-open");
    await click("step-settings-done");
    expect(fieldOf("title")?.value).toBe("往復の題");
    expect(fieldOf("body")?.value).toBe("往復の本文");
  });

  it("提案から開くダイアログは提案の内容で始まり、ふつうのダイアログの書きかけと混ざらない", async () => {
    const prefill = {
      label: "提案から作る",
      title: "提案の題",
      body: "提案の内容",
      repo: "",
      flakyFixTest: "x",
    };
    await act(async () =>
      root.render(h("div", null, h(NewTaskDialog, props), h(NewTaskDialog, { ...props, prefill }))),
    );
    await act(async () => trigger().click());
    await type("title", "ふつうの書きかけ");
    await closers.フッターの閉じる?.();
    await settle();
    const suggestion = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "提案から作る",
    );
    await act(async () => suggestion?.click());
    expect(fieldOf("title")?.value).toBe("提案の題");
    expect(fieldOf("body")?.value).toBe("提案の内容");
    await type("title", "提案を直した");
    await closers.フッターの閉じる?.();
    await settle();
    await open();
    expect(fieldOf("title")?.value).toBe("ふつうの書きかけ");
    expect(fieldOf("body")?.value).toBe("");
  });

  it("別のプロジェクト（key が別）の書きかけは出ない", async () => {
    const render = (id: string) =>
      act(async () => root.render(h(NewTaskDialog, { ...props, projectId: id, key: id })));
    await render("a");
    await open();
    await type("title", "Aの書きかけ");
    await closers.フッターの閉じる?.();
    await settle();
    await render("b");
    await open();
    expect(fieldOf("title")?.value).toBe("");
  });
});
