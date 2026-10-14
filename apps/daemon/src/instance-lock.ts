import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 同じ SACTY_HOME で、デーモンを二重に起動させない（PBI-79）。
 *
 * 判定は OS のファイルロック（SQLite の排他ロック。中身は fcntl のロック）で行う。ロックはプロセスが持ち、プロセスが
 * どう終わっても（SIGKILL・突然の終了を含む）OS が外すので、前のデーモンが残したファイルや、PID の再利用で起動を
 * 妨げることはない。ロックはファイル（inode）に掛かるので、同じ SACTY_HOME を別の書き方（シンボリックリンクなど）で
 * 指しても二重に起動できない。ロックのファイルは消さない（消すと、別のデーモンが新しいファイルでロックを取れてしまう）。
 *
 * 動いているデーモンの接続先と PID は、ロックを取ったデーモンが別のファイル（daemon-owner.json）に書く。表示のためだけの
 * もので、判定には使わない（落ちたデーモンが残したものは、次にロックを取ったデーモンが書き換える）。
 *
 * fcntl のロックは子プロセスに引き継がれないので、デーモンが落ちて MCP サーバーなどの子が残っても、次の起動は妨げない
 * （残った子は、次のデーモンが起動の片付けで止める。PBI-78）。
 *
 * テストで別のプロセスから（型を消すだけで）読み込むので、node の組み込みのほかは読み込まない。
 */
export const LOCK_FILE = "daemon.lock";
export const OWNER_FILE = "daemon-owner.json";

/** 動いているデーモン（表示用）。 */
export type InstanceOwner = { pid: number; url: string; startedAt: string };

export type InstanceLock = {
  /** ロックを外す（自分の書いた daemon-owner.json も消す）。 */
  release(): void;
};

export type LockResult =
  | { ok: true; lock: InstanceLock }
  /** owner は、読めなければ無い（ロックを取った直後で、まだ書いていないときなど）。 */
  | { ok: false; owner?: InstanceOwner };

/** SQLITE_BUSY（ほかのプロセスがロックを持っている）。 */
const SQLITE_BUSY = 5;

/** ロックを持つ DB（ガベージコレクションで閉じられて、ロックが外れないよう、ここで持ち続ける）。 */
const held = new Set<DatabaseSync>();

/**
 * ロックを取る。ほかのデーモンが持っていれば、その接続先と PID（読めれば）を返す。ロックの取得のほかの失敗
 * （権限が無いなど）は、例外のまま伝える（確かめられないまま起動しない）。
 */
export function acquireInstanceLock(home: string, url: string): LockResult {
  const db = new DatabaseSync(join(home, LOCK_FILE), { timeout: 0 });
  try {
    // 排他のロックを取り、コミットしないまま持ち続ける（データは書かない）
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === SQLITE_BUSY) {
      return { ok: false, owner: readOwner(home) };
    }
    throw error;
  }
  held.add(db);
  const owner: InstanceOwner = { pid: process.pid, url, startedAt: new Date().toISOString() };
  writeOwner(home, owner);
  let released = false;
  return {
    ok: true,
    lock: {
      release() {
        if (released) return;
        released = true;
        // 先に表示用のファイルを消してから（ロックを外した後だと、次のデーモンが書いたものを消しかねない）外す
        if (readOwner(home)?.pid === owner.pid) rmSync(join(home, OWNER_FILE), { force: true });
        held.delete(db);
        db.close();
      },
    },
  };
}

/** 二重に起動しようとしたときの表示。 */
export function alreadyRunningMessage(home: string, owner: InstanceOwner | undefined): string {
  const who = owner
    ? `接続先 ${owner.url}、PID ${owner.pid}、${owner.startedAt} に起動`
    : "接続先・PID は読めませんでした";
  return `[daemon] 同じ SACTY_HOME（${home}）で、ほかの sacty のデーモンが動いています（${who}）。起動しません。`;
}

function writeOwner(home: string, owner: InstanceOwner) {
  const file = join(home, OWNER_FILE);
  try {
    // 読む側が途中のものを読まないよう、書いてから置き換える
    writeFileSync(`${file}.tmp`, `${JSON.stringify(owner)}\n`);
    renameSync(`${file}.tmp`, file);
  } catch {
    // 表示のためだけのものなので、書けなくても起動は続ける
  }
}

export function readOwner(home: string): InstanceOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(home, OWNER_FILE), "utf8")) as Partial<InstanceOwner>;
    return typeof raw.pid === "number" &&
      typeof raw.url === "string" &&
      typeof raw.startedAt === "string"
      ? { pid: raw.pid, url: raw.url, startedAt: raw.startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}
