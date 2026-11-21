import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import { buildStepPullRequestBodyText } from "./prompts.js";
import { type SactyApi, startTaskMcp, summarizeTask } from "./task-mcp.js";
import { dbPath, makeService, useTempDir } from "./testing/daemon.js";

/** 承認待ちの成果物の「確認したいこと」を MCP で読む（PBI-475）。 */

useTempDir();

/** 実際に作ったタスク（要約に要る欄が全部ある）を土台にする。 */
function baseTask(): Task {
  const activity = new SqliteActivityStore(dbPath);
  const { service } = makeService(activity, []);
  const task = service.createTask({ projectId: "default", title: "決済" });
  const found = structuredClone(service.get(task.id)?.task) as Task;
  activity.close();
  return found;
}

const section = (must: string[], should: string[]) =>
  [
    "# 成果物",
    "",
    "## 確認したいこと",
    "",
    "**must**",
    "",
    ...(must.length > 0 ? must.map((m) => `- ${m}`) : ["なし"]),
    "",
    "**should**",
    "",
    ...(should.length > 0 ? should.map((m) => `- ${m}`) : ["なし"]),
    "",
    "## 次",
  ].join("\n");

function taskOf(step: string, output: string, extra: Record<string, unknown> = {}): Task {
  return {
    ...baseTask(),
    status: "awaiting_approval",
    outputs: { [step]: output },
    gate: { step, submission: 2 },
    ...extra,
  } as unknown as Task;
}

const withPr = {
  stepPullRequests: [
    {
      step: "design",
      submission: 2,
      number: 9,
      url: "https://github.com/a/b/pull/9",
      repo: "https://github.com/a/b",
      commit: "c1",
      branch: "b",
      state: "open",
    },
  ],
};

async function connect(task: Task | undefined) {
  const none = (): never => {
    throw new Error("呼ばれない");
  };
  const api = {
    getTask: async () => (task ? { task, activity: [] } : undefined),
    webUrl: () => undefined,
    listTasks: async () => (task ? [task] : []),
    waitingSince: async () => ({}),
    listProjects: none,
  } as unknown as SactyApi;
  const [a, b] = InMemoryTransport.createLinkedPair();
  startTaskMcp(api, { version: "9.9.9", transport: a });
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = { task_id: "t-1" }) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      isError: r.isError === true,
      text: (r.content as { text: string }[])[0]?.text ?? "",
      data: r.structuredContent as Record<string, unknown> & {
        questions?: { kind: string; text: string }[];
      },
    };
  };
  return call;
}

describe("get_step_questions（PBI-475）", () => {
  it("承認待ちの設計の問いを、件数と問いごとの文で読める。step・submission は approval と同じ", async () => {
    const task = taskOf(
      "design",
      section(["通貨を決めるか"], ["文言を直すか", "表を足すか"]),
      withPr,
    );
    const call = await connect(task);
    const r = await call("get_step_questions");
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      step: "design",
      submission: 2,
      status: "counted",
      must: 1,
      should: 2,
    });
    expect(r.data.questions?.map((q) => q.kind)).toEqual(["must", "should", "should"]);
    expect(r.data.questions?.[0]?.text).toContain("通貨を決めるか");
    expect(r.data.omittedQuestions).toBeUndefined();
    const summary = summarizeTask(task);
    expect(summary.approval).toMatchObject({ step: "design", submission: 2 });
  });

  it("問いが「なし」の成果物は none で、questions は空", async () => {
    const call = await connect(taskOf("requirements", section([], [])));
    const r = await call("get_step_questions");
    expect(r.data.status).toBe("none");
    expect(r.data.questions).toEqual([]);
  });

  it("節が無い成果物は「読み取れませんでした」で、問いは無いと返さない。全文は get_deliverable で読める", async () => {
    const call = await connect(taskOf("design", "# 設計\n\n本文だけ"));
    const r = await call("get_step_questions");
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("unreadable");
    expect(r.data.content).toBeUndefined();
    expect(r.data.questions).toEqual([]);
    expect(r.text).toContain("読み取れませんでした");
    expect(r.text).toContain("get_deliverable");
    expect(r.data.status).not.toBe("none");
  });

  it("must・should の札が無く箇条書きだけの節は、本文を添えて unreadable。件数は返さない", async () => {
    const call = await connect(
      taskOf(
        "design",
        ["# 設計", "", "## 確認したいこと", "", "- 通貨を決めるか", "- 期限を決めるか"].join("\n"),
      ),
    );
    const r = await call("get_step_questions");
    expect(r.data.status).toBe("unreadable");
    expect(r.data.content).toContain("通貨を決めるか");
    expect(r.data.must).toBeUndefined();
    expect(r.data.should).toBeUndefined();
  });

  it("PR の本文の件数と食い違わない（同じ readStepQuestions を使う）", async () => {
    const output = section(["a", "b", "c"], ["d", "e"]);
    const task = taskOf("design", output, withPr);
    const call = await connect(task);
    const r = await call("get_step_questions");
    const body = buildStepPullRequestBodyText(task, "design", "docs/x.md").main;
    expect(body).toContain(`must ${String(r.data.must)}件・should ${String(r.data.should)}件`);
    expect([r.data.must, r.data.should]).toEqual([3, 2]);
  });

  it("1件 1000 文字・各 20 件で切り、省いたことを返す", async () => {
    const long = "あ".repeat(1001);
    const musts = [long, ...Array.from({ length: 20 }, (_, i) => `問い${String(i)}`)];
    const call = await connect(taskOf("design", section(musts, []), withPr));
    const r = await call("get_step_questions");
    expect(r.data.must).toBe(21);
    expect(r.data.questions).toHaveLength(20);
    expect(r.data.omittedQuestions).toBe(1);
    expect(r.data.questions?.[0]?.text).toBe(`${"あ".repeat(1000)}\n…（以下 1 文字を省略）`);
  });

  it("上限の境界：ちょうど 1000 文字・各 20 件は切らず、should も 20 件で切り、省いた件数は合計する", async () => {
    const exact = "あ".repeat(1000);
    const musts = [exact, ...Array.from({ length: 19 }, (_, i) => `m${String(i)}`)];
    const shoulds = Array.from({ length: 22 }, (_, i) => `s${String(i)}`);
    const call = await connect(taskOf("design", section(musts, shoulds), withPr));
    const r = await call("get_step_questions");
    const qs = r.data.questions ?? [];
    expect(qs.filter((q) => q.kind === "must")).toHaveLength(20);
    expect(qs.filter((q) => q.kind === "should")).toHaveLength(20);
    expect(qs[0]?.text).toBe(exact);
    expect(r.data.omittedQuestions).toBe(2);
  });

  it("承認待ちの要求要件・設計が無いタスクは、失敗にして get_task で確かめる案内を返す", async () => {
    const out = section(["x"], []);
    const cases: Task[] = [
      taskOf("implement", out),
      taskOf("design", out, { status: "running", gate: undefined }),
      taskOf("design", out, { status: "escalated", escalation: { step: "design" } }),
    ];
    for (const task of cases) {
      const call = await connect(task);
      const r = await call("get_step_questions");
      expect(r.isError).toBe(true);
      expect(r.text).toContain("承認待ちの要求要件・設計の工程がありません");
      expect(r.text).toContain("status");
      expect(r.text).toContain("approval");
    }
  });

  it("答え方が承認の手段に合う（PR：コメントとマージ、PR の無い工程：request_changes と approve_step）", async () => {
    const out = section(["x"], []);
    const pr = (await (await connect(taskOf("design", out, withPr)))("get_step_questions")).data
      .howToAnswer as string;
    expect(pr).toContain("PR");
    expect(pr).toContain("コメント");
    expect(pr).toContain("マージ");
    expect(pr).toContain("推奨の答え");
    const direct = (await (await connect(taskOf("design", out)))("get_step_questions")).data
      .howToAnswer as string;
    expect(direct).toContain("request_changes");
    expect(direct).toContain("comments");
    expect(direct).toContain("approve_step");
    expect(direct).toContain("推奨の答え");
    expect(direct).not.toContain("PR にコメント");
  });
});

describe("要約の stepQuestions（PBI-475）", () => {
  it("承認待ちの要求要件・設計だけに、問いの有無と件数が出る", async () => {
    const out = section(["x"], ["y", "z"]);
    expect(summarizeTask(taskOf("design", out)).stepQuestions).toEqual({
      status: "counted",
      must: 1,
      should: 2,
    });
    expect(summarizeTask(taskOf("requirements", section([], []))).stepQuestions).toEqual({
      status: "none",
    });
    expect(summarizeTask(taskOf("design", "# 設計")).stepQuestions).toEqual({
      status: "unreadable",
    });
    expect(summarizeTask(taskOf("implement", out)).stepQuestions).toBeUndefined();
    expect(
      summarizeTask(taskOf("design", out, { status: "escalated", escalation: { step: "design" } }))
        .stepQuestions,
    ).toBeUndefined();
  });

  it("get_task にも同じ欄が出る", async () => {
    const call = await connect(taskOf("design", section(["x"], ["y", "z"])));
    const r = await call("get_task");
    expect(r.data.stepQuestions).toEqual({ status: "counted", must: 1, should: 2 });
  });
});
