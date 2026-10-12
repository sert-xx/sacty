import type { TaskService } from "./service.js";

/**
 * 実行待ちのタスクを、古い順に、上限の数まで同時に実行する（PBI-30）。上限は sacty の設定で決める
 * （ローカルのマシンの負荷と、利用上限の消費を抑えるため）。同じタスクを同時に2つ実行しない。
 */
export class Worker {
  private timer: NodeJS.Timeout | undefined;
  /** 実行中のタスクと、その処理。 */
  private readonly running = new Map<string, Promise<void>>();
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
   * 新しい実行を始めないようにし、実行中の処理（作業履歴への記録、認証ファイルの書き戻し、
   * 一時ファイルの削除を含む）がすべて終わるのを待つ。
   */
  async drain(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.running.values());
  }

  /**
   * 空いている数だけ、実行待ちのタスクの実行を始める。返す Promise は、いま実行中のすべての処理の終わり
   * （テストからも呼べるよう公開する）。停止後は何も始めない。
   */
  tick(): Promise<void> {
    if (!this.stopped) {
      let limit: number;
      let queued: string[];
      try {
        limit = this.service.maxParallelTasks();
        queued = this.service.queuedTaskIds();
      } catch (error) {
        console.error("[daemon] worker error:", error);
        queued = [];
        limit = 0;
      }
      for (const id of queued) {
        if (this.running.size >= limit) break;
        if (this.running.has(id)) continue;
        const run = this.service
          .runNext(id)
          .catch((error) => console.error("[daemon] worker error:", error))
          .finally(() => this.running.delete(id));
        this.running.set(id, run);
      }
    }
    return Promise.all(this.running.values()).then(() => {});
  }
}
