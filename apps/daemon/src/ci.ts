import { type CiCheck, type CiFailure, isFailedCiCheck } from "@sacty/core";
import { redact } from "./agents/redact.js";
import { apiError, nextPage, repoApi } from "./github.js";

/**
 * マージのコミットの CI/CD の状態（PBI-89）。checks は、GitHub Actions のワークフローの実行・チェック（GitHub Actions の
 * ジョブは除く）・コミットの状態。failedRuns は、失敗したワークフローの実行の ID（ジョブとログを読むため）。
 */
export type CiSnapshot = {
  checks: CiCheck[];
  /** 失敗したワークフローの実行（ID と名前・URL）。 */
  failedRuns: { id: number; name: string; url?: string; conclusion: string }[];
};

/** CI/CD の状態を読む口（PBI-89）。テストでは偽物に差し替える。repo はリポジトリの URL。 */
export interface CiStatusReader {
  snapshot(input: { repo: string; token: string; commit: string }): Promise<CiSnapshot>;
  /**
   * 失敗したワークフローの実行の、失敗したジョブとログの抜粋。抜粋は、秘密情報（secrets と、よくある秘密情報の形）を
   * 伏せてから切り詰める。
   */
  failures(input: {
    repo: string;
    token: string;
    runs: CiSnapshot["failedRuns"];
    secrets: readonly string[];
  }): Promise<CiFailure[]>;
}

/** 失敗とみなすジョブの結論（PBI-89。isFailedCiCheck と同じ）。 */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

/** 詳しく読む失敗の数（ジョブ）の上限。 */
export const CI_FAILURES_MAX = 5;
/** ログの末尾から取る行の数。 */
export const CI_LOG_LINES = 80;
/** 1件のログの抜粋の上限（文字数。伏せた後に切り詰める）。 */
export const CI_EXCERPT_MAX = 3_000;
/** 読むログの上限（バイト。大きなログを全部読まない）。 */
export const CI_LOG_BYTES = 2_000_000;
/** 一覧を読むページの上限。 */
const MAX_PAGES = 10;

/** 結論が失敗か（PBI-89）。 */
export const isFailedConclusion = isFailedCiCheck;

/**
 * よくある秘密情報の形（PBI-89。CI のログの抜粋に使う）。値の部分だけを伏せる（前の名前は残す）。
 * GitHub Actions はログの secrets を *** にするが、secrets に入れていない値（コマンドが出力した一時トークンなど）もある。
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
/** `Authorization: Bearer xxx`・`password=xxx` などの、値の部分（名前は残す）。 */
const SECRET_ASSIGNMENTS =
  /((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*|(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"'&,;]{4,})/gi;

/**
 * CI のログから、秘密情報を伏せる（PBI-89）。渡した値（使ったトークンなど）と、よくある秘密情報の形を伏せる。
 * 切り詰める前に呼ぶ（切り詰めで値の一部だけが残り、伏せられなくなるのを防ぐ）。
 */
export function redactLog(text: string, secrets: readonly string[]): string {
  // URL のユーザー情報（https://user:pass@host/）は、ほかの形に分かれる前に、URL として読んで伏せる
  let result = redactUrlCredentials(redact(text, secrets));
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result.replace(SECRET_ASSIGNMENTS, (_all, name: string) => `${name}[REDACTED]`);
}

/** スキームに使える文字（大文字・小文字は問わない）。 */
const SCHEME_CHAR = /[a-z0-9+.-]/i;
/** 単語の文字（正規表現の `\b` と同じ）。 */
const WORD_CHAR = /\w/;
/** 権限（ユーザー情報とホスト）の終わり（WHATWG URL の区切りと、ログの空白）。 */
const AUTHORITY_END = /[\s/?#\\]/;
/** ホストより後の、URL の終わり（ログの中の引用符・山括弧・バッククォート・空白）。 */
const URL_END = /[\s"'<>`]/;

/**
 * 文章の中の、スキーム（大文字・小文字は問わない）と `//` で始まる URL らしい文字列の位置（PBI-158）。`://` の位置から
 * 前へスキームを、後ろへ本体を調べる（文字列の長さに比例する時間で済ませる。URL の無い長いログで、候補ごとに残りを
 * 探し直さない）。ユーザー情報は引用符を含みうる（`https://user:p'ss@host/`）ので、権限の終わりまでに `@` があれば
 * そこまでを URL に含める（ログの引用符をまたいで伏せすぎることはあるが、認証情報の後半を残さない）。
 * queryAndFragment が true なら、クエリ・フラグメントの中の引用符でも終えない。
 */
function urlRanges(text: string, queryAndFragment: boolean): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let from = 0;
  for (let colon = text.indexOf("://"); colon !== -1; colon = text.indexOf("://", colon + 1)) {
    let begin = colon;
    while (begin > from && SCHEME_CHAR.test(text[begin - 1] as string)) begin--;
    // スキームは英字で始まり、前が単語の文字でない（`\b[a-z]`）。条件に合う最も前の位置から
    let start = -1;
    for (let i = begin; i < colon; i++) {
      const prev = i > 0 ? (text[i - 1] as string) : "";
      if (/[a-z]/i.test(text[i] as string) && !WORD_CHAR.test(prev)) {
        start = i;
        break;
      }
    }
    if (start === -1) continue;
    const body = colon + 3;
    // 権限は次の `://` の `/` までに終わるので、権限を調べる範囲は URL ごとに重ならない
    let lastAt = -1;
    for (let i = body; i < text.length && !AUTHORITY_END.test(text[i] as string); i++) {
      if (text[i] === "@") lastAt = i;
    }
    let end = lastAt === -1 ? body : lastAt + 1;
    while (end < text.length && !URL_END.test(text[end] as string)) end++;
    if (end === body) continue;
    // クエリ・フラグメントを伏せるときは、その中の引用符（`?session='…`）で URL を終えない。空白までにクエリか
    // フラグメントがあれば、空白までを URL に含める（閉じの引用符まで伏せることはあるが、値の後半を残さない）
    if (queryAndFragment) {
      let next = end;
      while (next < text.length && !/\s/.test(text[next] as string)) next++;
      let marked = false;
      for (let i = lastAt === -1 ? body : lastAt + 1; i < next && !marked; i++) {
        marked = text[i] === "?" || text[i] === "#";
      }
      if (marked) end = next;
    }
    ranges.push({ start, end });
    from = end;
    // URL の中の `://` は、次の候補にしない
    colon = end - 1;
  }
  return ranges;
}

/**
 * 文章の中の URL から、認証情報を除く（PBI-158）。ユーザー名・パスワード（`https://user:pass@host/`）を `REDACTED` に置き換える。
 * スキームの大文字・小文字は問わない（`HTTPS://` も）。queryAndFragment が true なら、クエリとフラグメントの中身も
 * `REDACTED` にする（トークンがクエリに入ることがあるため）。URL として読めない文字列は `[REDACTED URL]` にする。
 * 認証情報（と、指定したときのクエリ・フラグメント）が無い URL は、そのまま返す。
 */
export function redactUrlCredentials(
  text: string,
  options: { queryAndFragment?: boolean } = {},
): string {
  let result = "";
  let last = 0;
  for (const { start, end } of urlRanges(text, options.queryAndFragment === true)) {
    result += text.slice(last, start) + redactUrl(text.slice(start, end), options);
    last = end;
  }
  return last === 0 ? text : result + text.slice(last);
}

function redactUrl(value: string, options: { queryAndFragment?: boolean }): string {
  try {
    const url = new URL(value);
    let changed = false;
    if (url.username || url.password) {
      url.username = "REDACTED";
      url.password = "REDACTED";
      changed = true;
    }
    if (options.queryAndFragment) {
      if (url.search) {
        url.search = "?REDACTED";
        changed = true;
      }
      if (url.hash) {
        url.hash = "#REDACTED";
        changed = true;
      }
    }
    return changed ? url.href : value;
  } catch {
    return "[REDACTED URL]";
  }
}

/** ログの行の先頭の時刻（GitHub Actions のログの形）。 */
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/**
 * ログの抜粋（PBI-89）。時刻を除き、秘密情報を伏せてから、末尾の CI_LOG_LINES 行を取り、CI_EXCERPT_MAX 文字に
 * 切り詰める（長ければ末尾を残す。失敗の理由は末尾にあることが多いので）。
 */
export function logExcerpt(log: string, secrets: readonly string[]): string {
  const lines = redactLog(log.replace(/\r\n?/g, "\n"), secrets)
    .split("\n")
    .map((line) => line.replace(LOG_TIMESTAMP, ""))
    .filter((line, i, all) => line.trim() !== "" || i < all.length - 1);
  const tail = lines.slice(-CI_LOG_LINES).join("\n").trimEnd();
  return tail.length > CI_EXCERPT_MAX ? `…${tail.slice(-(CI_EXCERPT_MAX - 1))}` : tail;
}

/**
 * 同じワークフローの実行のうち、a が b より新しいか（PBI-89）。別の実行（run）は、通番（run_number）・作成の時刻
 * （created_at）・ID の順で比べ、同じ実行の中では再試行の回数（run_attempt）で比べる。run_attempt は1つの実行の中の
 * 回数なので、別の実行どうしの比べには使わない。
 */
export function newerRun(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a.id !== undefined && a.id === b.id) {
    return Number(a.run_attempt ?? 0) > Number(b.run_attempt ?? 0);
  }
  const number = Number(a.run_number ?? 0) - Number(b.run_number ?? 0);
  if (number !== 0) return number > 0;
  const created = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  if (created !== 0) return created > 0;
  return Number(a.id ?? 0) > Number(b.id ?? 0);
}

/**
 * 読みながら、末尾の max バイトだけを持つ（PBI-89。巨大なログを全部メモリーに読み込まない）。cut は、先頭を捨てたか。
 */
export async function readTail(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), cut: false };
  const chunks: Uint8Array[] = [];
  let held = 0;
  let cut = false;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    // 1つの塊が上限より大きければ、その末尾だけを持つ
    const chunk = value.length > max ? value.slice(value.length - max) : value;
    if (chunk !== value) cut = true;
    chunks.push(chunk);
    held += chunk.length;
    while (held > max) {
      const first = chunks[0] as Uint8Array;
      const over = held - max;
      cut = true;
      if (first.length <= over) {
        chunks.shift();
        held -= first.length;
      } else {
        chunks[0] = first.slice(over);
        held -= over;
      }
    }
  }
  const bytes = new Uint8Array(held);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, cut };
}

type Fetch = typeof fetch;

/** GitHub の REST API で CI/CD の状態を読む（PBI-89）。 */
export class GitHubCiStatus implements CiStatusReader {
  constructor(private readonly fetchImpl: Fetch = fetch) {}

  private headers(token: string) {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    };
  }

  /** 一覧（ページの続きも）を読み、key の配列をつなげて返す。 */
  private async list(
    api: string,
    first: string,
    token: string,
    key: string,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let url: string | undefined = first;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await this.fetchImpl(url, { headers: this.headers(token) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw apiError("readChecks", res.status, json);
      const items = json[key];
      if (Array.isArray(items)) all.push(...(items as Record<string, unknown>[]));
      const next = nextPage(res.headers.get("link"));
      url = next?.startsWith(`${api}/`) ? next : undefined;
    }
    return all;
  }

  async snapshot(input: Parameters<CiStatusReader["snapshot"]>[0]): Promise<CiSnapshot> {
    const { api, base } = repoApi(input.repo);
    const sha = encodeURIComponent(input.commit);
    const runs = await this.list(
      api,
      `${base}/actions/runs?head_sha=${sha}&per_page=100`,
      input.token,
      "workflow_runs",
    );
    const checkRuns = await this.list(
      api,
      `${base}/commits/${sha}/check-runs?per_page=100`,
      input.token,
      "check_runs",
    );
    const statuses = await this.list(
      api,
      `${base}/commits/${sha}/status?per_page=100`,
      input.token,
      "statuses",
    );
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const checks: CiCheck[] = [];
    const failedRuns: CiSnapshot["failedRuns"] = [];
    // 同じワークフローを再実行したら、最新の試行（run_attempt の大きいもの）だけを見る
    const latest = new Map<string, Record<string, unknown>>();
    for (const r of runs) {
      const key = String(r.workflow_id ?? r.name ?? r.id);
      const prev = latest.get(key);
      if (!prev || newerRun(r, prev)) latest.set(key, r);
    }
    for (const r of latest.values()) {
      const name = str(r.name) ?? str(r.display_title) ?? String(r.id);
      const completed = r.status === "completed";
      const conclusion = completed ? (str(r.conclusion) ?? "") : undefined;
      const url = str(r.html_url);
      const check: CiCheck = {
        kind: "workflow",
        name,
        status: completed ? "completed" : "pending",
        ...(conclusion !== undefined ? { conclusion } : {}),
        ...(url ? { url } : {}),
      };
      checks.push(check);
      if (isFailedConclusion(check) && typeof r.id === "number") {
        failedRuns.push({ id: r.id, name, conclusion: conclusion ?? "", ...(url ? { url } : {}) });
      }
    }
    for (const c of checkRuns) {
      // GitHub Actions のジョブは、ワークフローの実行で見る（二重に数えない）
      const app = (c.app as { slug?: unknown } | null)?.slug;
      if (app === "github-actions") continue;
      const completed = c.status === "completed";
      const url = str(c.html_url) ?? str(c.details_url);
      checks.push({
        kind: "check",
        name: str(c.name) ?? String(c.id),
        status: completed ? "completed" : "pending",
        ...(completed ? { conclusion: str(c.conclusion) ?? "" } : {}),
        ...(url ? { url } : {}),
      });
    }
    for (const st of statuses) {
      const state = str(st.state) ?? "pending";
      const url = str(st.target_url);
      checks.push({
        kind: "status",
        name: str(st.context) ?? "status",
        status: state === "pending" ? "pending" : "completed",
        ...(state === "pending" ? {} : { conclusion: state }),
        ...(url ? { url } : {}),
      });
    }
    return { checks, failedRuns };
  }

  async failures(input: Parameters<CiStatusReader["failures"]>[0]): Promise<CiFailure[]> {
    const { api, base } = repoApi(input.repo);
    const found: CiFailure[] = [];
    for (const run of input.runs) {
      if (found.length >= CI_FAILURES_MAX) break;
      let jobs: Record<string, unknown>[] = [];
      try {
        jobs = await this.list(
          api,
          `${base}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
          input.token,
          "jobs",
        );
      } catch {
        // ジョブを読めなければ、ワークフローの実行だけを書く
      }
      const failedJobs = jobs.filter(
        (j) =>
          j.status === "completed" &&
          typeof j.conclusion === "string" &&
          FAILED_CONCLUSIONS.has(j.conclusion),
      );
      if (failedJobs.length === 0) {
        found.push({
          workflow: run.name,
          conclusion: run.conclusion,
          ...(run.url ? { url: run.url } : {}),
        });
        continue;
      }
      for (const job of failedJobs) {
        if (found.length >= CI_FAILURES_MAX) break;
        const url = typeof job.html_url === "string" ? job.html_url : run.url;
        const excerpt =
          typeof job.id === "number" ? await this.jobLog(base, job.id, input) : undefined;
        found.push({
          workflow: run.name,
          job: typeof job.name === "string" ? job.name : String(job.id),
          conclusion: String(job.conclusion),
          ...(url ? { url } : {}),
          ...(excerpt ? { excerpt } : {}),
        });
      }
    }
    return found;
  }

  /** ジョブのログの抜粋（読めなければ undefined）。伏せてから切り詰める。 */
  private async jobLog(
    base: string,
    jobId: number,
    input: { token: string; secrets: readonly string[] },
  ): Promise<string | undefined> {
    try {
      // ログは別のホストへの転送で返る（fetch は、別のオリジンへの転送では Authorization を送らない）
      const res = await this.fetchImpl(`${base}/actions/jobs/${jobId}/logs`, {
        headers: this.headers(input.token),
        redirect: "follow",
      });
      if (!res.ok) return undefined;
      // 末尾の上限の分だけを、読みながら持つ（ログ全体をメモリーに読み込まない）
      const { bytes, cut } = await readTail(res.body, CI_LOG_BYTES);
      const decoded = new TextDecoder("utf-8").decode(bytes);
      // 切った先頭の行は、秘密情報の途中から始まりうる（伏せられない）ので捨てる
      const newline = decoded.indexOf("\n");
      const text = !cut ? decoded : newline < 0 ? "" : decoded.slice(newline + 1);
      const excerpt = logExcerpt(text, [...input.secrets, input.token]);
      return excerpt || undefined;
    } catch {
      return undefined;
    }
  }
}
