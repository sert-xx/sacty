// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 続きのタスクを作るダイアログ（PR #242 レビュー指摘）。開いて入力・選択して送ると、その値がフォームの値として
 * Server Action に渡ること、失敗して戻ったときも入力が残ることを、実際の操作で確かめる。
 */
const deriveTaskAction = vi.fn(async (_prev: unknown, data: FormData) => ({
  message: "作れませんでした",
  values: {
    title: String(data.get("title")),
    body: String(data.get("body")),
    repo: String(data.get("repo")),
    plan: String(data.get("plan")),
  },
}));
vi.mock("@/app/actions", () => ({ deriveTaskAction }));
vi.mock("@/lib/repository-candidates", () => ({ candidatesLoader: () => () => {} }));

const { I18nProvider } = await import("@/i18n/client");
const { DerivedTasksCard } = await import("./derive-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  id: "t1",
  projectId: "p1",
  repo: "https://github.com/acme/app",
} as unknown as Task;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  deriveTaskAction.mockClear();
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
const field = <T extends Element>(id: string) =>
  document.querySelector(`[data-testid="${id}"]`) as T;
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
async function open(security: boolean) {
  await render(h(DerivedTasksCard, { task, derived: [], security }));
  await act(() => field<HTMLElement>("derive-open").click());
  await wait(50);
}

describe("続きのタスクを作るダイアログ", () => {
  it("入力と選んだ進め方を送り、失敗して戻っても入力を残す", async () => {
    await open(false);
    expect(field<HTMLInputElement>("derive-repo").value).toBe("https://github.com/acme/app");
    const plan = field<HTMLSelectElement>("derive-plan");
    // 自動（オーケストレーターが選ぶ）を選べ、初めは自動
    expect(plan.value).toBe("");
    expect([...plan.options].map((o) => o.value)).toContain("");
    act(() => typeInto(field<HTMLInputElement>("derive-title"), "N+1 を直す"));
    act(() => typeInto(field<HTMLTextAreaElement>("derive-body"), "見つかった N+1 を直す"));
    await choose(field<HTMLSelectElement>("derive-plan"), "direct");
    await act(async () => field<HTMLFormElement>("derive-submit").closest("form")?.requestSubmit());
    await wait();
    const data = deriveTaskAction.mock.calls.at(-1)?.[1];
    expect(data && Object.fromEntries(data.entries())).toEqual({
      taskId: "t1",
      repo: "https://github.com/acme/app",
      plan: "direct",
      title: "N+1 を直す",
      body: "見つかった N+1 を直す",
    });
    expect(document.body.textContent).toContain("作れませんでした");
    expect(field<HTMLInputElement>("derive-title").value).toBe("N+1 を直す");
    expect(field<HTMLTextAreaElement>("derive-body").value).toBe("見つかった N+1 を直す");
    expect(field<HTMLSelectElement>("derive-plan").value).toBe("direct");
  });

  it("セキュリティのタスクの続きは、セキュリティの組み合わせだけを選べ、初めはセキュリティ対応", async () => {
    await open(true);
    const plan = field<HTMLSelectElement>("derive-plan");
    expect([...plan.options].map((o) => o.value)).toEqual(["security-fix", "security-check"]);
    expect(plan.value).toBe("security-fix");
    act(() => typeInto(field<HTMLInputElement>("derive-title"), "SF-1 を直す"));
    act(() => typeInto(field<HTMLTextAreaElement>("derive-body"), "SF-1 だけ直す"));
    await act(async () => field<HTMLFormElement>("derive-submit").closest("form")?.requestSubmit());
    await wait();
    expect(deriveTaskAction.mock.calls.at(-1)?.[1].get("plan")).toBe("security-fix");
  });
});
