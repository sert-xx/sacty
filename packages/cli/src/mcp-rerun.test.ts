import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Task } from "@sacty/core";
import { startTaskMcp, type TaskDetail, type TaskSummary } from "@sacty/daemon/task-mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "../../../apps/daemon/src/activity.js";
import { createApp } from "../../../apps/daemon/src/server.js";
import {
  dbPath,
  FakePulls,
  FakeRepos,
  makeService,
  useTempDir,
} from "../../../apps/daemon/src/testing/daemon.js";
import { type Fetch, writeDaemonFile } from "./context-preview.js";
import { daemonApi } from "./mcp.js";

useTempDir();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sacty-mcp-rerun-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

type Inject = (method: string, path: string) => Promise<Response | undefined>;
type Rerun = {
  message: string;
  rerun: { originalTaskId: string; newTaskId: string; noteAdded: boolean };
  task: TaskSummary;
};

/** 本物のデーモンの API（createApp とサービス）と、本物の daemonApi をつないだ MCP。送った要求を記録する。 */
async function setup(inject?: Inject) {
  const activity = new SqliteActivityStore(dbPath);
  const { service } = makeService(activity, [], { repos: new FakeRepos(), pulls: new FakePulls() });
  const token = "t".repeat(64);
  const app = createApp(service, token);
  writeDaemonFile(home, { url: "http://127.0.0.1:4710", token });
  const requests: { method: string; path: string; body?: string }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    requests.push({
      method,
      path: u.pathname,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const injected = await inject?.(method, u.pathname);
    if (injected) return injected;
    return app.request(`${u.pathname}${u.search}`, init);
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  startTaskMcp(daemonApi(home, fetcher), { version: "1", transport: a });
  const client = new Client(
    { name: "t", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: result.isError === true, text, data: result.structuredContent as unknown };
  };
  const posts = () => requests.filter((r) => r.method === "POST");
  const count = (id: string) => service.get(id)?.activity.length ?? 0;
  const live = (id: string) => service.get(id)?.task as Task;
  const taskCount = () => service.list().length;
  const detail = async (id: string) => (await call("get_task", { task_id: id })).data as TaskDetail;
  return { activity, service, client, call, requests, posts, count, live, taskCount, detail };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** 中止したタスク。 */
async function cancelled(t: Setup, patch: Record<string, unknown> = {}, body = "人の説明") {
  const { id } = t.service.createTask({ projectId: "default", title: "決済API", body });
  Object.assign(t.live(id), patch);
  await t.service.cancel(id);
  return id;
}

describe("本物のデーモンのサービスを通した、中止したタスクの再実行（PBI-402）", () => {
  it("ツールは16個。再実行の引数は task_id と note だけで、注釈は書き込み・非破壊・非冪等・openWorld", async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    expect(tools).toHaveLength(16);
    const tool = tools.find((x) => x.name === "rerun_task");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["task_id", "note"]);
    expect(tool?.inputSchema.required).toEqual(["task_id"]);
    t.activity.close();
  });

  it("中止したタスクの再実行：新しいタスクが1つでき、題は元の題・説明は人の説明＋補足＋前の試行の記録・リポジトリは元のもの。元の作業履歴は増えない", async () => {
    const t = await setup();
    const id = await cancelled(t, { repo: "https://github.com/acme/app" });
    const before = t.count(id);
    const tasks = t.taskCount();
    const r = await t.call("rerun_task", { task_id: id, note: "  次は慎重に  " });
    expect(r.isError).toBe(false);
    const done = r.data as Rerun;
    expect(done.rerun.originalTaskId).toBe(id);
    expect(done.rerun.noteAdded).toBe(true);
    expect(done.message).toContain(id);
    expect(done.message).toContain("もう再実行できません");
    expect(t.taskCount()).toBe(tasks + 1);
    expect(t.count(id)).toBe(before);
    const fresh = t.live(done.rerun.newTaskId);
    expect(done.task.id).toBe(fresh.id);
    expect(fresh.title).toBe("決済API");
    expect(fresh.repo).toBe("https://github.com/acme/app");
    expect(fresh.body.startsWith("人の説明")).toBe(true);
    expect(fresh.body).toContain("## 補足（再実行で人が足したもの）\n\n次は慎重に");
    expect(fresh.body).toContain("## 前の試行の記録（中止したタスク）");
    expect(fresh.body.indexOf("## 補足")).toBeLessThan(fresh.body.indexOf("## 前の試行の記録"));
    // 送るのは、画面の既定値と補足だけ（image は送らない）
    expect(t.posts().map((p) => [p.path, JSON.parse(p.body ?? "{}")])).toEqual([
      [
        `/api/tasks/${id}/rerun`,
        {
          title: "決済API",
          body: "人の説明",
          repo: "https://github.com/acme/app",
          note: "次は慎重に",
        },
      ],
    ]);
    t.activity.close();
  });

  it("補足なし・補足が空白だけのときは、補足の見出しを足さず、noteを送らない。リポジトリ無しのタスクは無しのまま", async () => {
    const t = await setup();
    const id = await cancelled(t, { repo: undefined, repository: undefined });
    expect(t.live(id).repo).toBeUndefined();
    const r = await t.call("rerun_task", { task_id: id, note: "   \n " });
    expect(r.isError).toBe(false);
    const done = r.data as Rerun;
    expect(done.rerun.noteAdded).toBe(false);
    const fresh = t.live(done.rerun.newTaskId);
    expect(fresh.body).not.toContain("## 補足（再実行で人が足したもの）");
    expect(fresh.body).toContain("## 前の試行の記録（中止したタスク）");
    expect(fresh.repo).toBeUndefined();
    expect(JSON.parse(t.posts()[0]?.body ?? "{}")).toEqual({
      title: "決済API",
      body: "人の説明",
      repo: null,
    });
    t.activity.close();
  });

  it("再実行の後、元の要約にやり直した先の ID が出て canRerun は false、新しいタスクに元の ID が出る。中止して未再実行は true", async () => {
    const t = await setup();
    const id = await cancelled(t);
    const other = await cancelled(t);
    const beforeDetail = await t.detail(id);
    expect(beforeDetail.canRerun).toBe(true);
    expect(beforeDetail.rerunBlocked).toBeUndefined();
    expect(beforeDetail.rerunBy).toBeUndefined();
    const done = (await t.call("rerun_task", { task_id: id })).data as Rerun;
    expect(done.task.rerunOf).toBe(id);
    expect(done.task.rerunBy).toBeUndefined();
    const afterDetail = await t.detail(id);
    expect(afterDetail.rerunBy).toBe(done.rerun.newTaskId);
    expect(afterDetail.canRerun).toBe(false);
    expect(afterDetail.rerunBlocked?.reason).toContain(done.rerun.newTaskId);
    const list = (await t.call("list_tasks", { limit: 50 })).data as { tasks: TaskSummary[] };
    const byId = (x: string) => list.tasks.find((s) => s.id === x);
    expect(byId(id)).toMatchObject({ rerunBy: done.rerun.newTaskId, canRerun: false });
    expect(byId(done.rerun.newTaskId)).toMatchObject({ rerunOf: id, canRerun: false });
    expect(byId(other)).toMatchObject({ canRerun: true });
    expect(byId(other)?.rerunBy).toBeUndefined();
    expect(byId(other)?.rerunOf).toBeUndefined();
    t.activity.close();
  });

  it("2回目の呼び出しは、API を呼ばずに断られ、タスクは増えない。理由にやり直した先の ID が入る", async () => {
    const t = await setup();
    const id = await cancelled(t);
    const first = (await t.call("rerun_task", { task_id: id })).data as Rerun;
    const tasks = t.taskCount();
    const before = t.count(id);
    const posts = t.posts().length;
    const r = await t.call("rerun_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("再実行済み");
    expect(r.text).toContain(first.rerun.newTaskId);
    expect(t.posts().length).toBe(posts);
    expect(t.taskCount()).toBe(tasks);
    expect(t.count(id)).toBe(before);
    t.activity.close();
  });

  it("再実行で作ったタスクが中止されたら、そのタスクは再実行できる（元のタスクはできないまま）", async () => {
    const t = await setup();
    const id = await cancelled(t);
    const first = (await t.call("rerun_task", { task_id: id })).data as Rerun;
    await t.service.cancel(first.rerun.newTaskId);
    expect((await t.detail(first.rerun.newTaskId)).canRerun).toBe(true);
    const second = await t.call("rerun_task", { task_id: first.rerun.newTaskId });
    expect(second.isError).toBe(false);
    expect((second.data as Rerun).task.rerunOf).toBe(first.rerun.newTaskId);
    expect((await t.detail(id)).canRerun).toBe(false);
    t.activity.close();
  });

  it("中止していないタスク（実行待ち・実行中・承認待ち・一時停止中・完了）は、API を呼ばずに断り、作業履歴・タスクの数は変わらない。完了は続きの作成（画面）に触れる", async () => {
    const t = await setup();
    const mk = (title: string, patch: Record<string, unknown> = {}) => {
      const { id } = t.service.createTask({ projectId: "default", title });
      Object.assign(t.live(id), patch);
      return id;
    };
    const cases: [string, string][] = [
      [mk("実行待ち"), "実行待ち"],
      [mk("実行中", { status: "running" }), "実行中"],
      [mk("承認待ち", { status: "awaiting_approval" }), "承認待ち"],
      [mk("一時停止中", { status: "paused", pausedReason: "manual" }), "一時停止中"],
    ];
    for (const [id, label] of cases) {
      const before = t.count(id);
      const r = await t.call("rerun_task", { task_id: id });
      expect(r.isError, label).toBe(true);
      expect(r.text, label).toContain("中止したタスクではない");
      expect(t.count(id), label).toBe(before);
      const d = await t.detail(id);
      expect(d.canRerun, label).toBe(false);
      expect(d.rerunBlocked, label).toBeUndefined();
    }
    // 完了（idle で、工程がすべて終わった）
    const done = mk("完了");
    Object.assign(t.live(done), {
      status: "idle",
      steps: [{ key: "implement", state: "done" }],
    });
    expect((await t.detail(done)).state).toBe("completed");
    const before = t.count(done);
    const finished = await t.call("rerun_task", { task_id: done });
    expect(finished.isError).toBe(true);
    expect(finished.text).toContain("続きの作成（派生）");
    expect(finished.text).toContain("画面で続きを作って");
    expect(t.count(done)).toBe(before);
    const fd = await t.detail(done);
    expect(fd.canRerun).toBe(false);
    expect(fd.rerunBlocked).toBeUndefined();
    expect(t.posts()).toEqual([]);
    t.activity.close();
  });

  it("再実行済み・分割の子タスク・PR のレビューのタスクは、API を呼ばずに理由を返して断り、作業履歴・タスクの数は変わらない", async () => {
    const t = await setup();
    const child = await cancelled(t, { parent: { taskId: "parent", dependsOn: [] } });
    const review = await cancelled(t, { start: "github_pull_request" });
    const tasks = t.taskCount();
    const cases: [string, string][] = [
      [child, "親のタスクから進めて"],
      [review, "PR で依頼し直して"],
    ];
    for (const [id, text] of cases) {
      const before = t.count(id);
      const r = await t.call("rerun_task", { task_id: id });
      expect(r.isError, text).toBe(true);
      expect(r.text, text).toContain(text);
      expect(t.count(id), text).toBe(before);
      const d = await t.detail(id);
      expect(d.canRerun, text).toBe(false);
      expect(d.rerunBlocked?.reason, text).toContain(text);
    }
    expect(t.taskCount()).toBe(tasks);
    expect(t.posts()).toEqual([]);
    t.activity.close();
  });

  it("チケットから取り込み、作業するリポジトリが決まっていないタスクは、API を呼ばずに、画面でリポジトリを選んで再実行すると返して断る", async () => {
    const t = await setup();
    const id = await cancelled(t, {
      start: "jira",
      repo: undefined,
      repository: undefined,
      ticket: {
        platform: "jira",
        service: "jira-cloud",
        key: "ABC-1",
        url: "https://example.test/ABC-1",
      },
    });
    const tasks = t.taskCount();
    const before = t.count(id);
    const r = await t.call("rerun_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("画面でリポジトリを選んで再実行");
    const d = await t.detail(id);
    expect(d.canRerun).toBe(false);
    expect(d.rerunBlocked?.decideOnScreen).toEqual(["作業するリポジトリの選択"]);
    expect(t.posts()).toEqual([]);
    expect(t.taskCount()).toBe(tasks);
    expect(t.count(id)).toBe(before);
    t.activity.close();
  });

  it("人の説明が上限を超えるなど、既定値のままでは送れないタスクは、API を呼ばずに、画面で直して再実行すると返して断る", async () => {
    const t = await setup();
    const id = await cancelled(t, { body: "あ".repeat(10_001) });
    const tasks = t.taskCount();
    const r = await t.call("rerun_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("画面で直して再実行");
    expect((await t.detail(id)).canRerun).toBe(false);
    expect(t.posts()).toEqual([]);
    expect(t.taskCount()).toBe(tasks);
    t.activity.close();
  });

  it("無いタスク・消したプロジェクトのタスク・形が正しくない task_id は、無いものとして断り、何も送らない", async () => {
    const t = await setup();
    const id = await cancelled(t);
    const none = await t.call("rerun_task", { task_id: "nope" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("タスクが見つかりません");
    const bad = await t.call("rerun_task", { task_id: "../x" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("task_id の形が正しくありません");
    const gone = await setup(async (m, p) =>
      m === "GET" && p === `/api/tasks/${id}`
        ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
        : undefined,
    );
    const r = await gone.call("rerun_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("タスクが見つかりません");
    expect(gone.posts()).toEqual([]);
    expect(t.posts()).toEqual([]);
    t.activity.close();
    gone.activity.close();
  });

  it("デーモンが断るとき（リポジトリがプロジェクトの対象でない）は、その理由と画面で選び直せることを返し、タスクは増えない", async () => {
    const t = await setup();
    const id = await cancelled(t, { repo: "https://github.com/other/unknown" });
    const tasks = t.taskCount();
    const before = t.count(id);
    const r = await t.call("rerun_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("対象リポジトリを");
    expect(r.text).toContain("画面の「再実行」で、作業するリポジトリを選び直して");
    expect(t.posts()).toHaveLength(1);
    expect(t.taskCount()).toBe(tasks);
    expect(t.count(id)).toBe(before);
    expect(t.live(id).rerunBy).toBeUndefined();
    t.activity.close();
  });

  it("補足が長すぎる（10,000 文字を超える）ときは、API を呼ばずに断り、タスクは増えない。ちょうど上限なら通る", async () => {
    const t = await setup();
    const id = await cancelled(t);
    const tasks = t.taskCount();
    const long = await t.call("rerun_task", { task_id: id, note: "あ".repeat(10_001) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain("補足は 10000 文字まで");
    expect(t.posts()).toEqual([]);
    expect(t.taskCount()).toBe(tasks);
    const ok = await t.call("rerun_task", { task_id: id, note: ` ${"あ".repeat(10_000)} ` });
    expect(ok.isError).toBe(false);
    expect(t.taskCount()).toBe(tasks + 1);
    t.activity.close();
  });

  it("デーモンが断るとき（プロジェクトに対象が1つも無い）は、デーモンの文のまま返し、画面で選び直せるとは添えない。タスクは増えない", async () => {
    const t = await setup();
    const id = await cancelled(t, { repo: "https://github.com/acme/app" });
    const project = (
      t.service as unknown as {
        deps: { projects: { get(id: string): { targets: unknown[] } | undefined } };
      }
    ).deps.projects.get("default");
    project?.targets.splice(0);
    const tasks = t.taskCount();
    const r = await t.call("rerun_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("プロジェクトの設定で対象を追加してから");
    expect(r.text).not.toContain("選び直して");
    expect(t.posts()).toHaveLength(1);
    expect(t.taskCount()).toBe(tasks);
    expect(t.live(id).rerunBy).toBeUndefined();
    t.activity.close();
  });

  it("送るリポジトリは source.repo を優先し、無ければ repo、それも無ければ repository.url。チケット由来でもリポジトリが決まっていれば再実行できる", async () => {
    const ticket = {
      platform: "jira",
      service: "jira-cloud",
      key: "ABC-2",
      url: "https://example.test/ABC-2",
    };
    const t = await setup();
    const bySource = await cancelled(t, {
      repo: "https://github.com/acme/other",
      source: { repo: "https://github.com/acme/app" },
    });
    const byRepo = await cancelled(t, { repo: "https://github.com/acme/app" });
    const byUrl = await cancelled(t, {
      repo: undefined,
      repository: { url: "https://github.com/acme/app" },
    });
    const fromTicket = await cancelled(t, {
      start: "jira",
      ticket,
      repo: "https://github.com/acme/app",
    });
    for (const id of [bySource, byRepo, byUrl, fromTicket]) {
      expect((await t.detail(id)).canRerun, id).toBe(true);
      const r = await t.call("rerun_task", { task_id: id });
      expect(r.isError, id).toBe(false);
    }
    expect(t.posts().map((p) => JSON.parse(p.body ?? "{}").repo)).toEqual([
      "https://github.com/acme/app",
      "https://github.com/acme/app",
      "https://github.com/acme/app",
      "https://github.com/acme/app",
    ]);
    t.activity.close();
  });

  it("補足の長さはデーモンと同じ検査で数える：CRLF を含み、改行をそろえると上限以下でも、元の長さが上限を超えれば送らずに断る", async () => {
    const t = await setup();
    const id = await cancelled(t);
    const tasks = t.taskCount();
    // n 行を CRLF でつなぐ（元の長さは 3n-2 文字、改行をそろえると 2n-1 文字）
    const lines = (n: number) => Array.from({ length: n }, () => "x").join("\r\n");
    expect(lines(3334).length).toBe(10_000);
    expect(lines(3335).length).toBe(10_003);
    const r = await t.call("rerun_task", { task_id: id, note: lines(3335) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("補足は 10000 文字まで");
    expect(t.posts()).toEqual([]);
    expect(t.taskCount()).toBe(tasks);
    const ok = await t.call("rerun_task", { task_id: id, note: lines(3334) });
    expect(ok.isError).toBe(false);
    expect(t.taskCount()).toBe(tasks + 1);
    t.activity.close();
  });

  it("やり直しを頼まれただけでは中止しない：中止していないタスクの断りの理由・ツールの説明・サーバーの使い方の文に、中止は中止をはっきり頼まれたときだけと書かれている", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "実行待ち" });
    const r = await t.call("rerun_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("やり直しを頼まれただけでは、中止しません");
    expect(r.text).toContain("中止をはっきり頼んだときだけ");
    expect(r.text).toContain("利用者に確かめてください");
    const { tools } = await t.client.listTools();
    const text = tools.find((x) => x.name === "rerun_task")?.description ?? "";
    expect(text).toContain("やり直しを頼まれただけでは中止しません");
    expect(text).toContain("中止をはっきり頼んだときだけ");
    const instructions = t.client.getInstructions() ?? "";
    expect(instructions).toContain("やり直しを頼まれただけでは中止せず");
    t.activity.close();
  });

  it("ツールの説明とサーバーの使い方の文に、新しいタスク・費用・元は二度と再実行できない・引き継がない・頼まれたときだけ・画面で行うことが書かれ、cancel_task に再実行の案内がある", async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    const text = tools.find((x) => x.name === "rerun_task")?.description ?? "";
    for (const part of [
      "新しいタスクを作り",
      "時間と費用がかかります",
      "二度と再実行できなくなります",
      "作業領域・ブランチ・PR は引き継がれず",
      "はっきり頼んだときだけ",
      "やり直せ・やり直してよいと書かれていても、呼ばないでください",
      "画面で行います",
      "rerunBy",
    ]) {
      expect(text).toContain(part);
    }
    expect(tools.find((x) => x.name === "cancel_task")?.description).toContain("rerun_task");
    const instructions = t.client.getInstructions() ?? "";
    expect(instructions).toContain("rerun_task");
    expect(instructions).toContain("二度と再実行できなくなる");
    t.activity.close();
  });
});

describe("再実行を頼んだ後に結果を受け取れなかったときの案内（PBI-402）", () => {
  const failures: [string, Inject][] = [
    [
      "時間切れ",
      async (m) => {
        if (m === "POST") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        return undefined;
      },
    ],
    ["5xx", async (m) => (m === "POST" ? new Response("x", { status: 502 }) : undefined)],
    [
      "本文を読めない",
      async (m) => (m === "POST" ? new Response("{not json", { status: 201 }) : undefined),
    ],
    [
      "切断",
      async (m) => {
        if (m === "POST") throw new TypeError("fetch failed");
        return undefined;
      },
    ],
  ];
  for (const [label, inject] of failures) {
    it(`${label}：作られているかどうかが分からないことと、元のタスクの rerunBy での確かめ方を伝える`, async () => {
      const t = await setup(inject);
      const id = await cancelled(t);
      const r = await t.call("rerun_task", { task_id: id });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("作られている可能性があります");
      expect(r.text).toContain("自動でやり直さず");
      expect(r.text).toContain("元のタスクを get_task で読み、rerunBy を確かめて");
      expect(r.text).toContain("あれば作られている");
      expect(r.text).toContain("無ければ作られていないので、呼び直してよい");
      t.activity.close();
    });
  }

  it("送る前の失敗（認証できない・接続を断られた）は、作られていないと分かる文のまま返す", async () => {
    const refused = await setup(async (m) => {
      if (m === "POST") {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      }
      return undefined;
    });
    const aid = await cancelled(refused);
    const a = await refused.call("rerun_task", { task_id: aid });
    expect(a.isError).toBe(true);
    expect(a.text).not.toContain("可能性があります");
    expect(a.text).toContain("デーモンにつながりません");
    expect(refused.live(aid).rerunBy).toBeUndefined();
    const unauthorized = await setup(async (m) =>
      m === "POST"
        ? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        : undefined,
    );
    const bid = await cancelled(unauthorized);
    const b = await unauthorized.call("rerun_task", { task_id: bid });
    expect(b.isError).toBe(true);
    expect(b.text).toContain("認証できません");
    expect(b.text).not.toContain("作られている可能性");
    expect(unauthorized.live(bid).rerunBy).toBeUndefined();
    refused.activity.close();
    unauthorized.activity.close();
  });
});
