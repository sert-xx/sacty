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
  /**
   * 取り込み元（検索の条件）ごとの、どこまで読んだか（更新日時）。次の取り込みはここから続ける。
   * デーモンを再起動すると先頭から読み直す（取り込み済みの Issue は二重に取り込まない）。
   */
  private readonly cursors = new Map<string, string>();
  private revision: string | undefined;

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

  /**
   * 取り込み元ごとに検索し、失敗は取り込み元ごとに記録する（1つの取り込み元の失敗で、
   * ほかの取り込み元やプロジェクトの取り込みを止めない）。取れた結果は取り込む。
   */
  private async runOnce(tokenSecret: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    let token: string;
    try {
      token = await this.secrets.get(tokenSecret);
    } catch (error) {
      this.service.recordIntake({
        lastRunAt: at,
        imported: 0,
        errors: [{ message: describe(error) }],
      });
      return;
    }
    // 担当の判定が変わりうるので、プロジェクトの設定が変わったら先頭から読み直す
    // （以前はほかのプロジェクトの担当で取り込まなかった Issue を、取りこぼさないため）
    const revision = this.service.projectsRevision();
    if (revision !== this.revision) {
      this.cursors.clear();
      this.revision = revision;
    }
    const found = [];
    const errors: { query?: string; message: string }[] = [];
    let rateLimited = false;
    for (const query of this.service.intakeQueries()) {
      if (rateLimited) {
        errors.push({ query, message: "レート制限のため、次の取り込みで検索します。" });
        continue;
      }
      try {
        const result = await this.search.search(query, token, this.cursors.get(query));
        found.push(...result.issues);
        if (result.cursor) this.cursors.set(query, result.cursor);
        if (result.incomplete) {
          errors.push({ query, message: redact(result.incomplete, [token]) });
        }
        rateLimited = result.rateLimited === true;
      } catch (error) {
        errors.push({ query, message: redact(describe(error), [token]) });
      }
    }
    const created = this.service.importIssues(found);
    this.service.recordIntake({
      lastRunAt: at,
      imported: created.length,
      ...(errors.length > 0 ? { errors } : {}),
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
