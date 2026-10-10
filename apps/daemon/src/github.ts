/** PRを作る口。テストでは偽物に差し替える。 */
export interface PullRequests {
  /** PRを作る。number があれば、そのPRの本文を更新する。 */
  upsert(input: {
    repo: string;
    token: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    number?: number;
  }): Promise<{ url: string; number: number }>;
}

const API = "https://api.github.com";

type Fetch = typeof fetch;

/** GitHub の REST API で PR を作る・更新する。 */
export class GitHubPullRequests implements PullRequests {
  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly api = API,
  ) {}

  async upsert(input: Parameters<PullRequests["upsert"]>[0]) {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    };
    const base = `${this.api}/repos/${input.repo}/pulls`;
    const call = async (url: string, init: RequestInit) => {
      const res = await this.fetchImpl(url, { ...init, headers });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { res, json };
    };
    const result = (json: Record<string, unknown>) => ({
      url: String(json.html_url),
      number: Number(json.number),
    });

    if (input.number) {
      const { res, json } = await call(`${base}/${input.number}`, {
        method: "PATCH",
        body: JSON.stringify({ body: input.body }),
      });
      if (res.ok) return result(json);
      throw apiError("PRを更新できませんでした", res.status, json);
    }

    const { res, json } = await call(base, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.baseBranch,
        body: input.body,
      }),
    });
    if (res.ok) return result(json);
    // すでに同じブランチのPRがある（前回、作成後の記録の前に止まったなど）なら、それを使う
    if (res.status === 422) {
      const owner = input.repo.split("/")[0];
      const found = await call(
        `${base}?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`,
        { method: "GET" },
      );
      const list = found.json as unknown;
      if (found.res.ok && Array.isArray(list) && list[0]) {
        return result(list[0] as Record<string, unknown>);
      }
    }
    throw apiError("PRを作れませんでした", res.status, json);
  }
}

function apiError(what: string, status: number, json: Record<string, unknown>): Error {
  const message = typeof json.message === "string" ? json.message : "";
  const hint =
    status === 401
      ? "（トークンが無効です）"
      : status === 403 || status === 404
        ? "（トークンの権限か、リポジトリ名を確認してください）"
        : "";
  return new Error(`${what}：GitHub API ${status} ${message}${hint}`);
}

/** 取り込みの対象として見つかった Issue。 */
export type FoundIssue = {
  /** owner/name。 */
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

/**
 * 検索の結果。cursor は、ここまで読んだ更新日時（次の検索は、ここから続ける）。
 * 途中で失敗しても、それまでに取れた Issue と cursor を返す（次の取り込みで先へ進めるように）。
 */
export type IssueSearchResult = {
  issues: FoundIssue[];
  cursor?: string;
  /** 取り切れなかった理由（失敗・上限）。 */
  incomplete?: string;
  /** レート制限で止まった（この取り込みでは、ほかの検索もしない）。 */
  rateLimited?: boolean;
};

/** Issue を探す口。テストでは偽物に差し替える。 */
export interface IssueSearch {
  /** since があれば、その更新日時以降に更新された Issue だけを探す。 */
  search(query: string, token: string, since?: string): Promise<IssueSearchResult>;
}

class RateLimitedError extends Error {}

/**
 * GitHub の検索 API で、開いている Issue を更新日時の順に探す（PR は除く）。
 * 検索 API は1つの検索で1,000件までしか返さないので、更新日時で範囲を区切って先もたどる。
 * 更新日時を使うのは、古い Issue に後からラベルが付いた場合も、次の取り込みで拾えるようにするため。
 */
export class GitHubIssueSearch implements IssueSearch {
  /** 1ページの件数、1つの範囲でたどるページの上限（1,000件）、範囲の数の上限。 */
  static readonly PER_PAGE = 100;
  static readonly MAX_PAGES = 10;
  static readonly MAX_WINDOWS = 20;

  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly api = API,
  ) {}

  async search(query: string, token: string, since?: string): Promise<IssueSearchResult> {
    const issues = new Map<string, FoundIssue>();
    const result = (extra: Omit<IssueSearchResult, "issues">): IssueSearchResult => ({
      issues: [...issues.values()],
      ...extra,
    });
    let cursor = since;
    let incomplete: string | undefined;
    try {
      for (let window = 0; window < GitHubIssueSearch.MAX_WINDOWS; window++) {
        const windowStart = cursor;
        const q = windowStart ? `${query} updated:>=${windowStart}` : query;
        for (let page = 1; page <= GitHubIssueSearch.MAX_PAGES; page++) {
          const { items, incompleteResults } = await this.page(q, page, token);
          if (incompleteResults) {
            incomplete = "GitHub の検索が時間内に終わらず、結果の一部しか得られませんでした。";
          }
          for (const item of items) {
            const issue = toIssue(item);
            if (issue) issues.set(`${issue.repo.toLowerCase()}#${issue.number}`, issue);
            if (typeof item.updated_at === "string") cursor = item.updated_at;
          }
          // 最後のページ（件数が1ページに満たない）なら、すべて取れた
          if (items.length < GitHubIssueSearch.PER_PAGE) return result({ cursor, incomplete });
        }
        // この範囲で1,000件に達した。最後の Issue の更新日時から先を、次の範囲として検索する
        // （同じ日時の Issue を落とさないよう >= にして、重複は番号で除く）
        if (cursor === windowStart) {
          return result({
            cursor,
            incomplete: "同じ日時に更新された Issue が多すぎるため、すべてを検索できませんでした。",
          });
        }
      }
      return result({
        cursor,
        incomplete:
          "Issue が多すぎるため、この取り込みでは途中までしか検索していません（次の取り込みで続きを検索します）。",
      });
    } catch (error) {
      // 失敗しても、それまでに取れた分と、どこまで読んだかを返す
      return result({
        cursor,
        incomplete: error instanceof Error ? error.message : String(error),
        rateLimited: error instanceof RateLimitedError,
      });
    }
  }

  private async page(q: string, page: number, token: string) {
    const url = `${this.api}/search/issues?q=${encodeURIComponent(q)}&per_page=${GitHubIssueSearch.PER_PAGE}&page=${page}&sort=updated&order=asc`;
    const res = await this.fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      (res.status === 403 || res.status === 429) &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))
    ) {
      throw new RateLimitedError(
        "GitHub の検索のレート制限に達しました。次の取り込みで、続きから検索します。",
      );
    }
    if (!res.ok) throw apiError("Issue を検索できませんでした", res.status, json);
    return {
      items: Array.isArray(json.items) ? (json.items as Record<string, unknown>[]) : [],
      incompleteResults: json.incomplete_results === true,
    };
  }
}

/** 検索の結果の1件を読む。PR と、形の読めないものは除く。 */
function toIssue(item: Record<string, unknown>): FoundIssue | undefined {
  if (item.pull_request) return undefined;
  const issue = {
    repo: String(item.repository_url ?? "").replace(/^.*\/repos\//, ""),
    number: Number(item.number),
    title: String(item.title ?? ""),
    body: typeof item.body === "string" ? item.body : "",
    url: String(item.html_url ?? ""),
    labels: Array.isArray(item.labels)
      ? item.labels.map((l) => String((l as Record<string, unknown>)?.name ?? l))
      : [],
  };
  return /^[^/]+\/[^/]+$/.test(issue.repo) && issue.number > 0 ? issue : undefined;
}
