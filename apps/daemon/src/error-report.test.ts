import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityEvent,
  EventInput,
  failureKind,
  hasFailures,
  MVP_STEPS,
  project,
  type Task,
} from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildErrorReport, fence } from "./error-report.js";
import { SessionLogStore } from "./session-logs.js";

let dir: string;
let store: SessionLogStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-error-report-"));
  store = new SessionLogStore(join(dir, "runs"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const ev = (input: EventInput, actor: ActivityEvent["actor"] = "sacty") =>
  ({
    ...EventInput.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId: "t1",
    projectId: "p1",
    actor,
    at: `2026-10-29T00:00:${String(seq).padStart(2, "0")}.000Z`,
  }) as ActivityEvent;

/** 要求要件の実行が失敗して止まったタスク。 */
function failedTask(): { task: Task; activity: ActivityEvent[] } {
  seq = 0;
  const activity = [
    ev(
      { type: "TaskCreated", payload: { title: "ログインを直す", body: "body", start: "sacty" } },
      "person",
    ),
    ev({ type: "StepsChosen", payload: { steps: [...MVP_STEPS] } }, "orchestrator"),
    ev({
      type: "AgentRunStarted",
      payload: { runId: "run-1", step: "requirements", agentId: "claude", authMode: "api-key" },
    }),
    ev(
      {
        type: "AgentRunFailed",
        payload: {
          runId: "run-1",
          step: "requirements",
          agentId: "claude",
          reason: "error",
          message: "コンテナが終了コード 1 で止まりました",
          costUsd: 0.12,
        },
      },
      "agent",
    ),
    ev({ type: "TaskPaused", payload: { reason: "error" } }),
  ];
  const task = project(activity).get("t1") as Task;
  return { task, activity };
}

function writeRun(lines: string[], stderr = "") {
  const log = store.open(
    {
      taskId: "t1",
      runId: "run-1",
      role: "requirements",
      agentId: "claude",
      runtime: "claude-code",
      authMode: "api-key",
      model: "sonnet",
    },
    () => [],
  );
  log.stdout(`${lines.join("\n")}\n`);
  if (stderr) log.stderr(stderr);
  log.close({
    kind: "failed",
    reason: "error",
    message: "exit 1",
  } as Parameters<typeof log.close>[0]);
}

const assistantTool = (name: string, input: unknown) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  });
const toolError = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: text, is_error: true }] },
  });
const say = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

describe("エラーとして扱う記録", () => {
  it("失敗・止まった（人が止めたものを除く）・確認の不合格を分け、分析そのものは数えない", () => {
    const { activity } = failedTask();
    expect(activity.map(failureKind)).toEqual([undefined, undefined, undefined, "error", "stop"]);
    expect(hasFailures(activity)).toBe(true);
    expect(failureKind(ev({ type: "TaskPaused", payload: { reason: "manual" } }))).toBeUndefined();
    expect(
      failureKind(
        ev({
          type: "TestsRun",
          payload: {
            command: "npm test",
            exitCode: 1,
            unmappedViewpoints: [],
            passed: false,
            output: "",
            durationMs: 1,
          },
        }),
      ),
    ).toBe("check");
    expect(
      failureKind(
        ev(
          {
            type: "ErrorAnalyzed",
            payload: {
              analysisId: "A-1",
              failed: "x",
              runResult: "failed",
              agentId: "o",
            },
          },
          "orchestrator",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("エラーレポート", () => {
  it("基本の情報・エラーの概要と詳細・エージェントの動き・作業履歴を書く", () => {
    const { task, activity } = failedTask();
    writeRun(
      [
        say("要求要件を読みます"),
        assistantTool("Bash", { command: "npm test" }),
        toolError("Error: Cannot find module 'left-pad'"),
        say("依存関係が足りません"),
      ],
      "fatal: something broke\n",
    );
    const report = buildErrorReport({
      task,
      activity,
      projectName: "acme",
      logs: store,
      generatedAt: "2026-10-29T01:00:00.000Z",
      locale: "ja",
    });
    expect(report).toContain("# エラーレポート：ログインを直す");
    expect(report).toContain("- プロジェクト：acme（p1）");
    expect(report).toContain("- 一時停止の理由：error");
    expect(report).toContain("エラーの記録：2 件");
    // 詳細は新しいものから。失敗の実行には、標準エラー出力とエージェントの最後の動きを添える
    expect(report.indexOf("### 2. 停止")).toBeLessThan(report.indexOf("### 1. 失敗"));
    expect(report).toContain("fatal: something broke");
    expect(report).toContain("tool-error Error: Cannot find module 'left-pad'");
    expect(report).toContain("message=コンテナが終了コード 1 で止まりました");
    // 実行の一覧と要約
    expect(report).toContain("| 1 | run-1 | requirements | claude / sonnet |");
    expect(report).toContain("メッセージ 2・ツールの呼び出し 1（失敗 1）・エラー 0");
    expect(report).toContain("よく使ったツール：Bash×1");
    expect(report).toContain("最後のメッセージ：依存関係が足りません");
    // 作業履歴
    expect(report).toContain("## 作業履歴（sacty の処理）");
    expect(report).toMatch(/- 4 \S+ agent AgentRunFailed ⚠/);
    // 分析はまだ
    expect(report).toContain("まだ分析していません");
  });

  it("英語の見出しでも書ける。セッションログが無い実行は、そのことを書く", () => {
    const { task, activity } = failedTask();
    const report = buildErrorReport({
      task,
      activity,
      generatedAt: "2026-10-29T01:00:00.000Z",
      locale: "en",
    });
    expect(report).toContain("# Error report: ログインを直す");
    expect(report).toContain("- Pause reason: error");
    expect(report).toContain("## Summary of errors");
    expect(report).toContain("There is no session log for this run.");
  });

  it("オーケストレーターの分析があれば入れ、分析の指示に渡すときは入れない", () => {
    const { activity } = failedTask();
    const all = [
      ...activity,
      ev({ type: "ErrorAnalysisRequested", payload: { analysisId: "A-1" } }, "person"),
      ev(
        {
          type: "ErrorAnalyzed",
          payload: {
            analysisId: "A-1",
            analysis: "### 原因の推定\n依存関係の不足",
            runResult: "completed",
            agentId: "o",
          },
        },
        "orchestrator",
      ),
    ];
    const task = project(all).get("t1") as Task;
    const base = { task, activity: all, generatedAt: "now", locale: "ja" as const };
    expect(buildErrorReport(base)).toContain("### 原因の推定\n依存関係の不足");
    const forPrompt = buildErrorReport({ ...base, includeAnalysis: false });
    expect(forPrompt).not.toContain("## オーケストレーターの分析");
    // 分析の記録はエラーに数えない
    expect(forPrompt).toContain("エラーの記録：2 件");
  });

  it("全体の大きさの上限を守り、作業履歴は先頭と新しいものを残して間を省く", () => {
    const { activity } = failedTask();
    const many = [...activity];
    for (let i = 0; i < 400; i++) {
      many.push(ev({ type: "BudgetWarned", payload: { usedUsd: i, capUsd: 1000 } }));
    }
    const task = project(many).get("t1") as Task;
    writeRun(Array.from({ length: 200 }, (_, i) => say(`step ${i} ${"x".repeat(2000)}`)));
    const report = buildErrorReport({
      task,
      activity: many,
      logs: store,
      generatedAt: "now",
      locale: "ja",
      limits: { totalBytes: 30_000 },
    });
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(30_000);
    expect(report).toMatch(/… 間の \d+ 件を省きました …/);
    expect(report).toContain("TaskCreated");
    expect(report).toContain(`- ${many.at(-1)?.seq} `);
    // 長い出来事は1件ごとに切り詰める
    expect(report).not.toContain("x".repeat(1000));
  });
});

describe("フェンス", () => {
  it("中身の ` の並びより長いフェンスで囲む", () => {
    expect(fence("a\n```\nb")).toBe("````\na\n```\nb\n````");
    expect(fence("plain", "json")).toBe("```json\nplain\n```");
  });
});
