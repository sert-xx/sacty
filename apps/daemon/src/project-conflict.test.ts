import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectDefinition } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { ConfigResult } from "./config.js";
import { MemoryProjectStore, SqliteProjectStore } from "./projects.js";
import { MemorySecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { InvalidOperationError, TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";

// プロジェクトの設定を同時に保存したとき、先の変更が黙って消えない（PBI-274）

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-project-conflict-"));
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

const repo = (name: string) => ({ scope: "repo", target: `https://github.com/acme/${name}` });
const definition = (...names: string[]): ProjectDefinition =>
  ({
    name: "決済",
    githubAccounts: { "github.com": "me" },
    targets: names.map(repo),
  }) as ProjectDefinition;

const json = { authorization: "Bearer tok", "content-type": "application/json" };

function setup(projects = new MemoryProjectStore()) {
  const activity = new SqliteActivityStore(join(dir, "sacty.db"));
  const service = new TaskService({
    activity,
    config,
    secrets: new MemorySecretStore({}),
    executor: unused as AgentExecutor,
    repos: unused as never,
    tests: unused as never,
    pulls: unused as never,
    projects,
    settings: new MemorySettingsStore({}),
    github: unused as never,
    workspaceRoot: join(dir, "workspaces"),
  });
  const app = createApp(service, "tok");
  /** 画面が設定を読み込む（版 updatedAt と、そのときの対象）。 */
  const load = (id: string) => {
    const { project } = service.getProject(id) ?? { project: undefined };
    if (!project) throw new Error("missing");
    return {
      base: project.updatedAt,
      names: project.targets.map((t) => t.target.split("/").pop()),
    };
  };
  const put = (id: string, base: string | undefined, body: unknown) =>
    app.request(`/api/projects/${id}`, {
      method: "PUT",
      headers: { ...json, ...(base !== undefined ? { "if-match": base } : {}) },
      body: JSON.stringify(body),
    });
  const targetsOf = (id: string) =>
    service.getProject(id)?.project.targets.map((t) => t.target.split("/").pop());
  return { activity, service, app, load, put, targetsOf };
}

describe("保存先の更新時刻（版）", () => {
  it("同じミリ秒に2回保存しても、時計が戻っても、前の値と必ず変わる", () => {
    const store = new SqliteProjectStore(
      join(dir, "p.db"),
      () => new Date("2026-10-30T00:00:00.000Z"),
    );
    const first = store.put("a", definition("x"));
    const second = store.put("a", definition("x", "y"));
    expect(second.updatedAt > first.updatedAt).toBe(true);
    expect(second.createdAt).toBe(first.createdAt);
    let now = new Date("2026-10-30T00:00:00.000Z");
    const back = new SqliteProjectStore(join(dir, "q.db"), () => now);
    const before = back.put("a", definition("x"));
    now = new Date("2026-10-29T00:00:00.000Z");
    expect(back.put("a", definition("y")).updatedAt > before.updatedAt).toBe(true);
    store.close();
    back.close();
  });
});

describe("プロジェクトの保存の照合", () => {
  it("読み込んだ後に別の保存で変わっていたら、上書きせずに拒否し、設定も版も変えない", () => {
    const { activity, service, load } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const first = load(p.id);
    const second = load(p.id);
    const saved = service.saveProject(p.id, definition("a", "b"), first.base);
    expect(saved.updatedAt).not.toBe(first.base);
    let error: unknown;
    try {
      service.saveProject(p.id, definition("a", "c"), second.base);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as InvalidOperationError).messages).toEqual([
      { code: "project.changedElsewhere" },
    ]);
    const now = service.getProject(p.id)?.project;
    expect(now?.targets.map((t) => t.target)).toEqual([repo("a").target, repo("b").target]);
    expect(now?.updatedAt).toBe(saved.updatedAt);
    activity.close();
  });

  it("保存した版を次の保存に使える（続けて自分が保存するのは拒否しない）。ほかのプロジェクトの保存は影響しない", () => {
    const { activity, service } = setup();
    const a = service.saveProject(undefined, definition("a"));
    const other = service.saveProject(undefined, { ...definition("z"), name: "別" });
    const one = service.saveProject(a.id, definition("a", "b"), a.updatedAt);
    service.saveProject(other.id, { ...definition("z", "y"), name: "別" }, other.updatedAt);
    const two = service.saveProject(a.id, definition("a", "b", "c"), one.updatedAt);
    expect(two.targets).toHaveLength(3);
    activity.close();
  });

  it("消えたプロジェクトは、版があっても見つからない扱い", () => {
    const { activity, service } = setup();
    expect(() => service.saveProject("none", definition("a"), "2026-01-01T00:00:00.000Z")).toThrow(
      /見つかりません/,
    );
    activity.close();
  });
});

describe("プロジェクトの保存 API（PUT /api/projects/:id）", () => {
  it("版（If-Match）が無ければ 428 で、保存しない", async () => {
    const { activity, service, put, targetsOf } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const res = await put(p.id, undefined, definition("a", "b"));
    expect(res.status).toBe(428);
    expect(targetsOf(p.id)).toEqual(["a"]);
    activity.close();
  });

  it("同時に保存すると、一方だけが保存され、もう一方は 409 で知らされる（黙って消えない）", async () => {
    const { activity, service, put, load, targetsOf } = setup();
    const p = service.saveProject(undefined, definition("a"));
    // 2人が同じ版を読み込み、別々の対象を足して、同時に保存する
    const alice = load(p.id);
    const bob = load(p.id);
    const [r1, r2] = await Promise.all([
      put(p.id, alice.base, definition("a", "b")),
      put(p.id, bob.base, definition("a", "c")),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const failed = r1.status === 409 ? r1 : r2;
    expect(((await failed.json()) as { messages: unknown[] }).messages).toEqual([
      { code: "project.changedElsewhere" },
    ]);
    const winner = r1.status === 200 ? ["a", "b"] : ["a", "c"];
    expect(targetsOf(p.id)).toEqual(winner);
    activity.close();
  });

  it("負けた側は、読み込み直せば、先の変更を残したまま保存できる", async () => {
    const { activity, service, put, load, targetsOf } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const s1 = load(p.id);
    const s4 = load(p.id);
    const s5 = load(p.id);
    expect((await put(p.id, s1.base, definition("a", "s1"))).status).toBe(200);
    expect((await put(p.id, s4.base, definition("a", "s4"))).status).toBe(409);
    expect((await put(p.id, s5.base, definition("a", "s5"))).status).toBe(409);
    // 読み込み直して、足し直す
    for (const name of ["s4", "s5"]) {
      const latest = load(p.id);
      const res = await put(p.id, latest.base, definition(...(latest.names as string[]), name));
      expect(res.status).toBe(200);
    }
    expect(targetsOf(p.id)).toEqual(["a", "s1", "s4", "s5"]);
    activity.close();
  });

  it("入力の誤りで保存できなかったときは、版が進まず、同じ版でやり直せる", async () => {
    const { activity, service, put, load, targetsOf } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const { base } = load(p.id);
    expect((await put(p.id, base, { name: "" })).status).toBe(400);
    expect(load(p.id).base).toBe(base);
    expect((await put(p.id, base, definition("a", "b"))).status).toBe(200);
    expect(targetsOf(p.id)).toEqual(["a", "b"]);
    activity.close();
  });

  it("古い版の保存は、別の項目だけを変えていても拒否する（項目ごとの併合はしない）", async () => {
    const { activity, service, put, load } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const stale = load(p.id);
    expect((await put(p.id, load(p.id).base, { ...definition("a"), name: "改名" })).status).toBe(
      200,
    );
    expect((await put(p.id, stale.base, definition("a", "b"))).status).toBe(409);
    expect(service.getProject(p.id)?.project.name).toBe("改名");
    activity.close();
  });

  it("作成（POST）は版を要らない", async () => {
    const { activity, app } = setup();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: json,
      body: JSON.stringify(definition("a")),
    });
    expect(res.status).toBe(201);
    activity.close();
  });
});
