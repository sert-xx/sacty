import { type DaemonText, githubApiBase, message, parseOrgUrl, parseRepoUrl } from "@sacty/core";
import { errorText, MessageError } from "./errors.js";

/** PRを作る口。テストでは偽物に差し替える。repo はリポジトリの URL（https://<ホスト>/<owner>/<name>。PBI-40）。 */
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
  /** PR の状態（承認待ちの間に見守る。PBI-14a）。 */
  status(input: { repo: string; token: string; number: number }): Promise<PullRequestStatus>;
  /**
   * PR へのフィードバック（PBI-14b）。レビュー（Request changes・コメント）の本文、行ごとのコメント、
   * PR への通常のコメント。bot のものは含めない。
   */
  feedback(input: {
    repo: string;
    token: string;
    number: number;
    /** プロジェクトの gh のアカウント。このアカウントが投稿した sacty のレビュー（PBI-19）は含めない。 */
    account?: string;
    /**
     * この PR をレビューした sacty のタスクの回（PBI-88）。key は目印の中身（`sactyReviewKey` の形で、タスクと再レビューの回）、
     * account はそのタスクが投稿に使うアカウント（元のタスクのアカウントと違うことがある）。その目印で始まり、そのアカウントが
     * 投稿したレビュー・行へのコメントは、allowed（取り込むラベルを付けて取り込んだタスクの、直すべき指摘のある回）なら
     * PR の指摘として含め、そうでなければ除く（Bot かどうか・元のタスクのアカウントかどうかに関わらない）。
     */
    sactyReviews?: readonly SactyReviewRound[];
  }): Promise<PullRequestFeedback[]>;
  /**
   * PR にラベルを付ける（PBI-88）。リポジトリにそのラベルが無ければ作ってから付ける（created）。すでに付いていれば
   * 何も変わらない。
   */
  addLabel(input: {
    repo: string;
    token: string;
    number: number;
    label: string;
  }): Promise<{ created: boolean }>;
  /**
   * Issue のコメントのうち、marker を含むものを探す（同じ結果を二度コメントしないため。PBI-18）。
   */
  findIssueComment(input: {
    repo: string;
    token: string;
    number: number;
    marker: string;
  }): Promise<{ url: string } | undefined>;
  /** Issue にコメントする（調査の結果を返す。PBI-18）。 */
  commentIssue(input: {
    repo: string;
    token: string;
    number: number;
    body: string;
  }): Promise<{ url: string }>;
  /**
   * Org（またはユーザー）の URL の、リポジトリの URL（アーカイブしたものは除く）。プロジェクトの対象の
   * Org から、タスクの対象リポジトリを選ぶため（PBI-25）。
   */
  repositories(input: { org: string; token: string }): Promise<string[]>;
  /** レビューの対象の PR（PBI-19）。 */
  pullRequest(input: { repo: string; token: string; number: number }): Promise<PullRequestInfo>;
  /**
   * account が投稿した PR のレビューのうち、本文が marker で始まるものを探す
   * （同じレビューを二度投稿しないため。PBI-19）。
   */
  findReview(input: {
    repo: string;
    token: string;
    number: number;
    account: string;
    marker: string;
  }): Promise<{ url: string } | undefined>;
  /**
   * PR にレビュー（COMMENT。承認も変更の要求もしない）を、行へのコメントとあわせて投稿する（PBI-19）。
   * 行へのコメントの line は、commit のファイルの行番号（差分の右側）。
   */
  postReview(input: {
    repo: string;
    token: string;
    number: number;
    commit: string;
    body: string;
    comments: { path: string; line: number; body: string }[];
  }): Promise<{ url: string }>;
}

/** レビューの対象の PR。headSha は PR の先頭、baseSha は向き先のブランチの先頭。 */
export type PullRequestInfo = {
  number: number;
  url: string;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  /** PR の作者の login（PBI-111）。読めなければ空。 */
  author: string;
};

/** PR をレビューした sacty のタスクの回（PBI-88）。`PullRequests.feedback` の sactyReviews を参照。 */
export type SactyReviewRound = { key: string; account: string; allowed: boolean };

/** sacty のレビューの工程が投稿したレビューの目印（PBI-19）。 */
export const REVIEW_MARKER_PREFIX = "<!-- sacty-review:";

/** 本文が、sacty のレビューの目印で始まるか。 */
function isSactyReview(body: unknown): boolean {
  return typeof body === "string" && body.trimStart().startsWith(REVIEW_MARKER_PREFIX);
}

/** sacty のレビューの目印の中身（タスクの ID。再レビューの回は `<ID>:<回>`。PBI-44・PBI-88）。 */
export function sactyReviewKey(taskId: string, round = 1): string {
  return round > 1 ? `${taskId}:${round}` : taskId;
}

/** sacty のレビューの目印の中身（`sactyReviewKey` の形。目印で始まらなければ undefined）。 */
export function sactyReviewTask(body: unknown): string | undefined {
  if (!isSactyReview(body)) return undefined;
  const rest = String(body).trimStart().slice(REVIEW_MARKER_PREFIX.length);
  return rest.match(/^([^\s:>]+(?::\d+)?) -->/)?.[1];
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
 * （マージ済みなら、マージされた内容。最新の提出がマージされたかを確かめるのに使う）。mergeCommit はマージのコミット
 * （取れれば。PBI-63）。
 */
export type PullRequestStatus = { headSha?: string } & (
  | { state: "open" }
  | { state: "closed" }
  | { state: "merged"; mergedBy?: string; mergeCommit?: string }
);

/** sacty が作る取り込むラベルの色（GitHub の既定の色の1つ）。 */
const LABEL_COLOR = "0e8a16";

/** 一覧を読むページの上限（100件ずつ。誤った Link で延々と読まないように）。 */
const MAX_PAGES = 50;

/** Link ヘッダーの次のページの URL（無ければ undefined）。 */
export function nextPage(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

type Fetch = typeof fetch;

/** リポジトリの URL の、REST API の URL（https://api.github.com/repos/<owner>/<name> など）と API の URL。 */
export function repoApi(repoUrl: string): { api: string; base: string } {
  const repo = parseRepoUrl(repoUrl);
  if (!repo) throw new MessageError(message("input.invalidRepo"));
  const api = githubApiBase(repo.host);
  return { api, base: `${api}/repos/${repo.path}` };
}

/** GitHub の REST API で PR を作る・更新する。 */
export class GitHubPullRequests implements PullRequests {
  constructor(private readonly fetchImpl: Fetch = fetch) {}

  close(input: Parameters<PullRequests["close"]>[0]) {
    return closePullRequest(this.fetchImpl, input);
  }

  async feedback(input: Parameters<PullRequests["feedback"]>[0]): Promise<PullRequestFeedback[]> {
    const get = (path: string) => this.list(input.repo, path, input.token, "getReviews");
    const user = (item: Record<string, unknown>) =>
      (item.user ?? {}) as { login?: unknown; type?: unknown };
    // bot（CI など）のコメントは、人間の指摘ではないので含めない
    // sacty のレビューの工程が、プロジェクトのアカウントで投稿したレビューと行へのコメント（PBI-19）も、
    // 人間の指摘ではないので含めない（目印で始まるものだけ。人間が引用・転記した目印では除かない）
    // この PR をレビューした sacty のタスク（PBI-88）が投稿したものは、そのタスクのアカウントと目印の回で判定する
    // （元のタスクとアカウントが違っても・Bot でも）。取り込むラベルを付けて取り込んだタスクの、直すべき指摘のある回だけを
    // 指摘として含め、ほかの回は除く。Bot の判定より先に見る（PBI-88 レビュー指摘）
    const rounds = new Map((input.sactyReviews ?? []).map((r) => [r.key, r]));
    const sactyRound = (item: Record<string, unknown>) => {
      const round = rounds.get(sactyReviewTask(item.body) ?? "");
      const login = user(item).login;
      return round &&
        typeof login === "string" &&
        login.toLowerCase() === round.account.toLowerCase()
        ? round
        : undefined;
    };
    const human = (item: Record<string, unknown>) => {
      const round = sactyRound(item);
      if (round) return round.allowed;
      return (
        user(item).type !== "Bot" &&
        !(
          input.account !== undefined &&
          user(item).login === input.account &&
          isSactyReview(item.body)
        )
      );
    };
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

  /**
   * 一覧を読む。100件ずつのページになるので、Link の next をたどってすべてのページを読む。
   * トークンを送るので、API と同じ場所の URL だけをたどる。
   */
  private list(
    repo: string,
    path: string,
    token: string,
    action: "getReviews" | "listIssueComments",
  ): Promise<Record<string, unknown>[]> {
    const { api, base } = repoApi(repo);
    return this.listAt(api, `${base}${path}`, token, action);
  }

  /** API の URL の一覧を、すべてのページから読む。 */
  private async listAt(
    api: string,
    first: string,
    token: string,
    action: "getReviews" | "listIssueComments" | "listRepositories",
  ): Promise<Record<string, unknown>[]> {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    };
    const all: Record<string, unknown>[] = [];
    let url: string | undefined = first;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await this.fetchImpl(url, { headers });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw apiError(action, res.status, json as Record<string, unknown>);
      if (Array.isArray(json)) all.push(...(json as Record<string, unknown>[]));
      const next = nextPage(res.headers.get("link"));
      url = next?.startsWith(`${api}/`) ? next : undefined;
    }
    return all;
  }

  async findIssueComment(input: Parameters<PullRequests["findIssueComment"]>[0]) {
    const comments = await this.list(
      input.repo,
      `/issues/${input.number}/comments?per_page=100`,
      input.token,
      "listIssueComments",
    );
    const found = comments.find((c) => typeof c.body === "string" && c.body.includes(input.marker));
    return found ? { url: String(found.html_url ?? "") } : undefined;
  }

  async commentIssue(input: Parameters<PullRequests["commentIssue"]>[0]) {
    const res = await this.fetchImpl(
      `${repoApi(input.repo).base}/issues/${input.number}/comments`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: input.body }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw apiError("commentIssue", res.status, json);
    return { url: String(json.html_url ?? "") };
  }

  async repositories(input: Parameters<PullRequests["repositories"]>[0]): Promise<string[]> {
    const org = parseOrgUrl(input.org);
    if (!org) throw new MessageError(message("input.invalidOrg"));
    const api = githubApiBase(org.host);
    const owner = encodeURIComponent(org.owner);
    const read = (path: string) =>
      this.listAt(api, `${api}${path}`, input.token, "listRepositories");
    const list = await read(`/orgs/${owner}/repos?per_page=100&type=all`).catch(
      async (error: unknown) => {
        if (githubStatus(error) !== 404) throw error;
        // Org でなければ（個人のアカウント）、公開リポジトリ（/users/{owner}/repos は公開のものしか返さない）と、
        // トークンで読めるリポジトリ（/user/repos。非公開のものを含む）のうち、その持ち主のものを合わせる
        const [publicRepos, accessible] = [
          await read(`/users/${owner}/repos?per_page=100&type=owner`),
          await read("/user/repos?per_page=100&affiliation=owner,collaborator,organization_member"),
        ];
        const ownerOf = (r: Record<string, unknown>) =>
          String((r.owner as { login?: unknown } | null)?.login ?? "").toLowerCase();
        return [
          ...publicRepos,
          ...accessible.filter((r) => ownerOf(r) === org.owner.toLowerCase()),
        ];
      },
    );
    const names = new Map<string, string>();
    for (const r of list) {
      if (r.archived === true || typeof r.full_name !== "string") continue;
      names.set(r.full_name.toLowerCase(), `https://${org.host}/${r.full_name}`);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  async pullRequest(input: Parameters<PullRequests["pullRequest"]>[0]): Promise<PullRequestInfo> {
    const res = await this.fetchImpl(`${repoApi(input.repo).base}/pulls/${input.number}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw apiError("getPr", res.status, json);
    const sha = (key: "head" | "base") => {
      const value = (json[key] as { sha?: unknown } | null)?.sha;
      return typeof value === "string" ? value : "";
    };
    return {
      number: Number(json.number ?? input.number),
      url: String(json.html_url ?? ""),
      title: typeof json.title === "string" ? json.title : "",
      body: typeof json.body === "string" ? json.body : "",
      headSha: sha("head"),
      baseSha: sha("base"),
      author: String((json.user as { login?: unknown } | null)?.login ?? ""),
    };
  }

  async findReview(input: Parameters<PullRequests["findReview"]>[0]) {
    const reviews = await this.list(
      input.repo,
      `/pulls/${input.number}/reviews?per_page=100`,
      input.token,
      "getReviews",
    );
    // 他人が本文に目印を書いても、投稿済みと見なさない
    const found = reviews.find(
      (r) =>
        (r.user as { login?: unknown } | null)?.login === input.account &&
        typeof r.body === "string" &&
        r.body.trimStart().startsWith(input.marker),
    );
    return found ? { url: String(found.html_url ?? "") } : undefined;
  }

  async postReview(input: Parameters<PullRequests["postReview"]>[0]) {
    const res = await this.fetchImpl(`${repoApi(input.repo).base}/pulls/${input.number}/reviews`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commit_id: input.commit,
        body: input.body,
        event: "COMMENT",
        comments: input.comments.map((c) => ({ ...c, side: "RIGHT" })),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw apiError("postReview", res.status, json);
    return { url: String(json.html_url ?? "") };
  }

  async status(input: Parameters<PullRequests["status"]>[0]): Promise<PullRequestStatus> {
    const res = await this.fetchImpl(`${repoApi(input.repo).base}/pulls/${input.number}`, {
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
      const mergeCommit = json.merge_commit_sha;
      return {
        state: "merged",
        ...head,
        ...(typeof by === "string" ? { mergedBy: by } : {}),
        ...(typeof mergeCommit === "string" && mergeCommit ? { mergeCommit } : {}),
      };
    }
    return { state: json.state === "closed" ? "closed" : "open", ...head };
  }

  async addLabel(input: Parameters<PullRequests["addLabel"]>[0]): Promise<{ created: boolean }> {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    };
    const { base } = repoApi(input.repo);
    const call = async (url: string, init: RequestInit) => {
      const res = await this.fetchImpl(url, { ...init, headers });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { res, json };
    };
    // リポジトリにラベルがあるか（名前の大文字・小文字は区別されない）。無ければ作る
    let created = false;
    const found = await call(`${base}/labels/${encodeURIComponent(input.label)}`, {
      method: "GET",
    });
    if (found.res.status === 404) {
      const made = await call(`${base}/labels`, {
        method: "POST",
        body: JSON.stringify({
          name: input.label,
          color: LABEL_COLOR,
          description: "sacty が取り込む Issue・PR",
        }),
      });
      // 作っている間に、ほかで作られた（422 の already_exists）なら、そのまま付ける
      const exists =
        made.res.status === 422 &&
        Array.isArray(made.json.errors) &&
        made.json.errors.some(
          (e) => (e as Record<string, unknown> | null)?.code === "already_exists",
        );
      if (!made.res.ok && !exists) throw apiError("createLabel", made.res.status, made.json);
      created = made.res.ok;
    } else if (!found.res.ok) {
      throw apiError("getLabel", found.res.status, found.json);
    }
    const added = await call(`${base}/issues/${input.number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [input.label] }),
    });
    if (!added.res.ok) throw apiError("addLabel", added.res.status, added.json);
    return { created };
  }

  async upsert(input: Parameters<PullRequests["upsert"]>[0]) {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    };
    const repo = parseRepoUrl(input.repo);
    const base = `${repoApi(input.repo).base}/pulls`;
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
      const owner = repo?.owner ?? "";
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
  input: { repo: string; token: string; number: number },
): Promise<void> {
  const res = await fetchImpl(`${repoApi(input.repo).base}/pulls/${input.number}`, {
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

export function apiError(
  action:
    | "updatePr"
    | "createPr"
    | "closePr"
    | "getPr"
    | "getReviews"
    | "commentIssue"
    | "listIssueComments"
    | "listRepositories"
    | "postReview"
    | "searchIssues"
    | "readChecks"
    | "getLabel"
    | "createLabel"
    | "addLabel",
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
  /** リポジトリの URL。 */
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  /** PR か（PBI-26）。 */
  pullRequest?: boolean;
  /**
   * PR のレビューの取り込みの検索で見つかったか（PBI-44）。requested：自分へのレビューの依頼、label：レビュー用の
   * ラベル。検索の結果には依頼されたレビュアーが無いので、どの検索で見つかったかで判断する。
   */
  review?: "requested" | "label";
  /** レビューの依頼の検索で、誰への依頼を探したか（そのホストのアカウント。PBI-44 レビュー指摘）。 */
  requestedFor?: string;
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
  /** host の GitHub で探す。since があれば、その更新日時以降に更新された Issue だけを探す。 */
  search(host: string, query: string, token: string, since?: string): Promise<IssueSearchResult>;
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

  constructor(private readonly fetchImpl: Fetch = fetch) {}

  async search(
    host: string,
    query: string,
    token: string,
    since?: string,
  ): Promise<IssueSearchResult> {
    const api = githubApiBase(host);
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
          const { items, incompleteResults } = await this.page(api, q, page, token);
          for (const item of items) {
            const issue = toIssue(item, host);
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

  private async page(api: string, q: string, page: number, token: string) {
    const url = `${api}/search/issues?q=${encodeURIComponent(q)}&per_page=${GitHubIssueSearch.PER_PAGE}&page=${page}&sort=updated&order=asc`;
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

/**
 * 検索の結果の1件を読む。形の読めないもの、検索したホストではないものは除く（ほかのホストのリポジトリとして
 * 取り込まないため）。リポジトリの URL は、Issue・PR の URL から読む。
 */
function toIssue(item: Record<string, unknown>, host: string): FoundIssue | undefined {
  const url = String(item.html_url ?? "");
  const repo = parseRepoUrl(
    url.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/(?:issues|pull)\/\d+$/)?.[1] ?? "",
  );
  // PR も取り込む（PBI-26）。検索の結果では、PR は pull_request を持つ
  const issue = {
    repo: repo?.url ?? "",
    number: Number(item.number),
    title: String(item.title ?? ""),
    body: typeof item.body === "string" ? item.body : "",
    url,
    labels: Array.isArray(item.labels)
      ? item.labels.map((l) => String((l as Record<string, unknown>)?.name ?? l))
      : [],
    ...(item.pull_request ? { pullRequest: true } : {}),
  };
  return repo?.host === host && issue.number > 0 ? issue : undefined;
}

/** GitHub の API の失敗の、HTTP のステータス（GitHub の失敗でなければ undefined）。 */
export function githubStatus(error: unknown): number | undefined {
  const text = errorText(error);
  if (typeof text !== "object" || text.code !== "github.failed") return undefined;
  const status = (text.params as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}
