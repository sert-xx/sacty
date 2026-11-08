import { describe, expect, it, vi } from "vitest";
import {
  agentField,
  agentFromField,
  changedStepChoices,
  chosenForPlan,
  customizedSteps,
  fetchStepOptions,
  IMAGE_FIELD,
  IMAGE_FROM_FIELD,
  planStepSettings,
  stepChoicesFrom,
  stepOptionsLoader,
} from "./step-options";

describe("タスクの作成で指定するタスクのイメージと、工程ごとのエージェント（PBI-318）", () => {
  it("進め方の工程を並べ、統合レビューのエージェントは指定できない", () => {
    expect(planStepSettings("split")).toEqual([
      { step: "requirements", agent: true },
      { step: "design", agent: true },
      { step: "split", agent: true },
      { step: "integrate", agent: false },
    ]);
  });

  it("進め方を選び直してもエージェントの指定は残し、今の進め方の工程の分だけを送る", () => {
    const agents = { implement: "strong", integrate: "strong", investigate: "fast" };
    expect(chosenForPlan("standard", agents)).toEqual({ implement: "strong" });
    expect(chosenForPlan("direct", agents)).toEqual({ implement: "strong" });
    // 統合レビューのエージェントは送らない
    expect(chosenForPlan("split", agents)).toEqual({});
    expect(customizedSteps("standard", agents)).toEqual(["implement"]);
    expect(customizedSteps("investigate", {})).toEqual([]);
  });

  it("フォームのタスクのイメージ（1つ）と工程ごとのエージェントを読み、空欄は指定しないことにする", () => {
    const data = new FormData();
    data.set(IMAGE_FIELD, "java");
    data.set(agentField("implement"), "strong");
    data.set(agentField("design"), "");
    // 古い版の工程ごとのイメージの項目は読まない
    data.set("image:design", "python");
    expect(stepChoicesFrom(data)).toEqual({ image: "java", agents: { implement: "strong" } });
    const empty = new FormData();
    empty.set(IMAGE_FIELD, "");
    expect(stepChoicesFrom(empty)).toEqual({ agents: {} });
  });

  it("再開・差し戻しでは、描いたときの今の名前から変えたものだけを返す", () => {
    const data = new FormData();
    data.set(IMAGE_FROM_FIELD, "default");
    data.set(IMAGE_FIELD, "default");
    data.set(agentFromField("implement"), "claude");
    data.set(agentField("implement"), "strong");
    expect(changedStepChoices(data)).toEqual({ agents: { implement: "strong" } });
    data.set(IMAGE_FIELD, "java");
    expect(changedStepChoices(data)).toEqual({ image: "java", agents: { implement: "strong" } });
    // 今の名前が無い（古い版の工程ごとのイメージ）ときに選んだら、変えたことにする
    const legacy = new FormData();
    legacy.set(IMAGE_FIELD, "default");
    expect(changedStepChoices(legacy)).toEqual({ image: "default", agents: {} });
  });

  it("候補を読み、読めなければ理由を返す（投げない）", async () => {
    const ok = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            images: [{ name: "default", description: "既定" }],
            agents: [{ id: "claude" }],
            stepAgents: { implement: "claude" },
          }),
        ),
    );
    expect(await fetchStepOptions("応答なし", ok as unknown as typeof fetch)).toEqual({
      status: "loaded",
      images: [{ name: "default", description: "既定" }],
      agents: [{ id: "claude" }],
      stepAgents: { implement: "claude" },
    });
    const failed = vi.fn(
      async () => new Response(JSON.stringify({ message: "読めません" }), { status: 503 }),
    );
    expect(await fetchStepOptions("応答なし", failed as unknown as typeof fetch)).toEqual({
      status: "failed",
      message: "読めません",
    });
    const thrown = vi.fn(async () => {
      throw new Error("x");
    });
    expect(await fetchStepOptions("応答なし", thrown as unknown as typeof fetch)).toEqual({
      status: "failed",
      message: "応答なし",
    });
  });

  it("開くたびに読むが、読めた後は読み直さない。読めなかったら読み直し、開き直したら前の結果を捨てる", async () => {
    let resolve: (value: { status: "failed"; message: string }) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<{ status: "failed"; message: string }>((r) => {
          resolve = r;
        }),
    );
    const loader = stepOptionsLoader(load);
    const set = vi.fn();
    loader("x", set);
    loader("x", set);
    expect(load).toHaveBeenCalledTimes(1);
    resolve({ status: "failed", message: "だめ" });
    await Promise.resolve();
    expect(set).toHaveBeenLastCalledWith({ status: "failed", message: "だめ" });
    // 読めなかったら、もう一度開いたときに読み直す
    loader("x", set);
    expect(load).toHaveBeenCalledTimes(2);
    // 開き直したら、遅れて届いた結果を捨てる
    loader.cancel();
    set.mockClear();
    resolve({ status: "failed", message: "古い" });
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();
  });
});
