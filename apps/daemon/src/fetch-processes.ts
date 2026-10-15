// 止められる取得の子プロセス（PBI-107）。デーモンが終わるときに止めるため、起動したものを記録する。
// テストで、デーモンの代わりの子のプロセス（素の Node が型を取り除いて読む）からも使えるよう、node: のほかは import せず、
// 型を取り除くだけで動く書き方にする。
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

/**
 * 止められる子プロセスのプロセスグループ。別のグループで動くので、端末の Ctrl+C も、デーモンと一緒に消える期限の
 * タイマーも届かない。デーモンが終わるとき（通常の終了・process.exit・捕まえない例外・SIGINT/SIGTERM からの終了）に止める。
 */
const groups = new Set<number>();
let exitHook = false;

/** 起動中の、止められる子プロセスのグループを、すべて止める（デーモンが終わるとき。同期で行う）。 */
export function stopFetchProcessesSync(): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // もう終わっている
    }
  }
  groups.clear();
}

/**
 * 子プロセスを、自分のプロセスグループで起動し、終わるまで記録する。stop で、グループごと（孫のプロセスも）止める。
 * デーモンが終わるときにも、すべて止める。
 */
export function spawnStoppable(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): { child: ChildProcess; stop: () => void } {
  const child = spawn(command, args, { ...options, detached: true });
  const pid = child.pid;
  if (pid !== undefined) {
    groups.add(pid);
    if (!exitHook) {
      exitHook = true;
      process.on("exit", stopFetchProcessesSync);
    }
    const forget = () => groups.delete(pid);
    child.on("close", forget);
    child.on("error", forget);
  }
  const stop = () => {
    try {
      if (pid !== undefined) process.kill(-pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  return { child, stop };
}
