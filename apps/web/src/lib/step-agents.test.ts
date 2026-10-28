import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { stepAgentOptions, stepAgentRows } from "./labels";

const task = (extra: Partial<Task> = {}): Task =>
  ({
    status: "idle",
    steps: [
      { key: "requirements", state: "done" },
      { key: "integrate", state: "todo" },
      { key: "implement", state: "todo" },
    ],
    ...extra,
  }) as unknown as Task;

describe("工程のエージェントの欄（PBI-121）", () => {
  it("config.yaml で決まる名前と、人が変えた名前・日時・前の名前を出し、統合レビューは出さない", () => {
    const rows = stepAgentRows(
      task({
        agents: { implement: "strong" },
        agentChanges: { implement: { from: "claude", to: "strong", at: "2026-10-17T00:00:00Z" } },
      }),
      { requirements: "claude", implement: "claude", integrate: "guardian" },
    );
    expect(rows.map((r) => r.step)).toEqual(["requirements", "implement"]);
    expect(rows[0]).toMatchObject({ agent: "claude", source: { by: "config" }, when: "done" });
    expect(rows[1]).toMatchObject({
      agent: "strong",
      source: { by: "person", from: "claude", at: "2026-10-17T00:00:00Z" },
      when: "next",
    });
  });

  it("人が作成時に指定したエージェントは、そのことを出し、後で人が変えたら人の変更を出す", () => {
    const requested = { requestedAgents: { implement: "strong" }, agents: { implement: "strong" } };
    expect(stepAgentRows(task(requested), { implement: "claude" })[1]).toMatchObject({
      agent: "strong",
      source: { by: "request" },
    });
    const changed = stepAgentRows(
      task({
        ...requested,
        agents: { implement: "weak" },
        agentChanges: { implement: { from: "strong", to: "weak", at: "2026-10-17T00:00:00Z" } },
      }),
      { implement: "claude" },
    );
    expect(changed[1]).toMatchObject({ agent: "weak", source: { by: "person", from: "strong" } });
  });

  it("状態を取れなければ、人が選んでいない工程の名前は不明にする", () => {
    const rows = stepAgentRows(task(), undefined);
    expect(rows[0]).not.toHaveProperty("agent");
  });

  it("選択肢は、状態を取れない・設定を読めないときは無い。stub は今のエージェントが stub のときだけ出す", () => {
    const agents = [
      { id: "claude", runtime: "claude-code" },
      { id: "stub", runtime: "stub" },
    ];
    expect(stepAgentOptions(undefined, "claude")).toBeUndefined();
    expect(stepAgentOptions({ problems: ["x"], agents }, "claude")).toBeUndefined();
    expect(stepAgentOptions({ problems: [] }, "claude")).toBeUndefined();
    expect(stepAgentOptions({ problems: [], agents }, "claude")?.map((a) => a.id)).toEqual([
      "claude",
    ]);
    expect(stepAgentOptions({ problems: [], agents }, "stub")?.map((a) => a.id)).toEqual([
      "claude",
      "stub",
    ]);
  });
});
