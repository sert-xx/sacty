import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { ConfigResult } from "./config.js";
import { MemoryProjectStore } from "./projects.js";
import { MemoryScheduleStore, ScheduledTasks, SqliteScheduleStore } from "./schedules.js";
import { MemorySecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { InvalidOperationError, TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-schedules-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const unused = new Proxy({}, { get: () => () => Promise.reject(new Error("unused")) });

const config = (): ConfigResult => ({
  ok: true,
  config: {
    image: "img",
    budgetPerTaskUsd: 1,
    defaultAgent: { id: "stub", runtime: "stub", auth: { mode: "stub" } } as never,
  } as never,
});

/** ローカルの時刻（月は 1 始まり）。 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

const REPO = "https://github.com/acme/payments";

function setup(store = new MemoryScheduleStore()) {
  const activity = new SqliteActivityStore(join(dir, "sacty.db"));
  const service = new TaskService({
    activity,
    config,
    secrets: new MemorySecretStore({}),
    executor: unused as AgentExecutor,
    repos: unused as never,
    tests: unused as never,
    pulls: unused as never,
    projects: new MemoryProjectStore(),
    settings: new MemorySettingsStore({}),
    github: unused as never,
    workspaceRoot: join(dir, "workspaces"),
  });
  const project = service.saveProject(undefined, {
    name: "決済",
    githubAccounts: { "github.com": "me" },
    targets: [{ scope: "repo", target: REPO }],
  });
  const clock = { now: at(2026, 10, 20, 8) };
  const network = { online: true, checks: 0 };
  const schedules = new ScheduledTasks({
    store,
    tasks: service,
    now: () => clock.now,
    reachable: async () => {
      network.checks++;
      return network.online;
    },
  });
  return { activity, service, project, schedules, clock, network, store };
}

const daily = (task: Record<string, unknown> = { title: "依存の更新", repo: REPO }) => ({
  name: "毎朝",
  rule: { kind: "daily", time: "09:00" },
  task,
});

describe("スケジュールタスク", () => {
  it("予定の時刻を過ぎたら、決めた内容のタスクを作り、そのスケジュールタスクの回として記録する", async () => {
    const { activity, service, project, schedules, clock } = setup();
    const created = schedules.create(project.id, daily({ title: "依存の更新", plan: "direct" }));
    expect(created.nextRunAt).toBe(at(2026, 10, 20, 9).toISOString());

    await schedules.tick(); // まだ予定の時刻ではない
    expect(service.list()).toHaveLength(0);

    clock.now = at(2026, 10, 20, 9, 0);
    await schedules.tick();
    const [task] = service.list();
    expect(task).toMatchObject({
      title: "依存の更新",
      start: "schedule",
      schedule: { id: created.id, slot: at(2026, 10, 20, 9).toISOString() },
      requestedPlan: "direct",
      noRepo: true,
    });
    const detail = schedules.get(created.id);
    expect(detail?.tasks.map((t) => t.id)).toEqual([task?.id]);
    expect(detail?.schedule.lastRun).toMatchObject({ taskId: task?.id });

    await schedules.tick(); // 同じ回は二重に作らない
    expect(service.list()).toHaveLength(1);
    activity.close();
  });

  it("PC が止まっていて何回分も逃しても、復帰したときに直前の1回分だけを作る", async () => {
    const { activity, service, project, schedules, clock } = setup();
    const created = schedules.create(project.id, daily());
    // 3日間止まっていて、10/23 の 15:00 に起動した
    clock.now = at(2026, 10, 23, 15);
    await schedules.tick();
    await schedules.tick();
    expect(service.list().map((t) => t.schedule?.slot)).toEqual([
      at(2026, 10, 23, 9).toISOString(),
    ]);
    // 次の回は、いつもどおり作る
    clock.now = at(2026, 10, 24, 9, 1);
    await schedules.tick();
    expect(schedules.get(created.id)?.tasks).toHaveLength(2);
    activity.close();
  });

  it("ネットにつながらない間は作らず、つながったときに直前の回の分を1つ作る", async () => {
    const { activity, service, project, schedules, clock, network } = setup();
    schedules.create(project.id, daily());
    network.online = false;
    clock.now = at(2026, 10, 20, 9, 5);
    await schedules.tick();
    clock.now = at(2026, 10, 21, 10);
    await schedules.tick();
    expect(service.list()).toHaveLength(0);
    network.online = true;
    await schedules.tick();
    expect(service.list().map((t) => t.schedule?.slot)).toEqual([
      at(2026, 10, 21, 9).toISOString(),
    ]);
    activity.close();
  });

  it("予定の回が来ていなければ、ネットの確認もしない", async () => {
    const { activity, project, schedules, network } = setup();
    schedules.create(project.id, daily());
    await schedules.tick();
    expect(network.checks).toBe(0);
    activity.close();
  });

  it("タスクを作った後、回を保存する前に止まっていても、同じ回のタスクを作り直さない", async () => {
    const store = new SqliteScheduleStore(join(dir, "sacty.db"));
    const { activity, service, project, schedules, clock } = setup(store);
    const created = schedules.create(project.id, daily());
    clock.now = at(2026, 10, 20, 9, 1);
    await schedules.tick();
    // 回の処理の保存を失った（タスクは作業履歴に残っている）
    const saved = store.get(created.id);
    if (!saved) throw new Error("missing");
    const { lastRun: _lost, ...rest } = saved;
    store.put(rest);
    await schedules.tick();
    expect(service.list()).toHaveLength(1);
    expect(store.get(created.id)?.lastRun?.taskId).toBe(service.list()[0]?.id);
    store.close();
    activity.close();
  });

  it("テンプレートの内容でも作れる（題と説明は sacty が決める）", async () => {
    const { activity, service, project, schedules, clock } = setup();
    schedules.create(project.id, daily({ template: "sacty-setup" }));
    clock.now = at(2026, 10, 20, 9);
    await schedules.tick();
    expect(service.list()[0]).toMatchObject({
      start: "schedule",
      template: "sacty-setup",
      repo: REPO,
    });
    activity.close();
  });

  it("作るタスクの内容は、保存するときに画面の作成と同じく確かめる", () => {
    const { activity, project, schedules } = setup();
    expect(() =>
      schedules.create(project.id, daily({ title: "t", repo: "https://github.com/other/x" })),
    ).toThrow(InvalidOperationError);
    expect(() => schedules.create("missing", daily())).toThrow(InvalidOperationError);
    activity.close();
  });

  it("編集で内容・予定・止める/再開を変えられる。予定を変えた・再開したなら、それより前の回は作らない", async () => {
    const { activity, service, project, schedules, clock } = setup();
    const created = schedules.create(project.id, daily());
    clock.now = at(2026, 10, 20, 8, 30);
    const paused = schedules.update(created.id, { ...daily(), enabled: false });
    expect(paused.nextRunAt).toBeUndefined();
    clock.now = at(2026, 10, 20, 9, 30);
    await schedules.tick();
    expect(service.list()).toHaveLength(0);
    // 9:30 に再開しても、止めていた間の 9:00 の回は作らない
    const resumed = schedules.update(created.id, {
      name: "夕方",
      rule: { kind: "weekly", time: "18:00", days: [2] },
      task: { title: "週次の確認", body: "内容", repo: REPO },
    });
    expect(resumed).toMatchObject({ name: "夕方", rule: { kind: "weekly" }, enabled: true });
    await schedules.tick();
    expect(service.list()).toHaveLength(0);
    clock.now = at(2026, 10, 20, 18, 0); // 10/20 は火曜
    await schedules.tick();
    expect(service.list()[0]).toMatchObject({ title: "週次の確認", body: "内容", repo: REPO });
    activity.close();
  });

  it("作れなくなった内容（プロジェクトの対象から外れた）なら、理由を回の結果に残し、同じ回を作り直さない", async () => {
    const { activity, service, project, schedules, clock } = setup();
    const created = schedules.create(project.id, daily());
    service.saveProject(project.id, {
      name: "決済",
      githubAccounts: { "github.com": "me" },
      targets: [{ scope: "repo", target: "https://github.com/acme/other" }],
    });
    clock.now = at(2026, 10, 20, 9);
    await schedules.tick();
    await schedules.tick();
    expect(service.list()).toHaveLength(0);
    const run = schedules.get(created.id)?.schedule.lastRun;
    expect(run?.taskId).toBeUndefined();
    expect(renderMessage(run?.error, "ja")).toContain("決済");
    activity.close();
  });

  it("API：作成・一覧・詳細・編集・削除。プロジェクトを消すと、そのスケジュールタスクも消える", async () => {
    const { activity, service, project, schedules } = setup();
    const app = createApp(service, "t", { schedules });
    const auth = { authorization: "Bearer t", "content-type": "application/json" };
    const post = await app.request(`/api/projects/${project.id}/schedules`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(daily()),
    });
    expect(post.status).toBe(201);
    const { schedule } = (await post.json()) as { schedule: { id: string } };
    const invalid = await app.request(`/api/projects/${project.id}/schedules`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...daily(), name: "" }),
    });
    expect(invalid.status).toBe(400);
    const list = await app.request(`/api/projects/${project.id}/schedules`, { headers: auth });
    expect(((await list.json()) as { schedules: unknown[] }).schedules).toHaveLength(1);
    const put = await app.request(`/api/schedules/${schedule.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ ...daily(), name: "改名" }),
    });
    expect(((await put.json()) as { schedule: { name: string } }).schedule.name).toBe("改名");
    const get = await app.request(`/api/schedules/${schedule.id}`, { headers: auth });
    expect(((await get.json()) as { tasks: unknown[] }).tasks).toEqual([]);

    const other = service.saveProject(undefined, {
      name: "別",
      githubAccounts: { "github.com": "me" },
      targets: [{ scope: "repo", target: "https://github.com/acme/web" }],
    });
    schedules.create(other.id, daily({ title: "t" }));
    await app.request(`/api/projects/${other.id}`, { method: "DELETE", headers: auth });
    expect(schedules.list(other.id)).toBeUndefined();
    expect(schedules.list(project.id)).toHaveLength(1);

    const del = await app.request(`/api/schedules/${schedule.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(200);
    expect((await app.request(`/api/schedules/${schedule.id}`, { headers: auth })).status).toBe(
      404,
    );
    activity.close();
  });
});
