import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative } from "node:path";
import type { DaemonMessage } from "@sacty/core";
import type { HostedContextMcp, HostedMcpRelay } from "./context.js";
import { type HostMcpConnector, HostMcpServers, type HostMcpSpec } from "./host-mcp.js";
import type { HostMcpProcesses } from "./host-mcp-processes.js";
import type { SecretStore } from "./secrets.js";

/**
 * コンテキストの mcp.yaml の command の MCP サーバーを、ホストで動かす（PBI-84）。起動・準備・中継・後始末は、ホストの
 * MCP サーバー（config.yaml の gateway.mcp_servers。PBI-36・75・77・78）の仕組みをそのまま使う。
 *
 * - 分離：ゲートウェイの中の名前（key）は、プロジェクトと中身（mcp.yaml の名前・コマンド・引数・env・時間切れ・層の
 *   リポジトリと commit）から作る。エージェントには mcp.yaml の名前の URL（/ctx-mcp/<名前>）だけを渡し、実行のトークン
 *   ごとに、その実行のプロジェクトの key に結びつける（PBI-74 の PF と同じ分離）。ほかのプロジェクトの実行からは、名前を
 *   知っていても使えず、同じ名前で中身が違っても混ざらない。
 * - 使い回し：同じプロジェクトで同じ中身なら、実行をまたいで同じプロセスを使う。中身が変われば（層の commit が変わった
 *   ときも）、新しい key で起動する。
 * - 止める：使っている実行が無くなったものは、同じプロジェクト・同じ名前で新しい中身が使われたら（古くなったら）すぐに、
 *   そうでなければ最後に使ってから idleMs（既定30分）で止める。デーモンの終了ですべて止め、突然落ちて残ったものは、次の
 *   起動で片付ける（プロセスの記録は、ホストの MCP サーバーと同じもの）。
 * - 作業ディレクトリ：そのサーバーを書いた層のリポジトリの写し（SACTY_HOME/context-mcp/layers の下。.git は写さない）。
 *   取得した層は実行の後に消えるので、プロジェクトと層の commit ごとに写して持ち、使うものが無くなったら消す。
 */

/** 最後に使ってから止めるまでの既定の間。 */
const IDLE_MS = 30 * 60_000;
/** 止めるものを確かめる間隔。 */
const SWEEP_MS = 60_000;
/**
 * 実行の前に準備を待つ上限の既定（秒）。npx・uvx の初回の取得に時間がかかるので、エージェントの既定より長めにする。
 * startup_timeout_sec がこれより長ければ、それまで待つ。
 */
export const CONTEXT_MCP_READY_SEC = 120;

type Entry = {
  key: string;
  /** 同じプロジェクト・同じ名前（新しい中身が使われたら、古いものは止める）。 */
  group: string;
  spec: HostMcpSpec;
  /** 層の写しの識別（プロジェクトと層の commit）と、そのディレクトリ。 */
  layerId: string;
  layerDir: string;
  /** 使っている実行の数。 */
  leases: number;
  /** 最後に使い終えた時刻。 */
  lastUsed: number;
  /** 使い始めた順（同じ group の中で、新しいものを決める）。 */
  seq: number;
};

/** 実行が使う、ホストで動かすコンテキストの MCP サーバー。release は実行が終わったら1回だけ呼ぶ。 */
export type ContextMcpLease = {
  /** ゲートウェイの実行の登録に渡す、mcp.yaml の名前とゲートウェイの中の名前。 */
  relays: HostedMcpRelay[];
  /** 準備を待つ名前（ゲートウェイの中の名前）。 */
  keys: string[];
  release: () => void;
};

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * ディレクトリを消す。消せなければ、中のディレクトリを書き込めるようにしてから消し直す（MCP サーバーが作業ディレクトリの
 * 中の権限を変えることがあるため）。シンボリックリンクはたどらない（リンクそのものを消す）。それでも消せなければ例外。
 */
export function forceRemove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 権限を直してから、もう一度消す
  }
  const writable = (path: string) => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    try {
      chmodSync(path, 0o700);
    } catch {
      // 直せないものは、そのまま（消すときに失敗を知らせる）
    }
    let names: string[] = [];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) writable(join(path, name));
  };
  writable(dir);
  rmSync(dir, { recursive: true, force: true });
}

export class ContextMcpServers {
  private readonly entries = new Map<string, Entry>();
  private readonly servers: HostMcpServers;
  private sweepTimer: NodeJS.Timeout | undefined;
  private seq = 0;
  private stopped = false;
  private readonly layersRoot: string;

  constructor(
    private readonly deps: {
      /** 層の写しを置くディレクトリ（SACTY_HOME/context-mcp）。 */
      root: string;
      secrets: SecretStore;
      processes?: HostMcpProcesses;
      connect?: HostMcpConnector;
      /** 使われなくなってから止めるまで（テストでは短くする）。 */
      idleMs?: number;
      retryMs?: number;
      readyWaitMs?: number;
      now?: () => number;
      /** ディレクトリを消す（テストでは失敗させる）。既定は forceRemove。 */
      remove?: (dir: string) => void;
      log?: (line: string) => void;
    },
  ) {
    this.layersRoot = join(deps.root, "layers");
    this.servers = new HostMcpServers({
      specs: () => [...this.entries.values()].map((e) => e.spec),
      secrets: deps.secrets,
      ...(deps.connect ? { connect: deps.connect } : {}),
      ...(deps.retryMs !== undefined ? { retryMs: deps.retryMs } : {}),
      ...(deps.readyWaitMs !== undefined ? { readyWaitMs: deps.readyWaitMs } : {}),
      ...(deps.processes ? { processes: deps.processes } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * 前回の残りの層の写しを消し（デーモンの起動時。プロセスは、ホストの MCP サーバーの片付けで止めてある）、使われなく
   * なったものを止める確かめを始める。
   */
  start(): void {
    // 消せなかったもの（消せない権限のもの）は、ログに残して進める（新しい写しは、毎回違う名前で作るので混ざらない）
    this.tryRemove(this.layersRoot);
    this.servers.start();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** すべて止める（デーモンの終了）。層の写しも消す。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.entries.clear();
    try {
      await this.servers.stop();
    } finally {
      // 消せなかったものは、次の起動の片付けで消す
      this.tryRemove(this.layersRoot);
    }
  }

  /**
   * 実行が使う MCP サーバーを確保する（まだ起動していなければ、次の ready で起動する）。層の写しは、ここで作る（取得した
   * 層は実行の後に消えるため）。
   */
  lease(projectId: string, servers: readonly HostedContextMcp[]): ContextMcpLease {
    if (this.stopped) return { relays: [], keys: [], release: () => {} };
    // 先にすべてを確かめて用意し（層の写しを含む。ここでは、持っている状態を何も変えない）、すべて用意できてから、まとめて
    // 確定する（確定は例外にならない）。途中で失敗したら、この呼び出しで写した層だけを消す。使っている実行の数・順序
    // （seq）・最後に使った時刻・持っている層の写しの一覧は、失敗した確保では変わらない（PR #89 レビュー指摘）
    const copied: string[] = [];
    let planned: Entry[];
    try {
      planned = this.prepare(projectId, servers, copied);
    } catch (error) {
      for (const dir of copied) this.discard(dir);
      throw error;
    }
    // 確定する
    for (const entry of planned) {
      if (!this.entries.has(entry.key)) this.entries.set(entry.key, entry);
      this.layerDirs.add(entry.layerDir);
      this.copies.set(entry.layerId, entry.layerDir);
      entry.leases += 1;
      entry.seq = ++this.seq;
    }
    // 新しい中身が使われたので、古くなった（使っている実行が無い）ものを止める。後片付けの失敗は、確保の失敗にしない
    // （sweep は例外にならない。PR #89 再レビュー指摘）
    this.sweep();
    let released = false;
    return {
      relays: planned.map((e, i) => ({ name: servers[i]?.name ?? "", host: e.key })),
      keys: planned.map((e) => e.key),
      release: () => {
        if (released) return;
        released = true;
        for (const e of planned) {
          e.leases = Math.max(0, e.leases - 1);
          e.lastUsed = this.now();
        }
        this.sweep();
      },
    };
  }

  /**
   * サーバーごとに、使う Entry を返す（あるものはそのまま、無いものは新しく作るが、まだ足さない）。持っている状態は変えない。
   * 新しく写した層のディレクトリは copied に入れる（失敗したときに消すため）。
   */
  private prepare(
    projectId: string,
    servers: readonly HostedContextMcp[],
    copied: string[],
  ): Entry[] {
    const fresh = new Map<string, Entry>();
    const freshCopies = new Map<string, string>();
    return servers.map((server) => {
      const layer = {
        repo: server.layer.repo,
        ...(server.layer.ref ? { ref: server.layer.ref } : {}),
        commit: server.layer.commit,
      };
      const content = {
        projectId,
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
        layer,
        startup_timeout_sec: server.startup_timeout_sec,
        tool_timeout_sec: server.tool_timeout_sec,
      };
      const key = `ctx-${sha(content).slice(0, 24)}`;
      const existing = this.entries.get(key) ?? fresh.get(key);
      if (existing) return existing;
      const layerId = sha({ projectId, ...layer }).slice(0, 24);
      const layerDir = this.copyLayer(layerId, server.layer.dir, freshCopies, copied);
      const entry: Entry = {
        key,
        group: sha({ projectId, name: server.name }),
        spec: {
          name: key,
          command: server.command,
          args: server.args,
          env: server.env,
          description: "",
          readyTimeoutSec: Math.max(CONTEXT_MCP_READY_SEC, server.startup_timeout_sec ?? 0),
          ...(server.startup_timeout_sec !== undefined
            ? { startupTimeoutSec: server.startup_timeout_sec }
            : {}),
          ...(server.tool_timeout_sec !== undefined
            ? { toolTimeoutSec: server.tool_timeout_sec }
            : {}),
          cwd: layerDir,
          context: { name: server.name, from: server.from },
        },
        layerId,
        layerDir,
        leases: 0,
        lastUsed: this.now(),
        seq: 0,
      };
      fresh.set(key, entry);
      return entry;
    });
  }

  /** 確保したものの準備を待つ（PBI-77 と同じ。上限あり）。準備ができないものの理由（どの MCP サーバーか）を返す。 */
  ready(keys: readonly string[]): Promise<DaemonMessage[]> {
    return this.servers.ready(keys);
  }

  /** ゲートウェイからの中継（key は、実行の登録で結びつけたもの）。 */
  handle(key: string, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    return this.servers.handle(key, req, res, body);
  }

  /** いま動かしている（確保している）ものの数と、使っている実行の数（テスト・ログ用）。 */
  running(): { key: string; name: string; leases: number }[] {
    return [...this.entries.values()].map((e) => ({
      key: e.key,
      name: e.spec.context?.name ?? e.key,
      leases: e.leases,
    }));
  }

  /** 起動し直した回数（テスト用）。 */
  restarts(key: string): number {
    return this.servers.restarts(key);
  }

  /** 使っている実行が無く、古くなった・しばらく使われていないものを止め、使うものの無い層の写しを消す。 */
  sweep(): void {
    if (this.stopped) return;
    // 確保・解放・定期の確かめから呼ぶので、例外にしない（後片付けの失敗は、ログに残して次の sweep でやり直す）
    try {
      this.stopUnused();
    } catch (error) {
      this.deps.log?.(
        `[gateway] context MCP: cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // 止める途中で失敗しても、使うものの無い写しは消す（消せなかったものは、やり直す）
    this.removeUnusedLayers();
    this.retryDiscarded();
  }

  /** 使っている実行が無く、古くなった・しばらく使われていないものを止め、使うものの無い層の写しを消す。 */
  private stopUnused(): void {
    const now = this.now();
    const idle = this.deps.idleMs ?? IDLE_MS;
    const newest = new Map<string, number>();
    for (const e of this.entries.values()) {
      newest.set(e.group, Math.max(newest.get(e.group) ?? 0, e.seq));
    }
    let removed = false;
    for (const e of [...this.entries.values()]) {
      if (e.leases > 0) continue;
      const superseded = (newest.get(e.group) ?? 0) > e.seq;
      if (superseded || now - e.lastUsed >= idle) {
        this.entries.delete(e.key);
        removed = true;
        this.deps.log?.(
          `[gateway] context MCP ${e.spec.context?.name}: stopping (${superseded ? "the content changed" : "not used"})`,
        );
      }
    }
    if (!removed) return;
    // 設定と合わせる（消したものを止める）
    this.servers.reconcile();
    this.removeUnusedLayers();
  }

  /** 使うものの無い層の写しを消す（消せなければ、後でやり直す）。 */
  private removeUnusedLayers(): void {
    const usedDirs = new Set([...this.entries.values()].map((e) => e.layerDir));
    for (const dir of [...this.layerDirs]) {
      if (usedDirs.has(dir)) continue;
      this.layerDirs.delete(dir);
      for (const [id, copy] of this.copies) if (copy === dir) this.copies.delete(id);
      this.discard(dir);
    }
  }

  /** 持っている層の写し（使っているものと、まだ消していないもの）。 */
  private readonly layerDirs = new Set<string>();
  /** 層の写しの識別ごとの、使い回すディレクトリ。 */
  private readonly copies = new Map<string, string>();
  /** 消せなかった写し（次の sweep・終了・次の起動の片付けで消す）。 */
  private readonly discarded = new Set<string>();

  /** もう使わない写しを消す。消せなければ、後でやり直すよう覚えておく（使い回さない）。 */
  private discard(dir: string): void {
    if (this.tryRemove(dir)) return;
    if (!this.discarded.has(dir)) {
      this.discarded.add(dir);
      this.deps.log?.(`[gateway] context MCP: could not remove ${dir}; retrying later`);
    }
  }

  /** 消せなかった写しを、もう一度消す。 */
  private retryDiscarded(): void {
    for (const dir of [...this.discarded]) {
      if (this.tryRemove(dir)) this.discarded.delete(dir);
    }
  }

  /** 消せなかったまま残っている写し（テスト用）。 */
  pendingRemovals(): string[] {
    return [...this.discarded];
  }

  /**
   * 層の写しの置き場（SACTY_HOME/context-mcp/layers）の中のものだけを消す（外は消さない）。例外にせず、消せたかを返す。
   */
  private tryRemove(dir: string): boolean {
    const rel = relative(this.layersRoot, dir);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    try {
      (this.deps.remove ?? forceRemove)(dir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 層のリポジトリを、プロジェクトと commit ごとに写す（あれば使い回す。.git は写さない）。新しく写したら copied に入れる。
   * 持っている状態（写しの一覧）は変えない（確保を確定するときに足す）。
   */
  private copyLayer(
    layerId: string,
    from: string,
    freshCopies: Map<string, string>,
    copied: string[],
  ): string {
    const existing = this.copies.get(layerId) ?? freshCopies.get(layerId);
    if (existing && existsSync(existing)) return existing;
    // 写しは毎回違う名前にする（消しきれなかった古い写しを、使い回さない）
    const dir = join(this.layersRoot, `${layerId}-${randomUUID().slice(0, 8)}`);
    mkdirSync(this.layersRoot, { recursive: true });
    const tmp = `${dir}.tmp`;
    try {
      cpSync(from, tmp, {
        recursive: true,
        filter: (src) => !/(^|[/\\])\.git$/.test(src),
      });
      renameSync(tmp, dir);
    } catch (error) {
      // 途中まで写したものを残さない
      this.discard(tmp);
      throw error;
    }
    freshCopies.set(layerId, dir);
    copied.push(dir);
    return dir;
  }
}
