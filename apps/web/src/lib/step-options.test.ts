import { describe, expect, it, vi } from "vitest";
import {
  agentField,
  chosenForPlan,
  customizedSteps,
  fetchStepOptions,
  imageField,
  planStepSettings,
  stepChoicesFrom,
  stepOptionsLoader,
} from "./step-options";

describe("タスクの作成で、工程ごとに指定するイメージ・エージェント", () => {
  it("進め方の工程を並べ、統合レビューのエージェントは指定できない", () => {
    expect(planStepSettings("split")).toEqual([
      { step: "requirements", agent: true },
      { step: "design", agent: true },
      { step: "split", agent: true },
      { step: "integrate", agent: false },
    ]);
  });

  it("進め方を選び直しても工程ごとの指定は残し、今の進め方の工程の分だけを送る", () => {
    const images = { design: "java", implement: "java", investigate: "python" };
    const agents = { implement: "strong", integrate: "strong" };
    expect(chosenForPlan("standard", images, agents)).toEqual({
      images: { design: "java", implement: "java" },
      agents: { implement: "strong" },
    });
    expect(chosenForPlan("direct", images, agents)).toEqual({
      images: { implement: "java" },
      agents: { implement: "strong" },
    });
    // 統合レビューのエージェントは送らない
    expect(chosenForPlan("split", images, agents)).toEqual({
      images: { design: "java" },
      agents: {},
    });
    expect(customizedSteps("standard", images, agents)).toEqual(["design", "implement"]);
    expect(customizedSteps("investigate", {}, {})).toEqual([]);
  });

  it("フォームの工程ごとの項目を読み、空欄は指定しないことにする", () => {
    const data = new FormData();
    data.set(imageField("design"), "java");
    data.set(imageField("implement"), "");
    data.set(agentField("implement"), "strong");
    data.set("image:bogus", "x");
    expect(stepChoicesFrom(data)).toEqual({
      images: { design: "java" },
      agents: { implement: "strong" },
    });
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
