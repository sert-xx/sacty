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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildErrorReport, cell, fence } from "./error-report.js";
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

describe("表のセル", () => {
  it("1行にし、バックスラッシュと | をエスケープする（中身の \\| で表の区切りが崩れない）", () => {
    expect(cell("a|b\nc")).toBe("a\\|b c");
    expect(cell("C:\\path\\|x")).toBe("C:\\\\path\\\\\\|x");
  });
});

describe("レビューの指摘（PR #254）", () => {
  it("デプロイの確認は unhealthy を確認の不合格にし、確認の実行そのものの失敗は失敗にする", () => {
    const checked = (payload: Record<string, unknown>) =>
      failureKind(
        ev({
          type: "DeploymentChecked",
          payload: { agentId: "o", ...payload },
        } as EventInput),
      );
    expect(checked({ result: "unhealthy", runResult: "completed" })).toBe("check");
    expect(checked({ result: "unknown", failed: "スキルを読めない", runResult: "failed" })).toBe(
      "error",
    );
    expect(checked({ result: "healthy", runResult: "completed" })).toBeUndefined();
  });

  it("エラーが多くても、分析・最新のエラーの詳細・最新の概要の行は残し、古い概要の行を省く", () => {
    const { activity } = failedTask();
    const many = [...activity];
    const failuresFrom = many.length;
    for (let i = 0; i < 1000; i++) {
      many.push(
        ev(
          {
            type: "IssueCommentFailed",
            payload: { message: `failure-${i} ${"y".repeat(300)}` },
          },
          "sacty",
        ),
      );
    }
    many.push(
      ev({ type: "ErrorAnalysisRequested", payload: { analysisId: "A-1" } }, "person"),
      ev(
        {
          type: "ErrorAnalyzed",
          payload: {
            analysisId: "A-1",
            analysis: "### 原因の推定\nコメントの権限が無い",
            runResult: "completed",
            agentId: "o",
          },
        },
        "orchestrator",
      ),
    );
    // レポートは作業履歴の記録を読むだけなので、投影できない記録（取り込み元の無いタスクのコメントの失敗）も並べられる
    const task = project([...many.slice(0, failuresFrom), ...many.slice(failuresFrom + 1000)]).get(
      "t1",
    ) as Task;
    const report = buildErrorReport({ task, activity: many, generatedAt: "now", locale: "ja" });
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(256_000);
    expect(report).not.toContain("（レポートの大きさの上限に達したため");
    expect(report).toContain("コメントの権限が無い");
    expect(report).toContain("### 1002. 失敗：IssueCommentFailed");
    expect(report).toMatch(/\| 1002 \| .*message=failure-999 /);
    expect(report).toMatch(/大きさの上限のため、古い \d+ 件を省きました/);
  });

  it("実行中のログの写しも、UTF-8 のバイト数で末尾を切り、途中の行を読まない", () => {
    const { task, activity } = failedTask();
    const log = store.open(
      {
        taskId: "t1",
        runId: "run-1",
        role: "requirements",
        agentId: "claude",
        runtime: "claude-code",
        authMode: "api-key",
      },
      () => [],
    );
    // 日本語の1行は約 3,000 バイト（1,000 文字）
    log.stdout(
      `${Array.from({ length: 10 }, (_, i) => say(`行${i}${"あ".repeat(1000)}`)).join("\n")}\n`,
    );
    const report = buildErrorReport({
      task,
      activity,
      logs: store,
      generatedAt: "now",
      locale: "ja",
      limits: { logReadBytes: 7_000 },
    });
    // 末尾の 7,000 バイトに入るのは、最後の2行だけ（途中の行は捨てる）
    expect(report).toContain("メッセージ 2・");
    expect(report).toContain("（ログが大きいので、末尾");
    expect(report).not.toContain("raw ");
    log.close({ kind: "completed", output: "" } as Parameters<typeof log.close>[0]);
  });
});

describe("レビューの指摘（PR #254 の再レビュー）", () => {
  it("要約が入りきらない実行が続いても、ログを読むのは新しい実行から summarizedRuns 件まで", () => {
    const { task, activity } = failedTask();
    const logs = [];
    for (let i = 0; i < 100; i++) {
      const log = store.open(
        {
          taskId: "t1",
          runId: `run-x${String(i).padStart(3, "0")}`,
          role: "implement",
          agentId: "claude",
          runtime: "claude-code",
          authMode: "api-key",
        },
        () => [],
      );
      log.stdout(`${say(`実行 ${i} ${"ぜ".repeat(500)}`)}\n`);
      logs.push(log);
    }
    const snapshot = vi.spyOn(store, "snapshot");
    const report = buildErrorReport({
      task,
      activity,
      logs: store,
      generatedAt: "now",
      locale: "ja",
      limits: { totalBytes: 12_000, summarizedRuns: 10 },
    });
    // 実行中の実行（いまの写し）を読んだのは10件まで。読まなかった実行は、省いた数に入れる
    expect(snapshot.mock.calls.length).toBeLessThanOrEqual(10);
    expect(report).toMatch(/大きさの上限のため、古い \d+ 件の実行の要約を省きました/);
    for (const log of logs)
      log.close({ kind: "completed", output: "" } as Parameters<typeof log.close>[0]);
  });
});

describe("レビューの指摘（PR #254 の3回目のレビュー）", () => {
  it("デーモンが止まって閉じられなかった実行も、起動し直した後のレポートに保存済みのログを入れ、そのことを書く", () => {
    const { task, activity } = failedTask();
    // 閉じる前にデーモンが止まった（終わりの記録が無い）実行
    const log = store.open(
      {
        taskId: "t1",
        runId: "run-1",
        role: "requirements",
        agentId: "claude",
        runtime: "claude-code",
        authMode: "api-key",
      },
      () => [],
    );
    log.stdout(`${[say("依存関係を入れます"), toolError("npm ERR! network")].join("\n")}\n`);
    log.stderr("fatal: lost connection\n");
    const snapshot = log.snapshot();
    expect(snapshot).toBeDefined();
    // 起動し直したデーモン（ログの置き場所は同じで、開いている実行は無い）
    const restarted = new SessionLogStore(join(dir, "runs"));
    expect(restarted.snapshot("t1", "run-1")).toBeUndefined();
    const report = buildErrorReport({
      task,
      activity,
      logs: restarted,
      generatedAt: "now",
      locale: "ja",
    });
    expect(report).not.toContain("この実行のセッションログはありません。");
    expect(report).toContain("tool-error npm ERR! network");
    expect(report).toContain("fatal: lost connection");
    expect(report).toContain("デーモンが止まって閉じられなかった実行の、保存済みのログです");
    expect(report).toContain("| 1 | run-1 | requirements |");
    expect(report).toContain("終わりの記録なし");
    log.close({ kind: "completed", output: "" } as Parameters<typeof log.close>[0]);
  });
});
