import { spawn } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Task } from "@sacty/core";
import { isCompleted } from "@sacty/core";
import { dockerClientEnv } from "./agents/docker.js";

/**
 * 終わったタスクと、中断された実行の作業領域の片付け（PBI-157）。消すのは、作業領域の根の下で、タスク・実行の ID
 * （UUID）の形をした名前のものだけ。リンクの先はたどらない。動いているコンテナがマウントしている場所は消さない。
 */

/**
 * 実行ごとの一時領域（作業領域の根の下。`<名前>/<runId>`）。実行の finally で消すが、実行中にデーモンを止めると残る。
 * 再起動の後、実行は新しい runId でやり直すので、残ったものは二度と使わない。共用の compose（`_shared-compose`）は
 * shared-compose.ts で消す。キャッシュ（`_cache`）と、退避した git のメタデータ（`_git`）は含めない。
 */
export const RUN_SCRATCH_DIRS = [
  "_guardian",
  "_snapshots",
  "_review",
  "_audit-logs",
  "_audit-ledger",
  "_deployment",
  "_export",
  "_handoff",
  "_question-logs",
] as const;

/** タスク・実行の ID の形（sacty が randomUUID で作る）。 */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSactyId(name: string): boolean {
  return ID_RE.test(name);
}

/**
 * 完了したタスクが、もう作業領域を使わないか。工程をすべて終えて止まっていて、監査をするタスクは監査が終わった
 * （完了・失敗）もの。予算で止まった監査は、上限を上げて続けられるので残す。マージの後の監視を工程の外で待っている
 * 古いタスク（PBI-116 より前）と、停止を確かめられなかったコンテナがあるタスクも残す。
 */
export function workspaceRetirable(task: Task): boolean {
  if (task.status !== "idle" || !isCompleted(task)) return false;
  if (task.audit && !task.audit.completedAt && !task.audit.failed) return false;
  if (task.deployment?.state === "waiting") return false;
  return !task.unstoppedRuns?.length;
}

/** 根の直下のディレクトリ（リンクでない）の、ID の形をした名前（suffix を除いたもの）の一覧。無ければ空。 */
export function idEntries(dir: string, suffix = ""): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter(
      (name) => name.endsWith(suffix) && isSactyId(name.slice(0, name.length - suffix.length)),
    );
  } catch {
    return [];
  }
}

/** path が、マウントされている場所のどれかと重なるか（同じか、どちらかがもう片方の下）。 */
export function overlapsMounts(path: string, mounts: readonly string[]): boolean {
  const paths = [path];
  try {
    paths.push(realpathSync(path));
  } catch {
    // 無ければ、そのまま比べる
  }
  return mounts.some((mount) =>
    paths.some((p) => mount === p || mount.startsWith(p + sep) || p.startsWith(mount + sep)),
  );
}

/**
 * 消す。リンクならリンクだけを消す（先はたどらない。ディレクトリの中のリンクも、rm はたどらない）。無ければ何もしない。
 * 消せたら true。
 */
export async function removeEntry(path: string): Promise<boolean> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink()) await unlink(path);
  else await rm(path, { recursive: true, force: true });
  return true;
}

/** docker のコマンドを、上限の時間まで待って実行する。失敗・時間切れなら undefined。 */
function docker(args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn("docker", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: dockerClientEnv(),
    });
    let stdout = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(undefined);
    }, timeoutMs);
    timer.unref();
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : undefined);
    });
  });
}

/**
 * 動いているコンテナ（sacty のものに限らない）がマウントしているホストの場所。Docker に問い合わせられなければ
 * undefined（動いていないことを確かめられないので、呼ぶ側は消さない）。
 */
export async function runningContainerMounts(timeoutMs = 15_000): Promise<string[] | undefined> {
  const ids = await docker(["ps", "-q"], timeoutMs);
  if (ids === undefined) return undefined;
  const list = ids.split("\n").filter((id) => id.trim() !== "");
  if (list.length === 0) return [];
  const sources = await docker(
    ["inspect", "--format", "{{range .Mounts}}{{println .Source}}{{end}}", ...list],
    timeoutMs,
  );
  if (sources === undefined) return undefined;
  return sources.split("\n").filter((line) => line.trim() !== "");
}

/** 作業領域の根の下の、タスクの作業領域と退避した git のメタデータの場所。 */
export function taskWorkspacePaths(workspaceRoot: string, taskId: string): string[] {
  return [join(workspaceRoot, taskId), join(workspaceRoot, "_git", `${taskId}.git`)];
}
