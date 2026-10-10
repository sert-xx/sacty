#!/usr/bin/env node
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);

const USAGE = `Usage: sacty up [--port <web port>] [--daemon-port <daemon port>]

  up    デーモンと画面（Next.js）を起動します。Ctrl+C で両方を終了します。`;

async function waitForDaemon(url: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`);
}

async function up(webPort: number, daemonPort: number) {
  const token = randomBytes(32).toString("hex");
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const children: ChildProcess[] = [];
  let stopping = false;

  const running = () => children.filter((c) => c.exitCode === null && c.signalCode === null);

  /** 子プロセスをすべて止め、止まったのを確かめてから終了コードを返して終わる。 */
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    const alive = running();
    if (alive.length === 0) process.exit(code);
    for (const child of alive) {
      child.once("exit", () => {
        if (running().length === 0) process.exit(code);
      });
      child.kill("SIGTERM");
    }
    // 子が応答しない場合の保険。unref しない（先にイベントループが終わると終了コードが失われるため）。
    setTimeout(() => {
      for (const child of running()) child.kill("SIGKILL");
      process.exit(code);
    }, 5_000);
  };

  const watch = (name: string, child: ChildProcess) => {
    children.push(child);
    child.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(
          `[sacty] ${name} exited unexpectedly (${signal ?? `code ${code}`}). Stopping.`,
        );
        // 想定外の終了は、子の終了コードが0でも失敗として伝える
        stop(code && code !== 0 ? code : 1);
      }
    });
  };

  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  const daemonMain = require.resolve("@sacty/daemon");
  watch(
    "daemon",
    spawn(process.execPath, ["--disable-warning=ExperimentalWarning", daemonMain], {
      stdio: "inherit",
      env: {
        ...process.env,
        SACTY_DAEMON_PORT: String(daemonPort),
        SACTY_DAEMON_TOKEN: token,
      },
    }),
  );

  try {
    await waitForDaemon(daemonUrl, token, 15_000);
  } catch (error) {
    console.error("[sacty]", error instanceof Error ? error.message : error);
    stop(1);
    return;
  }
  if (stopping) return;

  const webDir = dirname(require.resolve("@sacty/web/package.json"));
  const nextBin = require.resolve("next/dist/bin/next", { paths: [webDir] });
  watch(
    "web",
    spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(webPort)], {
      cwd: webDir,
      stdio: "inherit",
      env: {
        ...process.env,
        SACTY_DAEMON_URL: daemonUrl,
        SACTY_DAEMON_TOKEN: token,
      },
    }),
  );

  console.log(`\n[sacty] Open http://127.0.0.1:${webPort} in your browser.\n`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4700" },
      "daemon-port": { type: "string", default: "4710" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals[0] !== "up") {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const webPort = parsePort("--port", values.port);
  const daemonPort = parsePort("--daemon-port", values["daemon-port"]);
  if (webPort === daemonPort) {
    throw new Error("--port and --daemon-port must be different");
  }
  await up(webPort, daemonPort);
}

function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535 (got "${raw}")`);
  }
  return port;
}

main().catch((error: unknown) => {
  console.error("[sacty]", error instanceof Error ? error.message : error);
  process.exit(1);
});
