// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * テストが決まらずに止まったタスクの再開の欄（PR #201 レビュー指摘）。テストの扱いを選び、入力して送信すると、その値が
 * フォームの値として Server Action に渡ることを、実際の操作で確かめる。
 */
const resumeTaskAction = vi.fn(async (_prev: unknown, _data: FormData) => ({}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/app/actions", () => ({ resumeTaskAction }));

const { ResumeForm } = await import("./resume-form");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resumeTaskAction.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderForm(bugfix = false) {
  act(() =>
    root.render(
      h(ResumeForm, {
        taskId: "t1",
        reason: "error",
        usedUsd: 0,
        capUsd: 10,
        tests: { bugfix, rechoose: true },
      }),
    ),
  );
}

const radio = (value: string) =>
  container.querySelector<HTMLInputElement>(`input[name="tests"][value="${value}"]`);

/** React の制御の外から入力欄の値を変える（React に変更を知らせる）。 */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit() {
  const form = container.querySelector("form");
  await act(async () => {
    form?.requestSubmit();
  });
  const data = resumeTaskAction.mock.calls.at(-1)?.[1];
  return data ? Object.fromEntries(data.entries()) : undefined;
}

describe("テストが決まらずに止まったタスクの再開の欄", () => {
  it("テストのコマンドを選ぶと入力欄が出て、入れたコマンドを送る", async () => {
    renderForm();
    expect(container.querySelector("#test-command")).toBeNull();
    act(() => radio("command")?.click());
    const input = container.querySelector<HTMLInputElement>("#test-command");
    expect(input).not.toBeNull();
    if (input) act(() => typeInto(input, "make check"));
    expect(await submit()).toEqual({ taskId: "t1", tests: "command", testCommand: "make check" });
  });

  it("テストなしを選ぶと理由の欄が出て（既定の文が入っている）、書き直した理由を送る", async () => {
    renderForm();
    act(() => radio("none")?.click());
    const reason = container.querySelector<HTMLTextAreaElement>("#no-tests-reason");
    expect(reason?.value).toBe(messagesFor("ja").parts.resume.tests.reasonDefault);
    if (reason) act(() => typeInto(reason, "スキルを集めたリポジトリ"));
    expect(await submit()).toEqual({
      taskId: "t1",
      tests: "none",
      noTestsReason: "スキルを集めたリポジトリ",
    });
  });

  it("決めずに再開すると、テストの扱いを空で送る", async () => {
    renderForm();
    expect(await submit()).toEqual({ taskId: "t1", tests: "" });
  });

  it("不具合の修正では、テストなしを選べない", () => {
    renderForm(true);
    expect(radio("none")?.disabled).toBe(true);
  });
});
