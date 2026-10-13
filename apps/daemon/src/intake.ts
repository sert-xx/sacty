import { type DaemonText, message } from "@sacty/core";
import { redactText } from "./agents/redact.js";
import type { ConfigResult } from "./config.js";
import { errorText } from "./errors.js";
import type { GitHubAuth } from "./gh.js";
import type { IssueSearch } from "./github.js";
import type { TaskService } from "./service.js";

/**
 * GitHub Issue を定期的に探して、タスクに取り込む（PR のレビューの取り込みの PR も。PBI-44）。検索はプロジェクトの取り込み元ごとに行い、
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
    private readonly github: GitHubAuth,
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
    const run = this.runOnce();
    this.current = run;
    void run.finally(() => {
      if (this.current === run) this.current = undefined;
    });
    return run;
  }

  /**
   * 取り込み元ごとに検索し、失敗は取り込み元ごとに記録する（1つの取り込み元の失敗で、
   * ほかの取り込み元やプロジェクトの取り込みを止めない）。取れた結果は取り込む。
   * 検索は、その取り込み元のプロジェクトに設定した gh のアカウントで行う（PBI-13）。
   */
  private async runOnce(): Promise<void> {
    const at = new Date(this.now()).toISOString();
    // 担当の判定が変わりうるので、プロジェクトの設定が変わったら先頭から読み直す
    // （以前はほかのプロジェクトの担当で取り込まなかった Issue を、取りこぼさないため）
    const revision = this.service.projectsRevision();
    if (revision !== this.revision) {
      this.cursors.clear();
      this.revision = revision;
    }
    const found = [];
    const errors: { query?: string; message: DaemonText }[] = [];
    // アカウントごとのトークン（取り出せなければ、その理由）と、レート制限に達したか。
    // レート制限はトークン（アカウント）ごとなので、ほかのアカウントの検索は続ける
    const tokens = new Map<string, { token: string } | { error: DaemonText }>();
    const rateLimited = new Set<string>();
    // アカウントは、ホストごと（PBI-40）
    const tokenOf = async (host: string, account: string) => {
      const key = `${host} ${account}`;
      let entry = tokens.get(key);
      if (!entry) {
        try {
          entry = { token: await this.github.token(host, account) };
        } catch (error) {
          entry = { error: errorText(error) };
        }
        tokens.set(key, entry);
      }
      return entry;
    };
    for (const { host, query, account, project, review } of this.service.intakeSources()) {
      // アカウントを選んでいないプロジェクトの取り込み元は、理由を示して検索しない
      if (!account) {
        errors.push({ query, message: message("github.accountRequired", { project, host }) });
        continue;
      }
      const auth = await tokenOf(host, account);
      const key = `${host} ${account}`;
      const cursorKey = `${host} ${query}`;
      if ("error" in auth) {
        errors.push({ query, message: auth.error });
        continue;
      }
      if (rateLimited.has(key)) {
        errors.push({ query, message: message("intake.skippedRateLimited") });
        continue;
      }
      try {
        const result = await this.search.search(
          host,
          query,
          auth.token,
          this.cursors.get(cursorKey),
        );
        // PR のレビューの取り込みの検索（PBI-44）で見つかったものは、そのことを添える
        found.push(...(review ? result.issues.map((i) => ({ ...i, review })) : result.issues));
        if (result.cursor) this.cursors.set(cursorKey, result.cursor);
        if (result.incomplete) {
          errors.push({ query, message: redactText(result.incomplete, [auth.token]) });
        }
        if (result.rateLimited) rateLimited.add(key);
      } catch (error) {
        errors.push({ query, message: redactText(errorText(error), [auth.token]) });
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
