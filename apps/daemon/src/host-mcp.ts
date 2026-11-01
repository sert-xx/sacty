import { accessSync, constants, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { code, type DaemonMessage, type DaemonText, message, renderMessage } from "@sacty/core";
import { z } from "zod";
import { McpTimeouts } from "./context.js";
import { errorText } from "./errors.js";
import { GroupStdioTransport, HostMcpProcesses } from "./host-mcp-processes.js";
import { hideSecret } from "./platforms.js";
import { SecretRef, type SecretStore } from "./secrets.js";

/**
 * ホストで動かす MCP サーバー（PBI-36）。起動時にブラウザで認証する（Okta など）手元のコマンドの MCP サーバーを、
 * ゲートウェイがホストで起動して持ち続け、エージェントのコンテナには HTTP の MCP として中継する。
 *
 * 認証には有効期限があるので、決めた間隔で期限の前に起動し直す（新しいプロセスの準備ができてから切り替え、
 * 古いプロセスを止める）。プロセスが終わった・ツールが認証エラーを返したときも起動し直す。ブラウザでの承認は
 * 人の操作を待たない（Chrome の拡張で自動化している前提）。起動し直しても準備ができなければ、理由を画面に出す。
 */

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, code("input.envName"));

export const HostMcpFile = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  /** 環境変数。秘密情報は名前か 1Password の参照で書き、値は起動するときにだけ入れる。 */
  env: z
    .record(
      EnvName,
      z.union([
        z.string(),
        z.object({ secret: SecretRef, prefix: z.string().default("") }).strict(),
      ]),
    )
    .default({}),
  /** エージェントに伝える、MCP サーバーの説明。 */
  description: z.string().default(""),
  /** 認証の期限の前に起動し直す間隔（分）。期限より短くする。書かなければ、期限切れに気づいたときだけ起動し直す。 */
  restart_every_min: z.number().int().min(1).max(10_080).optional(),
  /** 起動してから準備ができる（認証が済む）まで待つ上限（秒）。 */
  ready_timeout_sec: z.number().int().min(5).max(3_600).default(300),
  /**
   * エージェントが、ゲートウェイ経由のこの MCP サーバーの起動（初期化とツールの一覧）・ツールの呼び出しを待つ上限（秒。
   * PBI-75）。コンテキストの mcp.yaml と同じ意味で、ゲートウェイの中継もこれより先に切らない。
   */
  ...McpTimeouts,
});

export type HostMcpSpec = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string | { secret: string; prefix: string }>;
  description: string;
  restartEveryMin?: number;
  readyTimeoutSec: number;
  /** エージェントに渡す時間切れ（秒。PBI-75）。変えても MCP サーバーは起動し直さない。 */
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  /** 作業ディレクトリ（書かなければデーモンのもの。PBI-84）。相対パスのコマンドも、ここから探す。 */
  cwd?: string;
  /**
   * コンテキストの mcp.yaml の MCP サーバー（PBI-84）。name はゲートウェイの中の名前（プロジェクトと中身ごと）なので、
   * 理由（画面・作業履歴・エージェントへの 503）とログには、mcp.yaml の名前・層・プロジェクトを出す（PBI-92）。
   */
  context?: HostMcpContext;
};

/** コンテキストの MCP サーバーの出どころ（PBI-84・92）。設定で探せる名前と、どのプロジェクト・層のものか。 */
export type HostMcpContext = {
  /** mcp.yaml の名前。 */
  name: string;
  /** 層（リポジトリ#ref@commit）。 */
  from: string;
  /** どのプロジェクトのものか（同じ層・同じ名前のものが、プロジェクトごとにある）。 */
  project: { id: string; name: string };
};

/**
 * ログに出す MCP サーバーの名前（PBI-92）。ホストの MCP サーバーは config.yaml の名前。コンテキストの MCP サーバーは、
 * ゲートウェイの中の名前（ctx-…）だけでは設定で探せないので、mcp.yaml の名前・プロジェクト・層を出し、中の名前を添える。
 */
export function mcpLogName(spec: Pick<HostMcpSpec, "name" | "context">): string {
  const c = spec.context;
  if (!c) return `host MCP ${spec.name}`;
  return `context MCP ${JSON.stringify(c.name)} (project ${JSON.stringify(c.project.name)} [${c.project.id}], context ${JSON.stringify(c.from)}, internal ${spec.name})`;
}

/** 理由（DaemonMessage）の引数にする、コンテキストの MCP サーバーの出どころ。 */
const contextParams = (c: HostMcpContext) => ({
  name: c.name,
  from: c.from,
  project: c.project.name,
});

export function toHostMcp(name: string, file: z.infer<typeof HostMcpFile>): HostMcpSpec {
  return {
    name,
    command: file.command,
    args: file.args,
    env: file.env,
    description: file.description,
    ...(file.restart_every_min ? { restartEveryMin: file.restart_every_min } : {}),
    readyTimeoutSec: file.ready_timeout_sec,
    ...(file.startup_timeout_sec !== undefined
      ? { startupTimeoutSec: file.startup_timeout_sec }
      : {}),
    ...(file.tool_timeout_sec !== undefined ? { toolTimeoutSec: file.tool_timeout_sec } : {}),
  };
}

/**
 * MCP サーバーを起動し直すかを決める設定（エージェントに渡す時間切れは、起動し直さずに変える。PBI-75）。出どころ（context）は
 * 表示だけに使うので含めない（プロジェクトの名前を変えても起動し直さない。PBI-92）。
 */
const processKey = ({ startupTimeoutSec, toolTimeoutSec, context, ...spec }: HostMcpSpec) =>
  JSON.stringify(spec);

/** 起動した MCP サーバーへの接続。 */
export type HostMcpConnection = {
  client: Pick<
    Client,
    | "getServerCapabilities"
    | "listTools"
    | "callTool"
    | "listResources"
    | "listResourceTemplates"
    | "readResource"
    | "listPrompts"
    | "getPrompt"
  >;
  close: () => Promise<void>;
  /** プロセスが終わったら呼ばれる。 */
  onClose: (callback: () => void) => void;
};

/** MCP サーバーを起動して、準備（MCP の初期化）ができるまで待つ。テストでは差し替える。 */
export type HostMcpConnector = (
  spec: HostMcpSpec,
  env: Record<string, string>,
) => Promise<HostMcpConnection>;

/** ツールの結果が、認証の期限切れらしいか。 */
const AUTH_ERROR =
  /\b401\b|unauthori[sz]ed|unauthenticated|not authenticated|authentication (failed|required|expired)|(token|session|credentials?) (has |have )?expired|expired (token|session)|re-?authenticate|please (log|sign) ?in|login required/i;

/** 準備ができないときに、起動し直すまでの間。 */
const RETRY_MS = 60_000;
/** ツールの呼び出しを待つ上限（SDK の既定の60秒では、時間のかかるツールが切れるため）。 */
export const CALL_TIMEOUT_MS = 10 * 60_000;
/** 一覧（ツール・リソース・プロンプト）を待つ上限の既定（SDK の既定）。 */
export const LIST_TIMEOUT_MS = 60_000;
/** 切り替えた古いプロセスで、途中の呼び出しが終わるのを待つ上限。 */
const DRAIN_MS = 5 * 60_000;
/** 標準エラーを持っておく長さ（理由には、秘密情報を伏せた後の末尾だけを添える）。 */
const STDERR_KEEP = 64 * 1024;
/** 準備ができなかった理由に添える標準エラーの末尾と、理由の長さの上限。 */
const STDERR_IN_REASON = 300;
const REASON_MAX = 600;

/** 起動するコマンドがホストに無い（PBI-84）。 */
export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`the command "${command}" was not found on the host`);
  }
}

/**
 * コマンドがホストにあるか（PBI-84）。/ を含むものは作業ディレクトリから、ほかは PATH から探す（spawn と同じ）。
 * 実行できるファイルが無ければ CommandNotFoundError。
 */
export function assertCommand(command: string, cwd: string | undefined, path: string | undefined) {
  const executable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/")) {
    const file = isAbsolute(command) ? command : resolve(cwd ?? process.cwd(), command);
    if (executable(file)) return;
  } else {
    for (const dir of (path ?? "").split(delimiter)) {
      if (
        dir &&
        executable(join(isAbsolute(dir) ? dir : resolve(cwd ?? process.cwd(), dir), command))
      ) {
        return;
      }
    }
  }
  throw new CommandNotFoundError(command);
}

/** 起動できなかった（標準エラーの末尾を、伏せる前の形で持つ）。 */
export class StartError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/**
 * 手元のコマンドを起動し（ブラウザを開けるよう、ホストの環境変数を引き継ぐ）、MCP の初期化を待つ。プロセスは自分の
 * グループで起動し、止めるときは子孫ごと止める（PBI-78）。
 */
const stdioConnector =
  (processes: HostMcpProcesses): HostMcpConnector =>
  async (spec, env) => {
    const merged = { ...(process.env as Record<string, string>), ...env };
    // コマンドがホストに無い（npx・uvx などを入れていない）ときは、起動する前に、わかる理由にする（PBI-84）
    assertCommand(spec.command, spec.cwd, merged.PATH);
    const transport = new GroupStdioTransport(
      {
        // 記録・後片付けのログで、どの MCP サーバーのものかわかる名前（PBI-92）
        name: mcpLogName(spec),
        command: spec.command,
        args: spec.args,
        env: merged,
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
      },
      processes,
    );
    // 標準エラーは読み捨てる（詰まらせない）。末尾は、準備ができなかった理由に添える。秘密情報を伏せる前に短く
    // 切ると一部が残るので、十分な長さを持っておき、伏せるのは理由を作るとき（呼び出し元）にする
    let tail = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      tail = `${tail}${chunk.toString()}`.slice(-STDERR_KEEP);
    });
    const client = new Client({ name: "sacty-gateway", version: "1.15.0" });
    try {
      await withTimeout(client.connect(transport), spec.readyTimeoutSec * 1000, "initialize");
    } catch (error) {
      await client.close().catch(() => {});
      const detail = error instanceof Error ? error.message : String(error);
      throw new StartError(detail, tail.trim());
    }
    // ラッパーのコマンドが起動した子孫も記録する（デーモンが突然落ちても、次の起動で片付けられるように）
    void processes.refresh();
    return {
      client,
      close: () => client.close(),
      // プロセスが終わると、クライアントが閉じる（transport.onclose はクライアントが使うので、上書きしない）
      onClose: (callback) => {
        client.onclose = callback;
      },
    };
  };

type State = {
  spec: HostMcpSpec;
  key: string;
  current?: HostMcpConnection;
  /** いまの接続を起動したときの設定（設定を変えて起動し直している途中は、key と違う。PBI-77 レビュー指摘）。 */
  currentKey?: string;
  starting?: Promise<void>;
  /** 起動中のプロセスの設定（起動の途中で設定が変わったら、終わった後に起動し直す）。 */
  startingKey?: string;
  problem?: DaemonMessage;
  /**
   * いまの接続の認証が切れたらしい（ツールが認証エラーを返した）。起動し直して準備ができるまで、新しい呼び出しには
   * 使わない（準備ができていないと返す）。
   */
  expired?: boolean;
  timer?: NodeJS.Timeout;
  /** 起動し直した回数（作業履歴ではなく、画面・ログ・テストで確かめる）。 */
  restarts: number;
};

export class HostMcpServers {
  private readonly states = new Map<string, State>();
  /** 接続ごとの、途中の呼び出しの数（切り替えた古いプロセスは、これが0になってから止める）。 */
  private readonly inFlight = new Map<HostMcpConnection, number>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly processes: HostMcpProcesses;

  constructor(
    private readonly deps: {
      specs: () => readonly HostMcpSpec[];
      secrets: SecretStore;
      connect?: HostMcpConnector;
      /** 準備ができないときに、起動し直すまでの間（テストでは短くする）。 */
      retryMs?: number;
      /** 起動し直す間隔の1分の長さ（テストでは短くする）。 */
      minuteMs?: number;
      /** 切り替えた古いプロセスで、途中の呼び出しを待つ上限（テストでは短くする）。 */
      drainMs?: number;
      /** 実行の前に、準備を待つ上限（テストでは短くする。既定は MCP サーバーごとの ready_timeout_sec。PBI-77）。 */
      readyWaitMs?: number;
      /** 起動したプロセスの記録と後始末（PBI-78）。書かなければ、記録せずに止めるだけ。 */
      processes?: HostMcpProcesses;
      log?: (line: string) => void;
    },
  ) {
    this.processes = deps.processes ?? new HostMcpProcesses();
  }

  /** 設定の MCP サーバーを起動する。設定が変わったら（30秒ごとに確かめる）、足す・止める・起動し直す。 */
  start(): void {
    this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), 30_000);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await Promise.all([...this.states.keys()].map((name) => this.remove(name)));
    // 起動の途中のもの・切り替えた古いもの（途中の呼び出しを待っているもの）も含めて、起動したプロセスを子孫ごと止める
    await this.processes.endAll();
  }

  /** 設定と、動かしている MCP サーバーを合わせる。 */
  reconcile(): void {
    if (this.stopped) return;
    const specs = this.deps.specs();
    for (const name of this.states.keys()) {
      if (!specs.some((s) => s.name === name)) void this.remove(name);
    }
    for (const spec of specs) {
      const key = processKey(spec);
      const state = this.states.get(spec.name);
      if (state && state.key === key) {
        // エージェントに渡す時間切れだけが変わったなら、起動し直さずに使う
        state.spec = spec;
        continue;
      }
      if (state) {
        state.spec = spec;
        state.key = key;
      } else {
        this.states.set(spec.name, { spec, key, restarts: 0 });
      }
      void this.restart(spec.name, state ? "the settings changed" : "start");
    }
  }

  /**
   * 実行の前に、その実行が使う MCP サーバーの準備を待つ（PBI-77）。先に設定と突き合わせ（足したものを起動し、消したものを
   * 止める。30秒ごとの突き合わせを待たない）、起動・再認証の途中のものは準備ができるまで待つ。待つのは MCP サーバーごとに
   * 準備を待つ上限（ready_timeout_sec）まで。同じ MCP サーバーの起動は、並行する実行で共有する（起動し直さない）。
   * 準備ができないものの理由（どの MCP サーバーか）を返す。起動に失敗して、起動し直すのを待っているものは待たない。
   */
  async ready(names: readonly string[]): Promise<DaemonMessage[]> {
    this.reconcile();
    const problems = await Promise.all(names.map((name) => this.readyOne(name)));
    return problems.flatMap((p) => (p ? [p] : []));
  }

  private async readyOne(name: string): Promise<DaemonMessage | undefined> {
    const first = this.states.get(name);
    if (!first) return unavailable({ name }, "not configured");
    const limitMs = this.deps.readyWaitMs ?? first.spec.readyTimeoutSec * 1000;
    const deadline = Date.now() + limitMs;
    // いまの設定で起動した接続だけを、準備ができたとみなす（command・args・env などを変えて起動し直している途中の、
    // 古い設定の接続では先に進まない。時間切れの値だけの変更では key は変わらない。PBI-75）
    const usable = (s: State) => !!s.current && !s.expired && s.currentKey === s.key;
    for (;;) {
      const state = this.states.get(name);
      if (!state) return unavailable(first.spec, "not configured");
      if (usable(state)) return undefined;
      // 起動の途中でなければ（起動に失敗して、起動し直すのを待っている）、待たずに理由を返す
      if (!state.starting) {
        return (
          state.problem ??
          unavailable(
            state.spec,
            state.current ? "not restarted with the changed settings" : "not started",
          )
        );
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const seconds = Math.round(limitMs / 1000);
        return state.spec.context
          ? message("context.mcpHostReadyTimeout", {
              ...contextParams(state.spec.context),
              seconds,
            })
          : message("gateway.mcpReadyTimeout", { name, seconds });
      }
      // 起動が終わる（終わった後に設定の変更で起動し直すなら、それも待つ）か、上限の時間が経つまで待つ
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        state.starting.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /** 動かしている MCP サーバーの名前と説明。 */
  servers(): { name: string; description: string }[] {
    return [...this.states.values()].map((s) => ({
      name: s.spec.name,
      description: s.spec.description,
    }));
  }

  /** 準備ができていない MCP サーバーの理由（画面の状態に出す）。 */
  problems(): DaemonText[] {
    return [...this.states.values()].flatMap((s) => (s.problem ? [s.problem] : []));
  }

  /** 起動し直した回数。 */
  restarts(name: string): number {
    return this.states.get(name)?.restarts ?? 0;
  }

  /**
   * 起動し直す。新しいプロセスの準備ができてから切り替え、古いプロセスを止める（使っている途中の呼び出しを
   * なるべく止めない）。起動し直している最中なら、それを待つ。
   */
  restart(name: string, reason: string): Promise<void> {
    const state = this.states.get(name);
    if (!state || this.stopped) return Promise.resolve();
    if (state.starting) return state.starting;
    if (state.timer) clearTimeout(state.timer);
    this.deps.log?.(`[gateway] ${mcpLogName(state.spec)}: starting (${reason})`);
    const spec = state.spec;
    const startingKey = state.key;
    state.startingKey = startingKey;
    state.starting = (async () => {
      let next: HostMcpConnection | undefined;
      const secrets: string[] = [];
      try {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(spec.env)) {
          if (typeof value === "string") {
            env[key] = value;
            continue;
          }
          const secret = await this.deps.secrets.get(value.secret);
          secrets.push(secret, `${value.prefix}${secret}`);
          env[key] = `${value.prefix}${secret}`;
        }
        next = await (this.deps.connect ?? stdioConnector(this.processes))(spec, env);
      } catch (error) {
        // 理由（画面・ログ・エージェントへの 503）には、秘密情報を伏せてから切り詰めたものだけを出す
        // （MCP サーバーが認証の失敗で秘密情報を標準エラーに出すこともある。PBI-36 レビュー指摘）
        const detail = startFailure(error, secrets);
        state.problem =
          error instanceof CommandNotFoundError && spec.context
            ? message("context.mcpHostCommandMissing", {
                ...contextParams(spec.context),
                command: error.command,
              })
            : unavailable(spec, detail);
        this.deps.log?.(`[gateway] ${mcpLogName(spec)}: not ready: ${detail}`);
        state.timer = setTimeout(
          () => void this.restart(name, "retry"),
          this.deps.retryMs ?? RETRY_MS,
        );
        state.timer.unref?.();
        return;
      }
      const connection = next;
      if (this.stopped || this.states.get(name) !== state) {
        await connection.close().catch(() => {});
        return;
      }
      const old = state.current;
      state.current = connection;
      state.currentKey = startingKey;
      state.expired = false;
      state.problem = undefined;
      state.restarts += reason === "start" ? 0 : 1;
      // プロセスが終わったら（期限切れで終わる MCP サーバーもある）、起動し直す
      connection.onClose(() => {
        if (state.current === connection && !this.stopped) {
          state.current = undefined;
          void this.restart(name, "the process exited");
        }
      });
      // 古いプロセスは、途中の呼び出しが終わってから止める（待つ間も、新しい呼び出しは新しいプロセスへ）
      if (old) void this.drain(old);
      // 認証の期限の前に、決めた間隔で起動し直す
      if (spec.restartEveryMin) {
        state.timer = setTimeout(
          () => void this.restart(name, "before the authentication expires"),
          spec.restartEveryMin * (this.deps.minuteMs ?? 60_000),
        );
        state.timer.unref?.();
      }
    })().finally(() => {
      state.starting = undefined;
      // 起動の途中で設定が変わったなら、新しい設定で起動し直す
      if (state.startingKey !== state.key && this.states.get(name) === state && !this.stopped) {
        void this.restart(name, "the settings changed");
      }
    });
    return state.starting;
  }

  /** 途中の呼び出しが終わる（または上限の時間が経つ）のを待ってから、接続を止める。 */
  private async drain(connection: HostMcpConnection): Promise<void> {
    const deadline = Date.now() + (this.deps.drainMs ?? DRAIN_MS);
    while ((this.inFlight.get(connection) ?? 0) > 0 && Date.now() < deadline && !this.stopped) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.inFlight.delete(connection);
    await connection.close().catch(() => {});
  }

  private async remove(name: string): Promise<void> {
    const state = this.states.get(name);
    if (!state) return;
    this.states.delete(name);
    if (state.timer) clearTimeout(state.timer);
    await state.current?.close().catch(() => {});
  }

  /**
   * エージェントからの HTTP の MCP のリクエストを、ホストの MCP サーバーに中継する（JSON で返す。セッションは
   * 持たない）。準備ができていなければ、そのことを返す。
   */
  async handle(
    name: string,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const state = this.states.get(name);
    // 認証が切れた接続は、起動し直して準備ができるまで使わない（PBI-36 レビュー指摘）
    const connection = state?.expired ? undefined : state?.current;
    if (!state || !connection) {
      const reason = state?.problem ? ` (${errorTextOf(state.problem)})` : "";
      // コンテキストの MCP サーバーは、エージェントにも mcp.yaml の名前と出どころを返す（中の名前は返さない。PBI-92）
      const context = state?.spec.context;
      const which = context
        ? `"${context.name}" (mcp.yaml of ${context.from}, project "${context.project.name}")`
        : `"${name}"`;
      res.writeHead(state ? 503 : 404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: state
              ? `sacty gateway: the MCP server ${which} is not ready (it is starting or re-authenticating)${reason}. Try again later.`
              : `sacty gateway: unknown MCP server "${name}"`,
          },
          id: null,
        }),
      );
      return;
    }
    const server = this.proxy(name, connection);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** ホストの MCP サーバーの機能を、そのまま見せる中継のサーバー。 */
  private proxy(name: string, connection: HostMcpConnection): Server {
    const client = connection.client;
    // エージェントに渡した時間切れより、ゲートウェイの中継が先に切れないようにする（PBI-75）
    const spec = this.states.get(name)?.spec;
    const callTimeout = Math.max(CALL_TIMEOUT_MS, (spec?.toolTimeoutSec ?? 0) * 1000);
    const listTimeout = Math.max(LIST_TIMEOUT_MS, (spec?.startupTimeoutSec ?? 0) * 1000);
    const list = { timeout: listTimeout };
    const capabilities = client.getServerCapabilities() ?? {};
    const server = new Server(
      { name: `sacty-gateway/${spec?.context?.name ?? name}`, version: "1.15.0" },
      {
        capabilities: {
          ...(capabilities.tools ? { tools: {} } : {}),
          ...(capabilities.resources ? { resources: {} } : {}),
          ...(capabilities.prompts ? { prompts: {} } : {}),
        },
      },
    );
    if (capabilities.tools) {
      server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params, list));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        this.inFlight.set(connection, (this.inFlight.get(connection) ?? 0) + 1);
        try {
          const result = await client.callTool(req.params, undefined, {
            timeout: callTimeout,
            resetTimeoutOnProgress: true,
          });
          if (result.isError && AUTH_ERROR.test(JSON.stringify(result.content ?? ""))) {
            // 認証の期限切れらしい。起動し直して再認証する（この呼び出しは、そのまま返す）。いまの接続でだけ、
            // 1回だけ起動し直す（起動し直しに失敗した後も、呼び出しのたびに起動し直さない。1分ごとに起動し直す）
            const state = this.states.get(name);
            if (state?.current === connection && !state.expired) {
              state.expired = true;
              void this.restart(name, "the tool reported an authentication error");
            }
            return {
              ...result,
              content: [
                ...((result.content as unknown[]) ?? []),
                {
                  type: "text",
                  text: "[sacty] The MCP server's authentication seems to have expired. sacty is restarting it to re-authenticate; retry this call in a minute.",
                },
              ],
            };
          }
          return result;
        } catch (error) {
          // いま使っている接続が切れた（プロセスが終わった）なら、起動し直す。切り替えた後の古い接続の失敗では
          // 起動し直さない（切り替えのたびに起動し直してしまうため）
          // 接続が切れた・認証が切れた（JSON-RPC のエラーとして返す MCP サーバーもある）ときだけ起動し直す。
          // ツールの誤り（引数の誤りなど）では起動し直さない（PBI-36 レビュー指摘）
          const closed = error instanceof McpError && error.code === ErrorCode.ConnectionClosed;
          const unauthorized = AUTH_ERROR.test(
            error instanceof Error ? error.message : String(error),
          );
          const state = this.states.get(name);
          if ((closed || unauthorized) && state?.current === connection && !state.expired) {
            state.expired = true;
            void this.restart(
              name,
              closed ? "the connection was closed" : "the tool reported an authentication error",
            );
          }
          throw error;
        } finally {
          const count = (this.inFlight.get(connection) ?? 1) - 1;
          if (count > 0) this.inFlight.set(connection, count);
          else this.inFlight.delete(connection);
        }
      });
    }
    if (capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, (req) =>
        client.listResources(req.params, list),
      );
      server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) =>
        client.listResourceTemplates(req.params, list),
      );
      server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params));
    }
    if (capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, (req) =>
        client.listPrompts(req.params, list),
      );
      server.setRequestHandler(GetPromptRequestSchema, (req) => client.getPrompt(req.params));
    }
    return server;
  }
}

/** 準備ができない理由（コンテキストの MCP サーバーは、mcp.yaml の名前と層で示す。PBI-84）。 */
function unavailable(spec: Pick<HostMcpSpec, "name" | "context">, detail: string): DaemonMessage {
  return spec.context
    ? message("context.mcpHostUnavailable", { ...contextParams(spec.context), detail })
    : message("gateway.mcpUnavailable", { name: spec.name, detail });
}

/** 起動できなかった理由。秘密情報を伏せてから、標準エラーの末尾を添えて切り詰める。 */
function startFailure(error: unknown, secrets: readonly string[]): string {
  const hide = (text: string) => secrets.reduce((t, secret) => hideSecret(t, secret), text);
  const raw = errorText(error);
  const detail = hide(typeof raw === "string" ? raw : renderMessage(raw, "ja"));
  const stderr =
    error instanceof StartError && error.stderr ? hide(error.stderr).slice(-STDERR_IN_REASON) : "";
  const reason = stderr ? `${detail} (stderr: ${stderr})` : detail;
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}…` : reason;
}

function errorTextOf(text: DaemonText): string {
  return typeof text === "string"
    ? text
    : typeof text.params?.detail === "string"
      ? text.params.detail
      : renderMessage(text, "en");
}
