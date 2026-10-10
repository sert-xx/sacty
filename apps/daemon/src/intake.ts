import { redact } from "./agents/redact.js";
import type { ConfigResult } from "./config.js";
import type { IssueSearch } from "./github.js";
import type { SecretStore } from "./secrets.js";
import type { TaskService } from "./service.js";

/**
 * GitHub Issue を定期的に探して、タスクに取り込む。検索はプロジェクトの取り込み元ごとに行い、
 * 担当の判定と重複の判定は TaskService が取り込むたびに行う。
 */
export class IssueIntake {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopped = false;
  private lastRun = 0;

  constructor(
    private readonly service: TaskService,
    private readonly search: IssueSearch,
    private readonly secrets: SecretStore,
    private readonly config: () => ConfigResult,
    private readonly now: () => number = Date.now,
  ) {}

  /** 設定の間隔は毎回読み直す（デーモンを止めずに変えられるように）。確認は30秒ごと。 */
  start(checkMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), checkMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  /** 間隔が来ていれば取り込む。force なら間隔を待たない。 */
  tick(force = false): Promise<void> {
    if (this.current || this.stopped) return this.current ?? Promise.resolve();
    const config = this.config();
    if (!config.ok || !config.config.github) return Promise.resolve();
    const github = config.config.github;
    if (!force && this.now() - this.lastRun < github.pollIntervalSec * 1000) {
      return Promise.resolve();
    }
    this.lastRun = this.now();
    const run = this.runOnce(github.tokenSecret);
    this.current = run;
    void run.finally(() => {
      if (this.current === run) this.current = undefined;
    });
    return run;
  }

  private async runOnce(tokenSecret: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    let token: string | undefined;
    try {
      token = await this.secrets.get(tokenSecret);
      const found = [];
      for (const query of this.service.intakeQueries()) {
        found.push(...(await this.search.search(query, token)));
      }
      const created = this.service.importIssues(found);
      this.service.recordIntake({ lastRunAt: at, imported: created.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.service.recordIntake({
        lastRunAt: at,
        error: redact(message, token ? [token] : []),
      });
    }
  }
}
