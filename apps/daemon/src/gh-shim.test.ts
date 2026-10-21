import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AiGateway } from "./gateway.js";

/** イメージに入れる gh（gh api だけをゲートウェイの GitHub の中継に送るもの）。 */
const SHIM = fileURLToPath(new URL("../../../packages/cli/docker/gh-shim.cjs", import.meta.url));

let gateway: AiGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function setup(responses: Response[]) {
  const calls: { url: string; method: string; auth: string | null; body: string }[] = [];
  gateway = new AiGateway({
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        auth: new Headers(init.headers).get("authorization"),
        body: init.body ? Buffer.from(init.body as Uint8Array).toString() : "",
      });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next;
    }) as typeof fetch,
    githubToken: async (_host, account) => `ghp_${account}`,
  });
  const port = await gateway.listen();
  const run = gateway.register(undefined, undefined, undefined, undefined, { "github.com": "me" });
  const env = {
    PATH: process.env.PATH ?? "",
    SACTY_GITHUB_URL: `http://127.0.0.1:${port}/r/${run.token}/github`,
    SACTY_GITHUB_HOSTS: "github.com",
    GH_HOST: "github.com",
  };
  const gh = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [SHIM, ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  return { gh, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

describe("イメージの gh（gh api だけを中継に送る）", () => {
  it("REST の GET を中継に送り、フィールドはクエリにする（トークンはゲートウェイが付ける）", async () => {
    const { gh, calls } = await setup([json({ number: 1, title: "t" })]);
    const res = await gh("api", "repos/acme/app/pulls/1", "-f", "per_page=100");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ number: 1, title: "t" });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/pulls/1?per_page=100",
      method: "GET",
      auth: "Bearer ghp_me",
    });
  });

  it("--paginate は link をたどり、配列をまとめて出す", async () => {
    const { gh, calls } = await setup([
      // 1ページ目の link は API の URL（ゲートウェイが中継の URL に書き換える）
      json([{ id: 1 }], {
        link: '<https://api.github.com/repos/acme/app/pulls/1/comments?page=2>; rel="next"',
      }),
      json([{ id: 2 }]),
    ]);
    const res = await gh("api", "--paginate", "repos/acme/app/pulls/1/comments");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/app/pulls/1/comments",
      "https://api.github.com/repos/acme/app/pulls/1/comments?page=2",
    ]);
  });

  it("--paginate で 0 件なら [] を出す", async () => {
    const { gh } = await setup([json([])]);
    const res = await gh("api", "--paginate", "repos/acme/app/issues/1/comments");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([]);
  });

  it("GraphQL の errors は、200 でも失敗で終わり、理由を出す（data があっても）", async () => {
    const { gh } = await setup([
      json({ data: { viewer: null }, errors: [{ message: "Resource not accessible" }] }),
    ]);
    const res = await gh("api", "graphql", "-f", "query={ viewer { login } }", "--silent");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("gh: Resource not accessible");
  });

  it("graphql は query と変数を POST する", async () => {
    const { gh, calls } = await setup([json({ data: { viewer: { login: "me" } } })]);
    const res = await gh(
      "api",
      "graphql",
      "-f",
      "query=query($n: Int!) { viewer { login } }",
      "-F",
      "n=3",
    );
    expect(res.code).toBe(0);
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      query: "query($n: Int!) { viewer { login } }",
      variables: { n: 3 },
    });
  });

  it("書き込みと、gh api 以外のコマンドは使えないことを示す", async () => {
    const { gh, calls } = await setup([]);
    const post = await gh("api", "-X", "POST", "repos/acme/app/issues/1/comments", "-f", "body=x");
    expect(post.code).toBe(1);
    expect(post.stderr).toContain("読み取りだけ");
    const view = await gh("pr", "view", "1");
    expect(view.code).toBe(1);
    expect(view.stderr).toContain("gh api");
    expect(view.stderr).toContain("sacty-github-comments");
    expect(calls).toHaveLength(0);
  });

  it("上流の誤りは、本文を出して失敗で終わる", async () => {
    const { gh } = await setup([
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    ]);
    const res = await gh("api", "repos/acme/none");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Not Found (HTTP 404)");
  });
});
