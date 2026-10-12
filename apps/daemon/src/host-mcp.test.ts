import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it } from "vitest";
import { AiGateway } from "./gateway.js";
import {
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
  options: { fail?: () => boolean; expired?: (generation: number) => boolean } = {},
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
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]);
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
});
