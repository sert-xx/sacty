import type { ActivityEvent } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { parseSessionLog, runLogId, runRoleKey } from "./session-log";

const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("セッションログの並べ方（PBI-62）", () => {
  it("Claude Code の考えたこと・ツールの呼び出しと結果・答え・最終結果を読む", () => {
    const entries = parseSessionLog(
      `${jsonl(
        {
          type: "system",
          subtype: "init",
          model: "claude-opus",
          tools: ["Bash", "Read"],
          cwd: "/workspace",
        },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "まず一覧を見る" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "a.txt" }],
              },
              { type: "tool_result", tool_use_id: "t2", content: "denied", is_error: true },
            ],
          },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "終わりました" }] } },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "# 成果",
          num_turns: 2,
          total_cost_usd: 0.01,
          usage: { input_tokens: 5, output_tokens: 6 },
        },
      )}\n`,
    );
    expect(entries.map((e) => e.kind)).toEqual([
      "session",
      "thinking",
      "toolCall",
      "toolResult",
      "toolResult",
      "message",
      "result",
    ]);
    expect(entries[0]).toMatchObject({ text: "claude-opus · tools=2 · /workspace" });
    expect(entries[2]).toMatchObject({ name: "Bash", input: '{\n  "command": "ls"\n}' });
    expect(entries[3]).toMatchObject({ text: "a.txt", isError: false });
    expect(entries[4]).toMatchObject({ text: "denied", isError: true });
    expect(entries[6]).toMatchObject({
      kind: "result",
      isError: false,
      text: "# 成果",
      detail: "success · turns=2 · cost=$0.01 · input_tokens=5 output_tokens=6",
    });
  });

  it("Codex の項目は終わった行で出し、終わらないまま止まった項目は始まった行で出す", () => {
    const entries = parseSessionLog(
      jsonl(
        { type: "thread.started", thread_id: "th" },
        { type: "turn.started" },
        { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } },
        {
          type: "item.completed",
          item: {
            id: "c1",
            type: "command_execution",
            command: "ls",
            aggregated_output: "x",
            exit_code: 2,
          },
        },
        { type: "item.completed", item: { id: "r1", type: "reasoning", text: "考え" } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "答え" } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
        {
          type: "item.started",
          item: { id: "c2", type: "command_execution", command: "sleep 99" },
        },
        {
          type: "item.updated",
          item: { id: "c2", type: "command_execution", command: "sleep 99" },
        },
        { type: "turn.failed", error: { message: "stream disconnected" } },
      ),
    );
    expect(entries.map((e) => e.kind)).toEqual([
      "session",
      "toolCall",
      "toolResult",
      "thinking",
      "message",
      "turn",
      "toolCall",
      "error",
    ]);
    expect(entries[2]).toMatchObject({ text: "x\n(exit 2)", isError: true });
    expect(entries[6]).toMatchObject({ input: "sleep 99", unfinished: true, line: 9 });
    expect(entries[7]).toMatchObject({ text: "stream disconnected" });
  });

  it("知らない形の行・壊れた JSON・JSON でない行は生の行で出し、切り詰めの目印を読む", () => {
    const entries = parseSessionLog(
      [
        "warning: plain text",
        '{"type":"assistant","message":{"content":[{"type":"te',
        '{"type":"something_new","x":1}',
        "",
        '{"type":"sacty.truncated","droppedBytes":42,"droppedLines":3,"headBytes":100,"tailBytes":50}',
      ].join("\n"),
    );
    expect(entries).toEqual([
      { line: 1, kind: "raw", text: "warning: plain text" },
      { line: 2, kind: "raw", text: '{"type":"assistant","message":{"content":[{"type":"te' },
      { line: 3, kind: "raw", text: '{"type":"something_new","x":1}' },
      {
        line: 5,
        kind: "truncated",
        droppedBytes: 42,
        droppedLines: 3,
        headBytes: 100,
        tailBytes: 50,
      },
    ]);
    expect(parseSessionLog("")).toEqual([]);
  });

  it("作業履歴の実行の行から、実行の ID を取り出す（ID の無い古い行・実行でない行は無い）", () => {
    const event = (type: string, payload: unknown) =>
      ({ id: 1, taskId: "t", at: "", actor: "sacty", type, payload }) as unknown as ActivityEvent;
    expect(runLogId(event("AgentRunStarted", { runId: "r1" }))).toBe("r1");
    expect(runLogId(event("AgentRunFailed", { runId: "r2" }))).toBe("r2");
    expect(runLogId(event("ChangeJudged", { runId: "r3" }))).toBe("r3");
    expect(runLogId(event("ChangeJudged", {}))).toBeUndefined();
    expect(runLogId(event("AiRequestsRetried", { runId: "r4" }))).toBeUndefined();
    // 写したエージェントの元のファイルの記録からも、その実行の画面に行ける（PBI-66）
    expect(runLogId(event("AgentSessionArchived", { runId: "r6", files: [] }))).toBe("r6");
    expect(runLogId(event("TaskPaused", { runId: "r5" }))).toBeUndefined();
    // エラーの分析の実行の行からも、その実行の画面に行ける
    expect(runLogId(event("ErrorAnalyzed", { runId: "r7" }))).toBe("r7");
  });

  it("エラーの分析の実行は、セッションログの役割（chat）を作業履歴から読み替える", () => {
    const event = (type: string) =>
      ({
        id: 1,
        taskId: "t",
        at: "",
        actor: "orchestrator",
        type,
        payload: {},
      }) as unknown as ActivityEvent;
    expect(runRoleKey("chat", [event("ErrorAnalyzed")])).toBe("error-analysis");
    expect(runRoleKey("chat", [event("QuestionAnswered")])).toBe("chat");
    expect(runRoleKey("implement", [])).toBe("implement");
  });
});
