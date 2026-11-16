// @vitest-environment jsdom
import { act, createElement as h, useActionState, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

let locale: "ja" | "en" = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({ createTaskAction: async () => ({}) }));
const { TaskFields } = await import("./new-task-dialog");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const props = {
  idPrefix: "task",
  projectId: "p",
  hasTargets: true,
  candidates: { status: "loaded" as const, repositories: [], problems: [] },
  template: "" as const,
  onTemplate: () => {},
  plan: "" as const,
  onPlan: () => {},
  steps: { customized: [], onOpen: () => {} },
};

describe("作成フォームのリポジトリ欄", () => {
  it.each(["ja", "en"] as const)(
    "%s で追加と削除が送信値に反映され、1欄と10欄の境界を守る",
    async (lang) => {
      locale = lang;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(() => root.render(h("form", null, h(TaskFields, props))));
      const form = container.querySelector("form");
      if (!form) throw new Error("form missing");
      const button = (label: string) => {
        const found = Array.from(form.querySelectorAll("button")).find(
          (b) => b.textContent === label,
        );
        if (!found) throw new Error(`button missing: ${label}`);
        return found;
      };
      const t = messagesFor(lang).forms.task;
      const inputs = () =>
        Array.from(form.querySelectorAll<HTMLInputElement>('input[name="repo"]'));
      const set = async (index: number, value: string) => {
        const input = inputs()[index];
        if (!input) throw new Error("input missing");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) throw new Error("value setter missing");
        await act(() => {
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      expect(form.querySelector(`[aria-label="${t.removeRepositoryField(1)}"]`)).toBeNull();
      await set(0, "acme/a");
      await act(() => button(t.addRepository).click());
      await set(1, "acme/b");
      expect(new FormData(form).getAll("repo")).toEqual(["acme/a", "acme/b"]);
      const remove = form.querySelector<HTMLButtonElement>(
        `[aria-label="${t.removeRepositoryField(2)}"]`,
      );
      if (!remove) throw new Error("remove missing");
      await act(() => remove.click());
      expect(new FormData(form).getAll("repo")).toEqual(["acme/a"]);
      expect(form.querySelector(`[aria-label="${t.removeRepositoryField(1)}"]`)).toBeNull();
      for (let i = 0; i < 9; i++) await act(() => button(t.addRepository).click());
      expect(inputs()).toHaveLength(10);
      expect(button(t.addRepository).disabled).toBe(true);
      await act(() => button(t.addRepository).click());
      expect(inputs()).toHaveLength(10);
      await act(() => root.unmount());
      container.remove();
      locale = "ja";
    },
  );

  it("作成が拒否されても空欄を含む全欄の値と順序を保持して再送する", async () => {
    const submitted: FormDataEntryValue[][] = [];
    function Form() {
      const [state, action] = useActionState(async (_state: number, data: FormData) => {
        submitted.push(data.getAll("repo"));
        return 1;
      }, 0);
      return h(
        "form",
        { action },
        h(TaskFields, props),
        h("button", { type: "submit" }, "Submit"),
        state ? h("p", null, "Error") : null,
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(h(Form)));
    const form = container.querySelector("form");
    if (!form) throw new Error("form missing");
    const add = Array.from(form.querySelectorAll("button")).find(
      (b) => b.textContent === messagesFor("ja").forms.task.addRepository,
    );
    if (!add) throw new Error("add missing");
    await act(() => add.click());
    await act(() => add.click());
    const inputs = form.querySelectorAll<HTMLInputElement>('input[name="repo"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter || !inputs[0] || !inputs[2]) throw new Error("inputs missing");
    await act(() => {
      setter.call(inputs[0], "acme/a");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(inputs[2], "acme/b");
      inputs[2].dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.requestSubmit();
    });
    expect(new FormData(form).getAll("repo")).toEqual(["acme/a", "", "acme/b"]);
    await act(async () => {
      form.requestSubmit();
    });
    expect(submitted).toEqual([
      ["acme/a", "", "acme/b"],
      ["acme/a", "", "acme/b"],
    ]);
    await act(() => root.unmount());
    container.remove();
  });

  it("先頭が未編集の空欄でも失敗後と再送時に後続欄を保持する", async () => {
    const submitted: FormDataEntryValue[][] = [];
    function Form() {
      const [state, action] = useActionState(async (_state: number, data: FormData) => {
        submitted.push(data.getAll("repo"));
        return 1;
      }, 0);
      return h(
        "form",
        { action },
        h(TaskFields, { ...props, repoDefault: state ? "" : "" }),
        h("button", { type: "submit" }, "Submit"),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(h(Form)));
    const form = container.querySelector("form");
    const add = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === messagesFor("ja").forms.task.addRepository,
    );
    if (!form || !add) throw new Error("form or add missing");
    await act(() => add.click());
    const input = form.querySelectorAll<HTMLInputElement>('input[name="repo"]')[1];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!input || !setter) throw new Error("input missing");
    await act(() => {
      setter.call(input, "acme/b");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => form.requestSubmit());
    expect(new FormData(form).getAll("repo")).toEqual(["", "acme/b"]);
    await act(async () => form.requestSubmit());
    expect(submitted).toEqual([
      ["", "acme/b"],
      ["", "acme/b"],
    ]);
    await act(() => root.unmount());
    container.remove();
  });

  it("候補の取得前にテンプレートを選んでも到着した初期値を反映する", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(() => root.render(h(TaskFields, { ...props, repoDefault: "" })));
    const radio = container.querySelector<HTMLInputElement>(
      'input[name="template"][value="sacty-setup"]',
    );
    if (!radio) throw new Error("template missing");
    await act(() => radio.click());
    await act(() =>
      root.render(h(TaskFields, { ...props, template: "sacty-setup", repoDefault: "acme/a" })),
    );
    expect(container.querySelector<HTMLInputElement>('input[name="repo"]')?.value).toBe("acme/a");
    await act(() => root.unmount());
  });

  it.each([false, true])(
    "先頭欄の削除後に候補が届くと残った欄の編集状態に従う（編集済み: %s）",
    async (edited) => {
      const container = document.createElement("div");
      const root = createRoot(container);
      await act(() => root.render(h("form", null, h(TaskFields, { ...props, repoDefault: "" }))));
      const form = container.querySelector("form");
      const add = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === messagesFor("ja").forms.task.addRepository,
      );
      if (!form || !add) throw new Error("form or add missing");
      await act(() => add.click());
      if (edited) {
        const input = form.querySelectorAll<HTMLInputElement>('input[name="repo"]')[1];
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!input || !setter) throw new Error("input missing");
        await act(() => {
          setter.call(input, "acme/edited");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      const remove = form.querySelector<HTMLButtonElement>(
        `[aria-label="${messagesFor("ja").forms.task.removeRepositoryField(1)}"]`,
      );
      if (!remove) throw new Error("remove missing");
      await act(() => remove.click());
      await act(() =>
        root.render(h("form", null, h(TaskFields, { ...props, repoDefault: "acme/a" }))),
      );
      expect(new FormData(form).getAll("repo")).toEqual([edited ? "acme/edited" : "acme/a"]);
      await act(() => root.unmount());
    },
  );

  describe.each(["ja", "en"] as const)("欄の操作（PBI-360。%s）", (lang) => {
    const mount = async (extra: Partial<Parameters<typeof TaskFields>[0]> = {}) => {
      locale = lang;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(() => root.render(h("form", null, h(TaskFields, { ...props, ...extra }))));
      const t = messagesFor(lang).forms.task;
      const inputs = () =>
        Array.from(container.querySelectorAll<HTMLInputElement>('input[name="repo"]'));
      const add = () => {
        const found = Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent === t.addRepository,
        );
        if (!found) throw new Error("add missing");
        return found;
      };
      const remove = async (position: number) => {
        const found = container.querySelector<HTMLButtonElement>(
          `[aria-label="${t.removeRepositoryField(position)}"]`,
        );
        if (!found) throw new Error("remove missing");
        // 押したボタンにフォーカスがある状態から消す（実際の操作と同じ）
        found.focus();
        await act(() => found.click());
      };
      const set = async (index: number, value: string) => {
        const input = inputs()[index];
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!input || !setter) throw new Error("input missing");
        await act(() => {
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      const unmount = async () => {
        await act(() => root.unmount());
        container.remove();
        locale = "ja";
      };
      return { container, t, inputs, add, remove, set, unmount };
    };

    it("初期値の入った1欄目を削除しても、残った欄に初期値が入り直らない", async () => {
      const { inputs, add, remove, unmount } = await mount({ repoDefault: "acme/a" });
      expect(inputs().map((i) => i.value)).toEqual(["acme/a"]);
      await act(() => add().click());
      await remove(1);
      expect(inputs().map((i) => i.value)).toEqual([""]);
      // 残った欄を増減しても戻らない
      await act(() => add().click());
      await remove(2);
      expect(inputs().map((i) => i.value)).toEqual([""]);
      await unmount();
    });

    it("追加したら新しい欄に、削除したら消した位置の欄（無ければ前の欄）にフォーカスを移す", async () => {
      const { inputs, add, remove, set, unmount } = await mount();
      await act(() => add().click());
      expect(document.activeElement).toBe(inputs()[1]);
      await act(() => add().click());
      expect(document.activeElement).toBe(inputs()[2]);
      await set(0, "acme/a");
      await set(1, "acme/b");
      await set(2, "acme/c");
      // 途中の欄を消すと、その位置に上がってきた欄
      await remove(2);
      expect(inputs().map((i) => i.value)).toEqual(["acme/a", "acme/c"]);
      expect(document.activeElement).toBe(inputs()[1]);
      // 最後の欄を消すと、前の欄
      await remove(2);
      expect(inputs().map((i) => i.value)).toEqual(["acme/a"]);
      expect(document.activeElement).toBe(inputs()[0]);
      // 先頭の欄を消すと、先頭に上がってきた欄
      await act(() => add().click());
      await set(1, "acme/d");
      await remove(1);
      expect(inputs().map((i) => i.value)).toEqual(["acme/d"]);
      expect(document.activeElement).toBe(inputs()[0]);
      await unmount();
    });

    it("上限の10件に達したら、追加を押せない理由を出し、減らすと消す", async () => {
      const { container, t, add, remove, unmount } = await mount();
      const limit = () => container.querySelector("#task-repo-limit");
      for (let i = 0; i < 8; i++) await act(() => add().click());
      expect(add().disabled).toBe(false);
      expect(limit()).toBeNull();
      expect(add().getAttribute("aria-describedby")).toBeNull();
      await act(() => add().click());
      expect(add().disabled).toBe(true);
      expect(limit()?.textContent).toBe(t.repositoryLimit(10));
      expect(limit()?.textContent).toContain("10");
      expect(limit()?.getAttribute("role")).toBe("status");
      expect(add().getAttribute("aria-describedby")).toBe("task-repo-limit");
      await remove(10);
      expect(add().disabled).toBe(false);
      expect(limit()).toBeNull();
      await unmount();
    });

    it("同じリポジトリを入れた欄を知らせ、空欄どうしは知らせない", async () => {
      const { container, t, add, set, unmount } = await mount();
      const notice = () => container.querySelector('[data-testid="task-repo-duplicates"]');
      await act(() => add().click());
      await act(() => add().click());
      // 空欄どうしは重複にしない
      expect(notice()).toBeNull();
      await set(0, "https://github.com/acme/a");
      await set(1, " https://github.com/acme/a/ ");
      await set(2, "https://github.com/ACME/a");
      expect(notice()?.textContent).toBe(t.duplicateRepositories([2, 3]));
      await set(1, "https://github.com/acme/b");
      expect(notice()?.textContent).toBe(t.duplicateRepositories([3]));
      await unmount();
    });
  });

  it("テンプレートの間は1欄だけを出し、なしに戻すと増やした欄・値を残している（PBI-360）", async () => {
    function Form() {
      const [template, setTemplate] = useState<"" | "sacty-setup">("");
      return h(
        "form",
        null,
        h(TaskFields, {
          ...props,
          template,
          onTemplate: (value) => setTemplate(value as "" | "sacty-setup"),
        }),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(h(Form)));
    const t = messagesFor("ja").forms.task;
    const inputs = () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('input[name="repo"]'));
    const add = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === t.addRepository,
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!add || !setter) throw new Error("add missing");
    await act(() => add.click());
    await act(() => add.click());
    for (const [index, value] of ["acme/a", "acme/a", "acme/c"].entries()) {
      const input = inputs()[index];
      if (!input) throw new Error("input missing");
      await act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const radio = (value: string) => {
      const found = container.querySelector<HTMLInputElement>(
        `input[name="template"][value="${value}"]`,
      );
      if (!found) throw new Error("template missing");
      return found;
    };
    await act(() => radio("sacty-setup").click());
    expect(inputs().map((i) => i.value)).toEqual(["acme/a"]);
    // 隠れている欄の重複は知らせない（送らないため）
    expect(container.querySelector('[data-testid="task-repo-duplicates"]')).toBeNull();
    await act(() => radio("").click());
    expect(inputs().map((i) => i.value)).toEqual(["acme/a", "acme/a", "acme/c"]);
    expect(container.querySelector('[data-testid="task-repo-duplicates"]')?.textContent).toBe(
      t.duplicateRepositories([2]),
    );
    await act(() => root.unmount());
    container.remove();
  });

  it("静的描画で追加を示し、テンプレートは1欄に固定する", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const html = renderToStaticMarkup(h(TaskFields, props));
      expect(html).toContain(messagesFor(lang).forms.task.addRepository);
      expect(html).toContain('name="repo"');
      const template = renderToStaticMarkup(h(TaskFields, { ...props, template: "sacty-setup" }));
      expect(template).not.toContain(messagesFor(lang).forms.task.addRepository);
      expect(template.match(/name="repo"/g)).toHaveLength(1);
    }
    locale = "ja";
  });
});
