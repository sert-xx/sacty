// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/p1/tasks/t1",
}));
// 変更は失敗させる（失敗しても、React は送信の後にフォームを初期値に戻す）
vi.mock("@/app/actions", () => ({
  changeStepImageAction: vi.fn(async () => ({ message: "変えられませんでした" })),
  rerunTaskAction: vi.fn(async () => ({})),
}));
vi.mock("@/lib/repository-candidates", () => ({
  candidatesLoader: () => () => {},
}));

const { I18nProvider } = await import("@/i18n/client");
const { StepImageForm } = await import("./step-image-form");
const { RerunDialog } = await import("./rerun-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options = [
  { name: "default", description: "既定のイメージ" },
  { name: "node", description: "Node.js 24" },
  { name: "python", description: "Python 3.12" },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
const wait = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
/** select の説明（aria-describedby の先）。 */
const describedBy = (select: HTMLSelectElement) => {
  const id = select.getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent : undefined;
};

describe("選んだイメージの説明は、実際の選択と食い違わない", () => {
  it("工程のイメージ：選び直すと説明も変わり、変更に失敗してフォームが戻ったら、説明も戻る", async () => {
    await render(h(StepImageForm, { taskId: "t1", step: "implement", current: "node", options }));
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(describedBy(select)).toBe("Node.js 24");

    await choose(select, "python");
    expect(describedBy(select)).toBe("Python 3.12");

    await act(async () => (select.form as HTMLFormElement).requestSubmit());
    await wait();
    await wait();
    expect(container.textContent).toContain("変えられませんでした");
    expect(select.value).toBe("node");
    expect(describedBy(select)).toBe("Node.js 24");
  });

  it("再実行：選んで送らずに閉じ、開き直したら、説明も選択欄と同じく戻る", async () => {
    await render(
      h(RerunDialog, {
        taskId: "t1",
        projectId: "p1",
        title: "題",
        body: "本文",
        repo: "",
        images: options,
      }),
    );
    const open = () =>
      act(() => (document.querySelector('[data-testid="rerun-open"]') as HTMLElement).click());
    const select = () => document.querySelector('[data-testid="rerun-image"]') as HTMLSelectElement;

    await open();
    await wait(50);
    // 自動選択（オーケストレーターに任せる）には説明が無い
    expect(select().value).toBe("");
    expect(describedBy(select())).toBeUndefined();
    await choose(select(), "python");
    expect(describedBy(select())).toBe("Python 3.12");

    await act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await wait(50);
    expect(document.querySelector('[data-testid="rerun-image"]')).toBeNull();

    await open();
    await wait(50);
    expect(select().value).toBe("");
    expect(describedBy(select())).toBeUndefined();
    expect(document.body.textContent).not.toContain("Python 3.12");
  });
});
