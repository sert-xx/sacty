import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiGateway } from "./gateway.js";
import {
  type HostMcpConnection,
  type HostMcpConnector,
  HostMcpFile,
  HostMcpServers,
  type HostMcpSpec,
  toHostMcp,
} from "./host-mcp.js";
import { MemorySecretStore } from "./secrets.js";

const spec = (extra: Record<string, unknown> = {}): HostMcpSpec =>
  toHostMcp("cloud", HostMcpFile.parse({ command: "cloud-mcp", ...extra }));

/**
 * ホストの MCP サーバーの偽物。起動（接続）するたびに新しい「世代」になり、whoami で世代を返す。
 * expired が true の世代は、ツールが認証エラーを返す（期限切れ）。
 */
function fakeServers(
  options: {
    fail?: () => boolean;
    expired?: (generation: number) => boolean;
    /** slow のツールが返るまで待つ。 */
    slow?: Promise<void>;
  } = {},
) {
  let generation = 0;
  const servers: McpServer[] = [];
  const transports: InMemoryTransport[] = [];
  const envs: Record<string, string>[] = [];
  const connect: HostMcpConnector = async (_spec, env) => {
    envs.push(env);
    if (options.fail?.()) throw new Error("Okta login did not complete");
    const mine = generation + 1;
    const server = new McpServer({ name: "cloud", version: "1.0.0" });
    server.registerTool("whoami", { description: "どの世代か" }, async () =>
      options.expired?.(mine)
        ? { isError: true, content: [{ type: "text", text: "401 Unauthorized: token expired" }] }
        : { content: [{ type: "text", text: `generation ${mine}` }] },
    );
    server.registerTool("slow", { description: "時間のかかるツール" }, async () => {
      await options.slow;
      return { content: [{ type: "text", text: `slow done on generation ${mine}` }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "sacty-gateway", version: "0.1.0" });
    await client.connect(clientSide);
    servers.push(server);
    transports.push(clientSide);
    // 準備ができた（接続が済んだ）ところで、世代を進める
    generation = mine;
    return {
      client,
      close: () => client.close(),
      onClose: (callback) => {
        client.onclose = callback;
      },
    };
  };
  return { connect, servers, transports, envs, generation: () => generation };
}

const until = async (check: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

let gateway: AiGateway | undefined;
let host: HostMcpServers | undefined;
afterEach(async () => {
  await gateway?.close();
  await host?.stop();
  gateway = undefined;
  host = undefined;
});

/** ゲートウェイの HTTP の MCP に、エージェントと同じく SDK のクライアントでつなぐ。 */
async function agentClient(port: number, token: string) {
  const client = new Client({ name: "agent", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/cloud`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const text = (result: unknown) =>
  ((result as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

describe("ホストで動かす MCP サーバー（PBI-36）", () => {
  it("ホストで起動し（秘密情報は環境変数で渡す）、エージェントには HTTP の MCP として中継する", async () => {
    const fake = fakeServers();
    host = new HostMcpServers({
      specs: () => [
        spec({ env: { REGION: "ap-northeast-1", TOKEN: { secret: "cloud-token", prefix: "t:" } } }),
      ],
      secrets: new MemorySecretStore({ "cloud-token": "secret-value" }),
      connect: fake.connect,
    });
    host.start();
    await until(() => fake.generation() === 1);
    expect(fake.envs[0]).toEqual({ REGION: "ap-northeast-1", TOKEN: "t:secret-value" });

    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const run = gateway.register();
    const agent = await agentClient(port, run.token);
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["whoami", "slow"]);
    expect(text(await agent.callTool({ name: "whoami", arguments: {} }))).toBe("generation 1");
    await agent.close();

    // 実行のトークンが無い・終わった実行は使えない
    const anonymous = await fetch(`http://127.0.0.1:${port}/mcp/cloud`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
    run.close();
    await expect(agentClient(port, run.token)).rejects.toThrow();
  });

  it("認証の期限の前に、決めた間隔で起動し直す（新しいプロセスの準備ができてから切り替え、古いプロセスを止める）", async () => {
    const fake = fakeServers();
    host = new HostMcpServers({
      specs: () => [spec({ restart_every_min: 1 })],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
      minuteMs: 30,
    });
    host.start();
    await until(() => fake.generation() >= 3);
    expect(host.restarts("cloud")).toBeGreaterThanOrEqual(2);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const agent = await agentClient(port, gateway.register().token);
    const current = fake.generation();
    expect(text(await agent.callTool({ name: "whoami", arguments: {} }))).toMatch(
      new RegExp(`generation (${current}|${current + 1})`),
    );
    await agent.close();
  });

  it("プロセスが終わったら、起動し直す", async () => {
    const fake = fakeServers();
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    host.start();
    await until(() => fake.generation() === 1);
    // プロセスが終わった（接続が切れた）
    await fake.transports[0]?.close();
    await until(() => fake.generation() === 2);
    expect(host.restarts("cloud")).toBe(1);
  });

  it("ツールが認証エラー（期限切れ）を返したら、起動し直して再認証し、エージェントにはやり直すよう伝える", async () => {
    const fake = fakeServers({ expired: (generation) => generation === 1 });
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    host.start();
    await until(() => fake.generation() === 1);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const agent = await agentClient(port, gateway.register().token);
    const expired = await agent.callTool({ name: "whoami", arguments: {} });
    expect(expired.isError).toBe(true);
    expect(text(expired)).toContain("401 Unauthorized: token expired");
    expect(text(expired)).toContain("restarting it to re-authenticate");
    await until(() => fake.generation() === 2);
    await new Promise((r) => setTimeout(r, 20));
    // 再認証した後は、そのまま使える
    expect(text(await agent.callTool({ name: "whoami", arguments: {} }))).toBe("generation 2");
    await agent.close();
  });

  it("準備ができなければ理由を画面に出し、エージェントには準備ができていないと返す。起動し直して準備ができたら消す", async () => {
    let fail = true;
    const fake = fakeServers({ fail: () => fail });
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
      retryMs: 20,
    });
    host.start();
    await until(() => host?.problems().length === 1);
    expect(renderMessage(host.problems()[0], "ja")).toBe(
      "ホストの MCP サーバー「cloud」の準備ができません（起動・認証に失敗）：Okta login did not complete。1分ごとに起動し直します。",
    );
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const token = gateway.register().token;
    const notReady = await fetch(`http://127.0.0.1:${port}/mcp/cloud`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(notReady.status).toBe(503);
    expect(await notReady.text()).toContain('the MCP server \\"cloud\\" is not ready');
    fail = false;
    await until(() => fake.generation() === 1);
    expect(host.problems()).toEqual([]);
  });

  it("設定から消した MCP サーバーは止め、設定を変えたら起動し直す", async () => {
    const fake = fakeServers();
    let specs = [spec()];
    host = new HostMcpServers({
      specs: () => specs,
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    host.start();
    await until(() => fake.generation() === 1);
    specs = [spec({ args: ["--verbose"] })];
    host.reconcile();
    await until(() => fake.generation() === 2);
    specs = [];
    host.reconcile();
    expect(host.servers()).toEqual([]);
  });

  it("起動の途中で設定が変わったら、起動が終わった後に新しい設定で起動し直す", async () => {
    const fake = fakeServers();
    const started: string[][] = [];
    let release: (() => void) | undefined;
    const slow: HostMcpConnector = async (s, env) => {
      started.push(s.args);
      if (started.length === 1) await new Promise<void>((r) => (release = r));
      return fake.connect(s, env);
    };
    let specs = [spec()];
    host = new HostMcpServers({
      specs: () => specs,
      secrets: new MemorySecretStore({}),
      connect: slow,
    });
    host.start();
    await until(() => started.length === 1);
    specs = [spec({ args: ["--profile", "work"] })];
    host.reconcile();
    release?.();
    await until(() => fake.generation() === 2);
    expect(started).toEqual([[], ["--profile", "work"]]);
  });

  it("切り替えた古いプロセスは、途中の呼び出しが終わってから止める（その失敗で、もう一度起動し直さない）", async () => {
    let finish: (() => void) | undefined;
    const fake = fakeServers({ slow: new Promise<void>((r) => (finish = r)) });
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    host.start();
    await until(() => fake.generation() === 1);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const agent = await agentClient(port, gateway.register().token);
    const pending = agent.callTool({ name: "slow", arguments: {} });
    await new Promise((r) => setTimeout(r, 50));
    // 途中の呼び出しがある間に、期限の前の起動し直し
    await host.restart("cloud", "before the authentication expires");
    expect(fake.generation()).toBe(2);
    // 新しい呼び出しは、新しいプロセスへ
    const fresh = await agentClient(port, gateway.register().token);
    expect(text(await fresh.callTool({ name: "whoami", arguments: {} }))).toBe("generation 2");
    finish?.();
    expect(text(await pending)).toBe("slow done on generation 1");
    await new Promise((r) => setTimeout(r, 300));
    expect(host.restarts("cloud")).toBe(1);
    await agent.close();
    await fresh.close();
  });

  it("待つ上限を過ぎて古いプロセスを止めたときの途中の呼び出しの失敗では、起動し直さない", async () => {
    const fake = fakeServers({ slow: new Promise<void>(() => {}) });
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
      drainMs: 50,
    });
    host.start();
    await until(() => fake.generation() === 1);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const agent = await agentClient(port, gateway.register().token);
    const pending = agent.callTool({ name: "slow", arguments: {} }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 50));
    await host.restart("cloud", "before the authentication expires");
    expect(await pending).toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.generation()).toBe(2);
    expect(host.restarts("cloud")).toBe(1);
    await agent.close();
  });

  it("起動に失敗した理由（MCP サーバーの標準エラーを含む）から、秘密情報を伏せてから切り詰める（レビュー指摘）", async () => {
    const secret = "FAKE-HOST-SECRET-0123456789abcdef";
    for (const pad of [0, 280, 290, 590, 990, 70_000]) {
      const lines: string[] = [];
      const server = new HostMcpServers({
        specs: () => [
          toHostMcp(
            "cloud",
            HostMcpFile.parse({
              // 実際の子プロセス（MCP サーバー）が、認証の失敗で秘密情報を標準エラーに出して終わる
              command: process.execPath,
              args: [
                "-e",
                "process.stderr.write('x'.repeat(Number(process.env.PAD)) + 'token=' + process.env.TOKEN); process.exit(1)",
              ],
              env: { PAD: String(pad), TOKEN: { secret: "cloud-token" } },
              ready_timeout_sec: 10,
            }),
          ),
        ],
        secrets: new MemorySecretStore({ "cloud-token": secret }),
        retryMs: 60_000,
        log: (line) => lines.push(line),
      });
      server.start();
      await until(() => server.problems().length === 1, 10_000);
      const shown = [renderMessage(server.problems()[0], "ja"), ...lines].join("\n");
      expect(shown).not.toContain(secret.slice(0, 8));
      expect(shown).not.toContain(secret.slice(-8));
      gateway = new AiGateway({ hostMcp: server });
      const port = await gateway.listen();
      const res = await fetch(`http://127.0.0.1:${port}/mcp/cloud`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gateway.register().token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(secret.slice(0, 8));
      await gateway.close();
      gateway = undefined;
      await server.stop();
    }
  }, 60_000);

  it("再認証に失敗したら、期限切れの接続には新しい呼び出しを送らず（503）、呼び出しのたびに起動し直さない（レビュー指摘）", async () => {
    const fake = fakeServers({
      expired: (generation) => generation === 1,
      // 最初の起動だけ成功し、再認証（2回目からの起動）は失敗する
      fail: () => attempts++ > 0,
    });
    let attempts = 0;
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
      retryMs: 60_000,
    });
    host.start();
    await until(() => fake.generation() === 1);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const token = gateway.register().token;
    const agent = await agentClient(port, token);
    const expired = await agent.callTool({ name: "whoami", arguments: {} });
    expect(expired.isError).toBe(true);
    await until(() => host?.problems().length === 1);
    const post = () =>
      fetch(`http://127.0.0.1:${port}/mcp/cloud`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      });
    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(503);
    // 起動は、最初と、再認証の1回だけ（次は1分後）
    expect(fake.envs).toHaveLength(2);
    await agent.close();
  });

  it("ツールの誤り（引数の誤りなど）の例外では起動し直さず、接続が切れた・認証が切れた（JSON-RPC のエラー）ときに起動し直す", async () => {
    let connects = 0;
    let failWith: McpError = new McpError(ErrorCode.InvalidParams, "bad arguments");
    const connect: HostMcpConnector = async () => {
      connects += 1;
      return {
        client: {
          getServerCapabilities: () => ({ tools: {} }),
          listTools: async () => ({ tools: [{ name: "x", inputSchema: { type: "object" } }] }),
          callTool: async () => {
            throw failWith;
          },
        } as unknown as HostMcpConnection["client"],
        close: async () => {},
        onClose: () => {},
      };
    };
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect,
    });
    host.start();
    await until(() => connects === 1);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const agent = await agentClient(port, gateway.register().token);
    await agent.callTool({ name: "x", arguments: {} }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(connects).toBe(1);
    failWith = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    await agent.callTool({ name: "x", arguments: {} }).catch(() => undefined);
    await until(() => connects === 2);
    // 認証切れを JSON-RPC のエラーとして返す MCP サーバーでも、再認証する（レビュー指摘）
    failWith = new McpError(-32001, "401 Unauthorized: token expired");
    await agent.callTool({ name: "x", arguments: {} }).catch(() => undefined);
    await until(() => connects === 3);
    await agent.close();
  });
});

describe("ホストの MCP サーバーの時間切れ（PBI-75）", () => {
  /** 呼び出しのときに渡した待つ上限を記録する、ホストの MCP サーバーの偽物。 */
  function recordingConnector() {
    const calls: { method: string; timeout?: number }[] = [];
    let connects = 0;
    const connect: HostMcpConnector = async () => {
      connects += 1;
      const record =
        (method: string, result: unknown) =>
        async (...args: unknown[]) => {
          const options = args.find(
            (a): a is { timeout?: number } => typeof a === "object" && a !== null && "timeout" in a,
          );
          calls.push({ method, ...(options ? { timeout: options.timeout } : {}) });
          return result;
        };
      return {
        client: {
          getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
          listTools: record("tools/list", {
            tools: [{ name: "x", inputSchema: { type: "object" } }],
          }),
          callTool: record("tools/call", { content: [{ type: "text", text: "ok" }] }),
          listResources: record("resources/list", { resources: [] }),
          listResourceTemplates: record("resources/templates/list", { resourceTemplates: [] }),
          listPrompts: record("prompts/list", { prompts: [] }),
        } as unknown as HostMcpConnection["client"],
        close: async () => {},
        onClose: () => {},
      };
    };
    return { connect, calls, connects: () => connects };
  }

  async function run(specs: () => HostMcpSpec[]) {
    const fake = recordingConnector();
    host = new HostMcpServers({ specs, secrets: new MemorySecretStore({}), connect: fake.connect });
    host.start();
    await until(() => fake.connects() === 1);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const agent = await agentClient(port, gateway.register().token);
    await agent.listTools();
    await agent.listResources();
    await agent.listResourceTemplates();
    await agent.listPrompts();
    await agent.callTool({ name: "x", arguments: {} });
    await agent.close();
    return fake;
  }

  it("書けば、ツールの呼び出しと一覧を、その値より先に切らない（既定より短ければ既定のまま）", async () => {
    const long = await run(() => [spec({ startup_timeout_sec: 120, tool_timeout_sec: 3_600 })]);
    expect(long.calls).toEqual([
      { method: "tools/list", timeout: 120_000 },
      { method: "resources/list", timeout: 120_000 },
      { method: "resources/templates/list", timeout: 120_000 },
      { method: "prompts/list", timeout: 120_000 },
      { method: "tools/call", timeout: 3_600_000 },
    ]);
    await gateway?.close();
    await host?.stop();
    // 既定（ツールの呼び出しは10分、一覧は60秒）より短い値では、ゲートウェイの上限は縮めない
    const short = await run(() => [spec({ startup_timeout_sec: 5, tool_timeout_sec: 30 })]);
    expect(short.calls.find((c) => c.method === "tools/call")?.timeout).toBe(600_000);
    expect(short.calls.find((c) => c.method === "tools/list")?.timeout).toBe(60_000);
  });

  it("書いていなければ、これまでどおり（ツールの呼び出しは10分、一覧は60秒）", async () => {
    const fake = await run(() => [spec()]);
    expect(fake.calls.find((c) => c.method === "tools/call")?.timeout).toBe(600_000);
    expect(fake.calls.find((c) => c.method === "tools/list")?.timeout).toBe(60_000);
  });

  it("時間切れだけを変えても MCP サーバーを起動し直さず、新しい値を使う。ほかの設定が変われば起動し直す", async () => {
    let current = spec({ tool_timeout_sec: 900 });
    const fake = recordingConnector();
    host = new HostMcpServers({
      specs: () => [current],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    host.start();
    await until(() => fake.connects() === 1);
    current = spec({ tool_timeout_sec: 1_800, startup_timeout_sec: 90 });
    host.reconcile();
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const agent = await agentClient(port, gateway.register().token);
    await agent.callTool({ name: "x", arguments: {} });
    expect(fake.calls.at(-1)).toEqual({ method: "tools/call", timeout: 1_800_000 });
    expect(fake.connects()).toBe(1);
    expect(host.restarts("cloud")).toBe(0);
    await agent.close();
    current = spec({ tool_timeout_sec: 1_800, startup_timeout_sec: 90, args: ["--v2"] });
    host.reconcile();
    await until(() => fake.connects() === 2);
  });

  it("範囲の外の値・整数でない値は、設定の誤りにする", () => {
    for (const extra of [
      { startup_timeout_sec: 0 },
      { startup_timeout_sec: 3_601 },
      { tool_timeout_sec: 0 },
      { tool_timeout_sec: -1 },
      { tool_timeout_sec: 86_401 },
      { tool_timeout_sec: 1.5 },
      { tool_timeout_sec: "60" },
    ]) {
      expect(HostMcpFile.safeParse({ command: "x", ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
    expect(
      toHostMcp(
        "a",
        HostMcpFile.parse({ command: "x", startup_timeout_sec: 1, tool_timeout_sec: 86_400 }),
      ),
    ).toMatchObject({ startupTimeoutSec: 1, toolTimeoutSec: 86_400 });
    expect(toHostMcp("a", HostMcpFile.parse({ command: "x" }))).not.toHaveProperty(
      "toolTimeoutSec",
    );
  });
});

describe("実行の前に、ホストの MCP サーバーの準備を待つ（PBI-77）", () => {
  /** 起動（接続）を、release を呼ぶまで止める偽物。 */
  function gatedServers(options: { fail?: () => boolean } = {}) {
    const fake = fakeServers(options);
    let gates: (() => void)[] = [];
    let calls = 0;
    const connect: HostMcpConnector = async (s, env) => {
      calls += 1;
      await new Promise<void>((resolve) => gates.push(resolve));
      return fake.connect(s, env);
    };
    const release = () => {
      const pending = gates;
      gates = [];
      for (const g of pending) g();
    };
    return { ...fake, connect, release, calls: () => calls, waiting: () => gates.length };
  }

  it("設定に足した直後の実行でも、起動を待ってから使える（30秒ごとの突き合わせを待たない）", async () => {
    const fake = gatedServers();
    let specs: HostMcpSpec[] = [];
    host = new HostMcpServers({
      specs: () => specs,
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    host.start();
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const run = gateway.register();
    // 設定に足した。まだ突き合わせていないので、ゲートウェイは知らない
    specs = [spec()];
    const before = await fetch(`http://127.0.0.1:${port}/mcp/cloud`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${run.token}` },
      body: "{}",
    });
    expect(before.status).toBe(404);
    let settled = false;
    const waiting = host.ready(["cloud"]).then((problems) => {
      settled = true;
      return problems;
    });
    await until(() => fake.waiting() === 1);
    await new Promise((r) => setTimeout(r, 20));
    // 起動の途中は、待ったまま
    expect(settled).toBe(false);
    fake.release();
    expect(await waiting).toEqual([]);
    const agent = await agentClient(port, run.token);
    expect(text(await agent.callTool({ name: "whoami", arguments: {} }))).toBe("generation 1");
    await agent.close();
    run.close();
  });

  it("起動に失敗したら、どの MCP サーバーかと理由を返す。起動し直すのを待っているものは、待たずに理由を返す", async () => {
    const fake = fakeServers({ fail: () => true });
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
      retryMs: 60_000,
    });
    const [problem] = await host.ready(["cloud"]);
    expect(problem).toMatchObject({ code: "gateway.mcpUnavailable", params: { name: "cloud" } });
    expect(renderMessage(problem as never, "ja")).toContain("「cloud」");
    expect(renderMessage(problem as never, "ja")).toContain("Okta login did not complete");
    // 次の実行では起動し直さない（1分ごとに起動し直すのを待つ。ブラウザでの再認証を増やさない）
    const started = Date.now();
    expect(await host.ready(["cloud"])).toEqual([problem]);
    expect(Date.now() - started).toBeLessThan(500);
    expect(fake.envs).toHaveLength(1);
  });

  it("並行する実行は、同じ MCP サーバーの起動の待ちを共有する（起動は1度だけ）", async () => {
    const fake = gatedServers();
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    const first = host.ready(["cloud"]);
    const second = host.ready(["cloud"]);
    await until(() => fake.waiting() === 1);
    const third = host.ready(["cloud"]);
    fake.release();
    expect(await Promise.all([first, second, third])).toEqual([[], [], []]);
    expect(fake.calls()).toBe(1);
    // 準備ができた後は、待たずに使う
    expect(await host.ready(["cloud"])).toEqual([]);
    expect(fake.calls()).toBe(1);
  });

  it("準備を待つ上限を過ぎたら、どの MCP サーバーかを返して先に進む（起動はそのまま続け、終われば使える）", async () => {
    const fake = gatedServers();
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
      readyWaitMs: 50,
    });
    const started = Date.now();
    expect(await host.ready(["cloud"])).toEqual([
      { code: "gateway.mcpReadyTimeout", params: { name: "cloud", seconds: 0 } },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    fake.release();
    await until(() => fake.generation() === 1);
    expect(await host.ready(["cloud"])).toEqual([]);
    expect(fake.calls()).toBe(1);
  });

  it("上限の既定は ready_timeout_sec（秒）", async () => {
    const fake = gatedServers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      host = new HostMcpServers({
        specs: () => [spec({ ready_timeout_sec: 5 })],
        secrets: new MemorySecretStore({}),
        connect: fake.connect,
      });
      let settled = false;
      const waiting = host.ready(["cloud"]).then((p) => {
        settled = true;
        return p;
      });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await waiting).toEqual([
        { code: "gateway.mcpReadyTimeout", params: { name: "cloud", seconds: 5 } },
      ]);
    } finally {
      vi.useRealTimers();
      fake.release();
    }
  });

  it("時間切れの値だけの変更では起動し直さない（PBI-75）。消したものは止め、使えなくする", async () => {
    const fake = fakeServers();
    let specs = [spec({ tool_timeout_sec: 900 })];
    host = new HostMcpServers({
      specs: () => specs,
      secrets: new MemorySecretStore({}),
      connect: fake.connect,
    });
    expect(await host.ready(["cloud"])).toEqual([]);
    specs = [spec({ tool_timeout_sec: 1800, startup_timeout_sec: 120 })];
    expect(await host.ready(["cloud"])).toEqual([]);
    expect(fake.envs).toHaveLength(1);
    expect(host.restarts("cloud")).toBe(0);
    // 設定から消した
    specs = [];
    const [gone] = await host.ready(["cloud"]);
    expect(gone).toMatchObject({ code: "gateway.mcpUnavailable", params: { name: "cloud" } });
    expect(host.servers()).toEqual([]);
  });

  it("再認証のために起動し直している（期限切れの接続は使わない）間は、起動し直した後の準備まで待つ", async () => {
    let expiredGeneration = 1;
    const fake = fakeServers({ expired: (g) => g <= expiredGeneration });
    let gate: (() => void) | undefined;
    let calls = 0;
    const connect: HostMcpConnector = async (s, env) => {
      calls += 1;
      if (calls > 1) await new Promise<void>((resolve) => (gate = resolve));
      return fake.connect(s, env);
    };
    host = new HostMcpServers({
      specs: () => [spec()],
      secrets: new MemorySecretStore({}),
      connect,
    });
    host.start();
    await until(() => fake.generation() === 1);
    gateway = new AiGateway({ hostMcp: host });
    const port = await gateway.listen();
    const run = gateway.register();
    const agent = await agentClient(port, run.token);
    // 認証エラーで、起動し直し始める
    await agent.callTool({ name: "whoami", arguments: {} });
    await agent.close();
    await until(() => gate !== undefined);
    expiredGeneration = 0;
    let settled = false;
    const waiting = host.ready(["cloud"]).then((p) => {
      settled = true;
      return p;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    gate?.();
    expect(await waiting).toEqual([]);
    run.close();
  });
});
