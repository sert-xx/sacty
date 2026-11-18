import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(await api.rereview("a b")).toEqual({ id: "a", status: "queued" });
    expect(api.webUrl()).toBe("http://127.0.0.1:4700");
    expect(calls).toEqual([
      { method: "GET", url: "http://127.0.0.1:4710/api/tasks", token: "Bearer tok" },
      { method: "GET", url: "http://127.0.0.1:4710/api/projects", token: "Bearer tok" },
      { method: "GET", url: "http://127.0.0.1:4710/api/tasks/a%2F..%2Fb", token: "Bearer tok" },
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
    const { fetcher } = fakeDaemon((method) =>
      method === "POST"
        ? Response.json(
            { error: "invalid_operation", messages: [{ code: "review.notRereviewable" }] },
            { status: 409 },
          )
        : Response.json({ error: "not_found" }, { status: 404 }),
    );
    const api = daemonApi(home, fetcher);
    expect(await api.getTask("none")).toBeUndefined();
    await expect(api.rereview("a")).rejects.toThrow(
      "再レビューできるのは、レビューを PR に投稿して完了したタスクだけです。",
    );
  });

  it("つながらない・認証できない・想定外の応答は、理由の例外にする", async () => {
    writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: "tok" });
    const refused = daemonApi(home, async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(refused.listTasks()).rejects.toThrow("デーモンにつながりません");
    const unauthorized = daemonApi(home, async () => new Response("", { status: 401 }));
    await expect(unauthorized.rereview("a")).rejects.toThrow("デーモンに認証できません");
    const broken = daemonApi(home, async () => new Response("oops", { status: 500 }));
    await expect(broken.listTasks()).rejects.toThrow("デーモンが 500 を返しました。");
    await expect(broken.getTask("a")).rejects.toThrow("デーモンが 500 を返しました。");
    await expect(broken.rereview("a")).rejects.toThrow("デーモンが 500 を返しました。");
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
