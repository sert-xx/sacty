import { type DaemonText, message } from "@sacty/core";
import { errorText, MessageError } from "./errors.js";

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
  /** PRを閉じる（中止したとき。マージはしない）。 */
  close(input: { repo: string; token: string; number: number }): Promise<void>;
  /** PR の状態（成果物チェックの間に見守る。PBI-14a）。 */
  status(input: { repo: string; token: string; number: number }): Promise<PullRequestStatus>;
  /**
   * PR へのフィードバック（PBI-14b）。レビュー（Request changes・コメント）の本文、行ごとのコメント、
   * PR への通常のコメント。bot のものは含めない。
   */
  feedback(input: { repo: string; token: string; number: number }): Promise<PullRequestFeedback[]>;
}

/**
 * PR へのフィードバックの1件。key は種類と ID（二重に取り込まないため）。requestChanges は
 * Request changes のレビュー（本文が無くても、変更を求められたこととして扱う）。
 */
export type PullRequestFeedback = {
  key: string;
  kind: "review" | "review_comment" | "comment";
  author: string;
  at: string;
  url?: string;
  body: string;
  path?: string;
  line?: number;
  requestChanges?: boolean;
};

/**
 * PR の状態。merged はマージ済み、closed はマージせずに閉じられた。headSha は PR の先頭のコミット
 * （マージ済みなら、マージされた内容。最新の提出がマージされたかを確かめるのに使う）。
 */
export type PullRequestStatus = { headSha?: string } & (
  | { state: "open" }
  | { state: "closed" }
  | { state: "merged"; mergedBy?: string }
);

const API = "https://api.github.com";

type Fetch = typeof fetch;

/** GitHub の REST API で PR を作る・更新する。 */
export class GitHubPullRequests implements PullRequests {
  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly api = API,
  ) {}

  close(input: Parameters<PullRequests["close"]>[0]) {
    return closePullRequest(this.fetchImpl, this.api, input);
  }

  async feedback(input: Parameters<PullRequests["feedback"]>[0]): Promise<PullRequestFeedback[]> {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "x-github-api-version": "2022-11-28",
    };
    const get = async (path: string) => {
      const res = await this.fetchImpl(`${this.api}/repos/${input.repo}${path}`, { headers });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw apiError("getReviews", res.status, json as Record<string, unknown>);
      return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
    };
    const user = (item: Record<string, unknown>) =>
      (item.user ?? {}) as { login?: unknown; type?: unknown };
    // bot（CI など）のコメントは、人間の指摘ではないので含めない
    const human = (item: Record<string, unknown>) => user(item).type !== "Bot";
    const author = (item: Record<string, unknown>) => String(user(item).login ?? "");
    const url = (item: Record<string, unknown>) =>
      typeof item.html_url === "string" ? { url: item.html_url } : {};
    const body = (item: Record<string, unknown>) =>
      typeof item.body === "string" ? item.body : "";
    const n = input.number;
    const [reviews, reviewComments, comments] = [
      await get(`/pulls/${n}/reviews?per_page=100`),
      await get(`/pulls/${n}/comments?per_page=100`),
      await get(`/issues/${n}/comments?per_page=100`),
    ];
    const items: PullRequestFeedback[] = [];
    for (const r of reviews.filter(human)) {
      // 承認は指摘ではない。コメントだけのレビューは本文があるときだけ
      const requestChanges = r.state === "CHANGES_REQUESTED";
      if (!requestChanges && !(r.state === "COMMENTED" && body(r).trim())) continue;
      items.push({
        key: `review:${r.id}`,
        kind: "review",
        author: author(r),
        at: String(r.submitted_at ?? ""),
        ...url(r),
        body: body(r),
        ...(requestChanges ? { requestChanges } : {}),
      });
    }
    for (const c of reviewComments.filter(human)) {
      if (!body(c).trim()) continue;
      const line = typeof c.line === "number" ? c.line : c.original_line;
      items.push({
        key: `review_comment:${c.id}`,
        kind: "review_comment",
        author: author(c),
        at: String(c.created_at ?? ""),
        ...url(c),
        body: body(c),
        path: String(c.path ?? ""),
        ...(typeof line === "number" ? { line } : {}),
      });
    }
    for (const c of comments.filter(human)) {
      if (!body(c).trim()) continue;
      items.push({
        key: `comment:${c.id}`,
        kind: "comment",
        author: author(c),
        at: String(c.created_at ?? ""),
        ...url(c),
        body: body(c),
      });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }

  async status(input: Parameters<PullRequests["status"]>[0]): Promise<PullRequestStatus> {
    const res = await this.fetchImpl(`${this.api}/repos/${input.repo}/pulls/${input.number}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw apiError("getPr", res.status, json);
    const sha = (json.head as { sha?: unknown } | null)?.sha;
    const head = typeof sha === "string" ? { headSha: sha } : {};
    if (json.merged === true) {
      const by = (json.merged_by as { login?: unknown } | null)?.login;
      return { state: "merged", ...head, ...(typeof by === "string" ? { mergedBy: by } : {}) };
    }
    return { state: json.state === "closed" ? "closed" : "open", ...head };
  }

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
      throw apiError("updatePr", res.status, json);
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
    throw apiError("createPr", res.status, json);
  }
}

/** PRを閉じる。GitHubPullRequests の一部だが、upsert と分けて読みやすくする。 */
async function closePullRequest(
  fetchImpl: Fetch,
  api: string,
  input: { repo: string; token: string; number: number },
): Promise<void> {
  const res = await fetchImpl(`${api}/repos/${input.repo}/pulls/${input.number}`, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw apiError("closePr", res.status, json);
  }
}

function apiError(
  action: "updatePr" | "createPr" | "closePr" | "getPr" | "getReviews" | "searchIssues",
  status: number,
  json: Record<string, unknown>,
): Error {
  // GitHub の文（json.message）は外から来た文なので、翻訳せずに引数で渡す
  const detail = typeof json.message === "string" ? json.message : "";
  const hint = status === 401 ? "token" : status === 403 || status === 404 ? "permission" : "none";
  return new MessageError(message("github.failed", { action, status, detail, hint }));
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
  incomplete?: DaemonText;
  /** レート制限で止まった（この取り込みでは、ほかの検索もしない）。 */
  rateLimited?: boolean;
};

/** Issue を探す口。テストでは偽物に差し替える。 */
export interface IssueSearch {
  /** since があれば、その更新日時以降に更新された Issue だけを探す。 */
  search(query: string, token: string, since?: string): Promise<IssueSearchResult>;
}

class RateLimitedError extends MessageError {}

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
    try {
      for (let window = 0; window < GitHubIssueSearch.MAX_WINDOWS; window++) {
        const windowStart = cursor;
        const q = windowStart ? `${query} updated:>=${windowStart}` : query;
        for (let page = 1; page <= GitHubIssueSearch.MAX_PAGES; page++) {
          const { items, incompleteResults } = await this.page(q, page, token);
          for (const item of items) {
            const issue = toIssue(item);
            if (issue) issues.set(`${issue.repo.toLowerCase()}#${issue.number}`, issue);
          }
          if (incompleteResults) {
            // 結果が不完全なら、返された Issue より前の Issue も取れたとは限らない。
            // 取れた分は取り込むが、どこまで読んだかはこのページの手前に留め、次の取り込みで
            // この範囲を検索し直す
            return result({
              cursor,
              incomplete: message("intake.searchTimedOut"),
            });
          }
          for (const item of items) {
            if (typeof item.updated_at === "string") cursor = item.updated_at;
          }
          // 最後のページ（件数が1ページに満たない）なら、すべて取れた
          if (items.length < GitHubIssueSearch.PER_PAGE) return result({ cursor });
        }
        // この範囲で1,000件に達した。最後の Issue の更新日時から先を、次の範囲として検索する
        // （同じ日時の Issue を落とさないよう >= にして、重複は番号で除く）
        if (cursor === windowStart) {
          return result({
            cursor,
            incomplete: message("intake.tooManySameTime"),
          });
        }
      }
      return result({
        cursor,
        incomplete: message("intake.partial"),
      });
    } catch (error) {
      // 失敗しても、それまでに取れた分と、どこまで読んだかを返す
      return result({
        cursor,
        incomplete: errorText(error),
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
      throw new RateLimitedError(message("intake.rateLimited"));
    }
    if (!res.ok) throw apiError("searchIssues", res.status, json);
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
