// @vitest-environment jsdom
import { act, createElement as h } from "react";
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
  it("追加と削除で送信値が変わり、10欄では追加できない", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(h("form", null, h(TaskFields, props))));
    const form = container.querySelector("form")!;
    const add = () =>
      Array.from(form.querySelectorAll("button")).find(
        (b) => b.textContent === "リポジトリを追加",
      )!;
    const inputs = () => Array.from(form.querySelectorAll<HTMLInputElement>('input[name="repo"]'));
    inputs()[0]!.value = "acme/a";
    await act(() => add().click());
    inputs()[1]!.value = "acme/b";
    expect(new FormData(form).getAll("repo")).toEqual(["acme/a", "acme/b"]);
    const remove = Array.from(form.querySelectorAll("button")).filter(
      (b) => b.textContent === "削除",
    );
    await act(() => remove[1]!.click());
    expect(new FormData(form).getAll("repo")).toEqual(["acme/a"]);
    for (let i = 0; i < 9; i++) await act(() => add().click());
    expect(inputs()).toHaveLength(10);
    expect(add().disabled).toBe(true);
    await act(() => add().click());
    expect(inputs()).toHaveLength(10);
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
