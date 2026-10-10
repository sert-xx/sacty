import type { TaskService } from "./service.js";

/**
 * 実行待ちのタスクを、古い順に1件ずつ実行する。
 * MVPでは同時に1件だけ実行する（ローカルのマシンの負荷と、利用上限の消費を抑えるため）。
 */
export class Worker {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly service: TaskService,
    private readonly intervalMs = 2_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** テストからも呼べるよう公開する。実行中なら何もしない。 */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const id of this.service.queuedTaskIds()) {
        await this.service.runNext(id);
      }
    } catch (error) {
      console.error("[daemon] worker error:", error);
    } finally {
      this.busy = false;
    }
  }
}
