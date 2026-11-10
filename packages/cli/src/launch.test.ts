import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetch } from "./context-preview.js";
import { launch, splitLaunchArgs } from "./launch.js";

const endpoint = { url: "http://127.0.0.1:4710", token: "t" };
const b64 = (text: string) => Buffer.from(text).toString("base64");

/** デーモンの偽物。呼ばれた API を記録する。 */
function fakeDaemon(session: unknown) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const path = url.slice(endpoint.url.length);
    calls.push({
      method: init.method ?? "GET",
      path,
      ...(init.body ? { body: JSON.parse(init.body) } : {}),
    });
    if (path === "/api/projects") {
      return Response.json({ projects: [{ id: "p1", name: "acme" }] });
    }
    if (path === "/api/projects/p1/local-sessions") return Response.json(session);
    return Response.json({ ok: true });
  };
  return { calls, fetcher };
}

/** 子プロセスの偽物。起動されたときの引数と、置いたファイルを記録して、code で終わる。 */
function fakeSpawn(code: number, seen: { args?: string[]; files?: Record<string, string> }) {
  return (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => true;
    seen.args = [command, ...args];
    const dir = args[args.indexOf("--append-system-prompt-file") + 1]?.replace(/\/CLAUDE\.md$/, "");
    seen.files = {
      dir: dir ?? "",
      cwd,
      env: env.SACTY_MCP_SECRET_0 ?? "",
      rules: dir ? readFileSync(join(dir, "CLAUDE.md"), "utf8") : "",
      mode: dir ? (statSync(join(dir, "CLAUDE.md")).mode & 0o777).toString(8) : "",
    };
    setImmediate(() => child.emit("close", code, null));
    return child;
  };
}

describe("splitLaunchArgs", () => {
  it("`--` の後を AI の CLI に渡す引数に分ける", () => {
    expect(splitLaunchArgs(["launch", "acme", "--", "--model", "x", "--"])).toEqual({
      own: ["launch", "acme"],
      extra: ["--model", "x", "--"],
    });
    expect(splitLaunchArgs(["launch", "acme"])).toEqual({ own: ["launch", "acme"], extra: [] });
  });
});

describe("launch", () => {
  it("セッションを作り、一時ディレクトリに置いて起動し、終わったらセッションを終えてディレクトリを消す", async () => {
    const { calls, fetcher } = fakeDaemon({
      session: {
        id: "s1",
        runtime: "claude-code",
        files: [{ path: "CLAUDE.md", content: b64("規則\n") }],
        env: { SACTY_MCP_SECRET_0: "Bearer gw" },
        mcpServers: [],
        warnings: [],
      },
    });
    const seen: { args?: string[]; files?: Record<string, string> } = {};
    const lines: string[] = [];
    const code = await launch(
      endpoint,
      { project: "acme", runtime: "claude-code", cwd: "/work/repo", extraArgs: ["--resume"] },
      { fetcher, spawn: fakeSpawn(3, seen), log: (l) => lines.push(l) },
    );
    expect(code).toBe(3);
    expect(seen.args?.[0]).toBe("claude");
    expect(seen.args?.at(-1)).toBe("--resume");
    expect(seen.files?.rules).toBe("規則\n");
    expect(seen.files?.mode).toBe("600");
    expect(seen.files?.cwd).toBe("/work/repo");
    expect(seen.files?.env).toBe("Bearer gw");
    const create = calls.find((c) => c.method === "POST");
    expect(create?.body).toEqual({ runtime: "claude-code", dir: seen.files?.dir });
    expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/api/local-sessions/s1" });
    expect(existsSync(seen.files?.dir ?? "/")).toBe(false);
    expect(lines).toEqual([]);
  });

  it("コンテキストを用意できなければ、起動せずに理由で止め、一時ディレクトリを消す", async () => {
    const { calls, fetcher } = fakeDaemon({ error: "取得できません" });
    let started = false;
    await expect(
      launch(
        endpoint,
        { project: "acme", runtime: "codex", cwd: "/work", extraArgs: [] },
        {
          fetcher,
          spawn: () => {
            started = true;
            return new EventEmitter() as ChildProcess;
          },
        },
      ),
    ).rejects.toThrow("コンテキストを用意できませんでした：取得できません");
    expect(started).toBe(false);
    const body = calls.find((c) => c.method === "POST")?.body as { dir: string } | undefined;
    const dir = body?.dir ?? "";
    expect(dir).not.toBe("");
    expect(existsSync(dir)).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
