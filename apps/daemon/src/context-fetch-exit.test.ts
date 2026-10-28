import { type ChildProcess, spawn } from "node:child_process";
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
import { GitContextFetcher } from "./context.js";
import { stopFetchProcessesSync } from "./fetch-processes.js";

/** デーモンの代わりの子のプロセスが読む（素の Node が型を取り除いて読む。node: のほかは import しない）。 */
const FETCH_PROCESSES = fileURLToPath(new URL("./fetch-processes.ts", import.meta.url));

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
  const pidFile = () => join(work, "pids");
  const pids = () =>
    existsSync(pidFile()) ? readFileSync(pidFile(), "utf8").trim().split("\n").map(Number) : [];
  /** 応答しない git（子プロセスも作る）。起動した git と子プロセスの PID を pids に書く。 */
  const hangingGit = () => {
    work = mkdtempSync(join(tmpdir(), "sacty-fetch-exit-"));
    const bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho $$ >> "${pidFile()}"\nsleep 300 &\necho $! >> "${pidFile()}"\nwait\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    return bin;
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

  it("止められる取得の git は、終わるときの後片付け（stopFetchProcessesSync）で、子プロセスごと止まる", async () => {
    const bin = hangingGit();
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const fetching = new GitContextFetcher()
        .fetch(
          { repo: "https://git.example.com/ctx.git" },
          join(work, "repo"),
          undefined,
          new AbortController().signal,
        )
        .then(
          () => "ok",
          () => "failed",
        );
      await vi.waitFor(() => expect(pids()).toHaveLength(2), { timeout: 5_000, interval: 50 });
      expect(pids().every(alive)).toBe(true);
      expect(process.listeners("exit")).toContain(stopFetchProcessesSync);
      stopFetchProcessesSync();
      expect(await fetching).toBe("failed");
      await vi.waitFor(() => expect(pids().filter(alive)).toEqual([]), {
        timeout: 3_000,
        interval: 50,
      });
    } finally {
      process.env.PATH = path;
    }
  }, 15_000);

  /**
   * デーモンの代わり（素の .mjs）。止められる取得の git を起動し、how が signal なら main.ts と同じく SIGTERM で
   * process.exit し、exit なら自分で終わり、throw なら捕まえない例外で終わる。
   */
  const startDaemon = (how: "signal" | "exit" | "throw") => {
    const bin = hangingGit();
    const script = join(work, "daemon.mjs");
    writeFileSync(
      script,
      `import { existsSync, readFileSync } from "node:fs";
import { spawnStoppable } from ${JSON.stringify(FETCH_PROCESSES)};
spawnStoppable("git", ["clone", "--", "https://git.example.com/ctx.git", "repo"], { stdio: "ignore" })
  .child.on("error", () => {});
process.on("SIGTERM", () => process.exit(0));
const ready = () =>
  existsSync(${JSON.stringify(pidFile())}) &&
  readFileSync(${JSON.stringify(pidFile())}, "utf8").trim().split("\\n").length >= 2;
const timer = setInterval(() => {
  if (!ready()) return;
  clearInterval(timer);
  console.log("ready");
  if (${JSON.stringify(how)} === "exit") process.exit(0);
  if (${JSON.stringify(how)} === "throw") throw new Error("落ちた");
}, 20);
`,
    );
    // 型の取り除きが既定で切れている版（Node 22.17 以前。engines は 26.12.1 以上だが、それより古い Node でも動かせる）では、フラグで有効にする
    const strip = (process.features as { typescript?: unknown }).typescript
      ? []
      : ["--experimental-strip-types"];
    const child = spawn(process.execPath, ["--no-warnings", ...strip, script], {
      cwd: work,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.on("exit", () => resolve());
    });
    return { child, exited };
  };
  /** デーモンの代わりを、待ちに失敗したときも止めて回収する。 */
  const reap = async (daemon: { child: ChildProcess; exited: Promise<void> }) => {
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
      daemon.child.kill("SIGKILL");
    }
    await daemon.exited;
  };

  for (const how of ["signal", "exit", "throw"] as const) {
    it(`デーモンが終わったら（${how}）、git のプロセスグループが残らない`, async () => {
      const daemon = startDaemon(how);
      try {
        await vi.waitFor(() => expect(pids()).toHaveLength(2), { timeout: 5_000, interval: 50 });
        if (how === "signal") {
          // 止める前は、取得の git も、その子プロセスも動いている
          expect(pids().every(alive)).toBe(true);
          daemon.child.kill("SIGTERM");
        }
        await daemon.exited;
        await vi.waitFor(() => expect(pids().filter(alive)).toEqual([]), {
          timeout: 3_000,
          interval: 50,
        });
      } finally {
        await reap(daemon);
      }
    }, 15_000);
  }
});
