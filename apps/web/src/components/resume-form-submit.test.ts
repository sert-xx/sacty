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
type ResumeStepSetting = import("./resume-form").ResumeStepSetting;

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

function renderForm(bugfix = false, steps?: ResumeStepSetting[]) {
  act(() =>
    root.render(
      h(ResumeForm, {
        taskId: "t1",
        reason: "error",
        usedUsd: 0,
        capUsd: 10,
        tests: { bugfix, rechoose: true },
        ...(steps ? { steps } : {}),
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
    expect(await submit()).toEqual({
      taskId: "t1",
      tests: "command",
      testCommand: "make check",
      note: "",
    });
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
      note: "",
    });
  });

  it("決めずに再開すると、テストの扱いを空で送る", async () => {
    renderForm();
    expect(await submit()).toEqual({ taskId: "t1", tests: "", note: "" });
  });

  it("不具合の修正では、テストなしを選べない", () => {
    renderForm(true);
    expect(radio("none")?.disabled).toBe(true);
  });
});

describe("再開の欄の補足と工程の設定", () => {
  const images = [
    { name: "default", description: "既定" },
    { name: "java", description: "Java 17" },
  ];
  const agents = [{ id: "claude" }, { id: "strong" }];
  const steps: ResumeStepSetting[] = [
    {
      step: "implement",
      image: "default",
      imageOptions: images,
      agent: { current: "claude", options: agents },
    },
    { step: "integrate", image: "default", imageOptions: images },
  ];
  const select = (name: string) =>
    container.querySelector<HTMLSelectElement>(`select[name="${name}"]`);

  it("補足と、選び直した工程のイメージ・エージェントを送る（今の名前を初めに選んでおく）", async () => {
    renderForm(false, steps);
    act(() => radio("command")?.click());
    const command = container.querySelector<HTMLInputElement>("#test-command");
    if (command) act(() => typeInto(command, "npm test"));
    const note = container.querySelector<HTMLTextAreaElement>("#resume-note");
    if (note) act(() => typeInto(note, "ACME_TOKEN を使う"));
    expect(select("image:implement")?.value).toBe("default");
    expect(select("agent:implement")?.value).toBe("claude");
    // 統合レビューは、エージェントを変えられない
    expect(select("agent:integrate")).toBeNull();
    const image = select("image:implement");
    if (image) image.value = "java";
    const agent = select("agent:implement");
    if (agent) agent.value = "strong";
    expect(await submit()).toMatchObject({
      note: "ACME_TOKEN を使う",
      "image:implement": "java",
      "agent:implement": "strong",
      "image:integrate": "default",
    });
  });

  it("テストを決めずに再開する（工程の選択からやり直す）ときは、工程の設定を出さない", async () => {
    renderForm(false, steps);
    expect(container.querySelector('[data-testid="resume-steps-rechoose"]')).not.toBeNull();
    expect(select("image:implement")).toBeNull();
    act(() => radio("command")?.click());
    expect(select("image:implement")).not.toBeNull();
  });
});
