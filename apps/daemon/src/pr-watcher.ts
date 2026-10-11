import type { TaskService } from "./service.js";

/**
 * 成果物チェックで待っているタスクの PR を、定期的に確かめる（PBI-14a）。PR のマージで承認し、
 * マージせずに閉じられたら記録して人間の判断を待つ。確認の重なりは避ける（前の確認が終わるまで待つ）。
 */
export class PullRequestWatcher {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly service: Pick<TaskService, "checkPullRequests">,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  tick(): Promise<void> {
    if (this.current || this.stopped) return this.current ?? Promise.resolve();
    const run = this.service.checkPullRequests().catch((error: unknown) => {
      console.warn("[daemon] PR の確認に失敗しました：", error);
    });
    this.current = run;
    void run.finally(() => {
      if (this.current === run) this.current = undefined;
    });
    return run;
  }
}
