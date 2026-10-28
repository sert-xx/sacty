import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostMcpFile, HostMcpServers, toHostMcp } from "./host-mcp.js";
import {
  collectTargets,
  GroupStdioTransport,
  HostMcpProcesses,
  type ProcessInfo,
  parseProcessTable,
  psTable,
} from "./host-mcp-processes.js";
import { MemorySecretStore } from "./secrets.js";
import { killSpawned } from "./testing/processes.js";
import { processSource, type WaitSource, waitFor } from "./testing/wait.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-host-mcp-processes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = (
  pid: number,
  started: string,
  members: { pid: number; started: string }[] = [],
  owner?: { pid: number; started: string },
) =>
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ name: "cloud", pid, started, members, ...(owner ? { owner } : {}) }),
  );

const T1 = "Wed Oct 14 01:00:00 2026";
const T2 = "Wed Oct 14 02:00:00 2026";

/** 偽のプロセスの一覧。SIGKILL は必ず、SIGTERM は stubborn でなければ、そのプロセスを終わらせる。 */
function fakeTable(rows: ProcessInfo[], stubborn: number[] = []) {
  const table = [...rows];
  const signals: [number, NodeJS.Signals][] = [];
  return {
    signals,
    killed: () => [...new Set(signals.map(([pid]) => pid))].sort((a, b) => a - b),
    deps: {
      table: async () => [...table],
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push([pid, signal]);
        const i = table.findIndex((p) => p.pid === pid);
        if (i < 0) throw new Error("ESRCH");
        if (signal === "SIGKILL" || !stubborn.includes(pid)) table.splice(i, 1);
      },
      graceMs: 200,
    },
  };
}

describe("ps の一覧の読み取り（PBI-78）", () => {
  it("PID・親・グループ・開始時刻を読む", () => {
    expect(
      parseProcessTable(
        "  144     1   142 Wed Oct 14 15:39:01 2026    \n\n  7 1 7 Thu Sep  3 01:02:03 2026\n",
      ),
    ).toEqual([
      { pid: 144, ppid: 1, pgid: 142, started: "Wed Oct 14 15:39:01 2026" },
      { pid: 7, ppid: 1, pgid: 7, started: "Thu Sep  3 01:02:03 2026" },
    ]);
  });

  it("PID と開始時刻が一致するもの・グループ・子孫を集め、デーモン自身とその親は含めない", () => {
    const table: ProcessInfo[] = [
      { pid: 100, ppid: 1, pgid: 100, started: T1 },
      { pid: 101, ppid: 100, pgid: 100, started: T1 },
      { pid: 102, ppid: 101, pgid: 102, started: T1 }, // 自分のグループに移った孫（親をたどって見つける）
      { pid: 103, ppid: 1, pgid: 100, started: T1 }, // 親が終わって付け替えられた（グループで見つける）
      { pid: 200, ppid: 1, pgid: 200, started: T2 },
      { pid: process.pid, ppid: 100, pgid: 999, started: T1 },
      { pid: process.ppid, ppid: 1, pgid: 999, started: T1 },
      { pid: 998, ppid: 1, pgid: 999, started: T1 }, // デーモン自身のグループ
    ];
    expect(
      collectTargets(table, [{ pid: 100, started: T1 }], [100])
        .map((p) => p.pid)
        .sort(),
    ).toEqual([100, 101, 102, 103]);
    // デーモン自身のグループは、グループとしては集めない
    expect(collectTargets(table, [], [999])).toEqual([]);
    // 開始時刻が違えば（PID が再利用された）、集めない
    expect(collectTargets(table, [{ pid: 200, started: T1 }])).toEqual([]);
  });
});

describe("前回の残りの片付け（PBI-78。偽の一覧）", () => {
  it("記録どおりに動いているリーダーは、グループと子孫ごと止め、ほかのプロセスと記録は残さない", async () => {
    record(100, T1);
    const fake = fakeTable([
      { pid: 100, ppid: 1, pgid: 100, started: T1 },
      { pid: 101, ppid: 100, pgid: 100, started: T1 },
      { pid: 102, ppid: 101, pgid: 102, started: T1 },
      { pid: 300, ppid: 1, pgid: 300, started: T1 }, // ほかのプロセス
    ]);
    expect(await new HostMcpProcesses(dir, fake.deps).cleanup()).toBe(3);
    expect(fake.killed()).toEqual([100, 101, 102]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("PID が再利用されていれば（開始時刻が違う）、そのプロセスもそのグループも止めない", async () => {
    record(100, T1);
    const fake = fakeTable([
      { pid: 100, ppid: 1, pgid: 100, started: T2 },
      { pid: 101, ppid: 100, pgid: 100, started: T2 },
    ]);
    expect(await new HostMcpProcesses(dir, fake.deps).cleanup()).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("リーダーが先に終わっていれば、記録した子孫（と、その子孫）だけを止め、同じグループの番号のほかのものは止めない", async () => {
    record(100, T1, [{ pid: 101, started: T1 }]);
    const fake = fakeTable([
      { pid: 101, ppid: 1, pgid: 100, started: T1 },
      { pid: 104, ppid: 101, pgid: 100, started: T2 },
      // 記録していない（グループの番号が同じでも、確かめられないので止めない）
      { pid: 105, ppid: 1, pgid: 100, started: T2 },
      // 記録した子孫の PID が再利用されたもの
      { pid: 106, ppid: 1, pgid: 106, started: T2 },
    ]);
    record(107, T1, [{ pid: 106, started: T1 }]);
    await new HostMcpProcesses(dir, fake.deps).cleanup();
    expect(fake.killed()).toEqual([101, 104]);
  });

  it("記録を書いたデーモンが動いていれば（同じ SACTY_HOME のほかの sacty）、止めず、記録も残す", async () => {
    record(100, T1, [], { pid: 50, started: T1 });
    const fake = fakeTable([
      { pid: 50, ppid: 1, pgid: 50, started: T1 },
      { pid: 100, ppid: 1, pgid: 100, started: T1 },
    ]);
    expect(await new HostMcpProcesses(dir, fake.deps).cleanup()).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(readdirSync(dir)).toEqual(["100.json"]);
  });

  it("記録を書いたデーモンが終わっていれば（PID が再利用されて開始時刻が違うものを含む）、前回の残りとして止める", async () => {
    record(100, T1, [], { pid: 50, started: T1 }); // 所有元の PID が再利用された
    record(200, T1, [], { pid: 60, started: T1 }); // 所有元が終わった
    const fake = fakeTable([
      { pid: 50, ppid: 1, pgid: 50, started: T2 },
      { pid: 100, ppid: 1, pgid: 100, started: T1 },
      { pid: 200, ppid: 1, pgid: 200, started: T1 },
    ]);
    expect(await new HostMcpProcesses(dir, fake.deps).cleanup()).toBe(2);
    expect(fake.killed()).toEqual([100, 200]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("壊れた記録は、止めずに消す。書いている途中の記録は読まない。デーモン自身とその親は、記録にあっても止めない", async () => {
    writeFileSync(join(dir, "100.json"), "{broken");
    writeFileSync(join(dir, "101.json.tmp"), "{");
    record(process.pid, T1);
    record(process.ppid, T1);
    const fake = fakeTable([
      { pid: 100, ppid: 1, pgid: 100, started: T1 },
      { pid: process.pid, ppid: process.ppid, pgid: process.pid, started: T1 },
      { pid: process.ppid, ppid: 1, pgid: process.ppid, started: T1 },
    ]);
    expect(await new HostMcpProcesses(dir, fake.deps).cleanup()).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(readdirSync(dir)).toEqual(["101.json.tmp"]);
  });

  it("SIGTERM で終わらなければ、猶予の後に SIGKILL する", async () => {
    record(100, T1);
    const fake = fakeTable([{ pid: 100, ppid: 1, pgid: 100, started: T1 }], [100]);
    await new HostMcpProcesses(dir, fake.deps).cleanup();
    expect(fake.signals).toEqual([
      [100, "SIGTERM"],
      [100, "SIGKILL"],
    ]);
  });

  it("プロセスの一覧が読めなければ（ps が使えない）、何も止めず、記録も消さない（次の起動で片付ける）", async () => {
    record(100, T1);
    const fake = fakeTable([]);
    expect(await new HostMcpProcesses(dir, fake.deps).cleanup()).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(readdirSync(dir)).toEqual(["100.json"]);
  });

  it("記録の場所が無ければ、何もしない", async () => {
    const fake = fakeTable([{ pid: 100, ppid: 1, pgid: 100, started: T1 }]);
    expect(await new HostMcpProcesses(join(dir, "none"), fake.deps).cleanup()).toBe(0);
    expect(await new HostMcpProcesses(undefined, fake.deps).cleanup()).toBe(0);
    expect(fake.signals).toEqual([]);
  });
});

/** 実際のプロセスでの確かめ。 */
describe.skipIf(process.platform === "win32")("実際のプロセスの後始末（PBI-78）", () => {
  /** 偽の MCP サーバー。ラッパーのように子孫（sh と sleep）を起動し、標準入力が閉じたら自分だけ終わる。 */
  const fakeMcp = () => {
    const file = join(dir, "fake-mcp.mjs");
    writeFileSync(
      file,
      `import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
spawn("sh", ["-c", "sleep 300 & wait"], { stdio: "ignore" });
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || process.env.FAKE_MCP_HANG) return;
  const result = msg.method === "initialize"
    ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
    : msg.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
rl.on("close", () => process.exit(0));
`,
    );
    return file;
  };

  const spawned: ChildProcess[] = [];
  const groups = new Set<number>();
  /** テストで作った記録の係（後始末で、動かしているものの記録を片付ける）。 */
  const made: HostMcpProcesses[] = [];
  const processesIn = (path: string) => {
    const processes = new HostMcpProcesses(path, { graceMs: 500 });
    made.push(processes);
    return processes;
  };
  /**
   * 失敗・時間切れでも残さない（PBI-94）。見つけたグループだけを止めると、見つける前（記録を待っている間など）に落ちた
   * ときに、合図のファイルを待ち続けるプロセスが残る。このテストのプロセスの子孫とそのグループを、まとめて止める。
   */
  const cleanup = async () => {
    await killSpawned(groups);
    groups.clear();
    for (const child of spawned.splice(0)) child.kill("SIGKILL");
    await Promise.all(made.splice(0).map((p) => p.endAll()));
  };
  afterEach(cleanup);
  // 時間切れの後も動き続けたテストが、afterEach の後に起動したもの
  afterAll(cleanup);

  /** pid の子孫（自分は含めない）。 */
  const descendants = async (pid: number) => {
    const table = await psTable();
    const me = table.find((p) => p.pid === pid);
    if (!me) return [];
    return collectTargets(table, [me]).filter((p) => p.pid !== pid);
  };
  const alive = async (targets: readonly ProcessInfo[]) => {
    const table = await psTable();
    return targets.filter((t) => table.some((p) => p.pid === t.pid && p.started === t.started));
  };
  /** 記録のファイル。記録の場所は、最初の記録を書くときに作られるので、それまでは空とする。 */
  const recordFiles = () =>
    existsSync(join(dir, "processes")) ? readdirSync(join(dir, "processes")) : [];
  /** 合図のファイルを置く（テストの側から、偽のプロセスに次へ進ませる。固定の時間で進めると、負荷が高いと間に合わない）。 */
  const signalFile = (name: string) => join(dir, `go-${name}`);
  /**
   * check が真になるのを待つ（10 秒まで）。source（合図を出すはずのプロセス）が先に終わったら、待ち続けずに、終了コード・
   * 標準エラー出力の末尾を書いたエラーですぐ落ちる。
   */
  const until = (check: () => Promise<boolean>, what = "条件", source?: WaitSource) =>
    waitFor(check, { what, source, intervalMs: 50 });
  /**
   * 起動した MCP サーバーとその子孫（sh と sleep まで起動するのを待つ）。親の子・孫・ひ孫の3代がそろうのを待ち、その3つを
   * 返す（子孫の数で待つと、親が記録の更新のために動かす ps などの一時的な子も数えてしまい、sh と sleep の起動の前に
   * 進むことがある）。
   */
  const tree = async (parent: number, source?: WaitSource) => {
    let found: ProcessInfo[] = [];
    await until(
      async () => {
        const all = await descendants(parent);
        const childrenOf = (pid: number) => all.filter((p) => p.ppid === pid);
        found = [];
        for (const mcp of childrenOf(parent)) {
          for (const sh of childrenOf(mcp.pid)) {
            const sleep = childrenOf(sh.pid)[0];
            if (sleep) found = [mcp, sh, sleep];
          }
        }
        return found.length === 3;
      },
      "MCP サーバー・sh・sleep の起動",
      source,
    );
    for (const p of found) groups.add(p.pgid);
    return found;
  };
  /** 記録から、デーモン（このテストのプロセス）が起動した MCP サーバーとその子孫を見つける。 */
  const recorded = async (count = 3, source?: WaitSource) => {
    let found: ProcessInfo[] = [];
    await until(
      async () => {
        const files = recordFiles();
        const pid = Number(files[0]?.replace(".json", ""));
        found = pid ? collectTargets(await psTable(), [], [pid]) : [];
        return found.length >= count;
      },
      `記録と、記録した MCP サーバーとその子孫（${count} つ）`,
      source,
    );
    for (const p of found) groups.add(p.pgid);
    return found;
  };

  const servers = (env: Record<string, string> = {}) =>
    new HostMcpServers({
      specs: () => [
        toHostMcp("fake", HostMcpFile.parse({ command: process.execPath, args: [fakeMcp()], env })),
      ],
      secrets: new MemorySecretStore({}),
      processes: processesIn(join(dir, "processes")),
    });

  it("デーモンを止めたら、MCP サーバーとその子孫を止め、記録を消す", async () => {
    const host = servers();
    host.start();
    expect(await host.ready(["fake"])).toEqual([]);
    const started = await recorded();
    expect(readdirSync(join(dir, "processes"))).toHaveLength(1);
    await host.stop();
    expect(await alive(started)).toEqual([]);
    expect(readdirSync(join(dir, "processes"))).toEqual([]);
  }, 20_000);

  it("起動の途中（準備を待っている間）に止めても、子孫ごと止める", async () => {
    const host = servers({ FAKE_MCP_HANG: "1" });
    host.start();
    const started = await recorded();
    await host.stop();
    expect(await alive(started)).toEqual([]);
  }, 20_000);

  it("MCP サーバーが自分で終わったら、残った子孫を止める", async () => {
    const processes = processesIn(join(dir, "processes"));
    const transport = new GroupStdioTransport(
      {
        name: "fake",
        command: "sh",
        // 合図が来たら自分だけ終わる（子孫の sleep 302 は残る）
        args: [
          "-c",
          `sleep 302 </dev/null >/dev/null 2>&1 & while [ ! -e ${signalFile("exit")} ]; do sleep 0.02; done`,
        ],
        env: process.env as Record<string, string>,
      },
      processes,
    );
    let closed = false;
    const ended = new Promise((resolve) => {
      transport.onclose = () => {
        closed = true;
        resolve("closed");
      };
    });
    await transport.start();
    // 合図の前に MCP サーバーが終わったら、すぐ落ちる
    const started = await recorded(2, { name: "MCP サーバー（sh）", ended });
    writeFileSync(signalFile("exit"), "");
    await until(async () => closed, "MCP サーバーが終わったことの知らせ");
    await until(async () => (await alive(started)).length === 0);
    await until(async () => recordFiles().length === 0);
  }, 20_000);

  it("MCP サーバーが自分で終わっても、子孫が標準出力・標準エラーを開いたままなら、子孫を止め、1回だけ知らせる", async () => {
    // Node のラッパーが、標準入出力を引き継いだ sleep を起動して終わる
    const wrapper = join(dir, "wrapper.mjs");
    writeFileSync(
      wrapper,
      `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
spawn("sleep", ["304"], { stdio: "inherit" });
setInterval(() => { if (existsSync(${JSON.stringify(signalFile("exit"))})) process.exit(0); }, 20);
`,
    );
    const processes = processesIn(join(dir, "processes"));
    const transport = new GroupStdioTransport(
      {
        name: "fake",
        command: process.execPath,
        args: [wrapper],
        env: process.env as Record<string, string>,
      },
      processes,
    );
    let closed = 0;
    const ended = new Promise((resolve) => {
      transport.onclose = () => {
        closed += 1;
        resolve("closed");
      };
    });
    await transport.start();
    const started = await recorded(2, { name: "MCP サーバー（Node のラッパー）", ended });
    writeFileSync(signalFile("exit"), "");
    await until(async () => closed > 0, "MCP サーバーが終わったことの知らせ");
    await until(async () => (await alive(started)).length === 0);
    await until(async () => recordFiles().length === 0);
    // 子孫が止まってパイプが閉じた後（close）も、知らせるのは1回だけ
    await new Promise((r) => setTimeout(r, 300));
    expect(closed).toBe(1);
    await transport.close();
    expect(closed).toBe(1);
  }, 20_000);

  it("同じ SACTY_HOME で2つ目のデーモンが起動しても、1つ目が動かしている MCP サーバーは止めない", async () => {
    const first = servers();
    first.start();
    expect(await first.ready(["fake"])).toEqual([]);
    const started = await recorded();
    // 2つ目のデーモンの起動時の片付け（記録を書いたデーモン＝このプロセスは動いている）
    const second = processesIn(join(dir, "processes"));
    expect(await second.cleanup()).toBe(0);
    expect(await alive(started)).toHaveLength(started.length);
    expect(readdirSync(join(dir, "processes"))).toHaveLength(1);
    await first.stop();
    expect(await alive(started)).toEqual([]);
  }, 20_000);

  it("起動して記録している途中に止めても取りこぼさず、止めた後は起動しない", async () => {
    const processes = processesIn(join(dir, "processes"));
    const params = {
      name: "fake",
      command: process.execPath,
      args: [fakeMcp()],
      env: process.env as Record<string, string>,
    };
    const starting = new GroupStdioTransport(params, processes).start();
    await processes.endAll();
    await starting.catch(() => {});
    // 記録も、動いているもの（この MCP サーバーのグループ）も残らない
    expect(recordFiles()).toEqual([]);
    const table = await psTable();
    expect(table.filter((p) => p.ppid === process.pid && p.pgid === p.pid)).toEqual([]);
    await expect(new GroupStdioTransport(params, processes).start()).rejects.toThrow(/stopping/);
  }, 20_000);

  /** デーモンの代わり（main.ts と同じく、シグナルでは止めてから終わり、exit ではグループに SIGTERM を送る）。 */
  const harness = (mode: "wait" | "throw") => {
    const file = join(dir, "harness.mjs");
    const module = fileURLToPath(new URL("./host-mcp-processes.ts", import.meta.url));
    writeFileSync(
      file,
      `const { HostMcpProcesses, GroupStdioTransport } = await import(${JSON.stringify(module)});
const processes = new HostMcpProcesses(${JSON.stringify(join(dir, "processes"))}, { graceMs: 500, refreshMs: 200 });
process.on("exit", () => processes.signalAllSync());
const stop = async () => { await processes.endAll(); process.exit(0); };
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const transport = new GroupStdioTransport(
  { name: "fake", command: process.execPath, args: [${JSON.stringify(fakeMcp())}], env: process.env },
  processes,
);
await transport.start();
setInterval(() => {}, 1000);
if (${JSON.stringify(mode)} === "throw") {
  const { existsSync } = await import("node:fs");
  setInterval(() => { if (existsSync(${JSON.stringify(signalFile("throw"))})) throw new Error("boom"); }, 20);
}
`,
    );
    // 型の取り除きが既定で切れている古い Node（22.17 以前）でも読めるように、フラグを付ける
    const flags = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
    const child = spawn(process.execPath, [...flags, file], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      // 標準エラー出力は、合図の前に終わったときの原因に使う
      stdio: ["ignore", "ignore", "pipe"],
    });
    spawned.push(child);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return { child, exited, source: processSource("デーモンの代わり（harness.mjs）", child) };
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`デーモンが ${signal} で止まったら、MCP サーバーとその子孫を止める`, async () => {
      const { child, exited, source } = harness("wait");
      const started = await tree(child.pid as number, source);
      // 記録が書かれるまで待つ（子孫が見えても、記録はまだ書かれていないことがある）
      await until(async () => recordFiles().length === 1, "記録", source);
      child.kill(signal);
      await exited;
      expect(await alive(started)).toEqual([]);
      expect(readdirSync(join(dir, "processes"))).toEqual([]);
    }, 20_000);
  }

  it("デーモンが例外で終わったら、MCP サーバーのグループに SIGTERM を送る", async () => {
    const { child, exited, source } = harness("throw");
    const started = await tree(child.pid as number, source);
    // 子孫まで起動したのを見てから、例外で終わらせる
    writeFileSync(signalFile("throw"), "");
    await exited;
    await until(async () => (await alive(started)).length === 0);
  }, 20_000);

  it("デーモンが突然落ちて残ったものは、次の起動で片付け、PID が再利用されたものは止めない", async () => {
    const { child, exited, source } = harness("wait");
    const started = await tree(child.pid as number, source);
    // 子孫まで記録されるのを待つ（MCP サーバーは、デーモンが落ちて標準入力が閉じたら自分だけ終わり、子孫が残る）
    await until(
      async () => {
        const files = recordFiles();
        if (files.length !== 1) return false;
        const saved = JSON.parse(readFileSync(join(dir, "processes", files[0] as string), "utf8"));
        return saved.members.length >= 2;
      },
      "子孫まで書いた記録",
      source,
    );
    // ほかのプロセス（記録の PID は同じだが、開始時刻が違う。PID が再利用されたのと同じ）
    const other = spawn("sleep", ["303"], { detached: true, stdio: "ignore" });
    spawned.push(other);
    groups.add(other.pid as number);
    await until(async () => (await psTable()).some((p) => p.pid === other.pid));
    mkdirSync(join(dir, "processes"), { recursive: true });
    writeFileSync(
      join(dir, "processes", `${other.pid}.json`),
      JSON.stringify({
        name: "x",
        pid: other.pid,
        started: "Thu Jan  1 00:00:00 1970",
        members: [],
      }),
    );
    child.kill("SIGKILL");
    await exited;
    // 落ちただけでは残る
    expect(await alive(started)).not.toEqual([]);
    const stopped = await processesIn(join(dir, "processes")).cleanup();
    // MCP サーバーは標準入力が閉じて自分で終わり、子孫（sh と sleep）が残っていた
    expect(stopped).toBeGreaterThanOrEqual(2);
    expect(await alive(started)).toEqual([]);
    expect((await psTable()).some((p) => p.pid === other.pid)).toBe(true);
    expect(existsSync(join(dir, "processes", `${other.pid}.json`))).toBe(false);
  }, 20_000);
});
