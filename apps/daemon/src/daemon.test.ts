import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    config: { image: "sacty-agent:test", defaultAgent: a, budgetPerTaskUsd },
  });

/** 決まった結果を順に返す偽物の実行器。渡された呼び出し内容も記録する。 */
class FakeExecutor implements AgentExecutor {
  calls: Invocation[] = [];
  constructor(private readonly outcomes: AgentOutcome[]) {}
  async run({ invocation }: { invocation: Invocation }): Promise<AgentOutcome> {
    this.calls.push(invocation);
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
    service.requestChanges(capped.id, { step: "requirements", comments: ["直して"] });
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
    service.requestChanges(task.id, { step: "requirements", comments: ["直して"] });
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

    const approved = service.approve(task.id, { step: "requirements" });
    expect(approved.status).toBe("idle"); // 設計の工程はPBI-8で実装
    expect(approved.steps.map((s) => [s.key, s.state]).slice(0, 2)).toEqual([
      ["requirements", "done"],
      ["design", "active"],
    ]);
    expect(() => service.approve(task.id, { step: "requirements" })).toThrow(
      /承認待ちのタスクではありません/,
    );
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
      service.requestChanges(task.id, { step: "requirements", comments: ["  ", ""] }),
    ).toThrow(/1件以上/);
    service.requestChanges(task.id, { step: "requirements", comments: ["受け入れ条件が足りない"] });
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

    service.requestChanges(task.id, { step: "requirements", comments: ["対象外が曖昧"] });
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

  it("差し戻しが上限（3回）を超えるとエスカレーションになり、続けるか承認するかを選べる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(
      ledger,
      Array.from({ length: 5 }, (_, i) => draft(`# v${i + 1}`)),
    );
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    for (let i = 1; i <= 3; i++) {
      service.requestChanges(task.id, { step: "requirements", comments: [`指摘${i}`] });
      await service.runNext(task.id);
    }
    const escalated = service.requestChanges(task.id, {
      step: "requirements",
      comments: ["指摘4"],
    });
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalation?.pendingRemarks.map((r) => r.text)).toEqual(["指摘4"]);

    expect(() => service.requestChanges(task.id, { step: "requirements", comments: [] })).toThrow(
      /上限（3回）/,
    );
    const continued = service.requestChanges(task.id, {
      step: "requirements",
      comments: [],
      continueOverLimit: true,
    });
    expect(continued.status).toBe("queued");
    expect(continued.remarks.at(-1)).toMatchObject({ id: "requirements-4-1", text: "指摘4" });
    const last = service.get(task.id)?.ledger.at(-1);
    expect(last?.type === "ChangesRequested" && last.payload.overLimit).toBe(true);

    await service.runNext(task.id);
    service.requestChanges(task.id, { step: "requirements", comments: ["指摘5"] });
    expect(service.get(task.id)?.task.status).toBe("escalated");
    expect(service.approve(task.id, { step: "requirements" }).status).toBe("idle");
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
    service.requestChanges(task.id, { step: "requirements", comments: ["直して"] });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.pausedReason).toBe("budget");
    ledger.close();
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

  it("存在しないタスクは404を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);
    expect((await app.request("/api/tasks/nope", { headers: auth })).status).toBe(404);
    ledger.close();
  });
});
