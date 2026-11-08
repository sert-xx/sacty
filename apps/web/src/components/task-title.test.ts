// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 題の変更（PBI-323）。1回目は断り、2回目は変えられたことにする
const renameTaskAction = vi.fn(
  async (_prev: unknown, _form: FormData) => ({}) as { message?: string },
);
vi.mock("@/app/actions", () => ({ renameTaskAction }));

const { I18nProvider } = await import("@/i18n/client");
const { TaskTitle } = await import("./task-title");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  renameTaskAction.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const render = (node: ReactNode) =>
  act(() =>
    root.render(h(I18nProvider as unknown as FC<{ locale: "ja" }>, { locale: "ja" }, node)),
  );
const wait = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const q = <T extends Element>(selector: string) => container.querySelector<T>(selector);
/** React の制御された入力に、人が打ったように値を入れる。 */
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () => {
  await act(async () => q<HTMLFormElement>("form")?.requestSubmit());
  await wait();
  await wait();
};

describe("タスクの詳細の題を変える", () => {
  it("題を変えるボタンで、今の題を入れた入力を開き、送った題をタスクと一緒に渡し、変えられたら閉じる", async () => {
    await render(h(TaskTitle, { taskId: "t1", title: "決済API", editable: true }));
    expect(q("h1")?.textContent).toBe("決済API");
    expect(q("form")).toBeNull();
    await act(async () => q<HTMLButtonElement>('[data-testid="task-title-edit"]')?.click());
    const input = q<HTMLInputElement>("input[name=title]") as HTMLInputElement;
    expect(input.value).toBe("決済API");
    expect(input.maxLength).toBe(200);
    expect(input.required).toBe(true);
    await type(input, "返金API");
    await submit();
    expect(renameTaskAction).toHaveBeenCalledTimes(1);
    const form = renameTaskAction.mock.calls[0]?.[1] as FormData;
    expect(form.get("taskId")).toBe("t1");
    expect(form.get("title")).toBe("返金API");
    expect(q("form")).toBeNull();
  });

  it("断られたら理由を出し、入力した題を消さずに開いたままにする。やめると今の題に戻る", async () => {
    renameTaskAction.mockResolvedValueOnce({ message: "タスクの題は変わっていません。" });
    await render(h(TaskTitle, { taskId: "t1", title: "決済API", editable: true }));
    await act(async () => q<HTMLButtonElement>('[data-testid="task-title-edit"]')?.click());
    const input = q<HTMLInputElement>("input[name=title]") as HTMLInputElement;
    await type(input, "決済API ");
    await submit();
    expect(q('[role="alert"]')?.textContent).toBe("タスクの題は変わっていません。");
    expect(q<HTMLInputElement>("input[name=title]")?.value).toBe("決済API ");
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "やめる",
    );
    await act(async () => cancel?.click());
    expect(q("form")).toBeNull();
    expect(q("h1")?.textContent).toBe("決済API");
    // 開き直すと、今の題から始める
    await act(async () => q<HTMLButtonElement>('[data-testid="task-title-edit"]')?.click());
    expect(q<HTMLInputElement>("input[name=title]")?.value).toBe("決済API");
  });

  it("編集中にほかの所で題が変わっても、フォームを閉じず、入力した題を消さない（PR #330 レビュー指摘）", async () => {
    await render(h(TaskTitle, { key: "t1", taskId: "t1", title: "決済API", editable: true }));
    await act(async () => q<HTMLButtonElement>('[data-testid="task-title-edit"]')?.click());
    await type(q<HTMLInputElement>("input[name=title]") as HTMLInputElement, "入力中の題");
    // 画面の自動の更新で、新しい題が届く（タスクの詳細と同じく、key はタスクの ID）
    await render(
      h(TaskTitle, { key: "t1", taskId: "t1", title: "トリアージの題", editable: true }),
    );
    expect(q("form")).not.toBeNull();
    expect(q<HTMLInputElement>("input[name=title]")?.value).toBe("入力中の題");
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "やめる",
    );
    await act(async () => cancel?.click());
    expect(q("h1")?.textContent).toBe("トリアージの題");
  });

  it("断られた後に閉じて開き直すと、前の理由を出さない（PR #330 レビュー指摘）", async () => {
    renameTaskAction.mockResolvedValueOnce({ message: "タスクの題は変わっていません。" });
    await render(h(TaskTitle, { taskId: "t1", title: "決済API", editable: true }));
    await act(async () => q<HTMLButtonElement>('[data-testid="task-title-edit"]')?.click());
    await submit();
    expect(q('[role="alert"]')?.textContent).toBe("タスクの題は変わっていません。");
    await act(async () =>
      (q<HTMLInputElement>("input[name=title]") as HTMLInputElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(q("form")).toBeNull();
    await act(async () => q<HTMLButtonElement>('[data-testid="task-title-edit"]')?.click());
    expect(q("form")).not.toBeNull();
    expect(q('[role="alert"]')).toBeNull();
  });

  it("中止したタスク（editable が false）には、題を変える操作を出さない", async () => {
    await render(h(TaskTitle, { taskId: "t1", title: "決済API", editable: false }));
    expect(q("h1")?.textContent).toBe("決済API");
    expect(q('[data-testid="task-title-edit"]')).toBeNull();
  });
});
