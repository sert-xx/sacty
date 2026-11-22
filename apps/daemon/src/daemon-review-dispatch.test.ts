import { join } from "node:path";
import { REVIEW_UNDISPATCHED_RETRIES } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { ConfigResult } from "./config.js";
import { buildReviewBody } from "./prompts.js";
import type { TaskService } from "./service.js";
import { SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
  appendLegacy,
  configOf,
  dbPath,
  dir,
  type FakeExecutor,
  FakePulls,
  ja,
  makeService,
  useTempDir,
} from "./testing/daemon.js";

useTempDir();

/**
 * PR のレビューが、観点ごとの担当（サブエージェント）を起動しなかったときの扱い（PBI-379）。エージェントのセッションの
 * ファイルは、形だけを写した架空の内容で作る。
 */
describe("担当を 1 件も起動しなかった PR のレビューは、採らずにやり直す（PBI-379）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const verdict = (v: string) =>
    `\`\`\`json\n${JSON.stringify({ "sacty-review-verdict": { verdict: v } })}\n\`\`\``;
  const pr = (number: number) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `PR ${number}`,
    body: "本文",
    url: `https://github.com/acme/app/pull/${number}`,
    labels: ["sacty-review"],
    pullRequest: true,
  });
  const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  const toolUse = (id: string, name: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  });
  /** Claude Code の親のセッション：スキルを読み、担当を n 件起動した。 */
  const session = (subagents: number) => ({
    "projects/-workspace/s1.jsonl": jsonl([
      toolUse("t0", "Skill"),
      ...Array.from({ length: subagents }, (_, i) => toolUse(`a${i}`, "Agent")),
    ]),
  });
  /** 実行の出力の最初の出来事（使えるツールの一覧）。 */
  const init = (tools: string[]) =>
    `${JSON.stringify({ type: "system", subtype: "init", tools })}\n`;

  /** 実行ごとに、起動した担当の数（counts の順。尽きたら最後の数）でセッションのファイルを書かせる。 */
  function start(
    outcomes: AgentOutcome[],
    counts: number[],
    options: {
      tools?: string[];
      config?: () => ConfigResult;
      secrets?: Record<string, string>;
    } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const made = makeService(activity, outcomes, {
      pulls,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
      sessionLogs: new SessionLogStore(join(dir, "runs")),
      ...(options.config ? { config: options.config } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
    });
    let run = 0;
    made.executor.sessionFiles = () => session(counts[Math.min(run++, counts.length - 1)] ?? 0);
    made.executor.logLines = () => init(options.tools ?? ["Task", "Bash", "Read"]);
    const [task] = made.service.importIssues([pr(9)]);
    return { ...made, activity, pulls, id: task?.id ?? "" };
  }
  /** 投稿する本文に、Sacty の過程の情報（エージェント・担当の数・切り替え・タスクの ID）が出ないこと（PBI-460）。 */
  const expectNoProcessInfo = (body: string | undefined) => {
    // 先頭の目印（表示されない HTML コメント）は、タスクの ID を含んでよい
    const visible = (body ?? "").replace(/^<!-- sacty-review:[^>]*-->\n/, "");
    expect(visible).toContain("AI がレビューしました（人間は確認していません）。");
    for (const word of [
      "レビューしたエージェント",
      "Claude Code",
      "Codex",
      "担当",
      "サブエージェント",
      "切り替え",
      "Sacty のタスク",
    ]) {
      expect(visible).not.toContain(word);
    }
  };
  const failures = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunFailed" ? [e.payload] : [],
    );
  const prompt = (executor: FakeExecutor, i: number) => executor.calls[i]?.command.join(" ") ?? "";

  it.each(["差分", "主対象の文書"])(
    "%s を読めず取得を再試行した結果は、判定なしで投稿する",
    async (missing) => {
      const body = `総評\n\nレビューを完了できませんでした。${missing}を読めませんでした。取得して確認してください。`;
      const { service, pulls, activity, id } = start([out(body)], [1]);
      await service.runNext(id);
      expect(service.get(id)?.task.reviewVerdicts).toEqual([{ round: 1, missing: "absent" }]);
      expect(failures(service, id)).toHaveLength(0);
      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(1);
      expect(pulls.reviews[0]?.body).toContain(body);
      expect(pulls.reviews[0]?.body).toContain("判定：付いていません");
      activity.close();
    },
  );

  it("担当を起動しなかった実行は、判定を採らず、PR に投稿せず、止めずにやり直す。次の実行には、前の回が担当を起動しなかったことを伝える", async () => {
    const { service, executor, pulls, activity, id } = start(
      [out(`# 1回目\n${verdict("no_findings")}`), out(`# 2回目\n${verdict("suggestions")}`)],
      [0, 17],
    );
    await service.runNext(id);
    const first = service.get(id)?.task;
    // 止めずに実行待ちに戻す。判定も本文も採らない
    expect(first?.status).toBe("queued");
    expect(first?.reviewVerdicts).toBeUndefined();
    expect(first?.outputs.review).toBeUndefined();
    expect(first?.reviewUndispatched).toEqual({ runs: 1, sinceResume: 1 });
    const [failed] = failures(service, id);
    expect(failed?.reviewDispatch).toEqual({ subagents: 0, runtime: "claude-code" });
    expect(failed?.costUsd).toBeGreaterThan(0);
    expect(ja(failed?.message)).toBe(
      "レビューが、観点ごとの担当（サブエージェント）を 1 件も起動しませんでした。この結果は使わず、PR にも投稿しません。担当を起動するよう、レビューをやり直します（やり直し 1/3 回目）。",
    );
    expect(pulls.reviews).toHaveLength(0);
    // 1回目の指示には、やり直しの知らせは無い（担当を起動する手順は、毎回ある）
    expect(prompt(executor, 0)).not.toContain("【やり直し】");
    expect(prompt(executor, 0)).toContain("references/pr-review.md");

    await service.runNext(id);
    expect(prompt(executor, 1)).toContain(
      "【やり直し】この PR のレビューは、直前まで 1 回、観点ごとの担当（サブエージェント）を 1 件も起動せずに本文を書いたため",
    );
    const second = service.get(id)?.task;
    expect(second?.reviewVerdicts).toEqual([{ round: 1, verdict: "suggestions" }]);
    expect(second?.reviewDispatch).toEqual({
      round: 1,
      agentId: "claude-subscription",
      runtime: "claude-code",
      subagents: 17,
    });
    expect(second?.reviewUndispatched).toBeUndefined();
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(pulls.reviews[0]?.body).toContain("# 2回目");
    expect(pulls.reviews[0]?.body).not.toContain("# 1回目");
    // 動いたエージェントと担当の数は、本文に書かず、作業履歴の記録（画面と get_task で読む）に残す
    expectNoProcessInfo(pulls.reviews[0]?.body);
    // 公開されうる PR の本文には、利用者が付けた設定の名前（エージェントの ID）を出さない
    expect(pulls.reviews[0]?.body).not.toContain("claude-subscription");
    activity.close();
  });

  it(`やり直しは ${REVIEW_UNDISPATCHED_RETRIES} 回まで。それでも起動しなければ、理由を付けて一時停止する。人が再開すると、もう一度上限まで試す`, async () => {
    const zero = () => out(`# 担当なし\n${verdict("no_findings")}`);
    const { service, executor, pulls, activity, id } = start(
      [zero(), zero(), zero(), zero(), zero(), out(`# 起動した\n${verdict("no_findings")}`)],
      [0, 0, 0, 0, 0, 3],
    );
    // 最初の実行と、やり直し 3 回
    for (let i = 0; i < REVIEW_UNDISPATCHED_RETRIES; i++) {
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("queued");
    }
    await service.runNext(id);
    const paused = service.get(id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("error");
    expect(ja(paused?.pausedMessage)).toBe(
      "担当（サブエージェント）を 1 件も起動しないレビューが、4 回続きました。どの回の結果も使わず、PR にも投稿していません。レビューの工程のエージェントを変えるなどしてから、再開してください（再開すると、もう一度レビューします）。",
    );
    expect(paused?.reviewUndispatched).toEqual({ runs: 4, sinceResume: 4 });
    expect(executor.calls).toHaveLength(4);
    expect(pulls.reviews).toHaveLength(0);
    // 止まった後は、実行しない
    await service.runNext(id);
    expect(executor.calls).toHaveLength(4);

    // 人が再開すると、もう一度試す（上限は数え直す。前の回が起動しなかったことは、伝え続ける）
    service.resume(id, {});
    expect(service.get(id)?.task.reviewUndispatched).toEqual({ runs: 4, sinceResume: 0 });
    await service.runNext(id);
    expect(prompt(executor, 4)).toContain("直前まで 4 回");
    expect(service.get(id)?.task.status).toBe("queued");
    expect(service.get(id)?.task.reviewUndispatched).toEqual({ runs: 5, sinceResume: 1 });
    await service.runNext(id);
    expect(service.get(id)?.task.reviewDispatch?.subagents).toBe(3);
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(pulls.reviews[0]?.body).toContain("# 起動した");
    activity.close();
  });

  it("担当を起動する手段があったと確かめられない実行（スキルの逐次モード）は、0 件でも今までどおり通し、本文にそう書く", async () => {
    const { service, pulls, activity, id } = start(
      [out(`# 逐次\n${verdict("no_findings")}`)],
      [0],
      // 使えるツールに、担当を起動するツールが無い
      { tools: ["Bash", "Read"] },
    );
    await service.runNext(id);
    expect(failures(service, id)).toEqual([]);
    expect(service.get(id)?.task.reviewDispatch).toEqual({
      round: 1,
      agentId: "claude-subscription",
      runtime: "claude-code",
      subagents: 0,
    });
    await service.runNext(id);
    expectNoProcessInfo(pulls.reviews[0]?.body);
    activity.close();
  });

  it("数えられない実行（セッションのファイルを写していない）は、分からないと記録して、やり直しにしない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    // セッションログの場所はあるが、エージェントのファイルは写されない
    const { service } = makeService(activity, [out(`# 評価\n${verdict("no_findings")}`)], {
      pulls,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
      sessionLogs: new SessionLogStore(join(dir, "runs")),
    });
    const [task] = service.importIssues([pr(9)]);
    const id = task?.id ?? "";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await service.runNext(id);
      // 数えられなかった理由を、デーモンのログに 1 行出す（タスクと実行の ID と、理由の種類だけ。本文は出さない）
      const runId = service
        .get(id)
        ?.activity.flatMap((e) => (e.type === "AgentRunCompleted" ? [e.payload.runId] : []))[0];
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("担当の数"));
      expect(lines).toEqual([
        `[daemon] PR のレビューが起動した担当の数を、数えられませんでした（タスク ${id}・実行 ${runId}・種類 claude-code・理由 no_parent_session）。担当を起動したかを確かめずに、レビューを使います。`,
      ]);
      expect(lines.join("")).not.toContain("評価");
    } finally {
      warn.mockRestore();
    }
    expect(failures(service, id)).toEqual([]);
    expect(service.get(id)?.task.reviewDispatch).toEqual({
      round: 1,
      agentId: "claude-subscription",
      runtime: "claude-code",
      subagents: null,
    });
    await service.runNext(id);
    expectNoProcessInfo(pulls.reviews[0]?.body);
    activity.close();
  });

  it("設定のエージェントが使えず、切り替え先で動いた回は、モデルと合わせて、そう記録して本文に書く", async () => {
    const backup = agent({
      id: "claude-api",
      auth: { mode: "api-key", secret: "anthropic-key" },
      model: "model-b",
    });
    const main = agent({ fallback: ["claude-api"] });
    const config = (): ConfigResult => {
      const base = configOf(main)();
      return base.ok
        ? { ok: true, config: { ...base.config, agents: { [main.id]: main, [backup.id]: backup } } }
        : base;
    };
    const limited: AgentOutcome = {
      kind: "failed",
      reason: "usage_limit",
      message: "You've hit your session limit",
    };
    const { service, pulls, activity, id } = start(
      [limited, out(`# 2回目の結果\n${verdict("no_findings")}`)],
      [0, 5],
      {
        config,
        secrets: { "claude-oauth-token": "oauth-secret", "anthropic-key": "sk-ant-secret" },
      },
    );
    // 利用制限で失敗した実行は、担当の数とは関係なく、今までどおり切り替える
    await service.runNext(id);
    expect(failures(service, id)[0]?.reviewDispatch).toBeUndefined();
    expect(service.get(id)?.task.reviewUndispatched).toBeUndefined();
    await service.runNext(id);
    expect(service.get(id)?.task.reviewDispatch).toEqual({
      round: 1,
      agentId: "claude-api",
      runtime: "claude-code",
      model: "model-b",
      configuredAgentId: "claude-subscription",
      subagents: 5,
    });
    await service.runNext(id);
    expectNoProcessInfo(pulls.reviews[0]?.body);
    expect(pulls.reviews[0]?.body).not.toContain("model-b");
    // 設定の名前（切り替え前のものも）は、本文に出さない（画面に出すために、タスクには持つ）
    expect(pulls.reviews[0]?.body).not.toContain("claude-api");
    expect(pulls.reviews[0]?.body).not.toContain("claude-subscription");
    activity.close();
  });

  it("デーモンを起動し直しても、採らなかった実行の数を作業履歴から復元して、やり直しの上限を数え続ける", async () => {
    const zero = () => out(`# 担当なし\n${verdict("no_findings")}`);
    const first = start([zero(), zero()], [0]);
    await first.service.runNext(first.id);
    await first.service.runNext(first.id);
    expect(first.service.get(first.id)?.task.reviewUndispatched).toEqual({
      runs: 2,
      sinceResume: 2,
    });
    first.activity.close();

    // 同じ作業履歴から、新しいデーモンを起動する
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const { service, executor } = makeService(activity, [zero(), zero()], {
      pulls,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
      sessionLogs: new SessionLogStore(join(dir, "runs")),
    });
    executor.sessionFiles = () => session(0);
    executor.logLines = () => init(["Task", "Bash"]);
    const id = first.id;
    expect(service.get(id)?.task.reviewUndispatched).toEqual({ runs: 2, sinceResume: 2 });
    expect(service.get(id)?.task.status).toBe("queued");
    // やり直しの 3 回目（通算 3 回目の 0 件）は、まだ止めない
    await service.runNext(id);
    expect(prompt(executor, 0)).toContain("直前まで 2 回");
    expect(service.get(id)?.task.status).toBe("queued");
    // 通算 4 回目の 0 件で止まる（起動し直しで、上限が増えない）
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.reviewUndispatched).toEqual({ runs: 4, sinceResume: 4 });
    expect(pulls.reviews).toHaveLength(0);
    activity.close();
  });

  it("Codex の実行も、親の rollout の spawn_agent で数える。0 件はやり直し、1 件以上は採って、本文にエージェントの種類を書く", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const rollout = (spawned: number) => ({
      "sessions/2026/01/02/rollout-2026-01-02T03-04-05-parent.jsonl": jsonl([
        { type: "session_meta", payload: { id: "th", source: "exec" } },
        { type: "turn_context", payload: { cwd: "/workspace", multi_agent_version: "v2" } },
        ...Array.from({ length: spawned }, (_, i) => ({
          type: "response_item",
          payload: { type: "function_call", name: "spawn_agent", id: `c${i}`, arguments: "{}" },
        })),
      ]),
      // 担当の rollout（親の履歴を引き継いでいても、数えない）
      "sessions/2026/01/02/rollout-2026-01-02T03-05-00-child.jsonl": jsonl([
        { type: "session_meta", payload: { id: "ch", source: { subagent: {} } } },
        { type: "response_item", payload: { type: "function_call", name: "spawn_agent", id: "x" } },
      ]),
    });
    const { service, executor, pulls, activity, id } = start(
      [
        out(`# 1回目の結果\n${verdict("no_findings")}`),
        out(`# 2回目の結果\n${verdict("no_findings")}`),
      ],
      [0],
      {
        config: configOf(codex),
        secrets: { "openai-key": "sk-secret", "github-token": "ghp_secret" },
      },
    );
    const counts = [0, 19];
    let run = 0;
    executor.sessionFiles = () => rollout(counts[Math.min(run++, counts.length - 1)] ?? 0);
    await service.runNext(id);
    expect(failures(service, id)[0]?.reviewDispatch).toEqual({ subagents: 0, runtime: "codex" });
    expect(service.get(id)?.task.status).toBe("queued");
    expect(pulls.reviews).toHaveLength(0);
    await service.runNext(id);
    expect(service.get(id)?.task.reviewDispatch).toEqual({
      round: 1,
      agentId: "codex-key",
      runtime: "codex",
      subagents: 19,
    });
    await service.runNext(id);
    expectNoProcessInfo(pulls.reviews[0]?.body);
    expect(pulls.reviews[0]?.body).not.toContain("codex-key");
    activity.close();
  });

  it("0 件の実行の間に、別の理由の失敗が挟まっても、採らなかった実行の数は消えない（数えるのは 0 件の実行だけ）", async () => {
    const broken: AgentOutcome = { kind: "failed", reason: "error", message: "boom" };
    const zero = () => out(`# 担当なし\n${verdict("no_findings")}`);
    const { service, executor, activity, id } = start([zero(), broken, zero()], [0]);
    await service.runNext(id);
    expect(service.get(id)?.task.reviewUndispatched).toEqual({ runs: 1, sinceResume: 1 });
    // 別の理由の失敗：今までどおり止まる（代わりのエージェントが無い）。0 件の実行には数えない
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(failures(service, id)[1]?.reviewDispatch).toBeUndefined();
    expect(service.get(id)?.task.reviewUndispatched).toEqual({ runs: 1, sinceResume: 1 });
    service.resume(id, {});
    await service.runNext(id);
    // 再開の後の 0 件は、やり直しの 1 回目として数える。前の回が起動しなかったことは伝え続ける
    expect(prompt(executor, 2)).toContain("直前まで 1 回");
    expect(service.get(id)?.task.status).toBe("queued");
    expect(service.get(id)?.task.reviewUndispatched).toEqual({ runs: 2, sinceResume: 1 });
    activity.close();
  });

  it("担当の数の記録が無い実行（これより前の作業履歴）は、そのまま読め、前の回の記録を今回のものとして残さず、本文にも書かない", async () => {
    const { service, pulls, activity, id } = start(
      [out(`# 1回目\n${verdict("no_findings")}`)],
      [17],
    );
    await service.runNext(id);
    await service.runNext(id);
    expect(service.get(id)?.task.reviewDispatch?.subagents).toBe(17);
    pulls.prInfo = { ...pulls.prInfo, headSha: "n".repeat(40) };
    service.rereview(id);
    // 再レビューの回を、以前の版が記録した形（reviewDispatch が無い）で足す
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 };
    appendLegacy(service, id, [
      {
        actor: "sacty",
        event: {
          type: "AgentRunStarted",
          payload: {
            runId: "legacy-run",
            step: "review",
            agentId: "claude-subscription",
            authMode: "subscription",
          },
        },
      },
      {
        actor: "agent",
        event: {
          type: "AgentRunCompleted",
          payload: {
            runId: "legacy-run",
            step: "review",
            agentId: "claude-subscription",
            authMode: "subscription",
            usage,
            costUsd: 0,
            estimated: false,
            output: "# 2回目",
            reviewVerdict: "no_findings",
          },
        },
      },
    ]);
    const task = service.get(id)?.task;
    expect(task?.reviewRound).toBe(2);
    expect(task?.reviewDispatch).toBeUndefined();
    expect(task && buildReviewBody(task)).toContain("# 2回目");
    expectNoProcessInfo(task && buildReviewBody(task));
    activity.close();
  });

  it("本文の末尾は AI の印だけで、エージェントの製品名・モデル・切り替え・担当・サブエージェント・タスクの ID を出さない（PBI-460）", async () => {
    const { service, activity, id } = start([out(`# 評価\n${verdict("no_findings")}`)], [5]);
    await service.runNext(id);
    const task = service.get(id)?.task;
    if (!task?.reviewDispatch) throw new Error("no review dispatch");
    const withDispatch = {
      ...task,
      reviewDispatch: {
        ...task.reviewDispatch,
        runtime: "claude-code",
        model: "model-b",
        configuredAgentId: "claude-subscription",
        subagents: 5,
      },
    } as never;
    const body = buildReviewBody(withDispatch);
    expect(body.endsWith("---\nAI がレビューしました（人間は確認していません）。")).toBe(true);
    expectNoProcessInfo(body);
    for (const word of ["model-b", "claude-subscription", id]) {
      expect(body.replace(/^<!-- sacty-review:[^>]*-->\n/, "")).not.toContain(word);
    }
    // 作業履歴の記録には残る（画面と get_task で読む）
    expect(task.reviewDispatch).toMatchObject({ runtime: "claude-code", subagents: 5 });
    activity.close();
  });
});
