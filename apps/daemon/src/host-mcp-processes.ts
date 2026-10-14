import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * ホストの MCP サーバーのプロセスの後始末（PBI-78）。
 *
 * MCP サーバーは、それぞれ自分のプロセスグループで起動する（ラッパーのコマンドが起動した子孫も、まとめて止められる
 * ように）。止めるときは、グループと子孫（親をたどれるもの）を SIGTERM で止め、時間内に終わらなければ SIGKILL する。
 *
 * デーモンが突然落ちたときに残ったものは、次の起動のときに片付ける（compose のサービスの片付けと同じ流儀）。そのため、
 * 起動したプロセスを SACTY_HOME の下に記録しておく。記録は PID と開始時刻の組で、片付けでは、いま動いているプロセスの
 * PID と開始時刻が記録と一致するもの（と、その子孫・そのプロセスがリーダーのグループ）だけを止める。PID が再利用された
 * ほかのプロセスは、開始時刻が違うので止めない。
 */

/** プロセスの一覧の1行。started は開始時刻（ps の lstart。UTC・C ロケールで読むので、同じプロセスなら同じ文字列）。 */
export type ProcessInfo = { pid: number; ppid: number; pgid: number; started: string };

/** プロセスを識別する組（PID は再利用されるので、開始時刻と組で比べる）。 */
export type ProcessIdentity = { pid: number; started: string };

/** 起動したときの記録（ファイルの中身）。members は、そのとき見えていた子孫。 */
type ProcessRecord = {
  name: string;
  pid: number;
  started: string;
  members: ProcessIdentity[];
};

export type ProcessDeps = {
  /** いま動いているプロセスの一覧（テストでは差し替える）。 */
  table?: () => Promise<ProcessInfo[]>;
  /** シグナルを送る（テストでは差し替える）。 */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** SIGTERM から SIGKILL までの猶予。 */
  graceMs?: number;
  /** 子孫を記録し直す間隔。 */
  refreshMs?: number;
  log?: (line: string) => void;
};

const GRACE_MS = 3_000;
const REFRESH_MS = 10_000;
/** 標準入力を閉じてから、自分で終わるのを待つ上限（SDK の stdio の transport と同じ）。 */
const STDIN_GRACE_MS = 2_000;

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/;

export function parseProcessTable(text: string): ProcessInfo[] {
  return text.split("\n").flatMap((line) => {
    const m = PS_LINE.exec(line);
    return m
      ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[4] as string }]
      : [];
  });
}

/** ps でプロセスの一覧を読む。読めなければ空（何も止めない側に倒す）。 */
export const psTable = (): Promise<ProcessInfo[]> =>
  new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseProcessTable(stdout)),
    );
  });

const defaultKill = (pid: number, signal: NodeJS.Signals) => {
  process.kill(pid, signal);
};

/**
 * 止める対象を集める。identities（PID と開始時刻が一致するもの）と、groups のグループに属するもの、それらの子孫
 * （親をたどれるもの）。デーモン自身と、その親（sacty up）・PID 1 は、どんなときも含めない。
 */
export function collectTargets(
  table: readonly ProcessInfo[],
  identities: readonly ProcessIdentity[],
  groups: readonly number[] = [],
): ProcessInfo[] {
  const excluded = new Set([0, 1, process.pid, process.ppid]);
  // デーモン自身のグループは、グループとしては止めない（MCP サーバーは、それぞれ自分のグループで起動している）
  const own = table.find((p) => p.pid === process.pid)?.pgid;
  const picked = new Map<number, ProcessInfo>();
  for (const p of table) {
    if (excluded.has(p.pid)) continue;
    const same = identities.some((i) => i.pid === p.pid && i.started === p.started);
    if (same || (p.pgid !== own && groups.includes(p.pgid))) picked.set(p.pid, p);
  }
  // 子孫を足す（親が先に終わって、PID 1 などに付け替えられたものは、グループでしか見つけられない）
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table) {
      if (!picked.has(p.pid) && !excluded.has(p.pid) && picked.has(p.ppid)) {
        picked.set(p.pid, p);
        grew = true;
      }
    }
  }
  return [...picked.values()];
}

/** ホストの MCP サーバーのプロセス（起動したもの・前回の残り）を止める。 */
export class HostMcpProcesses {
  /** いま動かしているもの（PID ごと）。 */
  private readonly live = new Map<number, { child: ChildProcess; record: ProcessRecord }>();
  /** 止めている途中のもの（同じものを二重に止めない）。 */
  private readonly ending = new Map<number, Promise<void>>();
  private refreshTimer: NodeJS.Timeout | undefined;
  /** すべて止めた（デーモンを止めている）。この後に起動したものは、すぐに止める。 */
  closed = false;

  /** dir に記録する（書かなければ、記録しない。テスト用）。 */
  private readonly dir: string | undefined;
  private readonly deps: ProcessDeps;

  // 型を消すだけで動くよう（テストで別のプロセスから読み込む）、引数のプロパティは使わない
  constructor(dir?: string, deps: ProcessDeps = {}) {
    this.dir = dir;
    this.deps = deps;
  }

  private table() {
    return (this.deps.table ?? psTable)();
  }

  private file(pid: number) {
    return this.dir ? join(this.dir, `${pid}.json`) : undefined;
  }

  private write(record: ProcessRecord) {
    const file = this.file(record.pid);
    if (!file || !this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      // 途中で落ちても壊れた記録を残さないよう、書いてから置き換える
      writeFileSync(`${file}.tmp`, JSON.stringify(record));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.deps.log?.(`[gateway] host MCP processes: could not record ${record.pid}: ${error}`);
    }
  }

  private forget(pid: number) {
    const file = this.file(pid);
    if (file) rmSync(file, { force: true });
  }

  /** 起動したプロセス（自分のグループのリーダー）を記録する。 */
  async track(name: string, child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    // 開始時刻を読む前に、動かしているものに加える（読む間に止められても、取りこぼさない）
    const record: ProcessRecord = { name, pid, started: "", members: [] };
    this.live.set(pid, { child, record });
    if (this.closed) {
      await this.end(pid);
      return;
    }
    const started = (await this.table()).find((p) => p.pid === pid)?.started;
    // 止めている途中・止めた後なら、記録しない
    if (this.live.get(pid)?.record !== record || this.ending.has(pid)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      // 記録する前に終わった。残った子孫だけを止める
      await this.end(pid);
      return;
    }
    // 開始時刻が読めない（ps が使えない）ときは、記録しない（次の起動で、確かめずに止めることになるため）
    if (!started) return;
    record.started = started;
    this.write(record);
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => void this.refresh(), this.deps.refreshMs ?? REFRESH_MS);
      this.refreshTimer.unref();
    }
  }

  /** 動かしているものの子孫を記録し直す（リーダーが先に落ちても、次の起動で子孫を見つけられるように）。 */
  async refresh(): Promise<void> {
    if (this.live.size === 0) return;
    const table = await this.table();
    for (const [pid, { child, record }] of this.live) {
      if (!record.started || this.ending.has(pid)) continue;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const members = collectTargets(table, [record], [pid])
        .filter((p) => p.pid !== pid)
        .map(({ pid, started }) => ({ pid, started }));
      record.members = members;
      this.write(record);
    }
  }

  /**
   * 起動したプロセスと、その子孫・グループを止める（終わった後の残りも止める）。止め終わったら記録を消す。
   * 同じものを並行して止めようとしたら、同じ処理を待つ。
   */
  end(pid: number): Promise<void> {
    const pending = this.ending.get(pid);
    if (pending) return pending;
    const entry = this.live.get(pid);
    if (!entry) return Promise.resolve();
    const { record } = entry;
    const promise = (async () => {
      // いま動かしているもの（グループの PID は、グループが残っている間は再利用されない）は、グループごと止める
      const identities = record.started ? [record, ...record.members] : [];
      await this.terminate(identities, [pid]);
      this.live.delete(pid);
      this.forget(pid);
    })().finally(() => this.ending.delete(pid));
    this.ending.set(pid, promise);
    return promise;
  }

  /** 動かしているものをすべて止める（デーモンを止めるとき）。 */
  async endAll(): Promise<void> {
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    await Promise.all([...this.live.keys(), ...this.ending.keys()].map((pid) => this.end(pid)));
  }

  /**
   * デーモンが終わる直前（process の exit。例外で落ちたときなど）に、動かしているもののグループへ SIGTERM を送る。
   * 待てないので、残ったものは次の起動の片付けに任せる（記録は消さない）。
   */
  signalAllSync(): void {
    for (const [pid, { child }] of this.live) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        (this.deps.kill ?? defaultKill)(-pid, "SIGTERM");
      } catch {
        // もう終わっている
      }
    }
  }

  /**
   * 前回の残り（デーモンが突然落ちて残ったもの）を止める（デーモンの起動時）。記録の PID と開始時刻が一致するもの
   * だけを止める（PID が再利用されたものは止めない）。そのうちグループのリーダーなら、グループも止める。
   */
  async cleanup(): Promise<number> {
    if (!this.dir) return 0;
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => /^\d+\.json(\.tmp)?$/.test(f));
    } catch {
      return 0;
    }
    const records: ProcessRecord[] = [];
    for (const f of files) {
      const path = join(this.dir, f);
      try {
        if (f.endsWith(".json")) records.push(parseRecord(readFileSync(path, "utf8")));
      } catch {
        // 壊れた記録は、確かめられないので止めずに消す
      }
    }
    const table = await this.table();
    // 一覧が読めない（ps が使えない）ときは、確かめられないので止めず、記録も消さない（次の起動で片付ける）
    if (table.length === 0) return 0;
    const identities = records.flatMap((r) =>
      r.started ? [{ pid: r.pid, started: r.started }, ...r.members] : [],
    );
    // リーダーが記録どおりに動いている（PID が再利用されていない）ものだけ、グループも止める
    const groups = records
      .filter((r) =>
        table.some((p) => p.pid === r.pid && p.started === r.started && p.pgid === r.pid),
      )
      .map((r) => r.pid);
    const stopped = await this.terminate(identities, groups, table);
    for (const f of files) rmSync(join(this.dir, f), { force: true });
    if (stopped > 0) {
      this.deps.log?.(`[gateway] host MCP: stopped ${stopped} process(es) left from the last run`);
    }
    return stopped;
  }

  /** 対象を SIGTERM で止め、猶予のうちに終わらなければ SIGKILL する。止めようとした数を返す。 */
  private async terminate(
    identities: readonly ProcessIdentity[],
    groups: readonly number[],
    first?: ProcessInfo[],
  ): Promise<number> {
    const kill = this.deps.kill ?? defaultKill;
    const send = (targets: readonly ProcessInfo[], signal: NodeJS.Signals) => {
      for (const p of targets) {
        try {
          kill(p.pid, signal);
        } catch {
          // もう終わっている
        }
      }
    };
    const table = first ?? (await this.table());
    if (table.length === 0) {
      // 一覧が読めない（ps が使えない）。動かしているもの（グループの PID は、いま確かに sacty が起動したもの）だけ、
      // グループごとシグナルを送る
      for (const pgid of groups) {
        try {
          kill(-pgid, "SIGTERM");
          await new Promise((r) => setTimeout(r, this.deps.graceMs ?? GRACE_MS));
          kill(-pgid, "SIGKILL");
        } catch {
          // もう終わっている
        }
      }
      return 0;
    }
    const targets = collectTargets(table, identities, groups);
    if (targets.length === 0) return 0;
    send(targets, "SIGTERM");
    const deadline = Date.now() + (this.deps.graceMs ?? GRACE_MS);
    // 止めている間に起動した子孫も止める（止めた対象の PID と開始時刻で、引き続き探す）
    const known = targets.map(({ pid, started }) => ({ pid, started }));
    for (;;) {
      await new Promise((r) => setTimeout(r, 50));
      const left = collectTargets(await this.table(), known, groups);
      if (left.length === 0) break;
      if (Date.now() >= deadline) {
        send(left, "SIGKILL");
        break;
      }
    }
    return targets.length;
  }
}

function parseRecord(text: string): ProcessRecord {
  const raw = JSON.parse(text) as Partial<ProcessRecord>;
  if (typeof raw.pid !== "number" || typeof raw.started !== "string") {
    throw new Error("invalid record");
  }
  const members = Array.isArray(raw.members)
    ? raw.members.filter(
        (m): m is ProcessIdentity => typeof m?.pid === "number" && typeof m?.started === "string",
      )
    : [];
  return { name: String(raw.name ?? ""), pid: raw.pid, started: raw.started, members };
}

type TransportParams = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * MCP サーバーを自分のプロセスグループで起動する stdio の transport（SDK の StdioClientTransport は、直接の子しか
 * 止めないため）。止めるときは、標準入力を閉じて自分で終わるのを待ち、残ったグループと子孫を止める。
 */
export class GroupStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** 標準エラー（起動の前から読めるようにしておく）。 */
  readonly stderr = new PassThrough();
  private child: ChildProcess | undefined;
  private readonly buffer = new ReadBuffer();

  private readonly params: TransportParams;
  private readonly processes: HostMcpProcesses;

  constructor(params: TransportParams, processes: HostMcpProcesses) {
    this.params = params;
    this.processes = processes;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("GroupStdioTransport already started");
    // デーモンを止めている途中なら、起動しない
    if (this.processes.closed) throw new Error("sacty is stopping");
    const child = spawn(this.params.command, this.params.args, {
      env: this.params.env,
      stdio: ["pipe", "pipe", "pipe"],
      // 自分のグループで起動する（子孫をまとめて止められる。端末の Ctrl-C は、デーモンが受けて止める）
      detached: true,
      shell: false,
    });
    this.child = child;
    // 起動したらすぐに記録する（起動の途中でデーモンが落ちても、次の起動で片付けられるように）
    const tracked = this.processes.track(this.params.name, child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.child = undefined;
        reject(error);
      });
    });
    child.on("error", (error) => this.onerror?.(error));
    child.on("close", () => {
      if (this.child === child) this.child = undefined;
      // 自分で終わったときも、残った子孫を止める
      if (child.pid) void this.processes.end(child.pid);
      this.onclose?.();
    });
    child.stdin?.on("error", (error) => this.onerror?.(error));
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (let m = this.buffer.readMessage(); m; m = this.buffer.readMessage()) {
          this.onmessage?.(m);
        }
      } catch (error) {
        this.onerror?.(error as Error);
        void this.close();
      }
    });
    child.stdout?.on("error", (error) => this.onerror?.(error));
    child.stderr?.pipe(this.stderr);
    await tracked;
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin) {
        reject(new Error("Not connected"));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.buffer.clear();
    if (!child?.pid) return;
    const pid = child.pid;
    if (child.exitCode === null && child.signalCode === null) {
      // まず標準入力を閉じて、自分で終わるのを待つ
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        child.stdin?.end();
      } catch {
        // もう閉じている
      }
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, STDIN_GRACE_MS).unref()),
      ]);
    }
    await this.processes.end(pid);
  }
}
