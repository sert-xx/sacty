import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor } from "./agents/docker.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { type AgentConfig, type ConfigResult, loadConfig } from "./config.js";
import { SqliteLedgerStore } from "./ledger.js";
import { MemorySecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-test-"));
  dbPath = join(dir, "sacty.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "claude-subscription",
  runtime: "claude-code",
  auth: { mode: "subscription", secret: "claude-oauth-token" },
  price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 },
  price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  ...overrides,
});

const configOf =
  (a: AgentConfig, budgetPerTaskUsd = 1): (() => ConfigResult) =>
  () => ({
    ok: true,
    config: { image: "sacty-agent:test", defaultAgent: a, guardianAgent: a, budgetPerTaskUsd },
  });

/** 決まった結果を順に返す偽物の実行器。渡された呼び出し内容も記録する。 */
class FakeExecutor implements AgentExecutor {
  calls: Invocation[] = [];
  /** 実行ごとにマウントした作業領域。 */
  dirs: string[] = [];
  constructor(private readonly outcomes: AgentOutcome[]) {}
  async run({
    invocation,
    workspaceDir,
  }: {
    invocation: Invocation;
    workspaceDir: string;
  }): Promise<AgentOutcome> {
    this.calls.push(invocation);
    this.dirs.push(workspaceDir);
    const next = this.outcomes.shift();
    if (!next) throw new Error("no more outcomes");
    return next;
  }
}

/** 100万出力トークン = $15 になる単価なので、output で費用を作る。 */
const completed = (outputTokens: number): AgentOutcome => ({
  kind: "completed",
  output: "# 要求要件",
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: outputTokens },
});

function makeService(
  ledger: SqliteLedgerStore,
  outcomes: AgentOutcome[] = [],
  options: { config?: () => ConfigResult; secrets?: Record<string, string> } = {},
) {
  const executor = new FakeExecutor(outcomes);
  const service = new TaskService({
    ledger,
    config: options.config ?? configOf(agent()),
    secrets: new MemorySecretStore(options.secrets ?? { "claude-oauth-token": "oauth-secret" }),
    executor,
    workspaceRoot: join(dir, "workspaces"),
  });
  return { service, executor };
}

/** 画面が表示している（いま承認待ちの）提出回。 */
const current = (svc: TaskService, id: string) => {
  const t = svc.get(id)?.task;
  const step = t?.gate?.step ?? t?.escalation?.step ?? "requirements";
  return t?.gate?.submission ?? t?.submissions[step] ?? 1;
};

describe("台帳", () => {
  it("UPDATEとDELETEを拒否する", () => {
    const ledger = new SqliteLedgerStore(dbPath);
    makeService(ledger).service.createTicket({ title: "A" });
    expect(() => ledger.rawExecForTest("UPDATE ledger SET type = 'x'")).toThrow(/append-only/);
    expect(() => ledger.rawExecForTest("DELETE FROM ledger")).toThrow(/append-only/);
    expect(ledger.all()).toHaveLength(2);
    ledger.close();
  });

  it("再起動しても同じ状態を復元する", async () => {
    const first = new SqliteLedgerStore(dbPath);
    const { service } = makeService(first, [completed(20_000)]);
    const created = service.createTicket({ title: "A", body: "B" });
    await service.runNext(created.id);
    const before = service.get(created.id)?.task;
    first.close();

    const second = new SqliteLedgerStore(dbPath);
    expect(makeService(second).service.get(created.id)?.task).toEqual(before);
    second.close();
  });
});

describe("工程の実行と費用", () => {
  it("実行すると、費用（換算値）と出力を台帳に記録して待機に戻る", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [completed(20_000)]);
    const task = service.createTicket({ title: "決済API", body: "冪等性" });
    expect(service.queuedTaskIds()).toEqual([task.id]);

    await service.runNext(task.id);
    const { task: after, ledger: events } = service.get(task.id) ?? {};
    expect(after?.status).toBe("awaiting_approval");
    expect(after?.budget.usedUsd).toBe(0.3);
    expect(after?.budget.estimated).toBe(true);
    expect(after?.outputs.requirements).toBe("# 要求要件");
    expect(events?.map((e) => e.type)).toEqual([
      "TaskCreated",
      "StepsChosen",
      "AgentRunStarted",
      "AgentRunCompleted",
      "StepSubmitted",
    ]);
    // 指示にチケットの内容が入っている
    expect(executor.calls[0]?.command.join(" ")).toContain("冪等性");
    ledger.close();
  });

  it("予算の80%で通知し、上限を超えたら次の実行の前に一時停止する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [completed(55_000), completed(70_000)]);
    const warned = service.createTicket({ title: "A" });
    const capped = service.createTicket({ title: "B" });

    await service.runNext(warned.id); // $0.825
    expect(service.get(warned.id)?.task.budget.warned).toBe(true);
    expect(service.get(warned.id)?.ledger.at(-1)?.type).toBe("BudgetWarned");

    await service.runNext(capped.id); // $1.05 → 承認待ちで止まる（人間の判断待ちなので、ここでは止めない）
    expect(service.get(capped.id)?.task.status).toBe("awaiting_approval");
    service.requestChanges(capped.id, {
      step: "requirements",
      submission: current(service, capped.id),
      comments: ["直して"],
    });
    await service.runNext(capped.id); // 実行前の判定で予算超過 → 実行しない
    expect(executor.calls).toHaveLength(2);
    expect(service.get(capped.id)?.task.status).toBe("paused");
    expect(service.get(capped.id)?.task.pausedReason).toBe("budget");
    ledger.close();
  });

  it("予算で止まったタスクは、使用済みより大きい上限でだけ再開できる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [completed(70_000)]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["直して"],
    });
    await service.runNext(task.id); // 予算超過で止まる

    expect(() => service.resume(task.id, {})).toThrow(/新しい上限が必要/);
    expect(() => service.resume(task.id, { capUsd: 1.05 })).toThrow(/より大きい金額/);
    const resumed = service.resume(task.id, { capUsd: 3 });
    expect(resumed.status).toBe("queued"); // まだ実行していないので、実行し直す
    expect(resumed.budget.capUsd).toBe(3);
    expect(() => service.resume(task.id, { capUsd: 5 })).toThrow(
      /一時停止中のタスクではありません/,
    );
    ledger.close();
  });

  it("実行前に予算を超えていれば、実行せずに止め、上限を上げると実行し直す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 70_000 }; // $1.05
    const { service, executor } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "429", usage },
      completed(1_000),
    ]);
    const task = service.createTicket({ title: "A" });

    await service.runNext(task.id); // 利用上限で失敗（費用は予算を超える）
    expect(service.resume(task.id, {}).status).toBe("queued");

    await service.runNext(task.id); // 実行前の判定で予算超過 → 実行しない
    expect(executor.calls).toHaveLength(1);
    expect(service.get(task.id)?.task.pausedReason).toBe("budget");

    // まだ実行していないので、上限を上げて再開すると実行し直す
    expect(service.resume(task.id, { capUsd: 3 }).status).toBe("queued");
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(2);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("利用上限で失敗したら一時停止し、再開すると実行し直す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "You've hit your session limit" },
      completed(1_000),
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const paused = service.get(task.id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("usage_limit");

    expect(service.resume(task.id, {}).status).toBe("queued");
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    expect(executor.calls).toHaveLength(2);
    ledger.close();
  });

  it("秘密情報が無ければ、認証エラーとして止める（値はどこにも出さない）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [], { secrets: {} });
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.pausedReason).toBe("auth");
    expect(executor.calls).toHaveLength(0);
    const failed = after?.ledger.find((e) => e.type === "AgentRunFailed");
    expect(JSON.stringify(failed)).toContain("sacty secret set claude-oauth-token");
    ledger.close();
  });

  it("設定が無ければ実行せず、理由を状態として返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [], {
      config: () => loadConfig(join(dir, "nope")),
    });
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("queued");
    expect(executor.calls).toHaveLength(0);
    expect(service.status().problems[0]).toMatch(/sacty config init/);
    ledger.close();
  });

  it("デーモンの停止で中断された実行は、再起動時に失敗として記録して一時停止する", () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger);
    const task = service.createTicket({ title: "A" });
    ledger.append({
      taskId: task.id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: { runId: "r1", step: "requirements", agentId: "a", authMode: "subscription" },
          },
        },
      ],
    });
    const { service: restarted } = makeService(ledger);
    restarted.recoverInterrupted();
    const after = restarted.get(task.id)?.task;
    expect(after?.status).toBe("paused");
    expect(after?.pausedReason).toBe("error");
    expect(restarted.resume(task.id, {}).status).toBe("queued");
    ledger.close();
  });
});

describe("秘密情報と予算の通知（レビュー指摘）", () => {
  it("出力・エラー文・例外に含まれた秘密情報を、台帳に残さない", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const leaked: AgentOutcome = {
      kind: "completed",
      output: "トークンは oauth-secret です",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
    };
    const { service } = makeService(ledger, [
      leaked,
      { kind: "failed", reason: "auth", message: "401 for oauth-secret" },
    ]);
    const a = service.createTicket({ title: "A" });
    const b = service.createTicket({ title: "B" });
    await service.runNext(a.id);
    await service.runNext(b.id);

    // 例外の経路
    const throwing = new TaskService({
      ledger,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor: {
        run: async () => {
          throw new Error("docker failed with oauth-secret");
        },
      },
      workspaceRoot: join(dir, "workspaces"),
    });
    const c = throwing.createTicket({ title: "C" });
    await throwing.runNext(c.id);

    const all = JSON.stringify(ledger.all());
    expect(all).not.toContain("oauth-secret");
    expect(all).toContain("[REDACTED]");
    ledger.close();
  });

  it("失敗した実行の費用でも、80%の通知を記録する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 57_000 }; // $0.855
    const { service } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "429", usage },
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.budget.warned).toBe(true);
    expect(after?.task.pausedReason).toBe("usage_limit");
    expect(after?.ledger.map((e) => e.type).slice(-3)).toEqual([
      "AgentRunFailed",
      "TaskPaused",
      "BudgetWarned",
    ]);
    ledger.close();
  });

  it("1回の実行で80%未満から上限を超えた場合も、通知を記録する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [completed(70_000)]); // $1.05
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    expect(
      service
        .get(task.id)
        ?.ledger.map((e) => e.type)
        .slice(-3),
    ).toEqual(["AgentRunCompleted", "StepSubmitted", "BudgetWarned"]);
    ledger.close();
  });

  it("空のキューを処理した後でも、作成・再開したタスクを実行する（回帰）", async () => {
    const { Worker } = await import("./worker.js");
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "429" },
      completed(1_000),
    ]);
    const worker = new Worker(service, 60_000);

    await worker.tick(); // 空のキュー
    const task = service.createTicket({ title: "A" });
    await worker.tick();
    expect(executor.calls).toHaveLength(1);
    expect(service.get(task.id)?.task.status).toBe("paused");

    await worker.tick(); // また空のキュー
    service.resume(task.id, {});
    await worker.tick();
    expect(executor.calls).toHaveLength(2);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("停止時は、実行中の処理が台帳に記録されるまで待つ", async () => {
    const { Worker } = await import("./worker.js");
    const ledger = new SqliteLedgerStore(dbPath);
    let finish: (o: AgentOutcome) => void = () => {};
    const service = new TaskService({
      ledger,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor: { run: () => new Promise<AgentOutcome>((resolve) => (finish = resolve)) },
      workspaceRoot: join(dir, "workspaces"),
    });
    const task = service.createTicket({ title: "A" });
    const worker = new Worker(service, 60_000);
    void worker.tick();
    await new Promise((r) => setTimeout(r, 20));
    let drained = false;
    const draining = worker.drain().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false); // まだ実行中
    finish({ kind: "failed", reason: "error", message: "中断" });
    await draining;
    expect(service.get(task.id)?.task.status).toBe("paused");
    ledger.close();
  });
});

describe("承認ゲート（PBI-7）", () => {
  const draft = (text: string, responses?: { remarkId: string; text: string }[]): AgentOutcome => ({
    kind: "completed",
    output: responses
      ? `${text}\n\n\`\`\`json\n${JSON.stringify({ "sacty-responses": responses })}\n\`\`\``
      : text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });

  it("要求要件を作ると承認待ちで止まり、承認すると設計が実行対象になって待機する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [draft("# 要求要件 v1")]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const waiting = service.get(task.id)?.task;
    expect(waiting?.status).toBe("awaiting_approval");
    expect(waiting?.gate).toEqual({ step: "requirements", submission: 1 });
    expect(service.queuedTaskIds()).toEqual([]);

    const approved = service.approve(task.id, {
      step: "requirements",
      submission: current(service, task.id),
    });
    expect(approved.status).toBe("queued"); // 設計の工程を実行する
    expect(approved.steps.map((s) => [s.key, s.state]).slice(0, 2)).toEqual([
      ["requirements", "done"],
      ["design", "active"],
    ]);
    expect(() =>
      service.approve(task.id, { step: "requirements", submission: current(service, task.id) }),
    ).toThrow(/承認待ちのタスクではありません/);
    ledger.close();
  });

  it("差し戻すと指摘を累積し、前回の下書きと有効な指摘の全件を渡して実行し直す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [
      draft("# v1"),
      draft("# v2", [{ remarkId: "requirements-1-1", text: "受け入れ条件を追加した" }]),
      draft("# v3", [
        { remarkId: "requirements-2-1", text: "対象外を明記した" },
        { remarkId: "unknown-id", text: "無視される" },
      ]),
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);

    expect(() =>
      service.requestChanges(task.id, {
        step: "requirements",
        submission: current(service, task.id),
        comments: ["  ", ""],
      }),
    ).toThrow(/1件以上/);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["受け入れ条件が足りない"],
    });
    expect(service.get(task.id)?.task.status).toBe("queued");
    await service.runNext(task.id);

    const second = service.get(task.id)?.task;
    expect(second?.gate?.submission).toBe(2);
    expect(second?.outputs.requirements).toBe("# v2"); // 対応のJSONは本文から除く
    expect(second?.remarks[0]?.response).toBe("受け入れ条件を追加した");
    expect(executor.calls[1]?.command.join(" ")).toContain("# v1");
    expect(executor.calls[1]?.command.join(" ")).toContain(
      "[requirements-1-1] 受け入れ条件が足りない",
    );

    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["対象外が曖昧"],
    });
    service.voidRemark(task.id, "requirements-1-1"); // 前提が変わった
    await service.runNext(task.id);
    const prompt = executor.calls[2]?.command.join(" ") ?? "";
    expect(prompt).toContain("requirements-2-1");
    expect(prompt).not.toContain("requirements-1-1"); // 無効にした指摘は渡さない
    const third = service.get(task.id)?.task;
    expect(third?.remarks.find((r) => r.id === "requirements-1-1")?.voided).toBe(true);
    expect(third?.remarks.find((r) => r.id === "requirements-2-1")?.response).toBe(
      "対象外を明記した",
    );
    ledger.close();
  });

  it("表示していた提出回が最新でなければ、承認も差し戻しも拒否する（レビュー指摘）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [draft("# v1"), draft("# v2")]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    // タブAは1回目を表示したまま、タブBで差し戻して2回目が提出された
    service.requestChanges(task.id, { step: "requirements", submission: 1, comments: ["直して"] });
    await service.runNext(task.id);

    expect(() => service.approve(task.id, { step: "requirements", submission: 1 })).toThrow(
      /最新ではありません/,
    );
    expect(() =>
      service.requestChanges(task.id, { step: "requirements", submission: 1, comments: ["x"] }),
    ).toThrow(/最新ではありません/);
    expect(service.get(task.id)?.task.steps[0]?.state).toBe("active"); // 承認されていない
    expect(service.approve(task.id, { step: "requirements", submission: 2 }).status).toBe("queued");
    ledger.close();
  });

  it("今回の提出で回答のない指摘は、前回の対応文を残さず未回答にする（レビュー指摘）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [
      draft("# v1"),
      draft("# v2", [{ remarkId: "requirements-1-1", text: "v2で対応しました" }]),
      draft("# v3", [{ remarkId: "requirements-2-1", text: "Bに対応" }]),
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    service.requestChanges(task.id, { step: "requirements", submission: 1, comments: ["A"] });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.remarks[0]).toMatchObject({
      response: "v2で対応しました",
      respondedIn: 2,
    });

    service.requestChanges(task.id, { step: "requirements", submission: 2, comments: ["B"] });
    await service.runNext(task.id);
    const remarks = service.get(task.id)?.task.remarks;
    expect(remarks?.find((r) => r.id === "requirements-1-1")).toMatchObject({
      response: undefined,
      respondedIn: undefined,
    });
    expect(remarks?.find((r) => r.id === "requirements-2-1")).toMatchObject({
      response: "Bに対応",
      respondedIn: 3,
    });
    ledger.close();
  });

  it("差し戻しが上限（3回）を超えるとエスカレーションになり、続けるか承認するかを選べる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(
      ledger,
      Array.from({ length: 5 }, (_, i) => draft(`# v${i + 1}`)),
    );
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    for (let i = 1; i <= 3; i++) {
      service.requestChanges(task.id, {
        step: "requirements",
        submission: current(service, task.id),
        comments: [`指摘${i}`],
      });
      await service.runNext(task.id);
    }
    const escalated = service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["指摘4"],
    });
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalation?.pendingRemarks.map((r) => r.text)).toEqual(["指摘4"]);

    expect(() =>
      service.requestChanges(task.id, {
        step: "requirements",
        submission: current(service, task.id),
        comments: [],
      }),
    ).toThrow(/上限（3回）/);
    const continued = service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: [],
      continueOverLimit: true,
    });
    expect(continued.status).toBe("queued");
    expect(continued.remarks.at(-1)).toMatchObject({ id: "requirements-4-1", text: "指摘4" });
    const last = service.get(task.id)?.ledger.at(-1);
    expect(last?.type === "ChangesRequested" && last.payload.overLimit).toBe(true);

    await service.runNext(task.id);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["指摘5"],
    });
    expect(service.get(task.id)?.task.status).toBe("escalated");
    expect(
      service.approve(task.id, { step: "requirements", submission: current(service, task.id) })
        .status,
    ).toBe("queued");
    ledger.close();
  });

  it("承認待ちのあいだは予算超過で止めず、次の実行の前に判定する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [completed(70_000)]); // $1.05
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.status).toBe("awaiting_approval");
    expect(after?.ledger.map((e) => e.type).slice(-3)).toEqual([
      "AgentRunCompleted",
      "StepSubmitted",
      "BudgetWarned",
    ]);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["直して"],
    });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.pausedReason).toBe("budget");
    ledger.close();
  });
});

describe("設計の工程（PBI-8）", () => {
  const draft = (text: string, blocks: Record<string, unknown>[] = []): AgentOutcome => ({
    kind: "completed",
    output: [text, ...blocks.map((b) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``)].join("\n\n"),
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const viewpoints = (...titles: string[]) => ({
    "sacty-test-viewpoints": titles.map((title) => ({
      title,
      input: `${title}の入力`,
      expected: `${title}の期待結果`,
    })),
  });
  const gate = (svc: TaskService, id: string, step: "requirements" | "design") =>
    svc.approve(id, { step, submission: current(svc, id) });

  /** 要求要件を承認し、設計を1回提出したところまで進める。 */
  async function toDesignGate(outcomes: AgentOutcome[]) {
    const ledger = new SqliteLedgerStore(dbPath);
    const made = makeService(ledger, [draft("# 要求要件 v1"), ...outcomes]);
    const task = made.service.createTicket({ title: "決済API", body: "二重処理を防ぐ" });
    await made.service.runNext(task.id);
    gate(made.service, task.id, "requirements");
    await made.service.runNext(task.id);
    return { ledger, ...made, id: task.id };
  }

  it("承認済みの要求要件から設計とテスト観点を作り、承認ゲートで止まる", async () => {
    const { ledger, service, executor, id } = await toDesignGate([
      draft("# 設計 v1", [
        {
          "sacty-test-viewpoints": [
            { title: "同じキーの再送", input: "同じ冪等性キーで2回送る", expected: "処理は1回" },
            { title: "期待結果が無い", input: "x" }, // 項目が欠けたものは除く
            { title: " ", input: "x", expected: "y" },
          ],
        },
      ]),
    ]);
    const prompt = executor.calls[1]?.command.join(" ") ?? "";
    expect(prompt).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v1");
    expect(prompt).toContain("sacty-test-viewpoints");

    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    expect(task?.outputs.design).toBe("# 設計 v1"); // テスト観点のJSONは本文から除く
    expect(task?.testViewpoints).toEqual([
      {
        id: "TV-1",
        title: "同じキーの再送",
        input: "同じ冪等性キーで2回送る",
        expected: "処理は1回",
      },
    ]);

    const approved = gate(service, id, "design");
    expect(approved.status).toBe("idle"); // 実装の工程はPBI-10で実装
    expect(approved.steps.map((s) => s.state)).toEqual(["done", "done", "active", "todo"]);
    expect(approved.approved.design).toMatchObject({
      submission: 1,
      output: "# 設計 v1",
      testViewpoints: [{ id: "TV-1" }],
    });
    expect(approved.approved.requirements?.output).toBe("# 要求要件 v1");
    ledger.close();
  });

  it("設計を差し戻すと、承認済みの要求要件はそのままで設計だけをやり直す", async () => {
    const { ledger, service, executor, id } = await toDesignGate([
      draft("# 設計 v1", [viewpoints("A")]),
      draft("# 設計 v2", [
        viewpoints("A", "B"),
        { "sacty-responses": [{ remarkId: "design-1-1", text: "異常系を足した" }] },
      ]),
    ]);
    const sent = service.requestChanges(id, {
      step: "design",
      submission: current(service, id),
      target: "design",
      comments: ["異常系のテスト観点が無い"],
    });
    expect(sent.status).toBe("queued");
    expect(sent.approved.requirements?.output).toBe("# 要求要件 v1");
    await service.runNext(id);

    const prompt = executor.calls[2]?.command.join(" ") ?? "";
    expect(prompt).toContain("# 設計 v1"); // 前回の下書き
    // 前回のテスト観点も、IDつきで全項目を渡す（指摘が TV-n を指しても分かるように。レビュー指摘）
    expect(prompt).toContain("- [TV-1] A\n  - 入力：Aの入力\n  - 期待結果：Aの期待結果");
    expect(prompt).toContain("[design-1-1] 異常系のテスト観点が無い");
    const task = service.get(id)?.task;
    expect(task?.gate).toEqual({ step: "design", submission: 2 });
    expect(task?.testViewpoints.map((v) => v.id)).toEqual(["TV-1", "TV-2"]);
    expect(task?.remarks.find((r) => r.id === "design-1-1")?.response).toBe("異常系を足した");
    expect(task?.steps[0]?.state).toBe("done");
    ledger.close();
  });

  it("要求要件へ差し戻すと承認を取り消し、再承認するまで設計を実行しない", async () => {
    const { ledger, service, executor, id } = await toDesignGate([
      draft("# 設計 v1", [viewpoints("A")]),
      draft("# 要求要件 v2", [
        { "sacty-responses": [{ remarkId: "requirements-1-1", text: "対象外を明記した" }] },
      ]),
      draft("# 設計 v2", [viewpoints("A", "B")]),
    ]);
    const sent = service.requestChanges(id, {
      step: "design",
      submission: current(service, id),
      target: "requirements",
      comments: ["対象外が決まっていない"],
    });
    expect(sent.status).toBe("queued");
    expect(sent.steps.map((s) => s.state)).toEqual(["active", "todo", "todo", "todo"]);
    expect(sent.approved).toEqual({});
    expect(sent.remarks.at(-1)).toMatchObject({ id: "requirements-1-1", step: "requirements" });

    await service.runNext(id);
    const resubmitted = service.get(id)?.task;
    expect(resubmitted?.gate).toEqual({ step: "requirements", submission: 2 }); // 再承認待ち
    expect(service.queuedTaskIds()).toEqual([]);

    gate(service, id, "requirements");
    await service.runNext(id);
    const prompt = executor.calls[3]?.command.join(" ") ?? "";
    expect(prompt).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v2");
    expect(prompt).toContain("# 設計 v1"); // 前回の設計の下書きも渡す
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 2 });
    ledger.close();
  });

  it("差し戻せるのは、承認ゲートの工程かそれより前の承認ゲートのある工程だけ", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [draft("# 要求要件 v1")]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    for (const target of ["design", "implement"] as const) {
      expect(() =>
        service.requestChanges(id, {
          step: "requirements",
          submission: 1,
          target,
          comments: ["x"],
        }),
      ).toThrow(/差し戻せません/);
    }
    expect(service.get(id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("要求要件への差し戻しも上限を数え、エスカレーション後は同じ工程の書きかけの指摘を引き継ぐ", async () => {
    const outcomes: AgentOutcome[] = [draft("# 設計 v1", [viewpoints("A")])];
    for (let i = 2; i <= 4; i++) {
      outcomes.push(draft(`# 要求要件 v${i}`), draft(`# 設計 v${i}`, [viewpoints("A")]));
    }
    outcomes.push(draft("# 要求要件 v5"));
    const { ledger, service, id } = await toDesignGate(outcomes);
    const back = (comments: string[], extra: Record<string, unknown> = {}) =>
      service.requestChanges(id, {
        step: "design",
        submission: current(service, id),
        target: "requirements",
        comments,
        ...extra,
      });
    for (let i = 1; i <= 3; i++) {
      back([`指摘${i}`]);
      await service.runNext(id);
      gate(service, id, "requirements");
      await service.runNext(id);
    }
    const escalated = back(["指摘4"]);
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalation).toMatchObject({ step: "design", target: "requirements" });

    // 上限に達していない設計へは、通常の差し戻しとして戻せる（書きかけの指摘は引き継がない）
    expect(() =>
      service.requestChanges(id, {
        step: "design",
        submission: current(service, id),
        target: "design",
        comments: [],
      }),
    ).toThrow(/1件以上/);

    const continued = back([], { continueOverLimit: true });
    expect(continued.remarks.at(-1)).toMatchObject({ id: "requirements-4-1", text: "指摘4" });
    expect(continued.steps[0]?.state).toBe("active");
    ledger.close();
  });

  it("PBI-7で承認され設計のまま待機していたタスクは、起動時に設計を実行待ちにする", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [
      draft("# 要求要件 v1"),
      draft("# 設計", [viewpoints("A")]),
    ]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    // PBI-7の台帳：設計を実行できなかったため、承認後に待機していた
    ledger.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: { type: "StepApproved", payload: { step: "requirements", next: "idle" } },
        },
      ],
    });
    const { service: restarted } = makeService(ledger, [draft("# 設計", [viewpoints("A")])]);
    expect(restarted.get(id)?.task.status).toBe("idle");
    restarted.queueWaitingSteps();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    expect(restarted.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    restarted.queueWaitingSteps(); // 承認待ちのタスクには何もしない
    expect(restarted.get(id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("承認済みの工程の成果物は凍結され、台帳でも書き換えを受け付けない", async () => {
    const { ledger, service, id } = await toDesignGate([draft("# 設計 v1", [viewpoints("A")])]);
    gate(service, id, "design");
    const task = service.get(id)?.task;
    expect(task?.outputs.requirements).toBe("# 要求要件 v1");
    expect(task?.approved.requirements?.output).toBe("# 要求要件 v1");
    // 承認済みの工程は、差し戻して承認を取り消さない限り実行対象にならない
    expect(task?.steps.find((s) => s.state === "active")?.key).toBe("implement");
    expect(() => gate(service, id, "requirements")).toThrow(/承認待ちのタスクではありません/);
    ledger.close();
  });
});

describe("ゴールガーディアン：変更の申し出の判定（PBI-9）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const designWithProposal = (target = "requirements") =>
    out(
      [
        "# 設計 v1",
        block({
          "sacty-test-viewpoints": [{ title: "A", input: "Aの入力", expected: "Aの期待結果" }],
        }),
        block({
          "sacty-change-proposal": {
            target,
            reason: "外部APIが冪等性キーに対応していない",
            facts: ["決済代行のAPI仕様書 v3 に Idempotency-Key が無い"],
            proposed: "# 要求要件 v2（sacty側で重複を防ぐ）",
          },
        }),
      ].join("\n\n"),
    );
  const verdict = (v: string, reason = "事実で裏付けられている") =>
    out(block({ "sacty-verdict": { verdict: v, reason } }), 1000);
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";

  /** 要求要件を承認し、設計の実行（申し出つき）とゴールガーディアンの判定まで進める。 */
  async function proposeAndJudge(outcomes: AgentOutcome[]) {
    const ledger = new SqliteLedgerStore(dbPath);
    const made = makeService(ledger, [out("# 要求要件 v1"), ...outcomes]);
    const task = made.service.createTicket({
      title: "決済API",
      body: "チケットの本文（秘密の経緯）",
    });
    await made.service.runNext(task.id);
    made.service.approve(task.id, { step: "requirements", submission: 1 });
    await made.service.runNext(task.id);
    return { ledger, ...made, id: task.id };
  }

  it("設計の工程は要求要件の変更を申し出られ、ゴールガーディアンは新しいセッションで必要な情報だけを受け取る", async () => {
    const { ledger, service, executor, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("rejected", "代替手段がある"),
    ]);
    expect(promptOf(executor, 1)).toContain("sacty-change-proposal");

    const guardian = promptOf(executor, 2);
    expect(guardian).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v1");
    expect(guardian).toContain("理由：外部APIが冪等性キーに対応していない");
    expect(guardian).toContain("- 決済代行のAPI仕様書 v3 に Idempotency-Key が無い");
    expect(guardian).toContain("# 要求要件 v2（sacty側で重複を防ぐ）");
    // チケットや工程の下書き、過去の経緯は渡さない
    expect(guardian).not.toContain("チケットの本文");
    expect(guardian).not.toContain("# 設計 v1");
    // 工程の作業領域とは別の、空の作業領域で実行する
    expect(executor.dirs[2]).not.toBe(executor.dirs[1]);
    expect(executor.dirs[2]).toContain("_guardian");
    expect(existsSync(executor.dirs[2] ?? "")).toBe(false);

    const task = service.get(id)?.task;
    expect(task?.proposals).toMatchObject([
      {
        id: "CP-1",
        fromStep: "design",
        target: "requirements",
        judgement: { verdict: "rejected", reason: "代替手段がある" },
        applied: false,
      },
    ]);
    // 却下されたら、設計をそのまま提出する。要求要件は承認済みのまま
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    expect(task?.outputs.design).toBe("# 設計 v1"); // 申し出のJSONは本文から除く
    expect(task?.approved.requirements?.output).toBe("# 要求要件 v1");
    // ゴールガーディアンの費用も予算に入る（100 + 100 + 1000 出力トークン × $15/M）
    expect(task?.budget.usedUsd).toBeCloseTo(0.018, 6);
    const types = service.get(id)?.ledger.map((e) => e.type) ?? [];
    expect(types.slice(-4)).toEqual([
      "AgentRunCompleted",
      "ChangeProposed",
      "ChangeJudged",
      "StepSubmitted",
    ]);
    expect(service.get(id)?.ledger.find((e) => e.type === "ChangeJudged")?.actor).toBe("guardian");
    ledger.close();
  });

  it("要求要件の変更が承認されても、人間の再承認が必要になる", async () => {
    const { ledger, service, executor, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("approved"),
      out("# 設計 v2"),
    ]);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "requirements", submission: 2 });
    expect(task?.outputs.requirements).toBe("# 要求要件 v2（sacty側で重複を防ぐ）");
    expect(task?.approved).toEqual({});
    expect(task?.steps.map((s) => s.state)).toEqual(["active", "todo", "todo", "todo"]);
    expect(task?.proposals[0]?.applied).toBe(true);

    service.approve(id, { step: "requirements", submission: 2 });
    await service.runNext(id);
    expect(promptOf(executor, 3)).toContain(
      "--- 承認済みの要求要件 ---\n# 要求要件 v2（sacty側で重複を防ぐ）",
    );
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    ledger.close();
  });

  it("判定できなければエスカレーションになり、人間が認めるか認めないかを決める", async () => {
    const { ledger, service, id } = await proposeAndJudge([
      designWithProposal(),
      out("判定の形式が無い出力"),
    ]);
    const escalated = service.get(id)?.task;
    expect(escalated?.status).toBe("escalated");
    expect(escalated?.proposals[0]?.judgement).toMatchObject({ verdict: "undecidable" });
    expect(() => service.approve(id, { step: "design", submission: 1 })).toThrow();
    expect(() => service.decideChange(id, "CP-9", { accept: true })).toThrow(
      /判断待ちではありません/,
    );

    const rejected = service.decideChange(id, "CP-1", { accept: false });
    expect(rejected.gate).toEqual({ step: "design", submission: 1 });
    expect(rejected.approved.requirements?.output).toBe("# 要求要件 v1");
    expect(() => service.decideChange(id, "CP-1", { accept: true })).toThrow(
      /判断待ちではありません/,
    );
    ledger.close();
  });

  it("人間が認めた要求要件の変更も、再承認に回す", async () => {
    const { ledger, service, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("undecidable", "価値判断を含む"),
    ]);
    const accepted = service.decideChange(id, "CP-1", { accept: true });
    expect(accepted.gate).toEqual({ step: "requirements", submission: 2 });
    expect(accepted.proposals[0]).toMatchObject({ decision: { accept: true }, applied: true });
    expect(accepted.approved).toEqual({}); // 承認を取り消している
    expect(accepted.steps.map((st) => st.state)).toEqual(["active", "todo", "todo", "todo"]);
    const types = service.get(id)?.ledger.map((e) => e.type) ?? [];
    expect(types.slice(-4)).toEqual([
      "TaskEscalated",
      "ChangeDecided",
      "ChangeApplied",
      "StepSubmitted",
    ]);
    ledger.close();
  });

  it("ゴールガーディアンの実行に失敗したら、判定できなかったものとしてエスカレーションにする", async () => {
    const { ledger, service, id } = await proposeAndJudge([
      designWithProposal(),
      { kind: "failed", reason: "usage_limit", message: "You've hit your session limit" },
    ]);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(task?.proposals[0]?.judgement?.reason).toContain("session limit");
    ledger.close();
  });

  it("承認されていない工程への申し出は無視し、そのまま提出する", async () => {
    const { ledger, service, executor, id } = await proposeAndJudge([designWithProposal("design")]);
    expect(executor.calls).toHaveLength(2); // ゴールガーディアンは呼ばない
    const task = service.get(id)?.task;
    expect(task?.proposals).toEqual([]);
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    ledger.close();
  });

  it("デーモンの停止で中断された判定は、再起動時にエスカレーションにする", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [out("# 要求要件 v1")]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    // 設計の実行完了と申し出までを記録したところで、デーモンが止まった
    const runId = "run-x";
    ledger.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: { runId, step: "design", agentId: "a", authMode: "subscription" },
          },
        },
        {
          actor: "agent",
          event: {
            type: "AgentRunCompleted",
            payload: {
              runId,
              step: "design",
              agentId: "a",
              authMode: "subscription",
              usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
              costUsd: 0,
              estimated: true,
              output: "# 設計",
            },
          },
        },
        {
          actor: "agent",
          event: {
            type: "ChangeProposed",
            payload: {
              proposalId: "CP-1",
              fromStep: "design",
              target: "requirements",
              reason: "r",
              facts: [],
              proposed: "p",
            },
          },
        },
      ],
    });
    const { service: restarted } = makeService(ledger);
    restarted.recoverInterrupted();
    const task = restarted.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(task?.proposals[0]?.judgement?.reason).toMatch(/中断/);
    ledger.close();
  });

  it("判定と後始末は、同じトランザクションで台帳に記録する（レビュー指摘）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const appended: string[][] = [];
    const original = ledger.append.bind(ledger);
    ledger.append = (entry) => {
      appended.push(entry.events.map((e) => e.event.type));
      return original(entry);
    };
    const { service } = makeService(ledger, [
      out("# 要求要件 v1"),
      designWithProposal(),
      verdict("approved"),
    ]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(appended).toContainEqual(["ChangeJudged", "ChangeApplied", "StepSubmitted"]);
    // 申し出のない実行も、完了と提出を一緒に記録する
    expect(appended).toContainEqual(["AgentRunCompleted", "StepSubmitted"]);
    ledger.close();
  });

  /** 判定（と人間の判断）までが記録され、後始末が記録されていない台帳を作る。 */
  async function cutAfter(
    judged: "approved" | "rejected" | "undecidable",
    extra: { actor: "person" | "sacty"; event: EventInput }[] = [],
  ) {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [out("# 要求要件 v1")]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    const runId = "run-x";
    const append = (actor: "agent" | "guardian" | "sacty" | "person", event: EventInput) =>
      ledger.append({ taskId: id, projectId: "default", events: [{ actor, event }] });
    append("sacty", {
      type: "AgentRunStarted",
      payload: { runId, step: "design", agentId: "a", authMode: "subscription" },
    });
    append("agent", {
      type: "AgentRunCompleted",
      payload: {
        runId,
        step: "design",
        agentId: "a",
        authMode: "subscription",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        costUsd: 0,
        estimated: true,
        output: "# 設計",
      },
    });
    append("agent", {
      type: "ChangeProposed",
      payload: {
        proposalId: "CP-1",
        fromStep: "design",
        target: "requirements",
        reason: "r",
        facts: [],
        proposed: "# 要求要件 v2",
      },
    });
    append("guardian", {
      type: "ChangeJudged",
      payload: { proposalId: "CP-1", verdict: judged, reason: "x", agentId: "g" },
    });
    for (const e of extra) append(e.actor, e.event);
    const { service: restarted } = makeService(ledger);
    expect(restarted.get(id)?.task.status).toBe("idle"); // どの状態にも進んでいない
    restarted.recoverInterrupted();
    return { ledger, service: restarted, id };
  }

  it("判定まで記録されて止まった台帳も、再起動時に後始末を記録して先に進める（レビュー指摘）", async () => {
    const undecidable = await cutAfter("undecidable");
    expect(undecidable.service.get(undecidable.id)?.task.status).toBe("escalated");
    // 人間の判断も受け付ける
    expect(
      undecidable.service.decideChange(undecidable.id, "CP-1", { accept: false }).gate,
    ).toEqual({ step: "design", submission: 1 });
    undecidable.ledger.close();
    rmSync(dbPath, { force: true });

    const approved = await cutAfter("approved");
    expect(approved.service.get(approved.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    approved.service.recoverInterrupted(); // 何度呼んでも同じ（冪等）
    expect(
      approved.service.get(approved.id)?.ledger.filter((e) => e.type === "StepSubmitted"),
    ).toHaveLength(2);
    approved.ledger.close();
    rmSync(dbPath, { force: true });

    const rejected = await cutAfter("rejected");
    expect(rejected.service.get(rejected.id)?.task.gate).toEqual({ step: "design", submission: 1 });
    rejected.ledger.close();
  });

  it("人間の判断や反映まで記録されて止まった台帳も、再起動時に先に進める（レビュー指摘）", async () => {
    const decided = await cutAfter("undecidable", [
      {
        actor: "sacty",
        event: {
          type: "TaskEscalated",
          payload: {
            step: "design",
            target: "requirements",
            reason: "change_undecidable",
            proposalId: "CP-1",
          },
        },
      },
      {
        actor: "person",
        event: { type: "ChangeDecided", payload: { proposalId: "CP-1", accept: true } },
      },
    ]);
    expect(decided.service.get(decided.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    decided.ledger.close();
    rmSync(dbPath, { force: true });

    const applied = await cutAfter("approved", [
      { actor: "sacty", event: { type: "ChangeApplied", payload: { proposalId: "CP-1" } } },
    ]);
    expect(applied.service.get(applied.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    applied.ledger.close();
  });
});

describe("API", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };

  it("トークンがないと401を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);
    expect((await app.request("/api/tasks")).status).toBe(401);
    expect(
      (await app.request("/api/tasks", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    ledger.close();
  });

  it("チケットを作ると、一覧と詳細（台帳つき）に現れる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);

    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "  決済APIの設計  ", body: "冪等性キーを扱う" }),
    });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { id: string; title: string } };
    expect(task.title).toBe("決済APIの設計");

    const list = (await (await app.request("/api/tasks", { headers: auth })).json()) as {
      tasks: { id: string }[];
    };
    expect(list.tasks.map((t) => t.id)).toEqual([task.id]);

    const detail = (await (
      await app.request(`/api/tasks/${task.id}`, { headers: auth })
    ).json()) as { ledger: { type: string; actor: string }[] };
    expect(detail.ledger.map((e) => [e.type, e.actor])).toEqual([
      ["TaskCreated", "person"],
      ["StepsChosen", "sacty"],
    ]);
    ledger.close();
  });

  it("タイトルが空なら400を返し、台帳に何も書かない", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(ledger.all()).toHaveLength(0);
    ledger.close();
  });

  it("状態に合わない再開は409、不正な金額は400を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger);
    const app = createApp(service, token);
    const task = service.createTicket({ title: "A" });
    const resume = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/resume`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await resume({})).status).toBe(409);
    expect((await resume({ capUsd: -1 })).status).toBe(400);
    expect((await resume({ capUsd: "3" })).status).toBe(400);
    ledger.close();
  });

  it("判断待ちでない変更の申し出への判断は409、不正な入力は400を返す（PBI-9）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger);
    const app = createApp(service, token);
    const task = service.createTicket({ title: "A" });
    const decide = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/proposals/CP-1/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await decide({ accept: true })).status).toBe(409);
    expect((await decide({ accept: "yes" })).status).toBe(400);
    expect(service.get(task.id)?.ledger.map((e) => e.type)).toEqual(["TaskCreated", "StepsChosen"]);
    ledger.close();
  });

  it("存在しないタスクは404を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);
    expect((await app.request("/api/tasks/nope", { headers: auth })).status).toBe(404);
    ledger.close();
  });
});
