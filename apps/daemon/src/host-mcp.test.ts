import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it } from "vitest";
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
