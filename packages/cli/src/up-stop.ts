import type { ChildProcess } from "node:child_process";
import { FORCE_STOP_SIGNAL } from "@sacty/daemon/exit-codes";

/**
 * 止めるときに、子が残っていても待つ上限。デーモンは実行中の処理の後片付け（認証ファイルの書き戻しなど）に最大20秒
 * かけるので、それより長く待つ。
 */
export const STOP_TIMEOUT_MS = 30_000;
/** 待たずに止めるときに、子が残っていても待つ上限。 */
export const FORCE_STOP_TIMEOUT_MS = 5_000;

export const STOPPING_MESSAGE =
  "[sacty] 止めています。実行中の処理の後片付けを待ちます（最大30秒）。待たずに止めるには、もう一度 Ctrl+C を押してください。";
export const FORCE_STOPPING_MESSAGE = "[sacty] 後片付けを待たずに止めます。";

type Child = Pick<ChildProcess, "exitCode" | "signalCode" | "kill" | "once">;

/** `sacty up` の子プロセス（デーモンと画面）を止める。 */
export class UpStopper {
  private readonly children: { name: string; child: Child }[] = [];
  private code = 0;
  private forcing = false;
  private killTimer: NodeJS.Timeout | undefined;
  stopping = false;

  constructor(
    private readonly deps: {
      exit: (code: number) => void;
      log: (line: string) => void;
    },
  ) {}

  add(name: string, child: Child): void {
    this.children.push({ name, child });
  }

  private running() {
    return this.children.filter(
      ({ child }) => child.exitCode === null && child.signalCode === null,
    );
  }

  /** 子プロセスをすべて止め、止まったのを確かめてから終了コードを返して終わる。 */
  stop(code: number): void {
    if (this.stopping) return;
    this.stopping = true;
    this.code = code;
    const alive = this.running();
    if (alive.length === 0) {
      this.deps.exit(code);
      return;
    }
    for (const { child } of alive) {
      child.once("exit", () => {
        if (this.running().length === 0) this.deps.exit(this.code);
      });
      child.kill("SIGTERM");
    }
    // 子が応答しない場合の保険。unref しない（先にイベントループが終わると終了コードが失われるため）
    this.killTimer = setTimeout(() => this.kill(), STOP_TIMEOUT_MS);
  }

  /** SIGINT・SIGTERM を受けたとき。止めている途中なら、後片付けを待たずに止める。 */
  signal(): void {
    if (this.stopping) {
      this.forceStop();
      return;
    }
    this.deps.log(STOPPING_MESSAGE);
    this.stop(0);
  }

  /**
   * デーモンには SIGKILL でなく FORCE_STOP_SIGNAL を送る（exit の後処理で、別のプロセスグループのホストの MCP サーバー
   * などを止めさせるため）。
   */
  private forceStop(): void {
    if (this.forcing) return;
    this.forcing = true;
    this.deps.log(FORCE_STOPPING_MESSAGE);
    clearTimeout(this.killTimer);
    for (const { name, child } of this.running()) {
      child.kill(name === "daemon" ? FORCE_STOP_SIGNAL : "SIGKILL");
    }
    this.killTimer = setTimeout(() => this.kill(), FORCE_STOP_TIMEOUT_MS);
  }

  private kill(): void {
    for (const { child } of this.running()) child.kill("SIGKILL");
    this.deps.exit(this.code);
  }
}
