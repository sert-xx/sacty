// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * 差し戻しのフォームの、差し戻しと一緒に変える工程のイメージ・エージェント。折りたたみを開くと候補を読み、やり直す工程から
 * 後ろの工程の選択を出し、選んだ値がフォームの値として Server Action に渡ることを、実際の操作で確かめる。
 */
const gateAction = vi.fn(async (_prev: unknown, _data: FormData) => ({}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/app/actions", () => ({ gateAction }));

const { GateForm } = await import("./gate-form");
type GateStepSetting = import("./gate-form").GateStepSetting;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(() => {
  gateAction.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        images: [
          { name: "default", description: "既定" },
          { name: "java", description: "Java 17" },
        ],
        agents: [{ id: "claude" }, { id: "strong", model: "claude-opus-5-5" }],
        stepAgents: { requirements: "claude", design: "claude", implement: "claude" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const steps: GateStepSetting[] = [
  { step: "requirements", image: "default", agentChangeable: true },
  { step: "design", image: "default", agentChangeable: true, agent: "strong" },
  { step: "implement", image: "java", agentChangeable: true },
  { step: "integrate", image: "default", agentChangeable: false },
];

function renderForm(withSteps: GateStepSetting[] = steps) {
  act(() =>
    root.render(
      h(GateForm, {
        taskId: "t1",
        step: "design",
        submission: 1,
        targets: ["design", "requirements"],
        defaultTarget: "design",
        escalated: false,
        maxChanges: 3,
        pendingComments: [],
        steps: withSteps,
      }),
    ),
  );
}

async function openSteps() {
  const details = container.querySelector<HTMLDetailsElement>('[data-testid="gate-steps"]');
  // 開くと、toggle のイベントが（非同期に）起きる
  await act(async () => {
    if (details) details.open = true;
    await new Promise((resolve) => setTimeout(resolve));
  });
}

const select = (name: string) =>
  container.querySelector<HTMLSelectElement>(`select[name="${name}"]`);

async function submit() {
  const form = container.querySelector("form");
  await act(async () => {
    form?.requestSubmit();
  });
  const data = gateAction.mock.calls.at(-1)?.[1];
  return data ? Object.fromEntries(data.entries()) : undefined;
}

describe("差し戻しの原因（PBI-268）", () => {
  const radios = () =>
    [...container.querySelectorAll<HTMLInputElement>('input[name="cause"]')].map((r) => r.value);

  it("原因は、選ばない（既定）・見逃し・新しい要望・競合から選べ、選んだ値を渡す", async () => {
    renderForm();
    expect(radios()).toEqual(["", "guardian_missed", "new_request", "base_changed"]);
    expect(container.querySelector<HTMLInputElement>('input[name="cause"]:checked')?.value).toBe(
      "",
    );
    expect(await submit()).toMatchObject({ cause: "" });
  });

  it("選んだ原因を渡す", async () => {
    renderForm();
    const base = container.querySelector<HTMLInputElement>(
      'input[name="cause"][value="base_changed"]',
    );
    act(() => base?.click());
    expect(await submit()).toMatchObject({ cause: "base_changed" });
  });

  it("差し戻しに失敗したら、選んでいた原因を戻す", async () => {
    gateAction.mockResolvedValueOnce({ message: "断られた", cause: "new_request" } as never);
    renderForm();
    await submit();
    expect(container.querySelector<HTMLInputElement>('input[name="cause"]:checked')?.value).toBe(
      "new_request",
    );
  });
});

describe("差し戻しと一緒に変える工程の設定", () => {
  it("開くまで候補を読まず、開くとやり直す工程から後ろの工程を、今の名前を選んで出す", async () => {
    renderForm();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(select("image:design")).toBeNull();
    await openSteps();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // やり直す工程（設計）より前の要求要件は出さない
    expect(select("image:requirements")).toBeNull();
    expect(select("image:design")?.value).toBe("default");
    // 人が選んだエージェントが無ければ、config.yaml で決まるもの
    expect(select("agent:design")?.value).toBe("strong");
    expect(select("agent:implement")?.value).toBe("claude");
    expect(select("image:implement")?.value).toBe("java");
    // 統合レビューは、エージェントを変えられない
    expect(select("image:integrate")).not.toBeNull();
    expect(select("agent:integrate")).toBeNull();
  });

  it("やり直す工程を前に選び直すと、その工程から出す", async () => {
    renderForm();
    await openSteps();
    const radio = container.querySelector<HTMLInputElement>(
      'input[name="target"][value="requirements"]',
    );
    act(() => radio?.click());
    expect(select("image:requirements")?.value).toBe("default");
    expect(select("agent:requirements")?.value).toBe("claude");
  });

  it("選び直した工程の設定を、描いたときの今の名前と一緒に送る", async () => {
    renderForm();
    await openSteps();
    const image = select("image:design");
    if (image) image.value = "java";
    const agent = select("agent:implement");
    if (agent) agent.value = "strong";
    expect(await submit()).toMatchObject({
      target: "design",
      "image:design": "java",
      "image-from:design": "default",
      "agent:implement": "strong",
      "agent-from:implement": "claude",
    });
  });

  it("差し戻しに失敗したら、選んでいた工程の設定を戻す", async () => {
    gateAction.mockResolvedValueOnce({
      message: "断られた",
      images: { design: "java" },
      agents: { design: "claude" },
    } as never);
    renderForm();
    await openSteps();
    await submit();
    expect(container.textContent).toContain("断られた");
    expect(select("image:design")?.value).toBe("java");
    expect(select("agent:design")?.value).toBe("claude");
  });

  it("候補を読めなければ、理由と、変えずに差し戻せることを出す", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "設定を読めない" }), { status: 503 }),
    );
    renderForm();
    await openSteps();
    expect(container.textContent).toContain("設定を読めない");
    expect(container.textContent).toContain("工程の設定は変えずに差し戻せます");
    expect(select("image:design")).toBeNull();
  });
});

describe("実装の PR がベースブランチと競合しているとき", () => {
  const renderPr = (conflicting: boolean) =>
    act(() =>
      root.render(
        h(GateForm, {
          taskId: "t1",
          step: "implement",
          submission: 1,
          targets: ["implement"],
          defaultTarget: "implement",
          escalated: false,
          maxChanges: 3,
          pendingComments: [],
          pullRequest: {
            number: 12,
            url: "https://github.com/acme/app/pull/12",
            closed: false,
            mergedOutdated: false,
            conflicting,
          },
        }),
      ),
    );
  const notice = () => container.querySelector('[data-testid="gate-pr-conflict"]');

  it("競合していることと、取り込むための操作（差し戻す・PR に指摘を書く）を出し、解消されたら消す", () => {
    renderPr(true);
    expect(notice()?.textContent).toContain("競合は自動では取り込みません");
    expect(notice()?.textContent).toContain("差し戻");
    expect(notice()?.textContent).toContain("PR に指摘を書くと取り込みます");
    // 差し戻しのボタンは、そのまま使える
    expect(container.querySelector('button[value="request"]')).not.toBeNull();
    renderPr(false);
    expect(notice()).toBeNull();
  });
});
