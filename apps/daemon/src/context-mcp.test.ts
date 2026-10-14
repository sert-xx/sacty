import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderMessage } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostedContextMcp } from "./context.js";
import { ContextMcpServers } from "./context-mcp.js";
import { AiGateway } from "./gateway.js";
import type { HostMcpConnector, HostMcpSpec } from "./host-mcp.js";
import { collectTargets, HostMcpProcesses, psTable } from "./host-mcp-processes.js";
import { MemorySecretStore } from "./secrets.js";

let dir: string;
let manager: ContextMcpServers | undefined;
let gateway: AiGateway | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-context-mcp-"));
});
afterEach(async () => {
  await gateway?.close();
  await manager?.stop();
  gateway = undefined;
  manager = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** 取得した層（実行の後に消える一時ディレクトリの代わり）。marker.txt に中身の目印を書く。 */
function layer(name: string, marker: string, commit = "c1".padEnd(40, "0")) {
  const layerDir = join(dir, "fetched", name, commit);
  mkdirSync(join(layerDir, ".git"), { recursive: true });
  writeFileSync(join(layerDir, "marker.txt"), marker);
  writeFileSync(join(layerDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return { repo: `https://github.com/acme/${name}.git`, commit, dir: layerDir };
}

const server = (extra: Partial<HostedContextMcp> & Pick<HostedContextMcp, "layer">) =>
  ({
    name: "tool",
    from: `${extra.layer.repo}@${extra.layer.commit.slice(0, 7)}`,
    command: "tool-mcp",
    args: [],
    env: {},
    ...extra,
  }) satisfies HostedContextMcp;

/**
 * 偽の MCP サーバー。起動するたびに数え、whoami で、作業ディレクトリの marker.txt と、env の TOKEN を返す（ホストで
 * 起動したことと、どの中身かを確かめる）。
 */
function fakeConnect() {
  const started: { spec: HostMcpSpec; env: Record<string, string> }[] = [];
  const closed: string[] = [];
  const connect: HostMcpConnector = async (spec, env) => {
    started.push({ spec, env });
    const mcp = new McpServer({ name: "tool", version: "1.0.0" });
    mcp.registerTool("whoami", { description: "どの中身か" }, async () => ({
      content: [
        {
          type: "text",
          text: `${readFileSync(join(spec.cwd ?? "", "marker.txt"), "utf8")} token=${env.TOKEN ?? ""}`,
        },
      ],
    }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "sacty-gateway", version: "0.1.0" });
    await client.connect(clientSide);
    return {
      client,
      close: async () => {
        closed.push(spec.name);
        await client.close();
      },
      onClose: (callback) => {
        client.onclose = callback;
      },
    };
  };
  return { connect, started, closed };
}

async function agentCall(port: number, token: string, name: string) {
  const client = new Client({ name: "agent", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/ctx-mcp/${name}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: "whoami", arguments: {} });
    return (result.content as { text: string }[]).map((c) => c.text).join("");
  } finally {
    await client.close();
  }
}

describe("コンテキストの command の MCP サーバーをホストで動かす（PBI-84）", () => {
  it("層を写した作業ディレクトリで起動し、秘密情報はホストで取り出して env に入れる（.git は写さない）", async () => {
    const fake = fakeConnect();
    manager = new ContextMcpServers({
      root: join(dir, "home"),
      secrets: new MemorySecretStore({ "tool-token": "host-only-secret" }),
      connect: fake.connect,
    });
    manager.start();
    const l = layer("ctx", "company");
    const lease = manager.lease("p1", [
      server({
        layer: l,
        args: ["./bin/server"],
        env: { TOKEN: { secret: "tool-token", prefix: "t:" }, REGION: "jp" },
      }),
    ]);
    expect(await manager.ready(lease.keys)).toEqual([]);
    const { spec, env } = fake.started[0] ?? { spec: undefined, env: {} };
    expect(env).toEqual({ TOKEN: "t:host-only-secret", REGION: "jp" });
    expect(spec?.args).toEqual(["./bin/server"]);
    // 作業ディレクトリは、取得した層（実行の後に消える）ではなく、SACTY_HOME の下の写し
    expect(spec?.cwd?.startsWith(join(dir, "home", "layers"))).toBe(true);
    expect(readFileSync(join(spec?.cwd ?? "", "marker.txt"), "utf8")).toBe("company");
    expect(existsSync(join(spec?.cwd ?? "", ".git"))).toBe(false);
    // 取得した層を消しても、使い続けられる
    rmSync(l.dir, { recursive: true, force: true });
    gateway = new AiGateway({ contextHostMcp: manager });
    const port = await gateway.listen();
    const run = gateway.register(
      undefined,
      Object.fromEntries(lease.relays.map((r) => [r.name, { host: r.host }])),
    );
    expect(await agentCall(port, run.token, "tool")).toBe("company token=t:host-only-secret");
    run.close();
    lease.release();
  });

  it("同じプロジェクト・同じ中身なら、実行をまたいで使い回す（並行する実行も同じプロセス）", async () => {
    const fake = fakeConnect();
    manager = new ContextMcpServers({
      root: join(dir, "home"),
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    manager.start();
    const a = manager.lease("p1", [server({ layer: layer("ctx", "v1") })]);
    const b = manager.lease("p1", [server({ layer: layer("ctx", "v1") })]);
    expect(b.keys).toEqual(a.keys);
    await Promise.all([manager.ready(a.keys), manager.ready(b.keys)]);
    a.release();
    b.release();
    // 使い終えても、しばらくは止めない（次の実行で使い回す）
    const c = manager.lease("p1", [server({ layer: layer("ctx", "v1") })]);
    expect(await manager.ready(c.keys)).toEqual([]);
    expect(c.keys).toEqual(a.keys);
    expect(fake.started).toHaveLength(1);
    expect(fake.closed).toEqual([]);
    c.release();
  });

  it("中身（コマンド・引数・env・層の commit）が変われば、新しく起動し、古いものは使っている実行が終わってから止める", async () => {
    const fake = fakeConnect();
    manager = new ContextMcpServers({
      root: join(dir, "home"),
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    manager.start();
    const base = { layer: layer("ctx", "v1") };
    const first = manager.lease("p1", [server(base)]);
    await manager.ready(first.keys);
    const variants: Partial<HostedContextMcp>[] = [
      { command: "other-mcp" },
      { args: ["--flag"] },
      { env: { MODE: "x" } },
      { layer: layer("ctx", "v2", "c2".padEnd(40, "0")) },
    ];
    let previous = first;
    for (const variant of variants) {
      const next = manager.lease("p1", [server({ ...base, ...variant })]);
      expect(next.keys).not.toEqual(previous.keys);
      await manager.ready(next.keys);
      // 前の中身を使っている実行の途中は、止めない
      const running = manager.running().map((r) => r.key);
      expect(running).toContain(previous.keys[0]);
      previous.release();
      // 終わったら（古くなったので）すぐに止める
      expect(manager.running().map((r) => r.key)).toEqual(next.keys);
      await until(() => fake.closed.includes(previous.keys[0] ?? ""));
      previous = next;
    }
    expect(fake.started).toHaveLength(1 + variants.length);
    // 新しい commit の層を写し、使われなくなった層の写しは消す
    expect(readdirSync(join(dir, "home", "layers"))).toHaveLength(1);
    expect(
      fake.started.at(-1)?.spec.cwd &&
        readFileSync(join(fake.started.at(-1)?.spec.cwd ?? "", "marker.txt"), "utf8"),
    ).toBe("v2");
    previous.release();
  });

  it("しばらく使われなければ止め、層の写しも消す。デーモンを止めたら、すべて止めて写しを消す", async () => {
    const fake = fakeConnect();
    let now = 1_000;
    manager = new ContextMcpServers({
      root: join(dir, "home"),
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
      idleMs: 60_000,
      now: () => now,
    });
    manager.start();
    const idle = manager.lease("p1", [server({ name: "idle", layer: layer("a", "a") })]);
    const busy = manager.lease("p1", [server({ name: "busy", layer: layer("b", "b") })]);
    await manager.ready([...idle.keys, ...busy.keys]);
    idle.release();
    now += 59_000;
    manager.sweep();
    expect(manager.running()).toHaveLength(2);
    now += 1_000;
    manager.sweep();
    // 使っている実行があるものは、いつまでも止めない
    expect(manager.running().map((r) => r.name)).toEqual(["busy"]);
    await until(() => fake.closed.length === 1);
    expect(readdirSync(join(dir, "home", "layers"))).toHaveLength(1);
    await manager.stop();
    expect(fake.closed).toHaveLength(2);
    expect(existsSync(join(dir, "home", "layers"))).toBe(false);
    manager = undefined;
  });

  it("前回の残りの層の写しは、起動のときに消す", () => {
    mkdirSync(join(dir, "home", "layers", "left"), { recursive: true });
    manager = new ContextMcpServers({
      root: join(dir, "home"),
      secrets: new MemorySecretStore({}),
    });
    manager.start();
    expect(existsSync(join(dir, "home", "layers"))).toBe(false);
  });

  it("プロジェクトごとに分ける：同じ名前でも中身が違えば混ざらず、ほかのプロジェクトの実行のトークンでは使えない", async () => {
    const fake = fakeConnect();
    manager = new ContextMcpServers({
      root: join(dir, "home"),
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    manager.start();
    // 同じ中身でも、プロジェクトが違えば別のプロセス（作業ディレクトリも別）
    const sameA = manager.lease("pa", [server({ layer: layer("shared", "shared") })]);
    const sameB = manager.lease("pb", [server({ layer: layer("shared", "shared") })]);
    expect(sameA.keys).not.toEqual(sameB.keys);
    const a = manager.lease("pa", [server({ layer: layer("ctx-a", "project A") })]);
    const b = manager.lease("pb", [server({ layer: layer("ctx-b", "project B") })]);
    await manager.ready([...sameA.keys, ...sameB.keys, ...a.keys, ...b.keys]);
    const cwds = new Set(fake.started.map((s) => s.spec.cwd));
    expect(cwds.size).toBe(4);
    gateway = new AiGateway({ contextHostMcp: manager });
    const port = await gateway.listen();
    const route = (lease: typeof a) =>
      Object.fromEntries(lease.relays.map((r) => [r.name, { host: r.host }]));
    const runA = gateway.register(undefined, route(a));
    const runB = gateway.register(undefined, route(b));
    expect(await agentCall(port, runA.token, "tool")).toBe("project A token=");
    expect(await agentCall(port, runB.token, "tool")).toBe("project B token=");
    // 実行のトークンに結びつけていない名前・ゲートウェイの中の名前は使えない
    const post = (path: string, token: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post(`/ctx-mcp/${b.keys[0]}`, runA.token)).status).toBe(404);
    expect((await post(`/mcp/${b.keys[0]}`, runA.token)).status).toBe(404);
    expect((await post("/ctx-mcp/constructor", runA.token)).status).toBe(404);
    // 終わった実行のトークンでは使えない
    runA.close();
    expect((await post("/ctx-mcp/tool", runA.token)).status).toBe(401);
    runB.close();
    for (const l of [sameA, sameB, a, b]) l.release();
  });

  it("コマンドがホストに無ければ、どの MCP サーバーか・どのコマンドか・コンテナで動かす書き方がわかる警告にする", async () => {
    manager = new ContextMcpServers({
      root: join(dir, "home"),
      secrets: new MemorySecretStore({}),
      processes: new HostMcpProcesses(),
    });
    manager.start();
    const lease = manager.lease("p1", [
      server({ name: "uvx-tool", command: "sacty-no-such-command-84", layer: layer("ctx", "x") }),
      server({ name: "relative", command: "./bin/missing", layer: layer("ctx", "x") }),
    ]);
    const problems = await manager.ready(lease.keys);
    expect(problems.map((p) => p.code)).toEqual([
      "context.mcpHostCommandMissing",
      "context.mcpHostCommandMissing",
    ]);
    const text = renderMessage(problems[0], "ja");
    expect(text).toContain("uvx-tool");
    expect(text).toContain("sacty-no-such-command-84");
    expect(text).toContain("via_gateway: false");
    expect(text).toContain("https://github.com/acme/ctx.git@c100000");
    lease.release();
  });
});

const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** 実際のプロセス（MCP の SDK のサーバーを stdio で、ホストで起動する）での確かめ。 */
describe.skipIf(process.platform === "win32")(
  "実際のプロセスで、ホストで動かしてゲートウェイ経由で使う（PBI-84）",
  () => {
    const require = createRequire(import.meta.url);
    const sdk = (path: string) =>
      pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${path}`)).href;

    /** 層のリポジトリ。相対パスのスクリプト（作業ディレクトリから探す）で、MCP の SDK の本物のサーバーを動かす。 */
    const realLayer = () => {
      const l = layer("real", "real-layer");
      mkdirSync(join(l.dir, "mcp"), { recursive: true });
      writeFileSync(
        join(l.dir, "mcp", "server.mjs"),
        `import { readFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(sdk("server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdk("server/stdio.js"))};
const server = new McpServer({ name: "real", version: "1.0.0" });
server.registerTool("where", { description: "作業ディレクトリと env" }, async () => ({
  content: [{ type: "text", text: JSON.stringify({
    marker: readFileSync("marker.txt", "utf8"),
    token: process.env.REAL_TOKEN ?? null,
    pid: process.pid,
  }) }],
}));
await server.connect(new StdioServerTransport());
`,
      );
      return l;
    };

    it("初期化・ツールの一覧・呼び出しができ、デーモンを止めたらプロセスが残らない", async () => {
      const processes = new HostMcpProcesses(join(dir, "home", "host-mcp", "processes"), {
        graceMs: 500,
      });
      manager = new ContextMcpServers({
        root: join(dir, "home", "context-mcp"),
        secrets: new MemorySecretStore({ "real-token": "real-secret-value" }),
        processes,
      });
      manager.start();
      const lease = manager.lease("p1", [
        server({
          name: "real",
          command: process.execPath,
          args: ["./mcp/server.mjs"],
          env: { REAL_TOKEN: { secret: "real-token", prefix: "" } },
          layer: realLayer(),
        }),
      ]);
      expect(await manager.ready(lease.keys)).toEqual([]);
      gateway = new AiGateway({ contextHostMcp: manager });
      const port = await gateway.listen();
      const run = gateway.register(undefined, { real: { host: lease.keys[0] ?? "" } });
      const client = new Client({ name: "agent", version: "0.0.1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/ctx-mcp/real`), {
          requestInit: { headers: { Authorization: `Bearer ${run.token}` } },
        }),
      );
      expect(client.getServerVersion()?.name).toBe("sacty-gateway/real");
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["where"]);
      const result = await client.callTool({ name: "where", arguments: {} });
      const where = JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}");
      expect(where).toMatchObject({ marker: "real-layer", token: "real-secret-value" });
      await client.close();
      run.close();
      lease.release();
      // 記録（前回の残りの片付けに使う）が書かれている
      expect(readdirSync(join(dir, "home", "host-mcp", "processes"))).toHaveLength(1);
      await manager.stop();
      manager = undefined;
      const table = await psTable();
      expect(table.some((p) => p.pid === where.pid)).toBe(false);
      expect(readdirSync(join(dir, "home", "host-mcp", "processes"))).toEqual([]);
    }, 30_000);

    it("デーモンが突然落ちて残ったものは、次の起動の片付けで止める（ホストの MCP サーバーと同じ記録）", async () => {
      const records = join(dir, "home", "host-mcp", "processes");
      // 落ちたデーモン（もう動いていない所有元）が起動したことにする
      const crashed = new HostMcpProcesses(records, {
        graceMs: 500,
        owner: { pid: 999_999, started: "Thu Jan  1 00:00:00 1970" },
      });
      manager = new ContextMcpServers({
        root: join(dir, "home", "context-mcp"),
        secrets: new MemorySecretStore({}),
        processes: crashed,
      });
      manager.start();
      const lease = manager.lease("p1", [
        server({
          name: "real",
          command: process.execPath,
          args: ["./mcp/server.mjs"],
          layer: realLayer(),
        }),
      ]);
      expect(await manager.ready(lease.keys)).toEqual([]);
      await until(() => readdirSync(records).length === 1);
      const pid = Number(readdirSync(records)[0]?.replace(".json", ""));
      const before = collectTargets(await psTable(), [], [pid]);
      expect(before.length).toBeGreaterThan(0);
      // 次の起動の片付け
      expect(await new HostMcpProcesses(records, { graceMs: 500 }).cleanup()).toBeGreaterThan(0);
      const after = await psTable();
      expect(
        before.filter((p) => after.some((a) => a.pid === p.pid && a.started === p.started)),
      ).toEqual([]);
      lease.release();
    }, 30_000);
  },
);
