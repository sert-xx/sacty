import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectDefinition } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { ConfigResult } from "./config.js";
import { MemoryProjectStore, REVISIONS_KEPT, SqliteProjectStore } from "./projects.js";
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

describe("保存した版の定義（併合の元）", () => {
  it("版ごとの定義を残し、再び開いても読める。多くなったら古いものから消す", () => {
    const path = join(dir, "r.db");
    const store = new SqliteProjectStore(path);
    const first = store.put("a", definition("x"));
    const second = store.put("a", definition("x", "y"));
    expect(store.revision("a", first.updatedAt)?.targets).toHaveLength(1);
    expect(store.revision("a", second.updatedAt)?.targets).toHaveLength(2);
    expect(store.revision("a", "2020-01-01T00:00:00.000Z")).toBeUndefined();
    expect(store.revision("b", first.updatedAt)).toBeUndefined();
    store.close();
    const reopened = new SqliteProjectStore(path);
    expect(reopened.revision("a", first.updatedAt)?.targets).toHaveLength(1);
    for (let i = 0; i < REVISIONS_KEPT + 5; i++) reopened.put("a", definition("x", `n${i}`));
    expect(reopened.revision("a", first.updatedAt)).toBeUndefined();
    const latest = reopened.get("a");
    expect(reopened.revision("a", latest?.updatedAt ?? "")).toBeDefined();
    // プロジェクトを消したら、版も消す
    reopened.delete("a");
    expect(reopened.revision("a", latest?.updatedAt ?? "")).toBeUndefined();
    reopened.close();
  });
});

describe("プロジェクトの保存の照合", () => {
  it("読み込んだ後に、同じ項目を違うように変えた保存は、上書きせずに拒否し、設定も版も変えない", () => {
    const { activity, service, load } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const first = load(p.id);
    const second = load(p.id);
    const saved = service.saveProject(p.id, { ...definition("a", "b"), name: "改名A" }, first.base);
    expect(saved.updatedAt).not.toBe(first.base);
    let error: unknown;
    try {
      service.saveProject(p.id, { ...definition("a", "c"), name: "改名B" }, second.base);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as InvalidOperationError).messages).toEqual([
      { code: "project.changedElsewhere" },
    ]);
    const now = service.getProject(p.id)?.project;
    expect(now?.name).toBe("改名A");
    expect(now?.targets.map((t) => t.target)).toEqual([repo("a").target, repo("b").target]);
    expect(now?.updatedAt).toBe(saved.updatedAt);
    activity.close();
  });

  it("読み込んだ後に別の保存があっても、別の項目や別の対象の変更は、互いに残して併合する（PBI-301）", () => {
    const { activity, service, load } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const alice = load(p.id);
    const bob = load(p.id);
    service.saveProject(p.id, definition("a", "b"), alice.base);
    // bob は古い版から、別の対象を足し、名前も変えた
    const result = service.saveProjectMerging(
      p.id,
      { ...definition("a", "c"), name: "改名" },
      bob.base,
    );
    expect(result.merged).toBe(true);
    expect(result.project.name).toBe("改名");
    expect(result.project.targets.map((t) => t.target)).toEqual([
      repo("a").target,
      repo("b").target,
      repo("c").target,
    ]);
    // 併合しない保存は merged にならない
    expect(service.saveProjectMerging(p.id, definition("a"), result.project.updatedAt).merged).toBe(
      false,
    );
    activity.close();
  });

  it("古い版から消した対象は消え、ほかが足した対象は残る。ほかが変えた対象を消す保存は拒否する", () => {
    const { activity, service, load } = setup();
    const p = service.saveProject(undefined, definition("a", "b"));
    const stale = load(p.id);
    const other = service.saveProject(p.id, { ...definition("a", "b", "c") }, load(p.id).base);
    const merged = service.saveProjectMerging(p.id, definition("a"), stale.base);
    expect(merged.project.targets.map((t) => t.target)).toEqual([
      repo("a").target,
      repo("c").target,
    ]);
    // b を別の画像に変えた保存と、b を消す保存は両立しない
    const stale2 = { base: merged.project.updatedAt };
    service.saveProject(
      p.id,
      {
        ...definition("a", "c"),
        targets: [{ ...repo("a"), image: "node" }, repo("c")],
      },
      stale2.base,
    );
    expect(() => service.saveProject(p.id, definition("c"), stale2.base)).toThrow(
      InvalidOperationError,
    );
    expect(other.targets).toHaveLength(3);
    activity.close();
  });

  it("読み込んだ版の定義が残っていなければ（古くなって消えた・無い）、併合せずに拒否する", () => {
    const projects = new MemoryProjectStore();
    const { activity, service } = setup(projects);
    const p = service.saveProject(undefined, definition("a"));
    service.saveProject(p.id, definition("a", "b"), p.updatedAt);
    projects.revision = () => undefined;
    expect(() => service.saveProject(p.id, definition("a", "c"), p.updatedAt)).toThrow(
      InvalidOperationError,
    );
    expect(service.getProject(p.id)?.project.targets).toHaveLength(2);
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

  it("同時に保存すると、互いの変更が併合され、どちらも消えない（2つの保存が重なる場合）", async () => {
    const { activity, service, put, load, targetsOf } = setup();
    const p = service.saveProject(undefined, definition("a"));
    // 2人が同じ版を読み込み、別々の対象を足して、同時に保存する
    const alice = load(p.id);
    const bob = load(p.id);
    const [r1, r2] = await Promise.all([
      put(p.id, alice.base, definition("a", "b")),
      put(p.id, bob.base, definition("a", "c")),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    // 後に保存した側だけが、併合して保存したと知らされる
    const bodies = (await Promise.all([r1.json(), r2.json()])) as { merged?: true }[];
    expect(bodies.filter((b) => b.merged)).toHaveLength(1);
    expect(targetsOf(p.id)?.slice().sort()).toEqual(["a", "b", "c"]);
    activity.close();
  });

  it("3人が同じ版から対象を足しても、全部残る。併合した側が同じ古い版のまま続けて保存しても、消えない", async () => {
    const { activity, service, put, load, targetsOf } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const s1 = load(p.id);
    const s4 = load(p.id);
    const s5 = load(p.id);
    expect((await put(p.id, s1.base, definition("a", "s1"))).status).toBe(200);
    expect((await put(p.id, s4.base, definition("a", "s4"))).status).toBe(200);
    expect((await put(p.id, s5.base, definition("a", "s5"))).status).toBe(200);
    expect(targetsOf(p.id)).toEqual(["a", "s1", "s4", "s5"]);
    // s5 の画面は古いままで、版も進めていない。続けて対象を足して保存しても、ほかの追加は消えない
    expect((await put(p.id, s5.base, definition("a", "s5", "s5b"))).status).toBe(200);
    expect(targetsOf(p.id)).toEqual(["a", "s1", "s4", "s5", "s5b"]);
    activity.close();
  });

  it("同じ項目を違うように変えて併合できないときは 409 で知らせ、黙って消さない", async () => {
    const { activity, service, put, load } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const alice = load(p.id);
    const bob = load(p.id);
    expect((await put(p.id, alice.base, { ...definition("a"), name: "改名A" })).status).toBe(200);
    const res = await put(p.id, bob.base, { ...definition("a"), name: "改名B" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { messages: unknown[] }).messages).toEqual([
      { code: "project.changedElsewhere" },
    ]);
    expect(service.getProject(p.id)?.project.name).toBe("改名A");
    activity.close();
  });

  it("負けた側は、読み込み直せば、先の変更を残したまま保存できる（409 のやり直し）", async () => {
    const { activity, service, put, load, targetsOf } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const s1 = load(p.id);
    const s4 = load(p.id);
    expect((await put(p.id, s1.base, { ...definition("a", "s1"), name: "改名1" })).status).toBe(
      200,
    );
    expect((await put(p.id, s4.base, { ...definition("a", "s4"), name: "改名4" })).status).toBe(
      409,
    );
    // 読み込み直して、足し直す
    const latest = load(p.id);
    const res = await put(p.id, latest.base, {
      ...definition(...(latest.names as string[]), "s4"),
      name: "改名1",
    });
    expect(res.status).toBe(200);
    expect(targetsOf(p.id)).toEqual(["a", "s1", "s4"]);
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

  it("古い版の保存は、別の項目だけを変えていれば併合する（項目ごとに、変えた側を採る）", async () => {
    const { activity, service, put, load } = setup();
    const p = service.saveProject(undefined, definition("a"));
    const stale = load(p.id);
    expect((await put(p.id, load(p.id).base, { ...definition("a"), name: "改名" })).status).toBe(
      200,
    );
    expect((await put(p.id, stale.base, definition("a", "b"))).status).toBe(200);
    const now = service.getProject(p.id)?.project;
    expect(now?.name).toBe("改名");
    expect(now?.targets.map((t) => t.target)).toEqual([repo("a").target, repo("b").target]);
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
