import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
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
    rmSync(this.layersRoot, { recursive: true, force: true });
    this.servers.start();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** すべて止める（デーモンの終了）。層の写しも消す。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.entries.clear();
    await this.servers.stop();
    rmSync(this.layersRoot, { recursive: true, force: true });
  }

  /**
   * 実行が使う MCP サーバーを確保する（まだ起動していなければ、次の ready で起動する）。層の写しは、ここで作る（取得した
   * 層は実行の後に消えるため）。
   */
  lease(projectId: string, servers: readonly HostedContextMcp[]): ContextMcpLease {
    if (this.stopped) return { relays: [], keys: [], release: () => {} };
    const used: Entry[] = [];
    // 途中で失敗したら（層の写しの失敗など）、ここまでの確保を巻き戻す（使っている実行の数を戻し、この呼び出しで足した
    // ものは消す。足したものは、まだ起動していない。PR #89 レビュー指摘）
    const created: Entry[] = [];
    try {
      this.acquire(projectId, servers, used, created);
    } catch (error) {
      for (const e of used) e.leases = Math.max(0, e.leases - 1);
      for (const e of created) {
        if (e.leases === 0 && this.entries.get(e.key) === e) this.entries.delete(e.key);
      }
      this.removeUnusedLayers();
      throw error;
    }
    // 新しい中身が使われたので、古くなった（使っている実行が無い）ものを止める
    this.sweep();
    let released = false;
    return {
      relays: used.map((e, i) => ({ name: servers[i]?.name ?? "", host: e.key })),
      keys: used.map((e) => e.key),
      release: () => {
        if (released) return;
        released = true;
        for (const e of used) {
          e.leases = Math.max(0, e.leases - 1);
          e.lastUsed = this.now();
        }
        this.sweep();
      },
    };
  }

  /** サーバーごとに確保する（used に確保したもの、created にこの呼び出しで足したものを入れる）。 */
  private acquire(
    projectId: string,
    servers: readonly HostedContextMcp[],
    used: Entry[],
    created: Entry[],
  ): void {
    for (const server of servers) {
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
      let entry = this.entries.get(key);
      if (!entry) {
        const layerDir = this.copyLayer(projectId, layer, server.layer.dir);
        entry = {
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
          layerDir,
          leases: 0,
          lastUsed: this.now(),
          seq: 0,
        };
        this.entries.set(key, entry);
        created.push(entry);
      }
      entry.leases += 1;
      entry.seq = ++this.seq;
      used.push(entry);
    }
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

  /** 使うものの無い層の写しを消す。 */
  private removeUnusedLayers(): void {
    const usedDirs = new Set([...this.entries.values()].map((e) => e.layerDir));
    for (const dir of this.layerDirs) {
      if (!usedDirs.has(dir)) {
        rmSync(dir, { recursive: true, force: true });
        this.layerDirs.delete(dir);
      }
    }
  }

  private readonly layerDirs = new Set<string>();

  /** 層のリポジトリを、プロジェクトと commit ごとに写す（あれば使い回す。.git は写さない）。 */
  private copyLayer(
    projectId: string,
    layer: { repo: string; ref?: string; commit: string },
    from: string,
  ): string {
    const dir = join(this.layersRoot, sha({ projectId, ...layer }).slice(0, 24));
    if (!existsSync(dir)) {
      mkdirSync(this.layersRoot, { recursive: true });
      const tmp = `${dir}.tmp-${process.pid}-${this.seq}`;
      rmSync(tmp, { recursive: true, force: true });
      try {
        cpSync(from, tmp, {
          recursive: true,
          filter: (src) => !/(^|[/\\])\.git$/.test(src),
        });
        renameSync(tmp, dir);
      } catch (error) {
        // 途中まで写したものを残さない
        rmSync(tmp, { recursive: true, force: true });
        throw error;
      }
    }
    this.layerDirs.add(dir);
    return dir;
  }
}
