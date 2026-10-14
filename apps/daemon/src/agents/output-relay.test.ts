import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORWARD_NOTICE_PREFIX, withLocalForwards } from "./forward.js";
import {
  OUTPUT_RELAY_SCRIPT,
  RELAY_DISCARD_BYTES,
  RELAY_NOTICE_PREFIX,
  withOutputRelay,
} from "./output-relay.js";

type Result = { code: number | null; stdout: Buffer; stderr: Buffer };

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sacty-relay-test-"));
  dirs.push(dir);
  return dir;
}

/**
 * コマンドを動かし、終了コード・標準出力・標準エラー出力を返す。pauseMs のあいだは読まない（読み手が遅い状態）。
 * onStart で、動いている子プロセスを受け取れる（シグナルを送るなど）。
 */
function run(
  command: string[],
  options: {
    env?: Record<string, string | undefined>;
    pauseMs?: number;
    onStart?: (child: ChildProcess, stdout: () => string) => void;
  } = {},
): Promise<Result> {
  return new Promise((resolve) => {
    const [file = "", ...args] = command;
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    if (options.pauseMs) {
      child.stdout.pause();
      child.stderr.pause();
      setTimeout(() => {
        child.stdout.resume();
        child.stderr.resume();
      }, options.pauseMs);
    }
    options.onStart?.(child, () => Buffer.concat(out).toString());
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );
  });
}

/** 中継の下でコマンドを動かす。 */
const relay = (command: string[], options?: Parameters<typeof run>[1]) =>
  run([process.execPath, "-e", OUTPUT_RELAY_SCRIPT, "--", ...command], options);

const node = (script: string) => [process.execPath, "-e", script];

/**
 * 決まった中身の大きな出力（0〜250 のバイトの繰り返し。改行を含む・UTF-8 として正しくないバイトも含む）。
 * 251 バイトの並びを Buffer.alloc で繰り返して埋める（数千万の要素の配列を作ると、それだけで負荷が高いと数秒かかる）。
 */
const patternSource = (size: number) =>
  `Buffer.alloc(${size}, Buffer.from(Array.from({ length: 251 }, (_, i) => i)))`;
const pattern = (size: number): Buffer =>
  Buffer.alloc(size, Buffer.from(Array.from({ length: 251 }, (_, i) => i)));

/**
 * 大きな出力を1回の write で書き、書けたバイト数か、失敗の理由（EAGAIN など）を標準エラー出力に出すコマンド。
 * 標準出力が通常のファイルかどうかも出す。
 */
const bigWrite = (size: number) =>
  node(`const fs = require("fs");
const data = ${patternSource(size)};
const kind = fs.fstatSync(1).isFile() ? "file" : "other";
try { process.stderr.write(kind + " wrote " + fs.writeSync(1, data) + "\\n"); }
catch (e) { process.stderr.write(kind + " " + e.code + "\\n"); process.exit(3); }`);

/**
 * 同じ標準出力を受け継いだ Node.js のプロセスが、その開いたファイルの記述に O_NONBLOCK を付けて動き続けている
 * あいだに、コマンドを動かす（組織の環境で起きた状態の再現）。コマンドと同じ終了コードで終わる。
 * Node.js の spawn は子の標準入出力をブロッキングに戻すので、シェルから動かす。
 */
const nonBlocking = (command: string[]) => [
  "sh",
  "-c",
  `ready="$(mktemp -u)"
READY="$ready" "$0" -e 'process.stdout._handle.setBlocking(false); require("fs").writeFileSync(process.env.READY, ""); setTimeout(() => {}, 30000)' &
bg=$!
while [ ! -e "$ready" ]; do sleep 0.02; done
"$@"
code=$?
{ kill $bg; wait $bg; } 2>/dev/null
rm -f "$ready"
exit $code`,
  process.execPath,
  ...command,
];

describe("出力の中継（PBI-64）", () => {
  it("標準出力と標準エラー出力を、別のまま、順番と中身を変えずに流し、同じ終了コードで終わる", async () => {
    const result = await relay([
      "sh",
      "-c",
      "printf a; printf e1 >&2; printf 'b\\n'; printf 'e2\\n' >&2; printf 'c'; exit 7",
    ]);
    expect(result.code).toBe(7);
    expect(result.stdout.toString()).toBe("ab\nc");
    expect(result.stderr.toString()).toBe("e1e2\n");
  });

  it("出力が空でも終わる（終了コード 0）", async () => {
    const result = await relay(["sh", "-c", "exit 0"]);
    expect(result).toEqual({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  });

  it("複数バイトの文字・改行の無い出力も、そのまま流す", async () => {
    const text = "日本語🍣".repeat(10_000);
    const result = await relay(node(`process.stdout.write(${JSON.stringify(text)})`));
    expect(result.stdout.toString()).toBe(text);
    expect(result.code).toBe(0);
  });

  it("コマンドの標準出力は通常のファイルになり、読み手が遅くても、巨大な1行（20MB）を1回の write で書ききる", async () => {
    const size = 20 * 1024 * 1024;
    const result = await relay(bigWrite(size), { pauseMs: 500 });
    expect(result.stderr.toString()).toBe(`file wrote ${size}\n`);
    expect(result.code).toBe(0);
    expect(result.stdout.equals(pattern(size))).toBe(true);
  });

  it("標準出力が非ブロッキングにされ、読み手が遅くても、中継は EAGAIN で落ちずに全部流す（直す前の形では書けない）", async () => {
    const size = 8 * 1024 * 1024;
    // 直す前の形：コマンドが、非ブロッキングにされた標準出力（パイプ）に直接書く。全部は書けない
    const before = await run(nonBlocking(bigWrite(size)), { pauseMs: 500 });
    expect(before.stderr.toString()).toMatch(/^other (EAGAIN|wrote \d+)\n$/);
    expect(before.stderr.toString()).not.toBe(`other wrote ${size}\n`);
    expect(before.stdout.length).toBeLessThan(size);
    // 中継あり：同じ状態でも、コマンドは書ききり、中継は待って書き直す
    const after = await run(
      nonBlocking([process.execPath, "-e", OUTPUT_RELAY_SCRIPT, "--", ...bigWrite(size)]),
      { pauseMs: 500 },
    );
    expect(after.stderr.toString()).toBe(`file wrote ${size}\n`);
    expect(after.code).toBe(0);
    expect(after.stdout.equals(pattern(size))).toBe(true);
  });

  it('コマンドが /dev/stdout を ">" で開き直して切り詰めても、その後の出力を流し続ける', async () => {
    const result = await relay([
      "sh",
      "-c",
      "printf aaaa; sleep 0.2; printf b > /dev/stdout; sleep 0.2; printf c; printf d >> /dev/stdout",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("aaaabcd");
    // Linux では切り詰められるので知らせる（macOS の /dev/stdout は開き直さずに複製するので、切り詰められない）
    expect(result.stderr.toString()).toMatch(
      new RegExp(
        `^(|${RELAY_NOTICE_PREFIX.replace(/[[\]]/g, "\\$&")}標準出力が開き直されて.*\\n)$`,
      ),
    );
  });

  it("コマンドがシグナルで終わったら、128 + 番号で終わる", async () => {
    const result = await relay(["sh", "-c", "kill -TERM $$"]);
    expect(result.code).toBe(143);
  });

  it("止めるシグナルはコマンドに伝え、コマンドが最後に書いたものまで流してから終わる", async () => {
    const result = await relay(
      node(`process.on("SIGTERM", () => { process.stdout.write("stopped"); process.exit(5); });
process.stdout.write("ready;");
setInterval(() => {}, 1000);`),
      {
        onStart: (child, stdout) => {
          const wait = setInterval(() => {
            if (!stdout().includes("ready;")) return;
            clearInterval(wait);
            child.kill("SIGTERM");
          }, 10);
        },
      },
    );
    expect(result.stdout.toString()).toBe("ready;stopped");
    expect(result.code).toBe(5);
  });

  it("コマンドが終わったら、後ろで書き続けるプロセスがあっても待ち続けず、終わった時点までを流して終わる", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "bg");
    const exiting = join(dir, "exiting");
    try {
      // 読み手が遅く、中継がまだ流しきれていないうちに、コマンドが終わる。後ろのプロセスは、コマンドが終わってから
      // 書き始め、止められるまで書き続ける（中継が後ろのプロセスを待つなら、このテストは終わらずに時間切れで落ちる）。
      // 書き始めを、コマンドを始めてからの固定の sleep にすると、負荷が高いときはコマンドの出力（1MB）を書き終える前に
      // 書き始めて混ざるので、コマンドが終わる合図を待つ。その後の 1 秒は、中継がコマンドの終わりに気づく
      // （終了のイベントを受け取る）までの猶予。読み手はそれより長く（2 秒）止めておくので、中継が追いつくまで流し続ける
      // 不具合なら、猶予の後に書いた分が混ざって落ちる
      const size = 1024 * 1024;
      const result = await relay(
        [
          "sh",
          "-c",
          `(while [ ! -e ${exiting} ]; do sleep 0.01; done; sleep 1; while :; do echo late >&2; sleep 0.01; done) & echo $! > ${pidFile}
head -c ${size} /dev/zero | tr '\\0' x >&2; printf end; : > ${exiting}; exit 3`,
        ],
        { pauseMs: 2_000 },
      );
      expect(result.code).toBe(3);
      expect(result.stdout.toString()).toBe("end");
      expect(result.stderr.toString()).toBe("x".repeat(size));
      // 中継が終わったとき、後ろのプロセスはまだ書き続けている（待たずに終わった）
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow();
    } finally {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    }
  });

  it("コマンドが見つからなければ、理由を標準エラー出力に出して 127 で終わる", async () => {
    const result = await relay(["sacty-no-such-command", "x"]);
    expect(result.code).toBe(127);
    expect(result.stderr.toString()).toContain("sacty-no-such-command");
    expect(result.stderr.toString()).toContain("ENOENT");
    expect(result.stdout.length).toBe(0);
  });

  it("一時的なファイルは、終わったら消える。作れなければ、これまでどおりそのまま渡して動かす", async () => {
    const dir = tempDir();
    const ok = await relay(["sh", "-c", "printf out; printf err >&2; exit 4"], {
      env: { TMPDIR: dir },
    });
    expect([ok.code, ok.stdout.toString(), ok.stderr.toString()]).toEqual([4, "out", "err"]);
    expect(readdirSync(dir)).toEqual([]);
    const missing = join(dir, "missing");
    const fallback = await relay(["sh", "-c", "printf out; printf err >&2; exit 4"], {
      env: { TMPDIR: missing },
    });
    expect([fallback.code, fallback.stdout.toString(), fallback.stderr.toString()]).toEqual([
      4,
      "out",
      "err",
    ]);
    expect(existsSync(missing)).toBe(false);
  });

  // 2回に分けて大きな出力（約25MB）を流して確かめるので、ほかのテストと並ぶと既定の5秒を超えることがある
  it("流した分は、穴を開けて捨てる（fallocate）。捨てられなくても、出力は変えない", {
    timeout: 30_000,
  }, async () => {
    const dir = tempDir();
    const log = join(dir, "calls");
    const size = 3 * RELAY_DISCARD_BYTES + 12345;
    // 呼ばれた引数を残すだけの fallocate
    writeFileSync(join(dir, "fallocate"), `#!/bin/sh\necho "$@" >> ${log}\nexit $FAKE_EXIT\n`);
    chmodSync(join(dir, "fallocate"), 0o755);
    const env = { PATH: `${dir}:${process.env.PATH}` };
    const ok = await relay(bigWrite(size), { env: { ...env, FAKE_EXIT: "0" } });
    expect(ok.stdout.equals(pattern(size))).toBe(true);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    // 流した範囲を、すき間も重なりも無く、先頭から順に捨てる
    let next = 0;
    for (const call of calls) {
      const [, , offset, , length, file] = call.split(" ");
      expect(call.startsWith("--punch-hole --offset")).toBe(true);
      expect(Number(offset)).toBe(next);
      expect(Number(length)).toBeGreaterThanOrEqual(RELAY_DISCARD_BYTES);
      expect(file).toMatch(/sacty-output-.*\/1$/);
      next += Number(length);
    }
    expect(calls).toHaveLength(3);
    expect(next).toBeLessThanOrEqual(size);
    // 失敗したら、以後は捨てない（出力は変えない）
    rmSync(log);
    const failed = await relay(bigWrite(size), { env: { ...env, FAKE_EXIT: "1" } });
    expect(failed.stdout.equals(pattern(size))).toBe(true);
    expect(failed.code).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("中継がコンテナの標準出力に書けなくなったら、コマンドを止めて、失敗で終わる", async () => {
    let pid = 0;
    const result = await relay(
      node(`process.stderr.write(process.pid + "\\n");
setInterval(() => process.stdout.write("x".repeat(1024)), 1);`),
      {
        onStart: (child) => {
          child.stderr?.once("data", (chunk: Buffer) => {
            pid = Number.parseInt(chunk.toString(), 10);
            child.stdout?.destroy();
          });
        },
      },
    );
    expect(result.code).toBe(1);
    expect(pid).toBeGreaterThan(0);
    // 中継は SIGKILL を送ってすぐ終わる。コマンドが消える（親を失って引き取られる）のは、負荷が高いと少し遅れるので、
    // 消えるまで待つ（止めていなければ、コマンドは書き続けるので消えずに落ちる）
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
      timeout: 3_000,
      interval: 20,
    });
  });

  it("localhost の転送（PBI-60）と組み合わせても、転送・出力・終了コードが変わらない", async () => {
    const service = createServer((socket) => {
      socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
      socket.on("error", () => {});
    });
    servers.push(service);
    await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
    const port = (service.address() as { port: number }).port;
    // すでに使われているポート（転送しない知らせが出る）と、空いているポート
    const busy = port;
    const free = await new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
    const command = withOutputRelay(
      withLocalForwards(
        node(`const s = require("net").connect(${free}, "127.0.0.1", () => s.write("ping"));
s.on("data", (d) => { process.stdout.write(String(d)); s.destroy(); process.exitCode = 6; });`),
        [
          { port: free, host: "127.0.0.1", target: port },
          { port: busy, host: "127.0.0.1" },
        ],
      ),
    ).map((part, i) => (i === 0 || part === "node" ? process.execPath : part));
    const result = await run(command);
    expect(result.stdout.toString()).toBe("echo:ping");
    expect(result.code).toBe(6);
    expect(result.stderr.toString()).toContain(`${FORWARD_NOTICE_PREFIX}127.0.0.1:${busy}`);
  });
});
