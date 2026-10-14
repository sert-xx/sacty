import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type ProcessInfo, psTable } from "../host-mcp-processes.js";
import { killSpawned } from "./processes.js";
import { waitFor } from "./wait.js";

const T = "Thu Oct 15 01:00:00 2026";

/** 偽のプロセスの一覧と、送ったシグナル。 */
function fake(rows: ProcessInfo[]) {
  const sent: number[] = [];
  return {
    sent,
    deps: {
      table: async () => rows,
      kill: (pid: number) => {
        sent.push(pid);
      },
      root: 10,
      descendants: true,
    },
  };
}

describe("テストで起動したプロセスの後始末（PBI-94。偽の一覧）", () => {
  const rows: ProcessInfo[] = [
    { pid: 1, ppid: 0, pgid: 1, started: T },
    { pid: 9, ppid: 1, pgid: 9, started: T }, // テストのプロセスの親（Vitest。グループも同じ）
    { pid: 10, ppid: 9, pgid: 9, started: T }, // テストのプロセス
    { pid: 11, ppid: 10, pgid: 9, started: T }, // 自分のグループで起動していない子
    { pid: 20, ppid: 10, pgid: 20, started: T }, // 自分のグループで起動した子（MCP サーバー）
    { pid: 21, ppid: 20, pgid: 20, started: T }, // その子（sleep）
    { pid: 22, ppid: 1, pgid: 20, started: T }, // 親が終わって付け替えられたもの（グループで見つける）
    { pid: 23, ppid: 21, pgid: 23, started: T }, // 孫が、さらに自分のグループで起動したもの
    { pid: 30, ppid: 1, pgid: 30, started: T }, // ほかのプロセス
    { pid: 40, ppid: 1, pgid: 40, started: T }, // ほかのプロセス（groups で渡す）
    { pid: 41, ppid: 1, pgid: 40, started: T },
  ];

  it("子孫とそのグループ、渡したグループを止め、テストのプロセスとそのグループ・ほかのプロセスは止めない", async () => {
    const f = fake(rows);
    expect(await killSpawned([40], f.deps)).toEqual([11, 20, 21, 22, 23, 40, 41]);
    expect(f.sent.filter((p) => p < 0).sort((a, b) => b - a)).toEqual([-20, -23, -40]);
    expect(f.sent.filter((p) => p > 0).sort((a, b) => a - b)).toEqual([11, 20, 21, 22, 23, 40, 41]);
  });

  it("テストのプロセスのグループ・1 を groups に渡しても、グループとしては止めない", async () => {
    const f = fake(rows);
    await killSpawned([9, 1, 0], f.deps);
    expect(f.sent).not.toContain(-9);
    expect(f.sent).not.toContain(-1);
    expect(f.sent).not.toContain(9);
    expect(f.sent).not.toContain(10);
  });

  it("子孫をたどらないとき（スレッドのワーカー）は、渡したグループだけを止める", async () => {
    const f = fake(rows);
    expect(await killSpawned([20], { ...f.deps, descendants: false })).toEqual([20, 21, 22]);
  });

  it("シグナルを送れなくても（もう終わっている）、残りに送り続ける", async () => {
    const sent: number[] = [];
    const deps = {
      ...fake(rows).deps,
      kill: (pid: number) => {
        sent.push(pid);
        throw new Error("ESRCH");
      },
    };
    expect(await killSpawned([], deps)).toEqual([11, 20, 21, 22, 23]);
    expect(sent).toHaveLength(7);
  });
});

describe.skipIf(process.platform === "win32")(
  "テストで起動したプロセスの後始末（PBI-94。実際のプロセス）",
  () => {
    const alive = async (pids: number[]) => {
      const table = await psTable();
      return pids.filter((pid) => table.some((p) => p.pid === pid));
    };

    it("合図を待ち続ける MCP サーバー（自分のグループ）と、その子孫・付け替えられた子孫を止める", async () => {
      // 時間切れで残ったのと同じ形：自分のグループで、子孫を起動して、来ない合図を待ち続ける
      const server = spawn("sh", ["-c", "sleep 305 & while :; do sleep 0.02; done"], {
        detached: true,
        stdio: "ignore",
      });
      // 自分のグループで起動して、すぐ終わる（子孫の sleep は親が付け替えられて残る）
      const orphan = spawn("sh", ["-c", "sleep 306 & exit 0"], { detached: true, stdio: "ignore" });
      const leader = { server: server.pid as number, orphan: orphan.pid as number };
      let members: number[] = [];
      try {
        await waitFor(
          async () => {
            const table = await psTable();
            members = table
              .filter((p) => p.pgid === leader.server || p.pgid === leader.orphan)
              .map((p) => p.pid);
            const orphanGone = !table.some((p) => p.pid === leader.orphan);
            // server・その sleep・orphan の sleep（orphan の sh は終わっている）
            return orphanGone && members.length >= 3;
          },
          { what: "MCP サーバー・子孫の起動" },
        );
        // 付け替えられた子孫は、子孫としてはたどれないので、グループで渡す
        await killSpawned([leader.orphan]);
        await waitFor(async () => (await alive(members)).length === 0, {
          what: "止めたプロセスが終わること",
        });
        // テストのプロセス自身は止めない
        expect(await alive([process.pid])).toEqual([process.pid]);
      } finally {
        for (const pgid of [leader.server, leader.orphan]) {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch {}
        }
      }
    }, 20_000);
  },
);
