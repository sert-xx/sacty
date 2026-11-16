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
const { TaskFields } = await import("./new-task-dialog");
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
});
