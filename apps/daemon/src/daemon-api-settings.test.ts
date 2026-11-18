import { message } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentConfig, ConfigResult, SactyConfig } from "./config.js";
import { MessageError } from "./errors.js";
import { MemoryProjectStore } from "./projects.js";
import { createApp } from "./server.js";
import { InvalidOperationError, type TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
  completed,
  configOf,
  configWithTimeouts,
  dbPath,
  FakeGitHub,
  FakePulls,
  makeService,
  projectsWithAccount,
  useTempDir,
} from "./testing/daemon.js";

useTempDir();

describe("API", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };

  it("sacty の設定を読み書きし、形の誤りは400を返す（PBI-26）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(
      makeService(activity, [], { settings: new MemorySettingsStore() }).service,
      token,
    );
    expect(await (await app.request("/api/settings", { headers: auth })).json()).toEqual({
      settings: {},
    });
    const put = (body: unknown) =>
      app.request("/api/settings", { method: "PUT", headers: json, body: JSON.stringify(body) });
    expect(await (await put({ intakeLabel: "sacty" })).json()).toEqual({
      settings: { intakeLabel: "sacty" },
    });
    const bad = await put({ intakeLabel: 'a"b' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: unknown[] }).issues).toEqual([
      { path: ["intakeLabel"], message: { code: "input.invalidLabel" } },
    ]);
    // 取り込むラベルとレビュー用のラベルに同じ名前（大文字・小文字だけの違いも）を書ける（PBI-104）
    const same = await put({ intakeLabel: "sacty", reviewLabel: "Sacty" });
    expect(same.status).toBe(200);
    expect(await (await app.request("/api/settings", { headers: auth })).json()).toEqual({
      settings: { intakeLabel: "sacty", reviewLabel: "Sacty" },
    });
    await put({ intakeLabel: "sacty" });
    // 取り込みの種類ごとの間隔（PBI-100）。60 秒より短いと、どの種類の間隔かがわかる文言で弾く
    const short = await put({ intakeLabel: "sacty", issueIntervalSec: 59 });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { issues: unknown[] }).issues).toEqual([
      { path: ["issueIntervalSec"], message: { code: "input.issueIntervalInvalid" } },
    ]);
    expect(
      await (
        await put({ intakeLabel: "sacty", issueIntervalSec: "120", ticketIntervalSec: "" })
      ).json(),
    ).toEqual({ settings: { intakeLabel: "sacty", issueIntervalSec: 120 } });
    activity.close();
  });

  it("トークンがないと401を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);
    expect((await app.request("/api/tasks")).status).toBe(401);
    expect(
      (await app.request("/api/tasks", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    activity.close();
  });

  it("?open=1 の一覧は、終わっていないタスクだけを返す（中止したタスクを除く。PBI-114）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity);
    const app = createApp(service, token);
    const create = async (title: string) => {
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ title, body: "", projectId: "default" }),
      });
      return ((await res.json()) as { task: { id: string } }).task.id;
    };
    const open = await create("続けるタスク");
    const cancelled = await create("やめるタスク");
    await service.cancel(cancelled);
    const ids = async (path: string) =>
      (
        (await (await app.request(path, { headers: auth })).json()) as { tasks: { id: string }[] }
      ).tasks
        .map((t) => t.id)
        .sort();
    expect(await ids("/api/tasks")).toEqual([open, cancelled].sort());
    expect(await ids("/api/tasks?open=1")).toEqual([open]);
    activity.close();
  });

  it("GET /api/dashboard は、対応待ちの時刻・費用・流量・品質・待ち行列の集計を返し、再起動しても同じ（PBI-118）", async () => {
    type Summary = import("@sacty/core").DashboardSummary;
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [completed(20_000)], {
      settings: new MemorySettingsStore({ maxParallelTasks: 2 }),
    });
    const app = createApp(service, token);
    const summary = async () =>
      (await (await app.request("/api/dashboard", { headers: auth })).json()) as Summary;
    expect((await app.request("/api/dashboard")).status).toBe(401);
    const task = service.createTask({ projectId: "default", title: "決済API" });
    const created = await summary();
    expect(Object.keys(created)).toEqual([
      "timeZone",
      "waitingSince",
      "costs",
      "flow",
      "quality",
      "queue",
    ]);
    expect(created.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(created.waitingSince).toEqual({});
    expect(created.costs.today).toBe(0);
    expect(created.queue).toEqual({ running: 0, queued: 1, max: 2 });
    expect(created.flow.days7).toEqual({ completed: 0, cancelled: 0, medianLeadMs: null });
    expect(created.quality.counts.changesRequested).toBe(0);

    // 要求要件を提出して承認待ち：待ち始めは提出の記録の時刻。費用は今日の分に入る
    await service.runNext(task.id);
    const waiting = await summary();
    const submitted = service.get(task.id)?.activity.find((e) => e.type === "StepSubmitted");
    expect(waiting.waitingSince).toEqual({ [task.id]: submitted?.at });
    const budget = service.get(task.id)?.task.budget;
    expect(budget?.usedUsd).toBeGreaterThan(0);
    expect(waiting.costs.today).toBe(budget?.usedUsd);
    expect(waiting.costs.days7).toEqual(waiting.costs.today);
    expect(waiting.queue).toEqual({ running: 0, queued: 0, max: 2 });

    // 人が差し戻すと品質の信号に数え、提出し直すと待ち始めが新しい提出になる
    service.requestChanges(task.id, {
      step: "requirements",
      submission: 1,
      comments: ["受け入れ条件を足す"],
    });
    expect((await summary()).waitingSince).toEqual({});
    expect((await summary()).quality.counts.changesRequested).toBe(1);
    expect((await summary()).quality.reworkBySteps).toEqual({ requirements: 1 });

    // 中止すると、対応待ちから消え、流量の中止に数える
    await service.cancel(task.id);
    const cancelled = await summary();
    expect(cancelled.waitingSince).toEqual({});
    expect(cancelled.flow.days7).toEqual({ completed: 0, cancelled: 1, medianLeadMs: null });
    expect(cancelled.flow.days30.cancelled).toBe(1);

    // 作業履歴から読み直しても（再起動）、同じ集計になる
    activity.close();
    const reopened = new SqliteActivityStore(dbPath);
    const again = makeService(reopened, [], {
      settings: new MemorySettingsStore({ maxParallelTasks: 2 }),
    }).service;
    expect(again.dashboard()).toEqual(cancelled);
    reopened.close();
  });

  it("待ち行列の混雑の始まりは、画面の取得に依らず、タスクの作成・中止・設定の変更で追う（PR #128 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let now = Date.parse("2026-10-16T03:00:00.000Z");
    const settings = new MemorySettingsStore({ maxParallelTasks: 1 });
    const { service } = makeService(activity, [], { settings, now: () => now });
    const create = (title: string) => service.createTask({ projectId: "default", title });
    const a = create("A");
    // 実行待ち 1 件は上限（1）より多くない
    expect(service.dashboard().queue).toEqual({ running: 0, queued: 1, max: 1 });
    // 2 件目を作った時刻が始まり（ダッシュボードを取る前から数える）
    now += 60_000;
    create("B");
    const startedAt = now;
    now += 15 * 60_000;
    expect(service.dashboard().queue).toEqual({
      running: 0,
      queued: 2,
      max: 1,
      overSince: new Date(startedAt).toISOString(),
    });
    // 画面を開いていない間に解消して（中止）、再発した（作成）：始まりは再発の時刻
    now += 60_000;
    await service.cancel(a.id);
    now += 60_000;
    create("C");
    const again = now;
    now += 60_000;
    expect(service.dashboard().queue.overSince).toBe(new Date(again).toISOString());
    // 上限を上げると解消する
    service.saveSettings({ maxParallelTasks: 3 });
    expect(service.dashboard().queue).toEqual({ running: 0, queued: 2, max: 3 });
    activity.close();
  });

  it("GET /api/dashboard は、消したプロジェクトのタスクを数えず、設定を読めなければ上限は既定値（PBI-118）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = projectsWithAccount();
    const settings = new MemorySettingsStore({});
    const { service } = makeService(activity, [], { projects, settings });
    service.createTask({ projectId: "default", title: "A" });
    expect(service.dashboard().queue).toEqual({ running: 0, queued: 1, max: 3 });
    settings.get = () => {
      throw new Error("設定を読めません");
    };
    expect(service.dashboard().queue.max).toBe(3);
    projects.all = () => [];
    expect(service.dashboard().queue).toEqual({ running: 0, queued: 0, max: 3 });
    activity.close();
  });

  it("タスクを作ると、一覧と詳細（作業履歴つき）に現れる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: "  決済APIの設計  ",
        body: "冪等性キーを扱う",
        projectId: "default",
      }),
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
    ).json()) as { activity: { type: string; actor: string }[] };
    expect(detail.activity.map((e) => [e.type, e.actor])).toEqual([["TaskCreated", "person"]]);
    activity.close();
  });

  it("タイトルが空なら400を返し、作業履歴に何も書かない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(activity.all()).toHaveLength(0);
    activity.close();
  });

  it("gh にログイン済みの GitHub のアカウントを返す（トークンは返さない。PBI-13）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(
      makeService(activity, [], {
        github: new FakeGitHub({ me: "ghp_active", "side-job": "ghp_side" }),
      }).service,
      token,
    );
    const res = await app.request("/api/github/accounts", { headers: auth });
    const body = await res.json();
    expect(body).toEqual({
      accounts: [
        { host: "github.com", login: "me", active: true, state: "success" },
        { host: "github.com", login: "side-job", active: false, state: "success" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("ghp_");
    const failing = createApp(
      makeService(activity, [], {
        github: Object.assign(new FakeGitHub(), {
          accounts: () => Promise.reject(new MessageError(message("github.ghMissing"))),
        }),
      }).service,
      token,
    );
    expect(await (await failing.request("/api/github/accounts", { headers: auth })).json()).toEqual(
      {
        error: { code: "github.ghMissing" },
      },
    );
    activity.close();
  });

  it("状態に合わない再開は409、不正な金額は400を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity);
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "A" });
    const resume = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/resume`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    const rejected = await resume({});
    expect(rejected.status).toBe(409);
    // 理由は文言のコードと引数で返し、画面が画面の言語の文言にする（PBI-11）
    expect(await rejected.json()).toEqual({
      error: "invalid_operation",
      messages: [{ code: "resume.notPaused" }],
    });
    expect((await resume({ capUsd: -1 })).status).toBe(400);
    expect((await resume({ capUsd: "3" })).status).toBe(400);
    activity.close();
  });

  it("判断待ちでない変更の申し出への判断は409、不正な入力は400を返す（PBI-9）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity);
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "A" });
    const decide = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/proposals/CP-1/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await decide({ accept: true })).status).toBe(409);
    expect((await decide({ accept: "yes" })).status).toBe(400);
    expect(service.get(task.id)?.activity.map((e) => e.type)).toEqual(["TaskCreated"]);
    activity.close();
  });

  it("プロジェクトのエクスポートは定義を返し、インポートは形式の誤りに400・重複に409を返す（PBI-5b）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: new MemoryProjectStore() });
    const app = createApp(service, token);
    const pay = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
    });
    const res = await app.request(`/api/projects/${pay.id}/export`, { headers: auth });
    expect(res.status).toBe(200);
    const exported = await res.json();
    expect(exported).toMatchObject({
      sacty: "project",
      version: 5,
      project: {
        name: "決済",
        targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      },
    });
    expect((await app.request("/api/projects/no-such/export", { headers: auth })).status).toBe(404);

    const post = (body: unknown) =>
      app.request("/api/projects/import", {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    const conflict = await post(exported);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { messages: unknown[] }).messages).toEqual([
      {
        code: "project.targetTaken",
        params: { scope: "repo", target: "https://github.com/acme/payments", project: "決済" },
      },
    ]);
    expect((await post({ ...exported, extra: 1 })).status).toBe(400);
    const badVersion = await post({ sacty: "project", version: 9, project: { name: "x" } });
    expect(badVersion.status).toBe(400);
    expect(((await badVersion.json()) as { issues: unknown[] }).issues[0]).toEqual({
      path: ["version"],
      message: { code: "input.unsupportedVersion" },
    });
    // コードを指定していない標準の検査も、コードと引数で返す（zod の英語の文は返さない）
    const save = await app.request(`/api/projects/${pay.id}`, {
      method: "PUT",
      headers: { ...json, "if-match": service.getProject(pay.id)?.project.updatedAt ?? "" },
      body: JSON.stringify({
        name: "決済",
        targets: [{ scope: "repo" }],
      }),
    });
    expect(save.status).toBe(400);
    expect(((await save.json()) as { issues: unknown[] }).issues).toEqual([
      { path: ["targets", 0, "target"], message: { code: "input.invalidType" } },
    ]);
    const created = await post({
      ...exported,
      project: { ...exported.project, name: "決済（コピー）", targets: [] },
    });
    expect(created.status).toBe(201);
    activity.close();
  });

  it("プロジェクトのエクスポートは通知先を含めず、通知先を含んでいた版（3・4）と通知先を足したファイルは断る（PBI-115）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: new MemoryProjectStore() });
    const app = createApp(service, token);
    const notification = {
      kind: "slack-api",
      url: "https://slack.com/api/chat.postMessage",
      channel: "#sacty",
      token: "op://Work/Slack/token",
      language: "en",
      mention: { targets: ["U0123ABCD"] },
    } as const;
    const pay = service.saveProject(undefined, { name: "決済" });
    const res = await app.request(`/api/projects/${pay.id}/export`, { headers: auth });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/notification|slack|U0123ABCD|mention/);
    const exported = JSON.parse(text);
    expect(exported).toEqual({
      sacty: "project",
      version: 5,
      project: { name: "決済", targets: [] },
    });

    const post = (body: unknown) =>
      app.request("/api/projects/import", {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    const before = service.listProjects().length;
    for (const version of [3, 4]) {
      const old = await post({
        sacty: "project",
        version,
        project: { name: "古い", notification },
      });
      expect(old.status).toBe(400);
      expect(((await old.json()) as { issues: unknown[] }).issues[0]).toEqual({
        path: ["version"],
        message: { code: "input.exportVersionWithNotification" },
      });
    }
    // 今の版に通知先を足したファイルも、知らない項目として断る
    const added = await post({
      ...exported,
      project: { ...exported.project, name: "足した", notification },
    });
    expect(added.status).toBe(400);
    expect(((await added.json()) as { issues: unknown[] }).issues[0]).toEqual({
      path: ["project"],
      message: { code: "input.unknownKeys", params: { keys: "notification" } },
    });
    expect(service.listProjects()).toHaveLength(before);
    const created = await post({ ...exported, project: { ...exported.project, name: "コピー" } });
    expect(created.status).toBe(201);
    activity.close();
  });

  it("存在しないタスクは404を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);
    expect((await app.request("/api/tasks/nope", { headers: auth })).status).toBe(404);
    activity.close();
  });
});

describe("タスクの詳細で工程のエージェントを変える（PBI-121）", () => {
  const base = agent();
  const strong = agent({ id: "strong", model: "claude-opus-5-5", reasoning_effort: "high" });
  const withAgents = (agents: AgentConfig[]): (() => ConfigResult) => {
    const config = (configOf(base)() as { ok: true; config: SactyConfig }).config;
    return () => ({
      ok: true,
      config: { ...config, agents: Object.fromEntries(agents.map((a) => [a.id, a])) },
    });
  };
  const started = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunStarted" ? [`${e.payload.step}:${e.payload.agentId}`] : [],
    );

  it("変えたことを作業履歴に残し、その工程の次の実行から使う（config.yaml の step_agents より優先）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // 既定（default_agent）・工程の指定（step_agents）・人の選択を、別の名前にする（PR #131 レビュー指摘）
    const stepped = agent({ id: "stepped", model: "claude-sonnet-5-5" });
    const configured = withAgents([base, stepped, strong]);
    const { service } = makeService(activity, [completed(100), completed(100), completed(100)], {
      config: () => {
        const loaded = configured() as { ok: true; config: SactyConfig };
        return {
          ok: true,
          config: { ...loaded.config, stepAgents: { requirements: stepped } },
        };
      },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(started(service, id)).toEqual(["requirements:stepped"]);
    const changed = service.changeStepAgent(id, { step: "requirements", agent: "strong" });
    expect(changed.agents).toEqual({ requirements: "strong" });
    expect(changed.agentChanges?.requirements).toMatchObject({
      from: "stepped",
      to: "strong",
    });
    const event = service.get(id)?.activity.find((e) => e.type === "StepAgentChanged");
    expect(event?.actor).toBe("person");
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["直す"] });
    await service.runNext(id);
    expect(started(service, id)).toEqual(["requirements:stepped", "requirements:strong"]);
    // 段階の設定（モデル・エフォート）も、選んだエージェントのもので記録する
    const last = (service.get(id)?.activity ?? [])
      .filter((e) => e.type === "AgentRunStarted")
      .at(-1);
    expect(last?.type === "AgentRunStarted" && last.payload).toMatchObject({
      agentId: "strong",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
    });
    activity.close();
  });

  it("無い名前・同じ名前・無い工程・中止したタスク・設定を読めないときは、理由を示して断る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let ok = true;
    const configured = withAgents([base, strong]);
    const { service } = makeService(activity, [completed(100)], {
      config: () =>
        ok ? configured() : { ok: false, problem: message("config.missing", { path: "x" }) },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    const reject = (raw: unknown) => {
      try {
        service.changeStepAgent(id, raw);
      } catch (error) {
        return error instanceof InvalidOperationError ? error.messages[0] : error;
      }
      return undefined;
    };
    expect(reject({ step: "requirements", agent: "nope" })).toEqual(
      message("agent.notInAgents", { name: "nope" }),
    );
    expect(reject({ step: "requirements", agent: "claude-subscription" })).toEqual(
      message("agent.unchanged", { name: "claude-subscription" }),
    );
    expect(reject({ step: "operation", agent: "strong" })).toEqual(message("agent.stepMissing"));
    ok = false;
    expect(reject({ step: "requirements", agent: "strong" })).toMatchObject({
      code: "agent.configUnavailable",
    });
    ok = true;
    await service.cancel(id);
    expect(reject({ step: "requirements", agent: "strong" })).toEqual(message("task.cancelled"));
    expect(service.get(id)?.activity.some((e) => e.type === "StepAgentChanged")).toBe(false);
    activity.close();
  });

  it("選んだ名前が config.yaml から消えていたら、既定に戻さず、理由を示して一時停止する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let agents = [base, strong];
    const { service, executor } = makeService(activity, [completed(100), completed(100)], {
      config: () => withAgents(agents)(),
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.changeStepAgent(id, { step: "requirements", agent: "strong" });
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["直す"] });
    agents = [base];
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    expect(task?.pausedMessage).toEqual(
      message("agent.chosenMissing", { step: "requirements", name: "strong" }),
    );
    // エージェントを動かしていない（1 回目の実行だけ）
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it("状態に、選べるエージェント（秘密・接続先なし）と config.yaml で決まる工程ごとの名前を出す", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { config: withAgents([base, strong]) });
    const status = service.status();
    expect(status.agents).toEqual([
      { id: "claude-subscription", runtime: "claude-code" },
      { id: "strong", runtime: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high" },
    ]);
    expect(JSON.stringify(status.agents)).not.toContain("secret");
    expect(status.stepAgents.requirements).toBe("claude-subscription");
    activity.close();
  });

  const rejectWith = (service: TaskService, id: string) => (raw: unknown) => {
    try {
      service.changeStepAgent(id, raw);
    } catch (error) {
      return error instanceof InvalidOperationError ? error.messages[0] : error;
    }
    return undefined;
  };

  it("agents に書いていない継承の名前（constructor・__proto__・toString）は断り、記録済みでも無い名前として止める（PR #131 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const configured = withAgents([base, strong]);
    const { service, executor } = makeService(activity, [completed(100), completed(100)], {
      config: configured,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    const reject = rejectWith(service, id);
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(reject({ step: "requirements", agent: name }), name).toEqual(
        message("agent.notInAgents", { name }),
      );
    }
    expect(service.get(id)?.activity.some((e) => e.type === "StepAgentChanged")).toBe(false);
    // 前の版で記録された継承の名前は、実行のときに無い名前として止める（例外にしない）
    const task = service.get(id)?.task;
    activity.append({
      taskId: id,
      projectId: task?.projectId ?? "default",
      events: [
        {
          actor: "person",
          event: {
            type: "StepAgentChanged",
            payload: { step: "requirements", from: "claude-subscription", to: "toString" },
          },
        },
      ],
    });
    const restored = makeService(activity, [completed(100)], { config: configured });
    restored.service.requestChanges(id, {
      step: "requirements",
      submission: 1,
      comments: ["直す"],
    });
    await restored.service.runNext(id);
    expect(restored.service.get(id)?.task.pausedMessage).toEqual(
      message("agent.chosenMissing", { step: "requirements", name: "toString" }),
    );
    expect(restored.executor.calls).toHaveLength(0);
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it("config.yaml の名前を変えずに受け取る（空白を含む別名・101 文字以上の名前。PR #131 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const spaced = agent({ id: " strong ", model: "claude-haiku-5-5" });
    const long = agent({ id: "l".repeat(150), model: "claude-sonnet-5-5" });
    const { service } = makeService(activity, [completed(100), completed(100), completed(100)], {
      config: withAgents([base, strong, spaced, long]),
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    // 空白を含む名前を選ぶと、空白を除いた別のエージェント（strong）ではなく、選んだものを使う
    expect(service.changeStepAgent(id, { step: "requirements", agent: " strong " }).agents).toEqual(
      { requirements: " strong " },
    );
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["直す"] });
    await service.runNext(id);
    expect(started(service, id).at(-1)).toBe("requirements: strong ");
    // 長い名前も選べる
    expect(
      service.changeStepAgent(id, { step: "requirements", agent: "l".repeat(150) }).agents,
    ).toEqual({ requirements: "l".repeat(150) });
    service.requestChanges(id, { step: "requirements", submission: 2, comments: ["直す"] });
    await service.runNext(id);
    expect(started(service, id).at(-1)).toBe(`requirements:${"l".repeat(150)}`);
    activity.close();
  });

  it("統合レビューは、API でも理由を示して断り、作業履歴に残さない（PR #131 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const planner = async () => ({
      steps: ["requirements" as const, "design" as const, "split" as const, "integrate" as const],
      plan: "split" as const,
      reason: "大きいので分ける",
      fallback: false,
      costUsd: 0,
      estimated: false,
    });
    const { service } = makeService(activity, [completed(100)], {
      config: withAgents([base, strong]),
      planner,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(service.get(id)?.task.steps.map((s) => s.key)).toContain("integrate");
    expect(rejectWith(service, id)({ step: "integrate", agent: "strong" })).toEqual(
      message("agent.stepNotChangeable"),
    );
    expect(service.get(id)?.activity.some((e) => e.type === "StepAgentChanged")).toBe(false);
    activity.close();
  });

  it("準備（レビューの対象の確認）の間に変えたら、開始の記録と実行に新しいエージェントを使う（PR #131 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const gate = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    const read = pulls.pullRequest.bind(pulls);
    pulls.pullRequest = async (input) => {
      asked.resolve();
      await gate.promise;
      return read(input);
    };
    const { service, executor } = makeService(activity, [completed(100)], {
      config: withAgents([base, strong]),
      pulls,
      settings: new MemorySettingsStore({ reviewRequested: true }),
      realPlanner: true,
    });
    const [task] = service.importIssues([
      {
        repo: "https://github.com/acme/app",
        number: 12,
        title: "PR 12",
        body: "本文",
        url: "https://github.com/acme/app/pull/12",
        labels: [],
        pullRequest: true,
        review: "requested",
        requestedFor: "me",
      },
    ]);
    const id = task?.id ?? "";
    const running = service.runNext(id);
    await asked.promise;
    // レビューの対象を確かめている間に、人がエージェントを変える
    service.changeStepAgent(id, { step: "review", agent: "strong" });
    gate.resolve();
    await running;
    expect(started(service, id)).toEqual(["review:strong"]);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.command.join(" ")).toContain("claude-opus-5-5");
    activity.close();
  });

  it("準備の間に config.yaml に足した名前を選んだら、古い設定で止めずに、次の実行で最新の設定から始める（PR #131 再々レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const gate = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    const read = pulls.pullRequest.bind(pulls);
    pulls.pullRequest = async (input) => {
      asked.resolve();
      await gate.promise;
      return read(input);
    };
    const added = agent({ id: "added", model: "claude-sonnet-5-5" });
    let agents = [base, strong];
    const { service, executor } = makeService(activity, [completed(100)], {
      config: () => withAgents(agents)(),
      pulls,
      settings: new MemorySettingsStore({ reviewRequested: true }),
      realPlanner: true,
    });
    const [task] = service.importIssues([
      {
        repo: "https://github.com/acme/app",
        number: 12,
        title: "PR 12",
        body: "本文",
        url: "https://github.com/acme/app/pull/12",
        labels: [],
        pullRequest: true,
        review: "requested",
        requestedFor: "me",
      },
    ]);
    const id = task?.id ?? "";
    const running = service.runNext(id);
    await asked.promise;
    // レビューの対象を確かめている間に、config.yaml にエージェントを足して選ぶ
    agents = [base, strong, added];
    service.changeStepAgent(id, { step: "review", agent: "added" });
    gate.resolve();
    await running;
    expect(service.get(id)?.task.status).toBe("queued");
    expect(service.get(id)?.task.pausedMessage).toBeUndefined();
    expect(executor.calls).toEqual([]);
    await service.runNext(id);
    expect(started(service, id)).toEqual(["review:added"]);
    expect(executor.calls[0]?.command.join(" ")).toContain("claude-sonnet-5-5");
    activity.close();
  });

  it("準備の間に選び直していないのに名前が無ければ、これまでどおり一時停止する（実行待ちに戻し続けない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let agents = [base, strong];
    const { service, executor } = makeService(activity, [completed(100)], {
      config: () => withAgents(agents)(),
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.changeStepAgent(id, { step: "requirements", agent: "strong" });
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["直す"] });
    agents = [base];
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });
});

describe("使えないエージェントの警告（PBI-134）", () => {
  it("接続先・単価が無くて使えないエージェントは、画面の状態の警告に出し、選べるエージェントに入れない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const base = configOf(agent())();
    if (!base.ok) throw new Error("unreachable");
    const warning = message("config.modelPriceMissing", {
      provider: "codex",
      model: "gpt-6.1-sol",
      agents: "codex_standard",
    });
    const { service } = makeService(activity, [], {
      config: () => ({
        ok: true,
        config: { ...base.config, agents: { [agent().id]: agent() }, agentWarnings: [warning] },
      }),
    });
    const status = service.status();
    expect(status.warnings).toEqual([warning]);
    expect(status.agents.map((a) => a.id)).toEqual([agent().id]);
    activity.close();
  });
});

describe("実行の上限（config.yaml の run_timeout。PBI-150）", () => {
  const withTimeouts =
    (roles: Record<string, number>): (() => ConfigResult) =>
    () => {
      const base = configOf(agent())();
      if (!base.ok) return base;
      return {
        ok: true,
        config: { ...base.config, runTimeouts: { agentMinutes: 45, testMinutes: 7, roles } },
      };
    };

  it("設定は実行のたびに読む（デーモンを起動し直さなくても、次の実行から効く。PR #169 レビュー提案）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let current = configWithTimeouts({ agentMinutes: 45, testMinutes: 20, roles: {} });
    const { service, executor } = makeService(activity, [completed(1_000), completed(1_000)], {
      config: () => current(),
    });
    const a = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(a.id);
    expect(executor.timeouts[0]).toBe(45 * 60_000);
    // 同じサービスのまま、設定を変える
    current = configWithTimeouts({
      agentMinutes: 45,
      testMinutes: 20,
      roles: { requirements: 120 },
    });
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(b.id);
    expect(executor.timeouts[1]).toBe(120 * 60_000);
    activity.close();
  });

  it("工程の実行に、その役割の上限を渡す（上書きが無ければ既定、書かなければ 30 分）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    for (const [roles, expected] of [
      [{ requirements: 90 }, 90],
      [{ implement: 90 }, 45],
    ] as const) {
      const { service, executor } = makeService(activity, [completed(1_000)], {
        config: withTimeouts(roles),
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      // 最初の工程は要求要件
      expect(executor.timeouts[0], JSON.stringify(roles)).toBe(expected * 60_000);
    }
    const plain = makeService(activity, [completed(1_000)]);
    const task = plain.service.createTask({ projectId: "default", title: "B" });
    await plain.service.runNext(task.id);
    expect(plain.executor.timeouts[0]).toBe(30 * 60_000);
    activity.close();
  });
});

describe("Docker とエージェントのイメージの注意（PBI-148）", () => {
  it("確かめた注意を、画面の状態の docker に載せる（ほかの注意とは分ける。無ければ空）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const missing = message("image.missing", {
      image: "sacty-agent:1.28.0",
      command: "npx sacty image build",
    });
    let current = [missing];
    const { service } = makeService(activity, [], { imageProblems: () => current });
    expect(service.status().docker).toEqual([missing]);
    expect(service.status().warnings).not.toContainEqual(missing);
    current = [];
    expect(service.status().docker).toEqual([]);
    activity.close();
  });

  it("設定ファイルが無いとき（既定のイメージだけ確かめる）も、注意を載せる（PR #166 レビュー指摘）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const missing = message("image.missing", {
      image: "sacty-agent:1.28.0",
      command: "npx sacty image build",
    });
    const unreachable = message("image.dockerUnreachable");
    let current = [missing];
    const { service } = makeService(activity, [], {
      imageProblems: () => current,
      config: () => ({ ok: false, problem: message("config.missing", { path: "/x" }) }),
    });
    expect(service.status()).toMatchObject({ agent: null, warnings: [], docker: [missing] });
    current = [unreachable];
    expect(service.status().docker).toEqual([unreachable]);
    current = [];
    expect(service.status().docker).toEqual([]);
    activity.close();
  });
});

describe("sacty の新しい版の知らせ（PBI-135）", () => {
  it("新しい版があれば画面の状態に載せ、無ければ項目ごと出さない。設定に誤りがあっても載せる", () => {
    const activity = new SqliteActivityStore(dbPath);
    const update = {
      latest: "1.1.0",
      current: "1.0.0",
      releaseUrl: "https://github.com/sert-xx/sacty/releases/tag/v1.1.0",
    };
    let current: typeof update | undefined = update;
    const { service } = makeService(activity, [], { update: () => current });
    expect(service.status().update).toEqual(update);
    current = undefined;
    expect("update" in service.status()).toBe(false);
    const broken = makeService(activity, [], {
      update: () => update,
      config: () => ({ ok: false, problem: message("config.noDefaultAgent") }),
    });
    expect(broken.service.status()).toMatchObject({ agent: null, update });
    activity.close();
  });
});
