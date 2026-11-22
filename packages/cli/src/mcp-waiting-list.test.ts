import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Task } from "@sacty/core";
import { startTaskMcp } from "@sacty/daemon/task-mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "../../../apps/daemon/src/activity.js";
import { createApp } from "../../../apps/daemon/src/server.js";
import {
  dbPath,
  makeService,
  projectsWithAccount,
  useTempDir,
} from "../../../apps/daemon/src/testing/daemon.js";
import { type Fetch, writeDaemonFile } from "./context-preview.js";
import { daemonApi } from "./mcp.js";

useTempDir();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sacty-mcp-waiting-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

type Item = {
  id: string;
  state: string;
  projectId: string;
  projectName: string;
  pendingReview?: boolean;
  personTurnGroup?: string;
  waitingSince?: string;
  waitingSinceSource?: string;
};
type Listed = {
  total: number;
  returned: number;
  order: string;
  nextOffset?: number;
  excludedAiJudging?: number;
  tasks: Item[];
};
type Inject = (method: string, path: string) => Promise<Response | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 本物のデーモンの API（createApp とサービス）と、本物の daemonApi をつないだ MCP。送った要求を記録する。 */
async function setup(inject?: Inject) {
  const activity = new SqliteActivityStore(dbPath);
  const projects = projectsWithAccount();
  projects.put("other", {
    name: "別のプロジェクト",
    targets: [{ scope: "repo", target: "https://github.com/acme/other" }],
    githubAccounts: { "github.com": "me" },
  });
  const { service } = makeService(activity, [], { projects });
  const token = "t".repeat(64);
  const app = createApp(service, token);
  writeDaemonFile(home, { url: "http://127.0.0.1:4710", token });
  const requests: { method: string; path: string }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    requests.push({ method, path: u.pathname });
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
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "list_tasks", arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    return {
      isError: result.isError === true,
      text,
      data: result.structuredContent as unknown as Listed,
    };
  };
  const live = (id: string) => service.get(id)?.task as Task;
  const make = (title: string, patch: Record<string, unknown> = {}, projectId = "default") => {
    const { id } = service.createTask({ projectId, title });
    Object.assign(live(id), patch);
    return id;
  };
  const counts = () => ({
    tasks: service.list().length,
    events: service.list().reduce((n, t) => n + (service.get(t.id)?.activity.length ?? 0), 0),
  });
  return { activity, service, client, call, requests, make, live, counts };
}

describe("人の出番の絞り込み：画面のダッシュボードの「あなたの出番」と同じ判定（PBI-403）", () => {
  it("承認待ち・エスカレーション・一時停止が返り、AI が判断中の承認待ち・ほかの状態・消したプロジェクトは返らない。除いた件数が分かる", async () => {
    const t = await setup();
    const at = (n: number) => `2026-11-0${n}T00:00:00.000Z`;
    const approval = t.make("承認待ち", { status: "awaiting_approval", updatedAt: at(1) });
    const escalated = t.make("エスカレーション", { status: "escalated", updatedAt: at(2) });
    const paused = t.make("一時停止", { status: "paused", updatedAt: at(3) });
    t.make("AI が判断中", {
      status: "awaiting_approval",
      pendingReview: { judgement: undefined },
      updatedAt: at(4),
    });
    // pendingReview は承認待ちだけで除く（エスカレーション・一時停止では除かない）
    const escalatedPending = t.make("判断中の欄があるエスカレーション", {
      status: "escalated",
      pendingReview: { judgement: undefined },
      updatedAt: at(5),
    });
    const pausedPending = t.make("判断中の欄がある一時停止", {
      status: "paused",
      pendingReview: { judgement: undefined },
      updatedAt: at(6),
    });
    t.make("実行待ち", { status: "queued" });
    t.make("実行中", { status: "running" });
    t.make("完了", { status: "idle", steps: [{ key: "requirements", state: "done" }] });
    t.make("中止", { status: "cancelled" });
    t.make("消したプロジェクト", { status: "paused", projectId: "gone" });
    const r = await t.call({ needs_person: true });
    expect(r.isError).toBe(false);
    expect(r.data.tasks.map((x) => x.id).sort()).toEqual(
      [approval, escalated, paused, escalatedPending, pausedPending].sort(),
    );
    expect(r.data.excludedAiJudging).toBe(1);
    expect(r.data.total).toBe(5);
    // 要約で、AI が判断中の承認待ちと分かる（人の出番に絞らない一覧）
    const all = await t.call({ state: ["awaiting_approval"], limit: 100 });
    expect(all.data.tasks.filter((x) => x.pendingReview === true)).toHaveLength(1);
    expect(all.data.tasks).toHaveLength(2);
    t.activity.close();
  });

  it("集計に記録が無いタスクは updatedAt で補い、どちらの値かが分かる", async () => {
    const t = await setup();
    const id = t.make("記録なし", {
      status: "awaiting_approval",
      updatedAt: "2026-11-02T00:00:00.000Z",
    });
    const r = await t.call({ needs_person: true });
    expect(r.data.tasks).toMatchObject([
      { id, waitingSince: "2026-11-02T00:00:00.000Z", waitingSinceSource: "updatedAt" },
    ]);
    expect(r.data.order).toBe("personTurnGroup_waitingSince_asc");
    expect(r.data.tasks[0]?.personTurnGroup).toBe("decision");
    t.activity.close();
  });

  it("サービスの dashboard() の waitingSince と、同じ時刻・同じ並び（待ち始めの順と作成の順が逆）", async () => {
    const t = await setup();
    const a = t.make("A（最初に作る）");
    const b = t.make("B");
    const c = t.make("C（最後に作る）");
    // 作成は A・B・C の順。一時停止は C・A・B の順（待ち始めの順と作成の順が逆）
    for (const id of [c, a, b]) {
      await t.service.pause(id);
      await sleep(5);
    }
    // 記録のあるエスカレーション（作成は最後、待ち始めは一時停止の後）も混ぜる
    const e = t.make("E（エスカレーション）", { status: "awaiting_approval" });
    await sleep(5);
    (t.service as unknown as { append: (task: Task, events: unknown[]) => void }).append(
      t.live(e),
      [
        {
          actor: "sacty",
          event: {
            type: "TaskEscalated",
            payload: { step: "implement", reason: "too_many_changes" },
          },
        },
      ],
    );
    expect(t.live(e).status).toBe("escalated");
    // 記録の無い承認待ち（updatedAt で補う）も混ぜる
    const d = t.make("D（記録なし）", { status: "awaiting_approval" });
    const dashboard = t.service.dashboard().waitingSince;
    expect(Object.keys(dashboard).sort()).toEqual([a, b, c, e].sort());
    // 上の組（承認待ち・エスカレーション）→ 下の組（一時停止）。組の中は待ち始めの順
    const group = (id: string) => (t.live(id).status === "paused" ? 1 : 0);
    const expected = [a, b, c, d, e]
      .map((id) => ({ id, since: dashboard[id] ?? t.live(id).updatedAt }))
      .sort(
        (x, y) =>
          group(x.id) - group(y.id) || x.since.localeCompare(y.since) || x.id.localeCompare(y.id),
      );
    expect(expected.slice(2).map((x) => x.id)).toEqual([c, a, b]);
    const r = await t.call({ needs_person: true });
    expect(r.data.tasks.map((x) => [x.id, x.waitingSince])).toEqual(
      expected.map((x) => [x.id, x.since]),
    );
    for (const item of r.data.tasks) {
      expect(item.waitingSinceSource).toBe(dashboard[item.id] ? "dashboard" : "updatedAt");
    }
    t.activity.close();
  });

  it("待ち始めが同じなら id の順", async () => {
    const t = await setup();
    const same = "2026-11-03T00:00:00.000Z";
    const ids = [1, 2, 3].map((n) => t.make(`同時${n}`, { status: "paused", updatedAt: same }));
    const r = await t.call({ needs_person: true });
    expect(r.data.tasks.map((x) => x.id)).toEqual([...ids].sort());
    t.activity.close();
  });
});

describe("人の出番の組と並び・続きの取得（PBI-442）", () => {
  const day = (n: number) => `2026-11-0${n}T00:00:00.000Z`;

  it("上の組（承認待ち・エスカレーション）→ 下の組（一時停止）の順で、組の中は待ち始めの古い順。各タスクに組の値が入る", async () => {
    const t = await setup();
    // 待ち始め（updatedAt）の順は、組・作成の順とばらばら
    const p1 = t.make("止まり1", { status: "paused", updatedAt: day(1) });
    const d1 = t.make("判断1", { status: "awaiting_approval", updatedAt: day(5) });
    const p2 = t.make("止まり2", { status: "paused", updatedAt: day(2) });
    const d2 = t.make("判断2", { status: "escalated", updatedAt: day(4) });
    const r = await t.call({ needs_person: true });
    expect(r.data.order).toBe("personTurnGroup_waitingSince_asc");
    expect(r.data.tasks.map((x) => [x.id, x.personTurnGroup])).toEqual([
      [d2, "decision"],
      [d1, "decision"],
      [p1, "paused"],
      [p2, "paused"],
    ]);
    t.activity.close();
  });

  it("limit 2 で offset 0・2・4 と続けて取ると、組の境目をまたいでも重なりも抜けも無く、total・excludedAiJudging は同じ", async () => {
    const t = await setup();
    const ids = [
      t.make("判断1", { status: "awaiting_approval", updatedAt: day(6) }),
      t.make("判断2", { status: "escalated", updatedAt: day(5) }),
      t.make("判断3", { status: "awaiting_approval", updatedAt: day(4) }),
      t.make("止まり1", { status: "paused", updatedAt: day(1) }),
      t.make("止まり2", { status: "paused", updatedAt: day(2) }),
      t.make("止まり3", { status: "paused", updatedAt: day(3) }),
    ];
    t.make("AI が判断中", {
      status: "awaiting_approval",
      pendingReview: { judgement: undefined },
    });
    const whole = await t.call({ needs_person: true, limit: 100 });
    expect(whole.data.tasks).toHaveLength(6);
    expect(whole.data.tasks.map((x) => x.id).sort()).toEqual([...ids].sort());
    const parts = [];
    for (const offset of [0, 2, 4])
      parts.push(await t.call({ needs_person: true, limit: 2, offset }));
    expect(parts.flatMap((r) => r.data.tasks.map((x) => x.id))).toEqual(
      whole.data.tasks.map((x) => x.id),
    );
    expect(parts.flatMap((r) => r.data.tasks.map((x) => x.personTurnGroup))).toEqual([
      "decision",
      "decision",
      "decision",
      "paused",
      "paused",
      "paused",
    ]);
    for (const r of parts) {
      expect(r.data.total).toBe(6);
      expect(r.data.excludedAiJudging).toBe(1);
    }
    expect(parts.map((r) => r.data.nextOffset)).toEqual([2, 4, undefined]);
    // waitingSince は今のまま（記録が無いので updatedAt で補い、そう分かる）
    for (const item of whole.data.tasks) expect(item.waitingSinceSource).toBe("updatedAt");
    t.activity.close();
  });

  it("ツールの説明・出力の型・サーバーの説明に、組の欄の名前と値・並びがあり、ベルの件数が違うという文は無い", async () => {
    const t = await setup();
    const tools = (await t.client.listTools()).tools;
    const list = tools.find((x) => x.name === "list_tasks");
    const schema = JSON.stringify(list?.outputSchema);
    expect(schema).toContain("personTurnGroup_waitingSince_asc");
    expect(schema).toContain("personTurnGroup");
    expect(schema).toContain("decision");
    expect(schema).toContain("paused");
    expect(list?.description).toContain("personTurnGroup");
    expect(list?.description).toContain("personTurnGroup_waitingSince_asc");
    expect(list?.description).not.toContain("件数が違う");
    const instructions = t.client.getInstructions() ?? "";
    expect(instructions).toContain("personTurnGroup");
    expect(instructions).not.toContain("件数が違う");
    t.activity.close();
  });
});

describe("状態・プロジェクトの絞り込み、続き、プロジェクト名（PBI-403）", () => {
  it("state は複数指定でき、指定した状態のタスクだけが返る。知らない値は断る", async () => {
    const t = await setup();
    const p = t.make("止まる", { status: "paused" });
    const q = t.make("実行待ち", { status: "queued" });
    t.make("実行中", { status: "running" });
    const r = await t.call({ state: ["paused", "queued"] });
    expect(r.data.tasks.map((x) => x.id).sort()).toEqual([p, q].sort());
    expect(r.data.order).toBe("createdAt_desc");
    const bad = await t.call({ state: ["bogus"] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("state");
    t.activity.close();
  });

  it("project_id は、そのプロジェクトのタスクだけが返り、プロジェクト名が入る。needs_person とも組み合わせられる。無い id は理由つきで断る", async () => {
    const t = await setup();
    const inDefault = t.make("既定の中", { status: "paused" });
    const inOther = t.make("別の中", { status: "paused" }, "other");
    t.make("別の中の実行待ち", { status: "queued" }, "other");
    const r = await t.call({ project_id: "other", needs_person: true });
    expect(r.data.tasks).toMatchObject([
      { id: inOther, projectId: "other", projectName: "別のプロジェクト" },
    ]);
    const def = await t.call({ project_id: "default" });
    expect(def.data.tasks.map((x) => x.id)).toEqual([inDefault]);
    expect(def.data.tasks[0]?.projectName).toBe("デフォルト");
    const none = await t.call({ project_id: "gone" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("project_id gone のプロジェクトが見つかりません");
    t.activity.close();
  });

  for (const n of [0, 1, 3, 4]) {
    it(`offset で続きを取る：${n} 件・limit 3 で、重なりも抜けも無く total 件。最後は nextOffset が無い`, async () => {
      const t = await setup();
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(t.make(`T${i}`, { createdAt: `2026-11-0${i + 1}T00:00:00.000Z` }));
      }
      const got: string[] = [];
      let offset: number | undefined;
      let pages = 0;
      for (;;) {
        const r = await t.call({ limit: 3, ...(offset !== undefined ? { offset } : {}) });
        expect(r.data.total).toBe(n);
        got.push(...r.data.tasks.map((x) => x.id));
        pages++;
        if (r.data.nextOffset === undefined) break;
        offset = r.data.nextOffset;
      }
      expect(got).toEqual([...ids].reverse());
      expect(pages).toBe(n <= 3 ? 1 : 2);
      t.activity.close();
    });
  }

  for (const n of [0, 1, 3, 4]) {
    it(`needs_person でも offset で続きを取る：${n} 件・limit 3 で、待ち始めの順のまま重なりも抜けも無い`, async () => {
      const t = await setup();
      // 待ち始め（updatedAt）の順は、作成の順とばらばらにする
      const order = [3, 1, 4, 2];
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(
          t.make(`P${i}`, {
            status: "paused",
            updatedAt: `2026-11-0${order[i]}T00:00:00.000Z`,
          }),
        );
      }
      // 対象外のタスクを混ぜる
      t.make("実行待ち", { status: "queued" });
      const expected = ids
        .map((id) => ({ id, since: t.live(id).updatedAt }))
        .sort((x, y) => x.since.localeCompare(y.since))
        .map((x) => x.id);
      const got: string[] = [];
      let offset: number | undefined;
      let pages = 0;
      for (;;) {
        const r = await t.call({
          needs_person: true,
          limit: 3,
          ...(offset !== undefined ? { offset } : {}),
        });
        expect(r.data.total).toBe(n);
        got.push(...r.data.tasks.map((x) => x.id));
        pages++;
        if (r.data.nextOffset === undefined) break;
        offset = r.data.nextOffset;
      }
      expect(got).toEqual(expected);
      expect(pages).toBe(n <= 3 ? 1 : 2);
      t.activity.close();
    });
  }

  it("範囲の外の offset は、空の一覧（nextOffset なし・total はそのまま）", async () => {
    const t = await setup();
    t.make("1件");
    const r = await t.call({ offset: 50 });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ total: 1, returned: 0, tasks: [] });
    expect(r.data.nextOffset).toBeUndefined();
    t.activity.close();
  });

  it("offset が負・小数のときは、ツールのエラーで断られ、API は呼ばれない", async () => {
    const t = await setup();
    t.make("1件");
    const before = t.requests.length;
    for (const offset of [-1, 1.5]) {
      const r = await t.call({ offset });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("offset");
    }
    expect(t.requests).toHaveLength(before);
    t.activity.close();
  });

  it("いまある引数だけの呼び出しは、API の呼び出しが増えるのは GET /api/projects の 1 回だけで、ダッシュボードは読まない", async () => {
    const t = await setup();
    t.make("1件");
    const r = await t.call({});
    expect(r.data.order).toBe("createdAt_desc");
    expect(r.data.tasks[0]?.waitingSince).toBeUndefined();
    expect(r.data.tasks[0]?.personTurnGroup).toBeUndefined();
    expect(r.data.nextOffset).toBeUndefined();
    expect(r.data.excludedAiJudging).toBeUndefined();
    const paths = t.requests.map((x) => x.path).sort();
    expect(paths).toEqual(["/api/projects", "/api/projects", "/api/tasks"]);
    t.activity.close();
  });
});

describe("知らない引数・待ち始めを読めないとき・読むだけ（PBI-403）", () => {
  it("知らない引数は、ツールのエラーで断られ、理由に名前が入り、API は呼ばれない。tools/list にも出る", async () => {
    const t = await setup();
    t.make("1件");
    const before = t.requests.length;
    for (const name of ["status", "project"]) {
      const r = await t.call({ [name]: "x" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(name);
    }
    expect(t.requests).toHaveLength(before);
    const tools = (await t.client.listTools()).tools;
    expect(tools).toHaveLength(20);
    const list = tools.find((x) => x.name === "list_tasks");
    expect(list?.inputSchema.additionalProperties).toBe(false);
    expect(list?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    // ほかのツールの入力は変えない
    const other = tools.find((x) => x.name === "get_task");
    expect(other?.inputSchema.additionalProperties).not.toBe(false);
    t.activity.close();
  });

  it("GET /api/dashboard が 5xx・欄なし・接続できないとき、人の出番の絞り込みは理由つきで失敗し、絞らない呼び出しは影響を受けない", async () => {
    const modes: [string, Inject, string][] = [
      [
        "5xx",
        async (_m, path) =>
          path === "/api/dashboard" ? new Response("{}", { status: 503 }) : undefined,
        "503",
      ],
      [
        "欄なし",
        async (_m, path) =>
          path === "/api/dashboard"
            ? new Response(JSON.stringify({ stats: {} }), { status: 200 })
            : undefined,
        "waitingSince",
      ],
      [
        "値が文字列でない",
        async (_m, path) =>
          path === "/api/dashboard"
            ? new Response(JSON.stringify({ waitingSince: { x: 5 } }), { status: 200 })
            : undefined,
        "waitingSince",
      ],
      [
        "接続できない",
        async (_m, path) => {
          if (path === "/api/dashboard") throw new Error("fetch failed");
          return undefined;
        },
        "",
      ],
    ];
    for (const [label, inject, word] of modes) {
      const t = await setup(inject);
      const id = t.make("止まる", { status: "paused" });
      const failed = await t.call({ needs_person: true });
      expect(failed.isError, label).toBe(true);
      expect(failed.text, label).toContain(word);
      const ok = await t.call({});
      expect(ok.isError, label).toBe(false);
      expect(ok.data.tasks.map((x) => x.id)).toContain(id);
      t.activity.close();
    }
  });

  it("どの呼び出しでも、作業履歴・タスクの数・状態は変わらない（POST を送らない）", async () => {
    const t = await setup();
    t.make("止まる", { status: "paused" });
    t.make("待つ", { status: "awaiting_approval" });
    const before = t.counts();
    const states = t.service.list().map((x) => x.status);
    await t.call({});
    await t.call({ needs_person: true });
    await t.call({ state: ["paused"], project_id: "default", offset: 1, limit: 1 });
    await t.call({ status: "x" });
    expect(t.counts()).toEqual(before);
    expect(t.service.list().map((x) => x.status)).toEqual(states);
    expect(t.requests.filter((x) => x.method !== "GET")).toEqual([]);
    t.activity.close();
  });
});
