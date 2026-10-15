/**
 * テストで起動した実際のプロセスを、テストが失敗・時間切れになっても残さないための後始末（PBI-94）。
 * 本体のコードからは使わない（ビルドの対象から外している）。
 */

import { isMainThread } from "node:worker_threads";
import { type ProcessInfo, psTable } from "../host-mcp-processes.js";

export type KillSpawnedDeps = {
  /** いま動いているプロセスの一覧（テストでは差し替える）。 */
  table?: () => Promise<ProcessInfo[]>;
  /** シグナルを送る（テストでは差し替える）。 */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** 子孫をたどる起点（既定はこのプロセス）。 */
  root?: number;
  /**
   * このプロセスの子孫をたどってよいか。既定は、Vitest のワーカーがプロセス（forks）のとき。スレッド（threads）のときは、
   * このプロセスがほかのテストファイルと同じなので、子孫をたどらず、groups だけを止める。
   */
  descendants?: boolean;
};

/**
 * このプロセスが起動した子孫（親が終わって付け替えられる前のもの）と、そのグループ、groups に渡したグループを、
 * SIGKILL で止める。このプロセス自身のグループは、グループとしては止めない（Vitest やシェルを巻き込まないため）。
 * 止めたもの（シグナルを送ったもの）の PID を返す。
 *
 * テストのプロセスのグループは、テストが失敗・時間切れになると、合図のファイルが置かれないまま待ち続けて残る。afterEach と
 * afterAll で呼び、テストの結果によらず止める。
 */
export async function killSpawned(
  groups: Iterable<number> = [],
  deps: KillSpawnedDeps = {},
): Promise<number[]> {
  const root = deps.root ?? process.pid;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const table = await (deps.table ?? psTable)();
  const own = table.find((p) => p.pid === root)?.pgid;
  const picked = new Map<number, ProcessInfo>();
  if (deps.descendants ?? isMainThread) {
    // 親をたどって、子孫を集める（一覧の並びによらず、増えなくなるまで）
    const ids = new Set([root]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of table) {
        if (!ids.has(p.pid) && ids.has(p.ppid)) {
          ids.add(p.pid);
          picked.set(p.pid, p);
          grew = true;
        }
      }
    }
  }
  const pgids = new Set([...groups, ...[...picked.values()].map((p) => p.pgid)]);
  for (const g of [own, 0, 1, root, process.pid]) if (g !== undefined) pgids.delete(g);
  // グループの番号のものも集める（親が終わって付け替えられた子孫）
  for (const p of table) if (pgids.has(p.pgid)) picked.set(p.pid, p);
  for (const g of [0, 1, root, process.pid, process.ppid]) picked.delete(g);
  const send = (pid: number) => {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // もう終わっている
    }
  };
  // グループごと止めてから、グループに入っていない子孫（テストのプロセスと同じグループのもの）を止める
  for (const pgid of pgids) send(-pgid);
  for (const pid of picked.keys()) send(pid);
  return [...picked.keys()].sort((a, b) => a - b);
}
