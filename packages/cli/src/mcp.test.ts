import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { READ_REASONS, startTaskMcp } from "@sacty/daemon/task-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "../../../apps/daemon/src/activity.js";
import { createApp } from "../../../apps/daemon/src/server.js";
import { SessionLogStore } from "../../../apps/daemon/src/session-logs.js";
import { dbPath, dir, makeService, useTempDir } from "../../../apps/daemon/src/testing/daemon.js";
import { type Fetch, readDaemonFile, writeDaemonFile } from "./context-preview.js";
import { daemonApi } from "./mcp.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sacty-mcp-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** デーモンの偽物。呼ばれた API と、渡されたトークンを記録する。 */
function fakeDaemon(reply: (method: string, path: string) => Response) {
  const calls: { method: string; url: string; token: string; body?: string }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const method = init.method ?? "GET";
    calls.push({
      method,
      url,
      token: init.headers.authorization ?? "",
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return reply(method, new URL(url).pathname);
  };
  return { calls, fetcher };
}

describe("sacty mcp が呼ぶデーモンの API（PBI-392）", () => {
  it("起動中の sacty が無ければ、理由の例外にする（画面の URL は無い）", async () => {
    const { calls, fetcher } = fakeDaemon(() => Response.json({}));
    const api = daemonApi(home, fetcher);
    await expect(api.listTasks()).rejects.toThrow("起動中の sacty が見つかりません");
    await expect(api.getTask("a")).rejects.toThrow("起動中の sacty が見つかりません");
    await expect(api.rereview("a")).rejects.toThrow("起動中の sacty が見つかりません");
    await expect(api.listProjects()).rejects.toThrow("起動中の sacty が見つかりません");
    await expect(api.createTask({ projectId: "p", title: "題", body: "" })).rejects.toThrow(
      "起動中の sacty が見つかりません",
    );
    expect(api.webUrl()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("画面と同じ API を、接続先ファイルのトークンで呼ぶ。ID は URL に安全に入れる", async () => {
    writeDaemonFile(home, {
      url: "http://127.0.0.1:4710",
      token: "tok",
      web: "http://127.0.0.1:4700",
    });
    const { calls, fetcher } = fakeDaemon((method, path) => {
      if (path === "/api/tasks") {
        // gone は、消したプロジェクトのタスク
        return Response.json({
          tasks: [
            { id: "a", projectId: "p1" },
            { id: "gone", projectId: "deleted" },
          ],
        });
      }
      if (path === "/api/projects") return Response.json({ projects: [{ id: "p1" }] });
      if (method === "POST") return Response.json({ task: { id: "a", status: "queued" } });
      return Response.json({ task: { id: "a" }, activity: [] });
    });
    const api = daemonApi(home, fetcher);
    // 消したプロジェクトのタスクは出さない
    expect(await api.listTasks()).toEqual([{ id: "a", projectId: "p1" }]);
    expect(await api.getTask("a/../b")).toEqual({ task: { id: "a" }, activity: [] });
    // 再レビューは、先にタスクがあることを確かめてから頼む
    expect(await api.rereview("a b")).toEqual({ id: "a", status: "queued" });
    expect(api.webUrl()).toBe("http://127.0.0.1:4700");
    expect(calls).toEqual([
      { method: "GET", url: "http://127.0.0.1:4710/api/tasks", token: "Bearer tok" },
      { method: "GET", url: "http://127.0.0.1:4710/api/projects", token: "Bearer tok" },
      { method: "GET", url: "http://127.0.0.1:4710/api/tasks/a%2F..%2Fb", token: "Bearer tok" },
      { method: "GET", url: "http://127.0.0.1:4710/api/tasks/a%20b", token: "Bearer tok" },
      {
        method: "POST",
        url: "http://127.0.0.1:4710/api/tasks/a%20b/rereview",
        token: "Bearer tok",
        body: "{}",
      },
    ]);
  });

  it("sacty を起動し直したら、次の呼び出しから新しい接続先とトークンを使う", async () => {
    const { calls, fetcher } = fakeDaemon(() => Response.json({ tasks: [], projects: [] }));
    const api = daemonApi(home, fetcher);
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "old" });
    await api.listTasks();
    expect(api.webUrl()).toBeUndefined();
    writeDaemonFile(home, {
      url: "http://127.0.0.1:4810",
      token: "new",
      web: "http://127.0.0.1:4800",
    });
    await api.listTasks();
    expect(calls.map((c) => [c.url, c.token])).toEqual([
      ["http://127.0.0.1:4710/api/tasks", "Bearer old"],
      ["http://127.0.0.1:4710/api/projects", "Bearer old"],
      ["http://127.0.0.1:4810/api/tasks", "Bearer new"],
      ["http://127.0.0.1:4810/api/projects", "Bearer new"],
    ]);
    expect(api.webUrl()).toBe("http://127.0.0.1:4800");
  });

  it("無いタスクの詳細は undefined。断られた再レビューは、理由の文にする", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const { calls, fetcher } = fakeDaemon((method, path) => {
      if (method === "POST") {
        return Response.json(
          { error: "invalid_operation", messages: [{ code: "review.notRereviewable" }] },
          { status: 409 },
        );
      }
      return path === "/api/tasks/a"
        ? Response.json({ task: { id: "a" }, activity: [] })
        : Response.json({ error: "not_found" }, { status: 404 });
    });
    const api = daemonApi(home, fetcher);
    expect(await api.getTask("none")).toBeUndefined();
    await expect(api.rereview("a")).rejects.toThrow(
      "再レビューできるのは、レビューを PR に投稿して完了したタスクだけです。",
    );
    // 無いタスク（消したプロジェクトのタスクを含む。詳細の API が 404）は、再レビューの API を呼ばずに断る
    calls.length = 0;
    await expect(api.rereview("gone")).rejects.toThrow("タスクが見つかりません。");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("再レビューを頼んだ後に結果を受け取れなければ、始まっている可能性があると伝える。頼む前の失敗と、断られたときは伝えない", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const hung: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const found = () => Promise.resolve(Response.json({ task: { id: "a" }, activity: [] }));
    const after =
      (post: Fetch): Fetch =>
      (url, init) =>
        init.method === "POST" ? post(url, init) : found();
    const failure = (fetcher: Fetch) =>
      daemonApi(home, fetcher, 20)
        .rereview("a")
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
    const uncertain = "再レビューは始まっている可能性があります";

    // 頼んだ後の時間切れ（元の例外を cause に持つ）
    const timedOut = await failure(after(hung));
    expect(timedOut?.message).toContain("デーモンが時間内に応答しませんでした");
    expect(timedOut?.message).toContain(uncertain);
    expect(String(timedOut?.cause)).toContain("デーモンが時間内に応答しませんでした");
    // 頼んだ後に接続が切れた
    const dropped = await failure(
      after(async () => {
        throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
      }),
    );
    expect(dropped?.message).toContain("デーモンにつながりません");
    expect(dropped?.message).toContain(uncertain);
    // 応答の本文を読む途中の時間切れ・読めない本文
    const stalled = await failure(
      after(
        async (_url, init) =>
          ({
            ok: true,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
              }),
          }) as unknown as Response,
      ),
    );
    expect(stalled?.message).toContain("デーモンが時間内に応答しませんでした");
    expect(stalled?.message).toContain(uncertain);
    const broken = await failure(after(async () => new Response("<html>", { status: 200 })));
    expect(broken?.message).toContain("デーモンの応答を読めませんでした");
    expect(broken?.message).toContain(uncertain);

    // デーモンが応答で断ったなら、始まっていない（理由だけ）
    const refused = await failure(after(async () => new Response("oops", { status: 500 })));
    expect(refused?.message).toBe("デーモンが 500 を返しました。");
    // 頼む前（タスクを確かめる段）の時間切れは、ふつうの文
    const before = await failure(hung);
    expect(before?.message).toContain("デーモンが時間内に応答しませんでした");
    expect(before?.message).not.toContain(uncertain);
  });

  it("応答しないデーモンでは、決めた時間で打ち切って、応答しなかったという理由の例外にする", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    // 打ち切られるまで応答しないデーモン
    const hung: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const api = daemonApi(home, hung, 20);
    for (const call of [() => api.listTasks(), () => api.getTask("a"), () => api.rereview("a")]) {
      await expect(call()).rejects.toThrow("デーモンが時間内に応答しませんでした");
    }
    // 片方（プロジェクトの一覧）だけが応答しなくても、一覧は戻る
    const half: Fetch = (url, init) =>
      url.endsWith("/api/tasks") ? Promise.resolve(Response.json({ tasks: [] })) : hung(url, init);
    await expect(daemonApi(home, half, 20).listTasks()).rejects.toThrow(
      "デーモンが時間内に応答しませんでした",
    );
    // 本文の途中で打ち切られたときも、同じ理由にする
    const stalledBody: Fetch = async (_url, init) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      }) as unknown as Response;
    await expect(daemonApi(home, stalledBody, 20).getTask("a")).rejects.toThrow(
      "デーモンが時間内に応答しませんでした",
    );
  });

  it("つながらなかった原因は、例外の cause に残す", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const refused = daemonApi(home, async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:4710");
    });
    const error = await refused.listTasks().catch((e: unknown) => e);
    expect((error as Error).message).toContain("デーモンにつながりません");
    expect(String((error as Error).cause)).toContain("ECONNREFUSED");
  });

  it("接続先ファイルの画面の URL は、あるときだけ読む（前の版のファイルも読める）", () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    expect(readDaemonFile(home)).toEqual({ url: "http://127.0.0.1:4710", token: "tok" });
    writeDaemonFile(home, {
      url: "http://127.0.0.1:4710",
      token: "tok",
      web: "http://127.0.0.1:4700",
    });
    expect(readDaemonFile(home)).toEqual({
      url: "http://127.0.0.1:4710",
      token: "tok",
      web: "http://127.0.0.1:4700",
    });
  });
});

describe("sacty mcp のタスクの作成（PBI-394）", () => {
  const input = { projectId: "p1", title: "題", body: "説明" };

  it("プロジェクトの一覧と作成は、画面と同じ API（GET /api/projects・POST /api/tasks）を、対象リポジトリ空欄・進め方なしで呼ぶ", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const { calls, fetcher } = fakeDaemon((_method, path) =>
      path === "/api/projects"
        ? Response.json({
            projects: [
              { id: "p1", name: "P", targets: [{ scope: "repo", target: "https://x/y" }] },
            ],
          })
        : Response.json({ task: { id: "t1", title: "題" } }, { status: 201 }),
    );
    const api = daemonApi(home, fetcher);
    expect(await api.listProjects()).toMatchObject([{ id: "p1", name: "P" }]);
    expect(await api.createTask(input)).toMatchObject({ id: "t1" });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname} ${c.token}`)).toEqual([
      "GET /api/projects Bearer tok",
      "POST /api/tasks Bearer tok",
    ]);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      projectId: "p1",
      title: "題",
      body: "説明",
      repo: null,
    });
  });

  it("断られたときは理由だけを返す（プロジェクトが無い・題が空・想定外の状態コード）", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const refuse = async (res: Response) => {
      const { fetcher } = fakeDaemon(() => res);
      return daemonApi(home, fetcher)
        .createTask(input)
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
    };
    const notFound = await refuse(
      Response.json(
        { error: "invalid_operation", messages: [{ code: "project.notFound" }] },
        { status: 409 },
      ),
    );
    expect(notFound?.message).toBe("プロジェクトが見つかりません。");
    const empty = await refuse(
      Response.json(
        {
          error: "invalid_input",
          issues: [{ path: ["title"], message: { code: "input.titleRequired" } }],
        },
        { status: 400 },
      ),
    );
    expect(empty?.message).toBe("タイトルを入力してください。");
    // 前の版のデーモンが読めない入力（形の違い）でも、理由を返す（落ちない）
    const old = await refuse(new Response("Not Found", { status: 404 }));
    expect(old?.message).toBe("デーモンが 404 を返しました。");
    // 断られたなら、作られていない（可能性を添えない）
    for (const e of [notFound, empty, old]) expect(e?.message).not.toContain("作られている可能性");
  });

  it("作る要求を送った後に結果を受け取れなければ、作られている可能性と確かめてから呼び直すことを伝える。送る前の失敗は伝えない", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const hung: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const failure = (fetcher: Fetch, at = home) =>
      daemonApi(at, fetcher, 20)
        .createTask(input)
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
    const uncertain = "タスクは作られている可能性があります";
    const timedOut = await failure(hung);
    expect(timedOut?.message).toContain("デーモンが時間内に応答しませんでした");
    expect(timedOut?.message).toContain(uncertain);
    expect(timedOut?.message).toContain("list_tasks");
    const dropped = await failure(async () => {
      throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
    });
    expect(dropped?.message).toContain("デーモンにつながりません");
    expect(dropped?.message).toContain(uncertain);
    expect(dropped?.cause).toBeDefined();
    const broken = await failure(async () => new Response("<html>", { status: 201 }));
    expect(broken?.message).toContain("デーモンの応答を読めませんでした");
    expect(broken?.message).toContain(uncertain);
    // 5xx は、作られたかどうかが分からない
    const server = await failure(async () => new Response("oops", { status: 500 }));
    expect(server?.message).toContain("デーモンが 500 を返しました。");
    expect(server?.message).toContain(uncertain);
    // 認証できない・接続を断られた（要求が処理されていない）
    const unauthorized = await failure(async () => new Response("no", { status: 401 }));
    expect(unauthorized?.message).toContain("デーモンに認証できません");
    expect(unauthorized?.message).not.toContain(uncertain);
    const refused = await failure(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    expect(refused?.message).toContain("デーモンにつながりません");
    expect(refused?.message).not.toContain(uncertain);
    // 接続先が無い（送っていない）
    const none = await failure(hung, mkdtempSync(join(tmpdir(), "sacty-mcp-none-")));
    expect(none?.message).toContain("起動中の sacty が見つかりません");
    expect(none?.message).not.toContain(uncertain);
  });
});

describe("sacty mcp の成果物と実行の取得（PBI-395）", () => {
  const callAll = (api: ReturnType<typeof daemonApi>) => [
    () => api.listDeliverables("t1"),
    () => api.getDeliverable("t1", { step: "design", kind: "output" }),
    () => api.listRuns("t1", {}),
  ];

  it("新しい3つの API を、画面と同じ接続先・トークンで、引数を URL に安全に入れて呼ぶ", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const { calls, fetcher } = fakeDaemon(() => Response.json({ deliverables: [] }));
    const api = daemonApi(home, fetcher);
    await api.listDeliverables("t 1");
    await api.getDeliverable("t1", { step: "design", kind: "output", offset: 5, maxBytes: 10 });
    await api.listRuns("t1", { offset: 2, limit: 3 });
    expect(calls.map((c) => c.url.replace("http://127.0.0.1:4710", ""))).toEqual([
      "/api/tasks/t%201/deliverables",
      "/api/tasks/t1/deliverables/design/output?offset=5&max=10",
      "/api/tasks/t1/runs?offset=2&limit=3",
    ]);
    expect(new Set(calls.map((c) => c.token))).toEqual(new Set(["Bearer tok"]));
  });

  it("前の版のデーモン（本文が 404 Not Found の 404）は、タスクが無いのではなく、更新と再起動を促す理由にする", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const old = fakeDaemon(() => new Response("404 Not Found", { status: 404 }));
    for (const call of callAll(daemonApi(home, old.fetcher))) {
      await expect(call()).rejects.toThrow(READ_REASONS.oldDaemon);
    }
    expect(READ_REASONS.oldDaemon).toContain("sacty を更新");
    expect(READ_REASONS.oldDaemon).toContain("sacty up");
    // タスクが無いときの 404（error を持つ JSON）は、無いものとして返す
    const none = fakeDaemon(() => Response.json({ error: "not_found" }, { status: 404 }));
    for (const call of callAll(daemonApi(home, none.fetcher))) {
      await expect(call()).resolves.toBeUndefined();
    }
  });

  it("結果・理由・標準エラーに、トークン・環境変数の値・SACTY_HOME のパス・中身を出さない。失敗の原因は、接続の失敗の種類と時間切れの印だけ", async () => {
    // SACTY_HOME のパスの印（home-MARK-3）は、このテストのためだけの置き場に付ける
    const marked = mkdtempSync(join(tmpdir(), "home-MARK-3-"));
    writeDaemonFile(marked, { url: "http://127.0.0.1:4710", token: "tok-MARK-1" });
    vi.stubEnv("SACTY_TEST_SECRET", "env-MARK-2");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hung: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const refused: Fetch = async () => {
      throw new TypeError("fetch failed body-MARK-4", {
        cause: Object.assign(new Error("connect ECONNREFUSED tok-MARK-1"), {
          code: "ECONNREFUSED",
        }),
      });
    };
    const scenarios: [string, Fetch][] = [
      [
        "400",
        async () => Response.json({ error: "invalid_range", note: "body-MARK-4" }, { status: 400 }),
      ],
      ["200 not json", async () => new Response("body-MARK-4 {", { status: 200 })],
      ["500 not json", async () => new Response("body-MARK-4", { status: 500 })],
      [
        "500 json",
        async () => Response.json({ error: "x", detail: "body-MARK-4" }, { status: 500 }),
      ],
      ["409", async () => Response.json({ error: "unredacted" }, { status: 409 })],
      ["timeout", hung],
      ["refused", refused],
    ];
    try {
      for (const [, fetcher] of scenarios) {
        const [a, b] = InMemoryTransport.createLinkedPair();
        startTaskMcp(daemonApi(marked, fetcher, 20), { version: "1", transport: a });
        const client = new Client(
          { name: "t", version: "1" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        await client.connect(b);
        for (const [name, args] of [
          ["list_deliverables", { task_id: "t1" }],
          ["get_deliverable", { task_id: "t1", step: "design", kind: "output" }],
          ["list_runs", { task_id: "t1" }],
        ] as const) {
          const result = await client.callTool({ name, arguments: args });
          const text = JSON.stringify(result);
          expect(result.isError).toBe(true);
          for (const mark of ["tok-MARK-1", "env-MARK-2", "home-MARK-3", "body-MARK-4"]) {
            expect(text).not.toContain(mark);
          }
        }
        await client.close();
      }
      const lines = logged.mock.calls.map((c) => c.join(" "));
      expect(lines.length).toBe(scenarios.length * 3);
      for (const line of lines) {
        for (const mark of ["tok-MARK-1", "env-MARK-2", "home-MARK-3", "body-MARK-4"]) {
          expect(line).not.toContain(mark);
        }
        expect(line).toMatch(
          /^\[sacty mcp\] (list_deliverables|get_deliverable|list_runs)\(task_id=t1\): /,
        );
      }
      expect(lines.some((l) => l.includes("（原因：ECONNREFUSED）"))).toBe(true);
      expect(lines.some((l) => l.includes("（原因：TimeoutError）"))).toBe(true);
      expect(lines.some((l) => l.includes("sacty の応答を読めませんでした。"))).toBe(true);
      // JSON でない 500・本文が JSON の 500 は、状態コードの理由（本文は入れない）
      expect(lines.some((l) => l.includes("sacty が 500 を返しました。"))).toBe(true);
    } finally {
      logged.mockRestore();
      vi.unstubAllEnvs();
      rmSync(marked, { recursive: true, force: true });
    }
  });

  it("つながらない・時間内に応答しない・起動していないときは、いまのツールと同じ理由を返し、サーバーは動き続ける", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    // daemon.json が無い
    startTaskMcp(
      daemonApi(home, async () => Response.json({})),
      { version: "1", transport: a },
    );
    const client = new Client(
      { name: "t", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(b);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const down = await client.callTool({ name: "list_runs", arguments: { task_id: "t1" } });
      expect(down.isError).toBe(true);
      expect(JSON.stringify(down)).toContain("起動中の sacty が見つかりません");
      // そのあとのツールの呼び出しにも応答する
      const again = await client.callTool({
        name: "list_deliverables",
        arguments: { task_id: "t1" },
      });
      expect(again.isError).toBe(true);
    } finally {
      logged.mockRestore();
    }
    await client.close();
  });
});

describe("本物のデーモンの API と、本物の daemonApi をつないだ成果物と実行の取得（PBI-395）", () => {
  useTempDir();

  it("3つのツールが、デーモンが持つ成果物・実行の一覧と同じ値を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const store = new SessionLogStore(join(dir, "runs"));
    const { service } = makeService(activity, [], { sessionLogs: store });
    const task = service.createTask({ projectId: "default", title: "題" });
    const body = "要求要件の本文です。🎉";
    Object.assign(service.get(task.id)?.task ?? {}, {
      outputs: { requirements: body },
      gate: { step: "requirements", submission: 1 },
      submissions: { requirements: 1 },
    });
    activity.append({
      taskId: task.id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: {
              runId: "run1",
              step: "requirements",
              agentId: "claude",
              authMode: "subscription",
              model: "m",
              reasoningEffort: "medium",
              image: "img",
            },
          } as never,
        },
      ],
    });
    const handle = store.open(
      {
        taskId: task.id,
        runId: "run1",
        role: "requirements",
        agentId: "claude",
        runtime: "claude-code",
        authMode: "subscription",
      },
      () => [],
    );
    handle.close({
      kind: "completed",
      output: "",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
    });

    const token = "t".repeat(64);
    const app = createApp(service, token);
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token });
    const fetcher: Fetch = async (url, init) => {
      const u = new URL(url);
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
      expect(result.isError).not.toBe(true);
      return result.structuredContent as Record<string, unknown>;
    };

    const list = await call("list_deliverables", { task_id: task.id });
    expect(list.deliverables).toEqual([
      expect.objectContaining({
        step: "requirements",
        kind: "output",
        submission: 1,
        status: "awaiting_approval",
        bytes: Buffer.byteLength(body),
      }),
    ]);
    const one = await call("get_deliverable", {
      task_id: task.id,
      step: "requirements",
      kind: "output",
    });
    expect(one).toMatchObject({ text: body, status: "awaiting_approval", clipped: false });
    const runs = await call("list_runs", { task_id: task.id });
    expect(runs).toMatchObject({ total: 1, returned: 1, clipped: false });
    expect(runs.runs).toEqual([
      expect.objectContaining({
        runId: "run1",
        role: "requirements",
        agentId: "claude",
        state: "succeeded",
      }),
    ]);
    await client.close();
    activity.close();
  });
});

describe("本物のデーモンの API と、本物の daemonApi をつないだ差し戻し（PBI-397）", () => {
  useTempDir();

  it("差し戻しが通り、同じ呼び出しの2回目と古い回は断られて、記録は1件のまま", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, []);
    const task = service.createTask({ projectId: "default", title: "題" });
    Object.assign(service.get(task.id)?.task ?? {}, {
      status: "awaiting_approval",
      steps: [{ key: "requirements", state: "awaiting_approval" }],
      outputs: { requirements: "本文" },
      gate: { step: "requirements", submission: 1 },
      submissions: { requirements: 1 },
    });
    const token = "t".repeat(64);
    const app = createApp(service, token);
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token });
    const fetcher: Fetch = async (url, init) => {
      const u = new URL(url);
      return app.request(`${u.pathname}${u.search}`, init);
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    startTaskMcp(daemonApi(home, fetcher), { version: "1", transport: a });
    const client = new Client(
      { name: "t", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(b);
    const call = (submission: number) =>
      client.callTool({
        name: "request_changes",
        arguments: { task_id: task.id, step: "requirements", submission, comments: ["直す"] },
      });
    const changes = () =>
      (service.get(task.id)?.activity ?? []).filter((e) => e.type === "ChangesRequested");

    const stale = await call(2);
    expect(stale.isError).toBe(true);
    expect(changes()).toHaveLength(0);
    const ok = await call(1);
    expect(ok.isError, JSON.stringify(ok.content)).not.toBe(true);
    expect(ok.structuredContent).toMatchObject({
      requested: { taskId: task.id, step: "requirements", submission: 1, comments: 1 },
    });
    expect(changes()).toHaveLength(1);
    const again = await call(1);
    expect(again.isError).toBe(true);
    expect(changes()).toHaveLength(1);
    await client.close();
    activity.close();
  });
});

describe("sacty mcp の承認（PBI-396）", () => {
  const input = { step: "requirements", submission: 1 };
  const uncertain = "承認されている可能性があります";
  const hung: Fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const failure = (fetcher: Fetch, at = home) =>
    daemonApi(at, fetcher, 20)
      .approve("t1", input)
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
  const taskBody = { task: { id: "t1" } };

  it("画面と同じ API（GET /api/tasks/:id で確かめてから POST /api/tasks/:id/approve に { step, submission }）を、接続先のトークンで呼ぶ", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const { calls, fetcher } = fakeDaemon(() => Response.json(taskBody));
    const task = await daemonApi(home, fetcher).approve("a/b", input);
    expect(task).toEqual({ id: "t1" });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/tasks/a%2Fb",
      "POST /api/tasks/a%2Fb/approve",
    ]);
    expect(calls.every((c) => c.token === "Bearer tok")).toBe(true);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual(input);
  });

  it("消したプロジェクトのタスク（詳細が 404）は、承認の API を呼ばずに、無いタスクとして断る", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const { calls, fetcher } = fakeDaemon(() =>
      Response.json({ error: "not_found" }, { status: 404 }),
    );
    const error = await failure(fetcher);
    expect(error?.message).toBe("タスクが見つかりません。");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("デーモンが断った理由は文にする。古い提出は、画面の更新ではなく get_task で確かめ直すことを伝える。承認の可能性は伝えない", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const refuse = (messages: unknown[]) =>
      failure(async (_url, init) =>
        init.method === "POST"
          ? Response.json({ error: "invalid_operation", messages }, { status: 409 })
          : Response.json(taskBody),
      );
    const stale = await refuse([
      { code: "gate.staleSubmission", params: { submission: 1, current: 3 } },
    ]);
    expect(stale?.message).toContain("1回目");
    expect(stale?.message).toContain("3回目");
    expect(stale?.message).toContain("get_task");
    expect(stale?.message).not.toContain("画面を更新");
    expect(stale?.message).not.toContain(uncertain);
    const onPr = await refuse([
      { code: "gate.approveOnPullRequest", params: { url: "https://github.com/a/b/pull/7" } },
    ]);
    expect(onPr?.message).toContain("マージ");
    expect(onPr?.message).toContain("https://github.com/a/b/pull/7");
    const repro = await refuse([{ code: "gate.reproduceNotApprovable" }]);
    expect(repro?.message).toContain("再現できなかった");
    expect(repro?.message).not.toContain(uncertain);
  });

  it("承認を送った後に結果を受け取れなければ（時間切れ・切断・本文を読めない・5xx）、承認されている可能性と get_task で確かめることを伝える", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const afterGet =
      (post: Fetch): Fetch =>
      (url, init) =>
        init.method === "POST" ? post(url, init) : Promise.resolve(Response.json(taskBody));
    const timedOut = await failure(afterGet(hung));
    expect(timedOut?.message).toContain("時間切れ");
    expect(timedOut?.message).toContain(uncertain);
    // 元の文（「もう一度試してください」）は、自動でやり直さない案内と矛盾するので使わない
    expect(timedOut?.message).not.toContain("もう一度試してください");
    expect(timedOut?.message).toContain("get_task");
    const dropped = await failure(
      afterGet(async () => {
        throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
      }),
    );
    expect(dropped?.message).toContain(uncertain);
    expect(dropped?.message).not.toContain("起動し直してください");
    const broken = await failure(afterGet(async () => new Response("<html>", { status: 200 })));
    expect(broken?.message).toContain("承認の結果を受け取れませんでした");
    expect(broken?.message).toContain(uncertain);
    const server = await failure(afterGet(async () => new Response("oops", { status: 500 })));
    expect(server?.message).toContain("デーモンが 500 を返しました。");
    expect(server?.message).toContain(uncertain);
  });

  it("先の詳細の確認（GET）で失敗したときは、承認を送っていないので、可能性を伝えず、承認の API を呼ばない", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const seen: string[] = [];
    const get500 = await failure(async (_url, init) => {
      seen.push(init.method ?? "GET");
      return new Response("oops", { status: 500 });
    });
    expect(get500?.message).toContain("500");
    expect(get500?.message).not.toContain(uncertain);
    const getHung = await failure((url, init) => {
      seen.push(init.method ?? "GET");
      return hung(url, init);
    });
    expect(getHung).toBeDefined();
    expect(getHung?.message).not.toContain(uncertain);
    expect(seen).not.toContain("POST");
  });

  it("認証できない・接続を断られた・起動中の sacty が無い・前の版のデーモン（想定外の 404）は、承認されていないので、可能性を伝えない", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const unauthorized = await failure(async () => new Response("no", { status: 401 }));
    expect(unauthorized?.message).toContain("デーモンに認証できません");
    expect(unauthorized?.message).not.toContain(uncertain);
    const refused = await failure(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    expect(refused?.message).toContain("デーモンにつながりません");
    expect(refused?.message).not.toContain(uncertain);
    const none = await failure(hung, mkdtempSync(join(tmpdir(), "sacty-mcp-none-")));
    expect(none?.message).toContain("起動中の sacty が見つかりません");
    expect(none?.message).not.toContain(uncertain);
    const old = await failure(async (_url, init) =>
      init.method === "POST" ? new Response("Not Found", { status: 404 }) : Response.json(taskBody),
    );
    expect(old?.message).toBe("デーモンが 404 を返しました。");
  });
});

describe("sacty mcp の差し戻し（PBI-397）", () => {
  const input = { step: "requirements", submission: 1, comments: ["ここを直す", "あれも直す"] };
  const uncertain = "差し戻されている可能性があります";
  const hung: Fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const failure = (fetcher: Fetch, at = home) =>
    daemonApi(at, fetcher, 20)
      .requestChanges("t1", input)
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
  const taskBody = { task: { id: "t1" } };

  it("画面と同じ API（POST /api/tasks/:id/request-changes）に、step・submission・comments だけを、接続先のトークンで送る", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const { calls, fetcher } = fakeDaemon(() => Response.json(taskBody));
    const task = await daemonApi(home, fetcher).requestChanges("a/b", input);
    expect(task).toEqual({ id: "t1" });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/tasks/a%2Fb/request-changes",
    ]);
    expect(calls[0]?.token).toBe("Bearer tok");
    const body = JSON.parse(calls[0]?.body ?? "") as Record<string, unknown>;
    expect(body).toEqual(input);
    for (const key of ["continueOverLimit", "target", "cause", "answer", "image", "agents"]) {
      expect(key in body).toBe(false);
    }
  });

  it("デーモンが断った理由は文にする。古い提出は、差し戻しの文（承認ではない）で、get_task で確かめ直すことを伝える", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const stale = await failure(async () =>
      Response.json(
        {
          error: "invalid_operation",
          messages: [{ code: "gate.staleSubmission", params: { submission: 1, current: 3 } }],
        },
        { status: 409 },
      ),
    );
    expect(stale?.message).toContain("1回目");
    expect(stale?.message).toContain("3回目");
    expect(stale?.message).toContain("差し戻しませんでした");
    expect(stale?.message).not.toContain("承認しませんでした");
    expect(stale?.message).not.toContain(uncertain);
    const over = await failure(async () =>
      Response.json(
        {
          error: "invalid_operation",
          messages: [{ code: "gate.overLimit", params: { limit: 3 } }],
        },
        { status: 409 },
      ),
    );
    expect(over?.message).toContain("上限");
    expect(over?.message).not.toContain(uncertain);
  });

  it("差し戻しを送った後に結果を受け取れなければ（時間切れ・切断・本文を読めない・5xx）、差し戻されている可能性と get_task で確かめることを伝える", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const timedOut = await failure(hung);
    expect(timedOut?.message).toContain("時間切れ");
    expect(timedOut?.message).toContain(uncertain);
    expect(timedOut?.message).not.toContain("もう一度試してください");
    expect(timedOut?.message).toContain("get_task");
    const dropped = await failure(async () => {
      throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
    });
    expect(dropped?.message).toContain(uncertain);
    const broken = await failure(async () => new Response("<html>", { status: 200 }));
    expect(broken?.message).toContain("差し戻しの結果を受け取れませんでした");
    expect(broken?.message).toContain(uncertain);
    const server = await failure(async () => new Response("oops", { status: 500 }));
    expect(server?.message).toContain("デーモンが 500 を返しました。");
    expect(server?.message).toContain(uncertain);
    // 指摘の文は、理由に写さない
    expect(server?.message).not.toContain("ここを直す");
  });

  it("認証できない・接続を断られた・起動中の sacty が無い・前の版のデーモン（想定外の 404）は、差し戻していないので、可能性を伝えない", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const unauthorized = await failure(async () => new Response("no", { status: 401 }));
    expect(unauthorized?.message).toContain("デーモンに認証できません");
    expect(unauthorized?.message).not.toContain(uncertain);
    const refused = await failure(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    expect(refused?.message).toContain("デーモンにつながりません");
    expect(refused?.message).not.toContain(uncertain);
    const none = await failure(hung, mkdtempSync(join(tmpdir(), "sacty-mcp-none-")));
    expect(none?.message).toContain("起動中の sacty が見つかりません");
    expect(none?.message).not.toContain(uncertain);
    const old = await failure(async () => new Response("Not Found", { status: 404 }));
    expect(old?.message).toBe("デーモンが 404 を返しました。");
  });
});

describe("sacty mcp の、タスクの状態が変わるまで待つ（PBI-399）の、デーモンの呼び出し", () => {
  it("getTask は、期限・取り消しを渡されたときだけ、それで打ち切る。渡さなければ、これまでと同じ既定の時間", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    let seen: AbortSignal | undefined;
    const hung: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init.signal;
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    // 取り消し（signal）で、待っている要求を打ち切る
    const controller = new AbortController();
    const pending = daemonApi(home, hung).getTask("a", { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    expect(seen?.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(seen?.aborted).toBe(true);
    // 期限（timeoutMs）は、デーモンの API の既定の時間（ここでは長い）の代わりに使う
    await expect(daemonApi(home, hung, 60_000).getTask("a", { timeoutMs: 20 })).rejects.toThrow(
      "デーモンが時間内に応答しませんでした",
    );
    // 渡さない呼び出しは、これまでどおり、既定の時間の signal を付ける（取り消しは付かない）
    void daemonApi(home, hung, 60_000)
      .getTask("a")
      .catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(seen?.aborted).toBe(false);
  });
});

describe("本物のデーモンの API と、本物の daemonApi をつないだ待つツール（PBI-399）", () => {
  useTempDir();

  it("cursor を渡すと、合間の承認待ちへの変化ですぐ返る。待つ間に呼ぶのは GET /api/tasks/:id だけで、作業履歴は増えない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, []);
    const task = service.createTask({ projectId: "default", title: "題" });
    const token = "t".repeat(64);
    const app = createApp(service, token);
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token });
    const requests: string[] = [];
    const fetcher: Fetch = async (url, init) => {
      const u = new URL(url);
      requests.push(`${init.method ?? "GET"} ${u.pathname}`);
      return app.request(`${u.pathname}${u.search}`, init);
    };
    // 待ちを、実際の時間の経過なしに進める時計（待っているタイマーを、呼び出しが終わるまで順に起こす）
    let now = 0;
    const timers: { at: number; fire: () => void }[] = [];
    const clock = {
      now: () => now,
      sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          const timer = { at: now + ms, fire: resolve };
          timers.push(timer);
          signal?.addEventListener(
            "abort",
            () => {
              const at = timers.indexOf(timer);
              if (at >= 0) timers.splice(at, 1);
              resolve();
            },
            { once: true },
          );
        }),
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    startTaskMcp(daemonApi(home, fetcher), { version: "1", transport: a, clock });
    const client = new Client(
      { name: "t", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(b);
    const advance = async <T>(promise: Promise<T>): Promise<T> => {
      let done = false;
      promise.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      for (let i = 0; i < 1000 && !done; i++) {
        for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r));
        if (done) break;
        timers.sort((x, y) => x.at - y.at);
        const next = timers.shift();
        if (next) {
          now = Math.max(now, next.at);
          next.fire();
        }
      }
      return promise;
    };
    const wait = async (args: Record<string, unknown>) =>
      (await advance(client.callTool({ name: "wait_for_task", arguments: args })))
        .structuredContent as { changed: boolean; changes: string[]; cursor: string };
    const first = await wait({ task_id: task.id, timeout_seconds: 7 });
    expect(first.changed).toBe(false);
    const activityBefore = service.get(task.id)?.activity.length;
    Object.assign(service.get(task.id)?.task ?? {}, {
      status: "awaiting_approval",
      steps: [{ key: "requirements", state: "awaiting_approval" }],
      gate: { step: "requirements", submission: 1 },
      submissions: { requirements: 1 },
    });
    const second = await wait({ task_id: task.id, cursor: first.cursor });
    expect(second.changed).toBe(true);
    expect(second.changes).toContain("state: active → awaiting_approval");
    expect(service.get(task.id)?.activity.length).toBe(activityBefore);
    expect(new Set(requests)).toEqual(new Set([`GET /api/tasks/${task.id}`]));
    // 無いタスクは、待たずに、いまの読み取りと同じ理由
    const missing = await client.callTool({
      name: "wait_for_task",
      arguments: { task_id: "none" },
    });
    expect(missing.isError).toBe(true);
    expect(now).toBe(7000);
    await client.close();
    activity.close();
  });
});
