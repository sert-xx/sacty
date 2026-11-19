import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Task } from "@sacty/core";
import { startTaskMcp, type TaskDetail } from "@sacty/daemon/task-mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "../../../apps/daemon/src/activity.js";
import type { AgentOutcome } from "../../../apps/daemon/src/agents/parse.js";
import { createApp } from "../../../apps/daemon/src/server.js";
import {
  dbPath,
  FakeRepos,
  makeService,
  useTempDir,
} from "../../../apps/daemon/src/testing/daemon.js";
import { type Fetch, writeDaemonFile } from "./context-preview.js";
import { daemonApi } from "./mcp.js";

useTempDir();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sacty-mcp-pause-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const out = (text: string): AgentOutcome => ({
  kind: "completed",
  output: text,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
});
const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
const NO_TESTS = "README.md だけで、テストのコード・設定・CI が無い";
const plan = out(
  block({ "sacty-steps": { plan: "skip-design", reason: "小さい", noTests: NO_TESTS } }),
);

/** clone した作業領域に、ファイルを置く偽のリポジトリ。 */
class FilesRepos extends FakeRepos {
  override async prepare(...args: Parameters<FakeRepos["prepare"]>) {
    const result = await super.prepare(...args);
    mkdirSync(dirname(join(args[0], "README.md")), { recursive: true });
    writeFileSync(join(args[0], "README.md"), "# app");
    return result;
  }
}

type Summary = { state: string; pausedReason?: string; canPause: boolean; canResume: boolean };
type Done = { message: string; task: Summary };
type Inject = (method: string, path: string) => Promise<Response | undefined>;

/** 本物のデーモンの API（createApp とサービス）と、本物の daemonApi をつないだ MCP。送った要求を記録する。 */
async function setup(agent: AgentOutcome[] = [], inject?: Inject) {
  const activity = new SqliteActivityStore(dbPath);
  const { service } = makeService(activity, agent, { realPlanner: true, repos: new FilesRepos() });
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
  const detail = async (id: string) => (await call("get_task", { task_id: id })).data as TaskDetail;
  return { activity, service, call, requests, posts, count, live, detail };
}

/** 要求要件の承認待ち（PR を作らない。画面で承認する工程）のタスク。 */
async function awaiting() {
  const t = await setup([
    plan,
    out("# 要求要件\n\n- AGENTS.md を足す"),
    out("# 実装の説明\n\n- AGENTS.md を足した"),
  ]);
  const { id } = t.service.createTask({ template: "sacty-setup", projectId: "default" });
  await t.service.runNext(id);
  for (let i = 0; i < 12; i++) {
    const ids = t.service.queuedTaskIds();
    if (ids.length === 0) break;
    for (const next of ids) await t.service.runNext(next);
  }
  return { ...t, id };
}

describe("本物のデーモンのサービスを通した、一時停止と再開（PBI-400）", () => {
  it("実行待ちのタスクを一時停止でき、結果に manual の一時停止と要約が入る。送ったのは {} だけ", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    const r = await t.call("pause_task", { task_id: id });
    expect(r.isError).toBe(false);
    const done = r.data as Done;
    expect(done.task).toMatchObject({ state: "paused", pausedReason: "manual", canPause: false });
    expect(done.message).toContain("一時停止しました");
    expect(t.posts()).toEqual([{ method: "POST", path: `/api/tasks/${id}/pause`, body: "{}" }]);
    const events = t.service.get(id)?.activity.filter((e) => e.type === "TaskPaused") ?? [];
    expect(events).toHaveLength(1);
    t.activity.close();
  });

  it("承認待ちのタスクを一時停止でき、再開すると承認待ちに戻る（工程は実行し直さない）", async () => {
    const t = await awaiting();
    expect((await t.detail(t.id)).state).toBe("awaiting_approval");
    const paused = (await t.call("pause_task", { task_id: t.id })).data as Done;
    expect(paused.task).toMatchObject({ state: "paused", pausedReason: "manual" });
    expect(paused.message).toContain("承認ゲートと PR の見守りが止まります");
    const resumed = await t.call("resume_task", { task_id: t.id });
    expect(resumed.isError).toBe(false);
    const done = resumed.data as Done & { resumed: { noteAdded: boolean } };
    expect(done.task.state).toBe("awaiting_approval");
    expect(done.message).toContain("承認待ちに戻りました");
    expect(done.message).toContain("実行し直しません");
    expect(done.resumed.noteAdded).toBe(false);
    t.activity.close();
  });

  it("再開で、実行待ちは実行待ちに戻り、工程を実行し直すと文で分かる。補足は説明に足され、送るのは { note } だけ（前後の空白は除く）", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題", body: "元の説明" });
    await t.call("pause_task", { task_id: id });
    const r = await t.call("resume_task", { task_id: id, note: "  利用者の補足です\n  " });
    expect(r.isError).toBe(false);
    const done = r.data as Done & { resumed: { noteAdded: boolean } };
    expect(done.task.state).toBe("queued");
    expect(done.message).toContain("実行し直します");
    expect(done.message).toContain("費用");
    expect(done.resumed.noteAdded).toBe(true);
    expect(t.posts().at(-1)).toEqual({
      method: "POST",
      path: `/api/tasks/${id}/resume`,
      body: JSON.stringify({ note: "利用者の補足です" }),
    });
    const body = t.live(id).body;
    expect(body).toContain("元の説明");
    expect(body).toContain("利用者の補足です");
    t.activity.close();
  });

  it("補足が空白だけなら {} を送る。再開の API に送る入力は、{} か { note } だけで、余計な引数は送られない", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    await t.call("pause_task", { task_id: id });
    await t.call("resume_task", { task_id: id, note: "   \n " });
    await t.call("pause_task", { task_id: id });
    await t.call("resume_task", { task_id: id, note: "あとで" });
    await t.call("pause_task", { task_id: id });
    await t.call("resume_task", {
      task_id: id,
      capUsd: 100,
      tests: { kind: "none" },
      image: "x",
      agents: {},
    });
    const bodies = t
      .posts()
      .filter((r) => r.path.endsWith("/resume"))
      .map((r) => r.body);
    expect(bodies).toEqual(["{}", JSON.stringify({ note: "あとで" }), "{}"]);
    t.activity.close();
  });

  it("再開できる理由（manual 以外の error・verification・incomplete・unchanged・usage_limit・auth）は、どれも再開できる", async () => {
    const t = await setup();
    for (const reason of [
      "error",
      "verification",
      "incomplete",
      "unchanged",
      "usage_limit",
      "auth",
    ]) {
      const { id } = t.service.createTask({ projectId: "default", title: reason });
      await t.call("pause_task", { task_id: id });
      Object.assign(t.live(id), { pausedReason: reason });
      expect((await t.detail(id)).canResume, reason).toBe(true);
      const r = await t.call("resume_task", { task_id: id });
      expect(r.isError, `${reason}: ${r.text}`).toBe(false);
      expect((r.data as Done).task.state).toBe("queued");
    }
    t.activity.close();
  });

  it("完了したタスクの一時停止は、API を呼ばずに断り、作業履歴は増えない（サービスの pause を直接呼ぶと通ってしまう）", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    Object.assign(t.live(id), {
      status: "idle",
      steps: [{ key: "requirements", state: "done" }],
    });
    expect((await t.detail(id)).state).toBe("completed");
    const before = t.count(id);
    const postsBefore = t.posts().length;
    const r = await t.call("pause_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("完了したタスクは一時停止できません");
    expect(t.count(id)).toBe(before);
    expect(t.posts()).toHaveLength(postsBefore);
    // デーモンのサービスは、完了したタスクを断らず、一時停止を記録してしまう（だから MCP の層で先に断る）
    await t.service.pause(id);
    expect(t.count(id)).toBeGreaterThan(before);
    t.activity.close();
  });

  it("中止・一時停止中・人の判断待ち・ほかのタスクの待ち・検証中でない idle の一時停止は、API を呼ばずに断り、作業履歴は増えない", async () => {
    const t = await setup();
    const make = (title: string, patch: Record<string, unknown> = {}) => {
      const { id } = t.service.createTask({ projectId: "default", title });
      Object.assign(t.live(id), patch);
      return id;
    };
    const cancelled = make("中止");
    await t.service.cancel(cancelled);
    const paused = make("一時停止中");
    await t.call("pause_task", { task_id: paused });
    const cases: [string, string, string][] = [
      [cancelled, "中止したタスク", "中止"],
      [paused, "すでに一時停止", "一時停止中"],
      [make("判断待ち", { status: "escalated" }), "人の判断待ち", "escalated"],
      [make("依存待ち", { status: "blocked" }), "完了を待っている", "blocked"],
      [make("子待ち", { status: "waiting_children" }), "完了を待っている", "waiting_children"],
      [
        make("検証中でない idle", {
          status: "idle",
          steps: [{ key: "implement", state: "running" }],
        }),
        "検証中でない idle",
        "idle",
      ],
    ];
    for (const [id, text, label] of cases) {
      const before = t.count(id);
      const postsBefore = t.posts().length;
      const r = await t.call("pause_task", { task_id: id });
      expect(r.isError, label).toBe(true);
      expect(r.text, label).toContain(text);
      expect(r.text, label).toContain("何も変えていません");
      expect(t.count(id), label).toBe(before);
      expect(t.posts().length, label).toBe(postsBefore);
    }
    t.activity.close();
  });

  it("検証中の idle は一時停止できる", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    Object.assign(t.live(id), {
      status: "idle",
      verification: "pending",
      steps: [{ key: "implement", state: "running" }],
    });
    expect((await t.detail(id)).canPause).toBe(true);
    const r = await t.call("pause_task", { task_id: id });
    expect(r.isError, r.text).toBe(false);
    expect((r.data as Done).task.state).toBe("paused");
    t.activity.close();
  });

  it("無いタスク・消したプロジェクトのタスク・形が正しくない task_id は、どちらのツールも断り、何も送らない", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    // 終わったタスクだけにして、プロジェクトを消す（デーモンの一時停止の API は、プロジェクトを確かめず、完了も断らない）
    Object.assign(t.live(id), { status: "idle", steps: [{ key: "requirements", state: "done" }] });
    t.service.deleteProject("default");
    const before = t.posts().length;
    for (const name of ["pause_task", "resume_task"]) {
      const gone = await t.call(name, { task_id: id });
      expect(gone.isError, name).toBe(true);
      expect(gone.text, name).toContain("タスクが見つかりません");
      const none = await t.call(name, { task_id: "none" });
      expect(none.isError, name).toBe(true);
      expect(none.text, name).toContain("タスクが見つかりません");
      const requestsBefore = t.requests.length;
      const bad = await t.call(name, { task_id: "../x" });
      expect(bad.isError, name).toBe(true);
      expect(bad.text, name).toContain("task_id の形が正しくありません");
      expect(t.requests, name).toHaveLength(requestsBefore);
    }
    expect(t.posts()).toHaveLength(before);
    expect(t.service.get(id)?.activity.some((e) => e.type === "TaskPaused")).toBe(false);
    t.activity.close();
  });

  it("再開は、一時停止中でないタスク・budget・テストの扱いを決められる停止・child_cancelled を、API を呼ばずに断り、決めることを伝える", async () => {
    const t = await setup();
    const paused = (title: string, patch: Record<string, unknown>) => {
      const { id } = t.service.createTask({ projectId: "default", title });
      Object.assign(t.live(id), { status: "paused", ...patch });
      return id;
    };
    const queued = t.service.createTask({ projectId: "default", title: "実行待ち" }).id;
    const cases: [string, string, boolean][] = [
      [queued, "一時停止中のタスクではない", false],
      [paused("予算", { pausedReason: "budget" }), "予算の上限の引き上げ", true],
      [
        paused("テスト", {
          pausedReason: "error",
          pausedMessage: { code: "verify.documentsOnlyContradicted" },
          documentsOnly: true,
          steps: [{ key: "implement", state: "failed" }],
        }),
        "テストの扱い",
        true,
      ],
      [paused("子の中止", { pausedReason: "child_cancelled" }), "子タスクの中止", true],
    ];
    for (const [id, text, blocked] of cases) {
      const before = t.count(id);
      const postsBefore = t.posts().length;
      const r = await t.call("resume_task", { task_id: id, note: "補足" });
      expect(r.isError, text).toBe(true);
      expect(r.text, text).toContain(text);
      expect(r.text, text).toContain("何も変えていません");
      if (blocked) expect(r.text, text).toContain("画面で人が決めてください");
      expect(t.count(id), text).toBe(before);
      expect(t.posts().length, text).toBe(postsBefore);
      // get_task の読み取り側が、ツールの断りと食い違わない
      const d = await t.detail(id);
      expect(d.canResume, text).toBe(false);
      if (blocked) {
        expect(d.resumeBlocked?.reason, text).toBe(r.text);
        expect(d.resumeBlocked?.decideOnScreen.length, text).toBeGreaterThan(0);
      } else {
        expect(d.resumeBlocked, text).toBeUndefined();
      }
    }
    t.activity.close();
  });

  it("get_task・list_tasks の canPause・canResume は、ツールが断るかどうかと一致する", async () => {
    const t = await setup();
    const make = (title: string, patch: Record<string, unknown> = {}) => {
      const { id } = t.service.createTask({ projectId: "default", title });
      Object.assign(t.live(id), patch);
      return id;
    };
    const ids = {
      escalated: make("判断待ち", { status: "escalated" }),
      completed: make("完了", { status: "idle", steps: [{ key: "requirements", state: "done" }] }),
      budget: make("予算", { status: "paused", pausedReason: "budget" }),
      manual: make("手動", { status: "paused", pausedReason: "manual" }),
      queued: make("実行待ち"),
    };
    const listed = (await t.call("list_tasks", {})).data as {
      tasks: ({ id: string } & Summary)[];
    };
    for (const [label, id] of Object.entries(ids)) {
      const summary = listed.tasks.find((x) => x.id === id);
      const detail = await t.detail(id);
      expect(summary?.canPause, label).toBe(detail.canPause);
      expect(summary?.canResume, label).toBe(detail.canResume);
      const pause = await t.call("pause_task", { task_id: id });
      expect(!pause.isError, `pause ${label}: ${pause.text}`).toBe(detail.canPause);
      const resume = await t.call("resume_task", { task_id: id });
      // 一時停止中でないタスクは、canResume が false で、再開も断られる。queued は、さっき一時停止した
      expect(!resume.isError, `resume ${label}: ${resume.text}`).toBe(
        detail.canResume || (label === "queued" && detail.canPause),
      );
    }
    t.activity.close();
  });

  it("補足が長すぎるときは、再開せずに理由を返し、API に送らない", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    await t.call("pause_task", { task_id: id });
    const postsBefore = t.posts().length;
    const before = t.count(id);
    const r = await t.call("resume_task", { task_id: id, note: "あ".repeat(10_001) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("10000 文字まで");
    expect(t.posts()).toHaveLength(postsBefore);
    expect(t.count(id)).toBe(before);
    expect((await t.detail(id)).state).toBe("paused");
    t.activity.close();
  });

  it("デーモンが再開を断ったときは、デーモンの理由をそのまま返し、何も記録しない（外部作業が始まっている）", async () => {
    const t = await setup();
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    await t.call("pause_task", { task_id: id });
    Object.assign(t.live(id), { operationAttempted: { step: "implement" } });
    const before = t.count(id);
    const r = await t.call("resume_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).not.toContain("可能性があります");
    expect(t.count(id)).toBe(before);
    t.activity.close();
  });

  it("止める前に作業が終わって承認待ちになったとき（pause.reachedApproval）は、一時停止していないと分かる理由を返す", async () => {
    const t = await setup([], async (method, path) =>
      method === "POST" && path.endsWith("/pause")
        ? Response.json(
            { error: "invalid_operation", messages: [{ code: "pause.reachedApproval" }] },
            { status: 409 },
          )
        : undefined,
    );
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    const r = await t.call("pause_task", { task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("一時停止しませんでした");
    expect(r.text).not.toContain("可能性があります");
    t.activity.close();
  });
});

describe("頼んだ後に結果を受け取れなかったときの案内（一時停止・再開）", () => {
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
      async (m) => (m === "POST" ? new Response("{not json", { status: 200 }) : undefined),
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
    it(`${label}：一時停止・再開は、されている可能性と get_task で確かめることを伝える（自動でやり直さない）`, async () => {
      const t = await setup([], inject);
      const { id } = t.service.createTask({ projectId: "default", title: "題" });
      const pause = await t.call("pause_task", { task_id: id });
      expect(pause.isError).toBe(true);
      expect(pause.text).toContain("一時停止されている可能性があります");
      expect(pause.text).toContain("自動でやり直さず");
      expect(pause.text).toContain("get_task");
      Object.assign(t.live(id), { status: "paused", pausedReason: "manual" });
      const resume = await t.call("resume_task", { task_id: id });
      expect(resume.isError).toBe(true);
      expect(resume.text).toContain("再開されている可能性があります");
      expect(resume.text).toContain("自動でやり直さず");
      expect(resume.text).toContain("get_task");
      t.activity.close();
    });
  }

  it("送る前の失敗（つながらない・認証できない）は、されている可能性とは言わない", async () => {
    const refused: Inject = async (m) => {
      if (m !== "POST") return undefined;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
    };
    const t = await setup([], refused);
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    const pause = await t.call("pause_task", { task_id: id });
    expect(pause.isError).toBe(true);
    expect(pause.text).toContain("デーモンにつながりません");
    expect(pause.text).not.toContain("可能性があります");
    t.activity.close();

    const unauth = await setup([], async (m) =>
      m === "POST" ? new Response("no", { status: 401 }) : undefined,
    );
    const other = unauth.service.createTask({ projectId: "default", title: "題" });
    Object.assign(unauth.live(other.id), { status: "paused", pausedReason: "manual" });
    const resume = await unauth.call("resume_task", { task_id: other.id });
    expect(resume.isError).toBe(true);
    expect(resume.text).toContain("認証できません");
    expect(resume.text).not.toContain("可能性があります");
    unauth.activity.close();
  });

  it("共通化した後も、承認・差し戻しの、結果を受け取れなかったときの文は、前と同じ全文", async () => {
    const t = await setup([], async (m) =>
      m === "POST" ? new Response("x", { status: 503 }) : undefined,
    );
    const { id } = t.service.createTask({ projectId: "default", title: "題" });
    const approve = await t.call("approve_step", {
      task_id: id,
      step: "requirements",
      submission: 1,
    });
    expect(approve.text).toBe(
      "デーモンが 503 を返しました。承認されている可能性があります。自動でやり直さず、get_task で state と approval を確かめてから、まだ承認待ちなら呼び直してください。",
    );
    const timedOut = await setup([], async (m) => {
      if (m === "POST") throw Object.assign(new Error("t"), { name: "TimeoutError" });
      return undefined;
    });
    const other = timedOut.service.createTask({ projectId: "default", title: "題" });
    const approveTimedOut = await timedOut.call("approve_step", {
      task_id: other.id,
      step: "requirements",
      submission: 1,
    });
    expect(approveTimedOut.text).toBe(
      "承認の結果を受け取れませんでした（時間切れ・切断など）。承認されている可能性があります。自動でやり直さず、get_task で state と approval を確かめてから、まだ承認待ちなら呼び直してください。",
    );
    t.activity.close();
    timedOut.activity.close();
  });
});
