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
 * 伏せる範囲は JSON の文字列の外へ出さない（監査の結果など、伏せてから JSON として読む出力を壊さないため。PBI-158）。
 * 終わりの行が無い秘密鍵は、`"`（エスケープしたものを含む）の前か、文字列の末尾までを伏せる。
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[^"\\]|\\[^"])*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?=\\?")|$)/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
/**
 * `Authorization: Bearer xxx`・`password=xxx` などの、値の部分（名前は残す）。値は次のどれか（PBI-158）。
 * - `"`（エスケープした `\"` を含む）で始まる値：同じ深さの閉じの引用符（と改行）の前まで（quotedEnd で探す）。
 *   中のエスケープした引用符（JSON の文字列の中の `\"`）と括弧も値に含める
 * - `'` で始まる値：閉じの `'`（と改行）の前まで（quotedEnd ではなく singleQuotedEnd で探す）。`"` と括弧も値に含めるが、
 *   JSON の文字列の外へは出さない
 * - 引用符の無い値：空白・引用符・`&`・`,`・`;` と、引用符をエスケープしている `\` の前まで（括弧も値に含める）。
 *   JSON のキーの後（`"token": …`）なら、JSON の区切りの括弧の前までを値とする
 * どの値も、閉じの引用符と、それをエスケープしている `\` の並びは残す（JSON の文字列の区切りを壊さないため）。名前の
 * 前後の引用符はエスケープしていてもよい（エスケープした JSON の `\"password\":\"…\"`）。
 */
const SECRET_ASSIGNMENTS =
  /((?:authorization|proxy-authorization)\\*["']?\s*[:=]\s*(?:bearer|basic|token)?\s*|(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\\*["']?\s*[:=]\s*)(?:(\\*")|(')|((?:[^\s"'&,;\\]|\\+(?=[^\s"'\\])){4,}))/gi;

/**
 * `"` で始まる値の終わり（PBI-158）。from は開きの引用符の次、escapes は開きの引用符の前のバックスラッシュの数（0 なら
 * JSON の文字列、1 ならエスケープした JSON の文字列、3 ならエスケープを重ねた JSON の文字列）。引用符の前のバックスラッシュの
 * 並びの長さ r が、この深さでエスケープした引用符（下位のビットがすべて 1）なら値の中身、そうでなければ閉じの引用符（か、
 * 外の文字列の終わり）なので、並びの前で終える。改行でも終える。
 */
function quotedEnd(text: string, from: number, escapes: number): number {
  const mask = 2 ** Math.floor(Math.log2(escapes + 1) + 1) - 1;
  let at = from;
  while (at < text.length) {
    const c = text[at] as string;
    if (c === "\r" || c === "\n" || c === '"') return at;
    if (c !== "\\") {
      at++;
      continue;
    }
    let run = at;
    while (run < text.length && text[run] === "\\") run++;
    if (text[run] === '"' && ((run - at) & mask) !== mask) return at;
    at = text[run] === '"' ? run + 1 : run;
  }
  return at;
}

/**
 * `'` で始まる値の終わり（PBI-158）。from は開きの引用符の次。閉じの `'`・改行の前までで、JSON の文字列の中なら、その文字列の
 * 閉じの引用符の前まで、外なら次の JSON の文字列の前まで（JSON の文字列の区切りを壊さないため）。ranges は jsonStrings の結果。
 */
function singleQuotedEnd(
  text: string,
  from: number,
  ranges: readonly { start: number; end: number }[],
): number {
  // ranges は重ならず、始まりの順に並ぶので、from より前に始まる最後の範囲を二分探索で探す
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ranges[middle] as { start: number }).start < from) low = middle + 1;
    else high = middle;
  }
  const before = ranges[low - 1];
  const limit = before && from < before.end ? before.end - 1 : (ranges[low]?.start ?? text.length);
  let at = from;
  while (at < limit && !"'\r\n".includes(text[at] as string)) at++;
  return at;
}

/** 名前と値の形の秘密情報（SECRET_ASSIGNMENTS）を伏せる。 */
function redactAssignments(text: string): string {
  const pattern = new RegExp(SECRET_ASSIGNMENTS.source, SECRET_ASSIGNMENTS.flags);
  let result = "";
  let last = 0;
  let ranges: { start: number; end: number }[] | undefined;
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    const [all, name = "", doubleQuote, singleQuote, bare] = found;
    const valueAt = found.index + name.length;
    let replaced: string | undefined;
    let end = found.index + all.length;
    if (doubleQuote !== undefined) {
      const from = valueAt + doubleQuote.length;
      const until = quotedEnd(text, from, doubleQuote.length - 1);
      if (until - from >= 4) {
        replaced = `${name}${doubleQuote}[REDACTED]`;
        end = until;
      }
    } else if (singleQuote !== undefined) {
      ranges ??= jsonStrings(text);
      const from = valueAt + 1;
      const until = singleQuotedEnd(text, from, ranges);
      if (until - from >= 4) {
        replaced = `${name}'[REDACTED]`;
        end = until;
      }
    } else {
      const value = bare ?? "";
      const key = /(\\*)"\s*:\s*$/.exec(name);
      // JSON のキーの後の引用符の無い値（`"token": 12345678}`）は、区切りの括弧の前までを JSON の文字列にして伏せる。
      // null・true・false は秘密情報ではないので残す。括弧で始まる値（配列・オブジェクト）は、中の値を別に調べる
      const secret = key ? (/^[^{}[\]]*/.exec(value)?.[0] ?? "") : value;
      if (!key) replaced = `${name}[REDACTED]`;
      else if (secret.length >= 4 && !/^(?:null|true|false)$/.test(secret)) {
        const quote = `${key[1]}"`;
        replaced = `${name}${quote}[REDACTED]${quote}`;
        end = valueAt + secret.length;
      }
    }
    if (replaced === undefined) continue;
    result += text.slice(last, found.index) + replaced;
    last = end;
    pattern.lastIndex = end;
  }
  return last === 0 ? text : result + text.slice(last);
}

/**
 * CI のログから、秘密情報を伏せる（PBI-89）。渡した値（使ったトークンなど）と、よくある秘密情報の形を伏せる。
 * 切り詰める前に呼ぶ（切り詰めで値の一部だけが残り、伏せられなくなるのを防ぐ）。
 */
export function redactLog(text: string, secrets: readonly string[]): string {
  // URL のユーザー情報（https://user:pass@host/）は、ほかの形に分かれる前に、URL として読んで伏せる
  let result = redactUrlCredentials(redact(text, secrets));
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return redactAssignments(result);
}

/** スキームに使える文字（大文字・小文字は問わない）。 */
const SCHEME_CHAR = /[a-z0-9+.-]/i;
/**
 * 権限（ユーザー情報とホスト）の終わり（WHATWG URL の区切りと、ログの空白）。`\` では終えない（JSON の
 * エスケープ `p\"ss` など、ユーザー情報に入りうるため）。
 */
const AUTHORITY_END = /[\s/?#]/;
/** JSON の文字列の外では、`"` も URL の終わりにする（JSON の文字列の区切りを越えないように）。 */
const AUTHORITY_END_OUTSIDE = /[\s/?#"]/;
/** ホストより後の、URL の終わり（ログの中の引用符・山括弧・バッククォート・空白）。 */
const URL_END = /[\s"'<>`]/;
const WHITESPACE = /\s/;

/**
 * from 以降で、最初に条件に合う文字の位置を返す口（無ければ文字列の長さ）。調べる位置が前に進むだけなら、一度調べた所を
 * 調べ直さない（URL ごとに残りを走査して二次時間にならないように）。
 */
function nextMatch(text: string, test: (c: string) => boolean): (from: number) => number {
  let searched = 0;
  let found = -1;
  return (from) => {
    if (from >= searched && found >= from) return found;
    searched = from;
    found = from;
    while (found < text.length && !test(text[found] as string)) found++;
    return found;
  };
}

/**
 * 文章の中の、スキーム（大文字・小文字は問わない）と `//` で始まる URL らしい文字列の位置（PBI-158）。`://` の位置から
 * 前へスキームを、後ろへ本体を調べる（文字列の長さに比例する時間で済ませる。URL の無い長いログや、空白の無い URL の
 * 並びで、候補ごとに残りを探し直さない）。スキームは、前に単語の文字があっても（`_https://`）英字から始める。
 * ユーザー情報は引用符・`\` を含みうる（`https://user:p'ss@host/`）ので、権限の終わりまでに `@` があれば
 * そこまでを URL に含める（ログの引用符をまたいで伏せすぎることはあるが、認証情報の後半を残さない）。
 * queryAndFragment が true なら、クエリ・フラグメントの中の引用符でも終えない。
 * insideString が false（JSON の文字列の外）なら、`"` と、それをエスケープしている `\` は越えない（エスケープした JSON や、
 * JSON の文字列と見なせなかった所でも、文字列の区切りを壊さないように）。
 */
function urlRanges(
  text: string,
  queryAndFragment: boolean,
  insideString: boolean,
): { start: number; end: number; userinfo: boolean }[] {
  const ranges: { start: number; end: number; userinfo: boolean }[] = [];
  const authorityEnd = insideString ? AUTHORITY_END : AUTHORITY_END_OUTSIDE;
  // クエリ・フラグメントを伸ばす先（JSON の文字列の外では、`"` の前まで）
  const nextStop = nextMatch(text, (c) => WHITESPACE.test(c) || (!insideString && c === '"'));
  const nextMark = nextMatch(text, (c) => c === "?" || c === "#");
  let from = 0;
  for (let colon = text.indexOf("://"); colon !== -1; colon = text.indexOf("://", colon + 1)) {
    let begin = colon;
    while (begin > from && SCHEME_CHAR.test(text[begin - 1] as string)) begin--;
    // スキームは英字で始まる。数字・記号から始まる部分は飛ばす
    let start = begin;
    while (start < colon && !/[a-z]/i.test(text[start] as string)) start++;
    if (start === colon) continue;
    const body = colon + 3;
    // 権限は次の `://` の `/` までに終わるので、権限を調べる範囲は URL ごとに重ならない
    let lastAt = -1;
    for (let i = body; i < text.length && !authorityEnd.test(text[i] as string); i++) {
      if (text[i] === "@") lastAt = i;
    }
    const host = lastAt === -1 ? body : lastAt + 1;
    let end = host;
    while (end < text.length && !URL_END.test(text[end] as string)) end++;
    if (end === body) continue;
    // クエリ・フラグメントを伏せるときは、その中の引用符（`?session='…`）で URL を終えない。空白までにクエリか
    // フラグメントがあれば、空白までを URL に含める（閉じの引用符まで伏せることはあるが、値の後半を残さない）
    if (queryAndFragment) {
      const stop = nextStop(end);
      if (nextMark(host) < stop) end = stop;
    }
    // 引用符をエスケープしているバックスラッシュ（`\"`）は、URL に含めない（エスケープした JSON を壊さないように）
    if (text[end] === '"' || text[end] === "'") {
      let slashes = 0;
      while (end - slashes - 1 >= host && text[end - slashes - 1] === "\\") slashes++;
      if (slashes % 2 === 1) end--;
    }
    if (end === body) continue;
    ranges.push({ start, end, userinfo: lastAt !== -1 });
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
  return redactUrls(text, options, false);
}

/**
 * redactUrlCredentials の本体。insideString は、JSON の文字列をデコードした中身か（中身はまとめてエンコードし直すので、
 * `"` を越えて伏せても、外の JSON の構文は壊れない）。
 */
function redactUrls(
  text: string,
  options: { queryAndFragment?: boolean },
  insideString: boolean,
): string {
  // JSON の文字列（キーと値）は、デコードした中身ごとに伏せる（URL の範囲が、ほかのフィールドへ出ないように）
  let result = "";
  let last = 0;
  for (const { start, end, decoded } of jsonStrings(text)) {
    const literal = text.slice(start, end);
    const hidden = redactUrls(decoded, options, true);
    result += redactUrlsInText(text.slice(last, start), options, insideString);
    result += hidden === decoded ? literal : JSON.stringify(hidden);
    last = end;
  }
  return last === 0
    ? redactUrlsInText(text, options, insideString)
    : result + redactUrlsInText(text.slice(last), options, insideString);
}

/** JSON の値の前（`{`・`[`・`,`・`:`）と後（`,`・`:`・`}`・`]`）。`""` は文章の始まり・終わり（文章の全体が JSON の文字列のとき）。 */
const JSON_BEFORE = new Set(["{", "[", ",", ":", ""]);
const JSON_AFTER = new Set([",", ":", "}", "]", ""]);
/** JSON の文字列らしいもの（改行を含まない。JSON として読めるかは別に確かめる）。 */
const JSON_STRING = /"(?:[^"\\\n\r]|\\.)*"/y;

/**
 * 文章の中の、JSON のキー・値の位置にある文字列（`"…"`）の範囲（PBI-158）。前後の空白を除いた隣の文字が、JSON の区切りの
 * もの（文章の始まり・終わりも含む）だけを選ぶ（地の文の `"` を、JSON の文字列と見なさないように）。エスケープした `"`（前のバックスラッシュが奇数個）からは
 * 試さない（入れ子の JSON は、デコードした中身で調べる）。どの位置も、隣の `"` までを一度ずつ読む。JSON として読めない
 * もの（`\x` などのエスケープ）は選ばない。
 */
function jsonStrings(text: string): { start: number; end: number; decoded: string }[] {
  const ranges: { start: number; end: number; decoded: string }[] = [];
  const nextQuote = (from: number): number => {
    for (let at = text.indexOf('"', from); at !== -1; at = text.indexOf('"', at + 1)) {
      let slashes = 0;
      while (at - slashes - 1 >= 0 && text[at - slashes - 1] === "\\") slashes++;
      if (slashes % 2 === 0) return at;
    }
    return -1;
  };
  const neighbor = (from: number, step: 1 | -1): string => {
    let at = from;
    while (at >= 0 && at < text.length && WHITESPACE.test(text[at] as string)) at += step;
    return text[at] ?? "";
  };
  for (let i = nextQuote(0); i !== -1; ) {
    JSON_STRING.lastIndex = i;
    const found = JSON_STRING.exec(text)?.[0];
    const end = found ? i + found.length : -1;
    const decoded =
      found && JSON_BEFORE.has(neighbor(i - 1, -1)) && JSON_AFTER.has(neighbor(end, 1))
        ? parseString(found)
        : undefined;
    if (decoded !== undefined) {
      ranges.push({ start: i, end, decoded });
      i = nextQuote(end);
    } else {
      i = nextQuote(i + 1);
    }
  }
  return ranges;
}

function parseString(literal: string): string | undefined {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return undefined;
  }
}

/** JSON の文字列の外の文章（または JSON の文字列の中身）の URL から、認証情報を除く。 */
function redactUrlsInText(
  text: string,
  options: { queryAndFragment?: boolean },
  insideString: boolean,
): string {
  let result = "";
  let last = 0;
  for (const { start, end, userinfo } of urlRanges(
    text,
    options.queryAndFragment === true,
    insideString,
  )) {
    result += text.slice(last, start) + redactUrl(text.slice(start, end), userinfo, options);
    last = end;
  }
  return last === 0 ? text : result + text.slice(last);
}

function redactUrl(
  value: string,
  userinfo: boolean,
  options: { queryAndFragment?: boolean },
): string {
  try {
    const url = new URL(value);
    // 権限に `@` があるのに、ユーザー情報として読まれない（`https:` などで `\` を `/` と読み、前をホストにする）なら、
    // `@` の前に認証情報が残るので、まとめて伏せる
    if (userinfo && !url.username && !url.password) return "[REDACTED URL]";
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
