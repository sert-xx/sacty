// @vitest-environment jsdom
import { act, createElement as h, useActionState, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

let locale: "ja" | "en" = "ja";
const createTask = vi.fn();
vi.mock("@/lib/daemon", () => ({ createTask, CONTEXT_CHECK_PARAM: "contextCheck" }));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor(locale) }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { createTaskAction } = await import("@/app/actions");
const { NewTaskDialog, TaskFields } = await import("./new-task-dialog");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Form() {
  const [state, action] = useActionState(createTaskAction, {});
  const [template, setTemplate] = useState<"" | "sacty-setup" | "security-check" | "docs-setup">(
    "",
  );
  return h(
    "form",
    { action },
    h("input", { type: "hidden", name: "projectId", value: "p" }),
    h(TaskFields, {
      idPrefix: "task",
      projectId: "p",
      hasTargets: true,
      candidates: { status: "loaded", repositories: [], problems: [] },
      template,
      onTemplate: setTemplate,
      plan: "",
      onPlan: () => {},
      steps: { customized: [], onOpen: () => {} },
      titleDefault: state.values?.title ?? "作業",
      bodyDefault: state.values?.body ?? "",
    }),
    h("button", { type: "submit" }, "Submit"),
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  createTask.mockReset().mockResolvedValue({ ok: false, message: "failed" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(h(Form)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe.each(["ja", "en"] as const)("作成フォームの送信（%s）", (lang) => {
  const form = () => {
    const found = container.querySelector("form");
    if (!found) throw new Error("form missing");
    return found;
  };
  const button = (label: string) => {
    const found = Array.from(form().querySelectorAll("button")).find(
      (b) => b.textContent === label,
    );
    if (!found) throw new Error(`button missing: ${label}`);
    return found;
  };
  const setRepo = async (index: number, value: string) => {
    const input = form().querySelectorAll<HTMLInputElement>('input[name="repo"]')[index];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!input || !setter) throw new Error("input missing");
    await act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => act(async () => form().requestSubmit());
  beforeEach(async () => {
    locale = lang;
    await act(() => root.render(h(Form)));
  });

  it("欄の追加と削除を各送信の作成入力に反映する", async () => {
    const t = messagesFor(lang).forms.task;
    await submit();
    expect(createTask).toHaveBeenNthCalledWith(1, {
      title: "作業",
      body: "",
      projectId: "p",
      repo: null,
    });
    await setRepo(0, "acme/a");
    await submit();
    expect(createTask).toHaveBeenNthCalledWith(2, {
      title: "作業",
      body: "",
      projectId: "p",
      repo: "acme/a",
    });
    await act(() => button(t.addRepository).click());
    await setRepo(1, "acme/b");
    await submit();
    expect(createTask).toHaveBeenNthCalledWith(3, {
      title: "作業",
      body: "",
      projectId: "p",
      repos: ["acme/a", "acme/b"],
    });
    const remove = form().querySelector<HTMLButtonElement>(
      `[aria-label="${t.removeRepositoryField(2)}"]`,
    );
    if (!remove) throw new Error("remove missing");
    await act(() => remove.click());
    await submit();
    expect(createTask).toHaveBeenNthCalledWith(4, {
      title: "作業",
      body: "",
      projectId: "p",
      repo: "acme/a",
    });
    expect(createTask).toHaveBeenCalledTimes(4);
  });

  it("10欄で追加を押しても10件までを送る", async () => {
    const add = button(messagesFor(lang).forms.task.addRepository);
    for (let i = 0; i < 9; i++) await act(() => add.click());
    for (let i = 0; i < 10; i++) await setRepo(i, `acme/r${i}`);
    expect(add.disabled).toBe(true);
    await act(() => add.click());
    await submit();
    expect(createTask).toHaveBeenCalledExactlyOnceWith({
      title: "作業",
      body: "",
      projectId: "p",
      repos: Array.from({ length: 10 }, (_, i) => `acme/r${i}`),
    });
  });

  it("テンプレートを選び空欄で送るとリポジトリを省く", async () => {
    const radio = form().querySelector<HTMLInputElement>(
      'input[name="template"][value="sacty-setup"]',
    );
    if (!radio) throw new Error("template missing");
    await act(() => radio.click());
    await submit();
    expect(createTask).toHaveBeenCalledExactlyOnceWith({ template: "sacty-setup", projectId: "p" });
  });

  it("複数欄からテンプレートを選ぶと1欄目だけを送り、なしに戻すと増やした欄と値が残っている（PBI-360）", async () => {
    await setRepo(0, "acme/a");
    await act(() => button(messagesFor(lang).forms.task.addRepository).click());
    await setRepo(1, "acme/b");
    const template = form().querySelector<HTMLInputElement>(
      'input[name="template"][value="sacty-setup"]',
    );
    const none = form().querySelector<HTMLInputElement>('input[name="template"][value=""]');
    if (!template || !none) throw new Error("template missing");
    await act(() => template.click());
    expect(form().querySelectorAll('input[name="repo"]')).toHaveLength(1);
    await submit();
    expect(createTask).toHaveBeenNthCalledWith(1, {
      template: "sacty-setup",
      projectId: "p",
      repo: "acme/a",
    });
    await act(() => none.click());
    expect(
      Array.from(form().querySelectorAll<HTMLInputElement>('input[name="repo"]'), (i) => i.value),
    ).toEqual(["acme/a", "acme/b"]);
    const title = form().querySelector<HTMLInputElement>('input[name="title"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!title || !setter) throw new Error("title missing");
    await act(() => {
      setter.call(title, "作業");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
    expect(createTask).toHaveBeenNthCalledWith(2, {
      title: "作業",
      body: "",
      projectId: "p",
      repos: ["acme/a", "acme/b"],
    });
    expect(createTask).toHaveBeenCalledTimes(2);
  });

  it("途中の空欄を除いて送る", async () => {
    const add = button(messagesFor(lang).forms.task.addRepository);
    await setRepo(0, "acme/a");
    await act(() => add.click());
    await act(() => add.click());
    await setRepo(2, "acme/c");
    await submit();
    expect(createTask).toHaveBeenCalledExactlyOnceWith({
      title: "作業",
      body: "",
      projectId: "p",
      repos: ["acme/a", "acme/c"],
    });
  });

  it("重複した値は画面で知らせ、そのまま送る（重複はデーモンが除く。PBI-360）", async () => {
    const t = messagesFor(lang).forms.task;
    const notice = () => form().querySelector('[data-testid="task-repo-duplicates"]');
    await setRepo(0, "https://github.com/acme/a");
    await act(() => button(t.addRepository).click());
    expect(notice()).toBeNull();
    // 書き方の揺れ（大文字・末尾の /・.git）は、デーモンと同じく同じリポジトリとして比べる
    await setRepo(1, "https://GitHub.com/Acme/A.git");
    expect(notice()?.textContent).toBe(t.duplicateRepositories([2]));
    expect(notice()?.getAttribute("role")).toBe("status");
    await setRepo(1, "https://github.com/acme/b");
    expect(notice()).toBeNull();
    await setRepo(0, "acme/a");
    await setRepo(1, "acme/a");
    expect(notice()?.textContent).toBe(t.duplicateRepositories([2]));
    await submit();
    expect(createTask).toHaveBeenCalledExactlyOnceWith({
      title: "作業",
      body: "",
      projectId: "p",
      repos: ["acme/a", "acme/a"],
    });
  });

  it("値の前後の空白を取り除いて送る", async () => {
    await setRepo(0, "  acme/a  ");
    await act(() => button(messagesFor(lang).forms.task.addRepository).click());
    await setRepo(1, "  acme/b  ");
    await submit();
    expect(createTask).toHaveBeenCalledExactlyOnceWith({
      title: "作業",
      body: "",
      projectId: "p",
      repos: ["acme/a", "acme/b"],
    });
  });
});

describe.each(["ja", "en"] as const)("作成ダイアログの送信（%s）", (lang) => {
  it("候補を読み込み初期値に追加して送る", async () => {
    locale = lang;
    const fetchCandidates = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ repositories: ["acme/a"], problems: [] }),
    });
    vi.stubGlobal("fetch", fetchCandidates);
    try {
      await act(() =>
        root.render(h(NewTaskDialog, { projectId: "p", projectName: "Project", hasTargets: true })),
      );
      const open = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === messagesFor(lang).forms.task.create,
      );
      if (!open) throw new Error("open missing");
      await act(async () => {
        open.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(fetchCandidates).toHaveBeenCalledWith("/projects/p/repositories", {
        cache: "no-store",
      });
      const form = document.querySelector("form");
      if (!form) throw new Error("form missing");
      expect(form.querySelector<HTMLInputElement>('input[name="repo"]')?.value).toBe("acme/a");
      const add = Array.from(form.querySelectorAll("button")).find(
        (b) => b.textContent === messagesFor(lang).forms.task.addRepository,
      );
      if (!add) throw new Error("add missing");
      await act(() => add.click());
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const second = form.querySelectorAll<HTMLInputElement>('input[name="repo"]')[1];
      const title = form.querySelector<HTMLInputElement>('input[name="title"]');
      if (!setter || !second || !title) throw new Error("input missing");
      await act(() => {
        setter.call(second, "acme/b");
        second.dispatchEvent(new Event("input", { bubbles: true }));
        setter.call(title, "作業");
        title.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => form.requestSubmit());
      expect(createTask).toHaveBeenCalledExactlyOnceWith({
        title: "作業",
        body: "",
        projectId: "p",
        repos: ["acme/a", "acme/b"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("候補が1件の初期値の入った1欄目を削除しても、残った欄に初期値が戻らない（PBI-360）", async () => {
    locale = lang;
    const t = messagesFor(lang).forms.task;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ repositories: ["acme/a"], problems: [] }),
      }),
    );
    try {
      await act(() =>
        root.render(h(NewTaskDialog, { projectId: "p", projectName: "Project", hasTargets: true })),
      );
      const open = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === t.create,
      );
      if (!open) throw new Error("open missing");
      await act(async () => {
        open.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const form = document.querySelector("form");
      if (!form) throw new Error("form missing");
      const values = () =>
        Array.from(form.querySelectorAll<HTMLInputElement>('input[name="repo"]'), (i) => i.value);
      expect(values()).toEqual(["acme/a"]);
      const add = Array.from(form.querySelectorAll("button")).find(
        (b) => b.textContent === t.addRepository,
      );
      if (!add) throw new Error("add missing");
      await act(() => add.click());
      const remove = form.querySelector<HTMLButtonElement>(
        `[aria-label="${t.removeRepositoryField(1)}"]`,
      );
      if (!remove) throw new Error("remove missing");
      await act(() => remove.click());
      expect(values()).toEqual([""]);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const title = form.querySelector<HTMLInputElement>('input[name="title"]');
      if (!setter || !title) throw new Error("title missing");
      await act(() => {
        setter.call(title, "作業");
        title.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => form.requestSubmit());
      expect(values()).toEqual([""]);
      expect(createTask).toHaveBeenCalledExactlyOnceWith({
        title: "作業",
        body: "",
        projectId: "p",
        repo: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
