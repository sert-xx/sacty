import {
  type DaemonText,
  IntakeKind,
  intakeIntervalSec,
  message,
  type SactySettings,
} from "@sacty/core";
import { redactText } from "./agents/redact.js";
import type { ConfigResult } from "./config.js";
import { errorText } from "./errors.js";
import type { GitHubAuth } from "./gh.js";
import type { FoundIssue, IssueSearch } from "./github.js";
import type { TaskService } from "./service.js";
import { type FoundTicket, type TicketClient, ticketErrorText, ticketJql } from "./tickets.js";

/**
 * GitHub の検索の読んだ位置（更新日時）を、検索を始めた時刻より先に進めない。
 * 読んだ位置は GitHub の更新日時なので、GitHub の時刻がこの機械の時計より先に進んでいる間に付いた更新日時を
 * そのまま持つと、時刻が戻った後にラベルが付いたものや更新されたものが、その位置より古い更新日時になって
 * 次の更新まで検索に当たらない（PBI-270）。検索を始めた時刻より先の位置は、その時刻に戻す。
 * 戻すと余分に読み直すだけで、取り込み済みのものは二重に取り込まない。秒より細かい部分は切り捨てる。
 */
export function clampCursor(cursor: string, searchedAt: number): string {
  const read = Date.parse(cursor);
  if (!Number.isFinite(read) || read <= searchedAt) return cursor;
  return new Date(Math.floor(searchedAt / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** 1つの種類の取り込みの状態（PBI-100）。 */
type KindState = {
  /**
   * 最後に取り込みを始めた時刻。無ければ、まだ取り込んでいない（すぐに取り込む）。取り込み元が無かった回は起点にしない
   * （ラベルを設定して On にしたら、次の確認ですぐに取り込むため）。
   */
  lastRun?: number;
  current?: Promise<void>;
  /**
   * 取り込み元（検索の条件）ごとの、どこまで読んだか。次の取り込みはここから続ける。
   * デーモンを再起動すると先頭から読み直す（取り込み済みのものは二重に取り込まない）。
   */
  cursors: Map<string, string>;
  revision?: string;
  /** 見た、sacty の設定を保存した回数（TaskService.settingsSaveCount）。変わったら間隔の起点を戻す。 */
  saves?: number;
};

/**
 * GitHub の Issue・PR（PR のレビューの取り込み。PBI-44）と、チケット（JIRA など。PBI-52）を定期的に探して、タスクに取り込む。
 * 取り込みの種類（Issue・PR のレビュー・チケット）ごとに、sacty の設定の間隔で、別々に取り込む（PBI-100。1つの種類の失敗や
 * 遅れが、ほかの種類を止めない）。検索はプロジェクトの取り込み元ごとに行い、担当の判定と重複の判定は TaskService が
 * 取り込むたびに行う。
 */
export class IssueIntake {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly kinds: Record<IntakeKind, KindState> = {
    issues: { cursors: new Map() },
    reviews: { cursors: new Map() },
    tickets: { cursors: new Map() },
  };

  constructor(
    private readonly service: TaskService,
    private readonly search: IssueSearch,
    private readonly github: GitHubAuth,
    private readonly config: () => ConfigResult,
    private readonly now: () => number = Date.now,
    /** チケット（JIRA など）の検索（PBI-52）。無ければ、チケットを取り込まない。 */
    private readonly tickets?: TicketClient,
  ) {}

  /** 間隔（sacty の設定）は毎回読み直す（デーモンを止めずに変えられるように）。確認は30秒ごと。 */
  start(checkMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), checkMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(Object.values(this.kinds).map((k) => k.current));
  }

  /**
   * 間隔が来た種類を取り込む。force なら、すべての種類を間隔を待たずに取り込む。取り込み中の種類は、その取り込みを待つ
   * （二重に始めない）。設定ファイルを読めなければ取り込まない。失敗しても reject しない（定期実行を止めないため）。
   * sacty の設定を読めなければ、その理由を取り込み中でない種類の失敗として記録し、次の確認でやり直す（間隔の起点にしない）。
   */
  async tick(force = false): Promise<void> {
    let settings: SactySettings;
    try {
      const config = this.config();
      if (this.stopped || !config.ok) {
        await Promise.all(Object.values(this.kinds).map((k) => k.current));
        return;
      }
      settings = this.service.getSettings();
    } catch (error) {
      const at = new Date(this.now()).toISOString();
      for (const kind of IntakeKind.options) {
        if (this.kinds[kind].current) continue;
        // 直ったら次の確認ですぐに取り込む（前の取り込みからの間隔を待たない）
        this.kinds[kind].lastRun = undefined;
        this.service.recordIntake(kind, {
          lastRunAt: at,
          imported: 0,
          errors: [{ message: errorText(error) }],
        });
      }
      return;
    }
    await Promise.all(IntakeKind.options.map((kind) => this.tickKind(kind, settings, force)));
  }

  private tickKind(kind: IntakeKind, settings: SactySettings, force: boolean): Promise<void> {
    const state = this.kinds[kind];
    if (state.current) return state.current;
    // sacty の設定を保存していたら（何を変えたかによらず）、間隔を待たずに取り込む
    const saves = this.service.settingsSaveCount();
    if (saves !== state.saves) {
      state.saves = saves;
      state.lastRun = undefined;
    }
    if (
      !force &&
      state.lastRun !== undefined &&
      this.now() - state.lastRun < intakeIntervalSec(settings, kind) * 1000
    ) {
      return Promise.resolve();
    }
    state.lastRun = this.now();
    const run = this.runKind(kind, state);
    state.current = run;
    void run.finally(() => {
      if (state.current === run) state.current = undefined;
    });
    return run;
  }

  /** 1つの種類を取り込み、その結果を記録する。思わぬ失敗も、その種類の失敗として記録する（ほかの種類は続ける）。 */
  private async runKind(kind: IntakeKind, state: KindState): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const errors: { query?: string; message: DaemonText }[] = [];
    let imported = 0;
    let sources = 0;
    try {
      // 始めたときの設定（sacty の設定の保存の回数と、プロジェクトの設定の版）。終わったときに変わっていたら、読んだ位置を確定しない
      const saves = this.service.settingsSaveCount();
      // 担当の判定が変わりうるので、プロジェクトの設定が変わったら先頭から読み直す
      // （以前はほかのプロジェクトの担当で取り込まなかったものを、取りこぼさないため）
      const revision = this.service.projectsRevision();
      if (revision !== state.revision) {
        state.cursors.clear();
        state.revision = revision;
      }
      const result =
        kind === "tickets"
          ? await this.runTickets(state.cursors, errors)
          : await this.runGitHub(kind, state.cursors, errors);
      imported = result.imported;
      sources = result.sources;
      // 読んだ位置は、取り込みの途中で設定が変わらなかったときだけ進める（途中で Off にして On に戻したなどで、取り込まれなかった
      // 項目を読み飛ばさないため。何が変わったかは見分けない）
      if (
        this.service.settingsSaveCount() === saves &&
        this.service.projectsRevision() === revision
      ) {
        for (const [key, cursor] of result.advanced) {
          if (cursor) state.cursors.set(key, cursor);
          else state.cursors.delete(key);
        }
      }
    } catch (error) {
      errors.push({ message: errorText(error) });
      // 思わぬ失敗（途中で sacty の設定を読めなくなったなど）は、次の確認でやり直す（間隔を待たない）
      state.lastRun = undefined;
    }
    // 取り込み元が無かった（ラベルが無い・Off・対象が無い）回は、間隔の起点にせず、記録も残さない（取り込んだように見せない）
    if (sources === 0 && errors.length === 0) {
      state.lastRun = undefined;
      this.service.clearIntake(kind);
      return;
    }
    this.service.recordIntake(kind, {
      lastRunAt: at,
      imported,
      ...(errors.length > 0 ? { errors } : {}),
    });
  }

  /**
   * GitHub の取り込み（Issue か、PR のレビュー）。取り込み元ごとに検索し、失敗は取り込み元ごとに記録する（1つの取り込み元の
   * 失敗で、ほかの取り込み元やプロジェクトの取り込みを止めない）。取れた結果は取り込み、作ったタスクの数を返す。
   * 検索は、その取り込み元のプロジェクトに設定した gh のアカウントで行う（PBI-13）。
   */
  private async runGitHub(
    kind: "issues" | "reviews",
    cursors: Map<string, string>,
    errors: { query?: string; message: DaemonText }[],
  ): Promise<{ imported: number; sources: number; advanced: Map<string, string | undefined> }> {
    const found: FoundIssue[] = [];
    // 見つかった PR が、どの検索の読んだ位置で見つかったか（再依頼を確かめられなかったら、その位置を進めない。PBI-143）
    const foundIn = new Map<FoundIssue, string>();
    // 読んだ位置は、ここでは進めない（取り込み（タスクの保存）に成功し、途中で設定が変わらなかったら、runKind が進める）
    const advanced = new Map<string, string | undefined>();
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
    // PR のレビューの取り込みの検索（review のあるもの）と、Issue の取り込みの検索を分ける（PBI-100）
    const sources = this.service
      .intakeSources()
      .filter((source) => (kind === "reviews") === (source.review !== undefined));
    for (const { host, query, account, project, review } of sources) {
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
      // この検索を始めた時刻（読んだ位置を、これより先に進めないために使う）
      const searchedAt = this.now();
      try {
        const result = await this.search.search(host, query, auth.token, cursors.get(cursorKey));
        // PR のレビューの取り込みの検索（PBI-44）で見つかったものは、そのことを添える
        const issues = review
          ? result.issues.map((i) => ({
              ...i,
              review,
              // 依頼の検索なら、誰への依頼を探したか（担当のプロジェクトのアカウントと照らし合わせる）
              ...(review === "requested" ? { requestedFor: account } : {}),
            }))
          : result.issues;
        for (const issue of issues) foundIn.set(issue, cursorKey);
        found.push(...issues);
        if (result.cursor) advanced.set(cursorKey, clampCursor(result.cursor, searchedAt));
        if (result.incomplete) {
          errors.push({ query, message: redactText(result.incomplete, [auth.token]) });
        }
        if (result.rateLimited) rateLimited.add(key);
      } catch (error) {
        errors.push({ query, message: redactText(errorText(error), [auth.token]) });
      }
    }
    // 見つからなければ、取り込みの処理（すべてのタスクを調べる）を省く
    let imported = found.length > 0 ? this.service.importIssues(found).length : 0;
    // 依頼の検索で、すでにレビューを投稿したタスクの PR が見つかったら、再依頼かを確かめて再レビューする（PBI-143）
    if (kind === "reviews" && found.length > 0) {
      const { restarted, failed } = await this.service.restartRerequestedReviews(found);
      imported += restarted.length;
      for (const { issue, message: text } of failed) {
        errors.push({ message: text });
        // 次の取り込みで、同じ PR がまた見つかるように、その検索の読んだ位置を進めない
        const cursorKey = foundIn.get(issue);
        if (cursorKey) advanced.delete(cursorKey);
      }
    }
    return { imported, sources: sources.length, advanced };
  }

  /** チケットの取り込み（PBI-52）。作ったタスクの数を返す。 */
  private async runTickets(
    cursors: Map<string, string>,
    errors: { query?: string; message: DaemonText }[],
  ): Promise<{ imported: number; sources: number; advanced: Map<string, string | undefined> }> {
    // チケット（JIRA など。PBI-52）。接続先は gateway.platforms の組織内 PF（認証もその設定）か、ホストに無ければ
    // そのプロジェクトのコンテキストの platforms.yaml の PF（PBI-74）
    const tickets: FoundTicket[] = [];
    const config = this.config();
    const platforms = (config.ok ? config.config.platforms : undefined) ?? [];
    const client = this.tickets;
    // プロジェクトのコンテキストは、1回の取り込みでプロジェクトごとに1度だけ取得する
    const contextPlatforms = new Map<string, ReturnType<TaskService["projectContextPlatforms"]>>();
    const sources = client ? this.service.ticketSources() : [];
    // 続きの位置は、ここでは進めない（取り込みに成功し、途中で設定が変わらなかったら、runKind が進める。undefined は先頭に戻す）
    const advanced = new Map<string, string | undefined>();
    const count = sources.length;
    if (client) {
      for (const source of sources) {
        const query = `${source.platform}: ${ticketJql(source.keys, source.label)}`;
        let platform = platforms.find((p) => p.name === source.platform);
        if (!platform && source.projectId) {
          let pending = contextPlatforms.get(source.projectId);
          if (!pending) {
            pending = this.service.projectContextPlatforms(source.projectId);
            contextPlatforms.set(source.projectId, pending);
          }
          const found = await pending;
          if ("error" in found) {
            errors.push({ query, message: found.error });
            continue;
          }
          platform = found.platforms.find((p) => p.name === source.platform);
        }
        if (!platform) {
          errors.push({
            query,
            message: message("ticket.platformMissing", { platform: source.platform }),
          });
          continue;
        }
        // 読む上限を超える数のチケットがあれば、次の回は続きから読む（最後まで読んだら先頭に戻る）
        const cursorKey = `ticket ${source.service} ${source.projectId ? `${source.projectId} ` : ""}${query}`;
        try {
          const result = await client.search({
            ...source,
            platform,
            ...(cursors.has(cursorKey) ? { cursor: cursors.get(cursorKey) } : {}),
          });
          // プロジェクトのコンテキストの PF で見つけたチケットは、そのプロジェクトのもの（PBI-74）
          tickets.push(
            ...(source.projectId
              ? result.tickets.map((t) => ({ ...t, projectId: source.projectId }))
              : result.tickets),
          );
          advanced.set(cursorKey, result.cursor);
        } catch (error) {
          // 続きの位置が使えなくなった（期限切れなど）かもしれないので、次の回は先頭から読む
          cursors.delete(cursorKey);
          errors.push({ query, message: ticketErrorText(error) });
        }
      }
    }
    const imported = tickets.length > 0 ? this.service.importTickets(tickets).length : 0;
    return { imported, sources: count, advanced };
  }
}
