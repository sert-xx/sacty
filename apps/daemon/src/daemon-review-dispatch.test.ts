import { join } from "node:path";
import { REVIEW_UNDISPATCHED_RETRIES } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { ConfigResult } from "./config.js";
import type { TaskService } from "./service.js";
import { SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
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
  const failures = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunFailed" ? [e.payload] : [],
    );
  const prompt = (executor: FakeExecutor, i: number) => executor.calls[i]?.command.join(" ") ?? "";

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
    expect(failed?.reviewDispatch).toEqual({ subagents: 0 });
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
      subagents: 17,
    });
    expect(second?.reviewUndispatched).toBeUndefined();
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(pulls.reviews[0]?.body).toContain("# 2回目");
    expect(pulls.reviews[0]?.body).not.toContain("# 1回目");
    expect(pulls.reviews[0]?.body).toContain(
      "レビューしたエージェント：`claude-subscription`。観点ごとの担当（サブエージェント）を 17 件起動しました。",
    );
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
      subagents: 0,
    });
    await service.runNext(id);
    expect(pulls.reviews[0]?.body).toContain(
      "観点ごとの担当（サブエージェント）は起動していません（担当を起動する手段があることを、sacty が確かめられなかった実行です）。",
    );
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
    await service.runNext(id);
    expect(failures(service, id)).toEqual([]);
    expect(service.get(id)?.task.reviewDispatch).toEqual({
      round: 1,
      agentId: "claude-subscription",
      subagents: null,
    });
    await service.runNext(id);
    expect(pulls.reviews[0]?.body).toContain(
      "観点ごとの担当（サブエージェント）の起動の数は、確かめられませんでした。",
    );
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
      [limited, out(`# 切り替え先\n${verdict("no_findings")}`)],
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
      model: "model-b",
      configuredAgentId: "claude-subscription",
      subagents: 5,
    });
    await service.runNext(id);
    expect(pulls.reviews[0]?.body).toContain(
      "レビューしたエージェント：`claude-api`（`model-b`）。設定のエージェント `claude-subscription` が使えなかったため、切り替え先で実行しました。観点ごとの担当（サブエージェント）を 5 件起動しました。",
    );
    activity.close();
  });
});
