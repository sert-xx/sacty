import { spawn } from "node:child_process";
import { createServer, type Server, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORWARD_NOTICE_PREFIX,
  FORWARD_SCRIPT,
  forwardNotices,
  withLocalForwards,
} from "./forward.js";

/** 転送を起動してコマンドを動かし、終了コード・標準出力・標準エラー出力を返す。 */
function runForwarder(
  forwards: [number, string, number][],
  command: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["-e", FORWARD_SCRIPT, "--", JSON.stringify(forwards), ...command],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/** 127.0.0.1 で待ち受けるサーバー（サービスの代わり）。受け取ったものに印を付けて返す。 */
async function echoServer(): Promise<number> {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

/** 空いているポート。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise((done) => server.close(done));
  return port;
}

/** host:port に接続して ping を送り、返ってきたものを標準出力に出すコマンド（コンテナの中のテストの代わり）。 */
const client = (host: string, port: number) => [
  process.execPath,
  "-e",
  `const s = require("net").connect(${port}, ${JSON.stringify(host)}, () => s.write("ping"));
   s.on("data", (d) => { process.stdout.write(String(d)); s.destroy(); });
   s.on("error", (e) => { process.stderr.write(e.code + "\\n"); process.exit(9); });`,
];

describe("localhost の転送（PBI-60）", () => {
  it("127.0.0.1 のポートへの接続を、転送先のサービスにつなぐ（実際の TCP）", async () => {
    const service = await echoServer();
    const listen = await freePort();
    const result = await runForwarder(
      [[listen, "127.0.0.1", service]],
      client("127.0.0.1", listen),
    );
    expect(result).toEqual({ code: 0, stdout: "echo:ping", stderr: "" });
  });

  it("localhost と書いても届く", async () => {
    const service = await echoServer();
    const listen = await freePort();
    const result = await runForwarder(
      [[listen, "127.0.0.1", service]],
      client("localhost", listen),
    );
    expect(result.stdout).toBe("echo:ping");
    expect(result.code).toBe(0);
  });

  it("複数のポートを、それぞれのサービスにつなぐ", async () => {
    const [a, b] = [await echoServer(), await echoServer()];
    const [la, lb] = [await freePort(), await freePort()];
    const result = await runForwarder(
      [
        [la, "127.0.0.1", a],
        [lb, "127.0.0.1", b],
      ],
      [
        "sh",
        "-c",
        `${client("127.0.0.1", la).map(q).join(" ")} && ${client("127.0.0.1", lb).map(q).join(" ")}`,
      ],
    );
    expect(result.stdout).toBe("echo:pingecho:ping");
    expect(result.code).toBe(0);
  });

  it("コマンドの終了コード・標準出力・標準エラー出力を変えない", async () => {
    const listen = await freePort();
    const result = await runForwarder(
      [[listen, "127.0.0.1", 1]],
      ["sh", "-c", 'printf \'{"result":"x"}\'; printf err >&2; exit 7'],
    );
    expect(result).toEqual({ code: 7, stdout: '{"result":"x"}', stderr: "err" });
  });

  it("コマンドがシグナルで終わったら、シェルと同じ終了コード（128 + 番号）で終わる", async () => {
    const listen = await freePort();
    const result = await runForwarder([[listen, "127.0.0.1", 1]], ["sh", "-c", "kill -TERM $$"]);
    expect(result.code).toBe(143);
  });

  it("コマンドが見つからなければ、127 で終わる", async () => {
    const listen = await freePort();
    const result = await runForwarder([[listen, "127.0.0.1", 1]], ["sacty-no-such-command"]);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("sacty-no-such-command");
  });

  it("すでに使われているポートは転送せず、理由を標準エラー出力に出して、コマンドはそのまま動かす", async () => {
    const service = await echoServer();
    // そのポートで、ほかのもの（テストするアプリ自身など）が待ち受けている
    const busy = createServer((socket) => socket.end("busy"));
    servers.push(busy);
    await new Promise<void>((done) => busy.listen(0, "127.0.0.1", done));
    const used = (busy.address() as { port: number }).port;
    const free = await freePort();
    const result = await runForwarder(
      [
        [used, "db", service],
        [free, "127.0.0.1", service],
      ],
      ["sh", "-c", `${client("127.0.0.1", free).map(q).join(" ")}; exit 4`],
    );
    // 使われていないほうのポートは転送する。コマンドの終了コードは変えない
    expect(result.stdout).toBe("echo:ping");
    expect(result.code).toBe(4);
    expect(forwardNotices(result.stderr)).toEqual([
      `${FORWARD_NOTICE_PREFIX}127.0.0.1:${used} を db:${service} に転送しません（すでに使われています）。db:${service} で接続してください`,
    ]);
  });

  it("コマンドが終わったら、転送も止まる", async () => {
    const service = await echoServer();
    const listen = await freePort();
    await runForwarder([[listen, "127.0.0.1", service]], ["true"]);
    const refused = await new Promise<string>((done) => {
      const s = new Socket();
      s.on("error", (e: NodeJS.ErrnoException) => done(e.code ?? ""));
      s.connect(listen, "127.0.0.1", () => {
        s.destroy();
        done("connected");
      });
    });
    expect(refused).toBe("ECONNREFUSED");
  });

  it("転送先に届かなければ、その接続だけを閉じる（コマンドは続く）", async () => {
    const listen = await freePort();
    const closed = await freePort();
    const result = await runForwarder(
      [[listen, "127.0.0.1", closed]],
      [
        process.execPath,
        "-e",
        `const s = require("net").connect(${listen}, "127.0.0.1");
         s.on("close", () => { process.stdout.write("closed"); process.exit(0); });
         s.on("error", () => {});`,
      ],
    );
    expect(result).toEqual({ code: 0, stdout: "closed", stderr: "" });
  });
});

describe("コマンドの組み立て（PBI-60）", () => {
  it("転送先のポートが違えば（ホストに出すポート）、そのポートにつなぐ", () => {
    expect(withLocalForwards(["sh"], [{ port: 15432, host: "db", target: 5432 }]).slice(4)).toEqual(
      ['[[15432,"db",5432]]', "sh"],
    );
  });

  it("転送するものが無ければ、コマンドはそのまま", () => {
    const command = ["sh", "-c", "npm test"];
    expect(withLocalForwards(command, [])).toBe(command);
  });

  it("転送を起動してから、元のコマンドを動かす（同じポートでサービスにつなぐ）", () => {
    expect(
      withLocalForwards(
        ["claude", "-p", "--x"],
        [
          { port: 5432, host: "db" },
          { port: 6379, host: "cache" },
        ],
      ),
    ).toEqual([
      "node",
      "-e",
      FORWARD_SCRIPT,
      "--",
      '[[5432,"db",5432],[6379,"cache",6379]]',
      "claude",
      "-p",
      "--x",
    ]);
  });
});

/** sh の引数として囲む。 */
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
