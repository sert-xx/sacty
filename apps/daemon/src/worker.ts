import type { TaskService } from "./service.js";

/**
 * 実行待ちのタスクを、古い順に1件ずつ実行する。
 * MVPでは同時に1件だけ実行する（ローカルのマシンの負荷と、利用上限の消費を抑えるため）。
 */
export class Worker {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly service: TaskService,
    private readonly intervalMs = 2_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  /**
   * 新しい実行を始めないようにし、実行中の処理（台帳への記録、認証ファイルの書き戻し、
   * 一時ファイルの削除を含む）が終わるのを待つ。
   */
  async drain(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  /** テストからも呼べるよう公開する。実行中、または停止後は何もしない。 */
  tick(): Promise<void> {
    if (this.current || this.stopped) return this.current ?? Promise.resolve();
    const run = (async () => {
      try {
        for (const id of this.service.queuedTaskIds()) {
          if (this.stopped) break;
          await this.service.runNext(id);
        }
      } catch (error) {
        console.error("[daemon] worker error:", error);
      }
    })();
    // 実行中の印は、代入した後に外す。キューが空だと上の処理は await を通らず同期的に終わるため、
    // 処理の中で外すと、直後の代入で完了済みの処理が残り、以降の tick がすべて止まってしまう。
    this.current = run;
    void run.finally(() => {
      if (this.current === run) this.current = undefined;
    });
    return run;
  }
}
