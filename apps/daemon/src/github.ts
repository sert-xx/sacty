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

/** Issue を探す口。テストでは偽物に差し替える。 */
export interface IssueSearch {
  search(query: string, token: string): Promise<FoundIssue[]>;
}

/** GitHub の検索 API で、開いている Issue を探す（PR は除く）。 */
export class GitHubIssueSearch implements IssueSearch {
  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly api = API,
  ) {}

  /** 1ページの件数と、たどるページの上限（検索 API は最大1,000件まで返す）。 */
  static readonly PER_PAGE = 100;
  static readonly MAX_PAGES = 10;

  async search(query: string, token: string): Promise<FoundIssue[]> {
    const found: FoundIssue[] = [];
    for (let page = 1; page <= GitHubIssueSearch.MAX_PAGES; page++) {
      const url = `${this.api}/search/issues?q=${encodeURIComponent(query)}&per_page=${GitHubIssueSearch.PER_PAGE}&page=${page}&sort=created&order=asc`;
      const res = await this.fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw apiError("Issue を検索できませんでした", res.status, json);
      const items = Array.isArray(json.items) ? (json.items as Record<string, unknown>[]) : [];
      found.push(
        ...items
          .filter((item) => !item.pull_request)
          .map((item) => ({
            repo: String(item.repository_url ?? "").replace(/^.*\/repos\//, ""),
            number: Number(item.number),
            title: String(item.title ?? ""),
            body: typeof item.body === "string" ? item.body : "",
            url: String(item.html_url ?? ""),
            labels: Array.isArray(item.labels)
              ? item.labels.map((l) => String((l as Record<string, unknown>)?.name ?? l))
              : [],
          }))
          .filter((issue) => /^[^/]+\/[^/]+$/.test(issue.repo) && issue.number > 0),
      );
      // 最後のページ（件数が1ページに満たない）なら終わる
      if (items.length < GitHubIssueSearch.PER_PAGE) break;
    }
    return found;
  }
}
