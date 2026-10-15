import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/** TypeScript のまま子のプロセスで動かす（デーモンの代わり）。 */
const JITI = fileURLToPath(new URL("../../../node_modules/jiti/lib/jiti-cli.mjs", import.meta.url));
const CONTEXT = fileURLToPath(new URL("./context.ts", import.meta.url));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("デーモンが終わるときに、取得中の git を止める（PR #117 レビュー指摘）", () => {
  let work = "";
  const pids = () => {
    const file = join(work, "pids");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(Number) : [];
  };
  afterEach(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 止まっている
      }
    }
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * 応答しない git（子プロセスも作る）で、止められる取得を始めたデーモンの代わりを動かす。how が signal なら、main.ts と
   * 同じく SIGTERM で process.exit し、exit なら自分で終わり、throw なら捕まえない例外で終わる。
   */
  const startDaemon = (how: "signal" | "exit" | "throw") => {
    work = mkdtempSync(join(tmpdir(), "sacty-fetch-exit-"));
    const bin = join(work, "bin");
    mkdirSync(bin);
    const pidFile = join(work, "pids");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho $$ >> "${pidFile}"\nsleep 300 &\necho $! >> "${pidFile}"\nwait\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const script = join(work, "daemon.ts");
    writeFileSync(
      script,
      `import { existsSync, readFileSync } from "node:fs";
import { GitContextFetcher } from ${JSON.stringify(CONTEXT)};
const stop = new AbortController();
new GitContextFetcher()
  .fetch({ repo: "https://git.example.com/ctx.git" }, ${JSON.stringify(join(work, "repo"))}, undefined, stop.signal)
  .catch(() => {});
process.on("SIGTERM", () => process.exit(0));
const ready = () =>
  existsSync(${JSON.stringify(pidFile)}) &&
  readFileSync(${JSON.stringify(pidFile)}, "utf8").trim().split("\\n").length >= 2;
const timer = setInterval(() => {
  if (!ready()) return;
  clearInterval(timer);
  console.log("ready");
  if (${JSON.stringify(how)} === "exit") process.exit(0);
  if (${JSON.stringify(how)} === "throw") throw new Error("落ちた");
}, 50);
`,
    );
    const child = spawn(process.execPath, [JITI, script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return { child, exited };
  };

  for (const how of ["signal", "exit", "throw"] as const) {
    it(`デーモンが終わったら（${how}）、git のプロセスグループが残らない`, async () => {
      const { child, exited } = startDaemon(how);
      await vi.waitFor(() => expect(pids()).toHaveLength(2), { timeout: 15_000, interval: 100 });
      if (how === "signal") {
        // 止める前は、取得の git も、その子プロセスも動いている
        expect(pids().every(alive)).toBe(true);
        child.kill("SIGTERM");
      }
      await exited;
      await vi.waitFor(() => expect(pids().filter(alive)).toEqual([]), {
        timeout: 3_000,
        interval: 100,
      });
    }, 30_000);
  }
});
