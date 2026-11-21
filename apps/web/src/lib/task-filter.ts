import type { StatusTone } from "@/lib/labels";
import { repoShortName } from "@/lib/repo-label";
import type { TaskRow } from "@/lib/task-list-data";

/**
 * タスクの一覧の絞り込み。空の項目は絞り込まない。
 * - query：題に含む文字（大文字と小文字を区別しない）
 * - from・to：作った日（画面のタイムゾーンの YYYY-MM-DD。両端を含む）
 * - start：開始地点
 * - repo：作業するリポジトリの名前か、複数を指定したタスクの、指定したリポジトリの名前のどれか
 *   （NO_REPO は、リポジトリがまだ決まっておらず、指定もしていないタスク）
 * - status：状態の種類（ACTIVE は、完了と中止のほか）
 */
export type TaskFilter = {
  query: string;
  from: string;
  to: string;
  start: "" | TaskRow["start"];
  repo: string;
  status: "" | typeof ACTIVE | StatusTone;
};

/**
 * 「未定・リポジトリ無し」を表す値。リポジトリの名前（英数字と `.`・`_`・`-` だけ）と重ならないよう、名前に使えない `:` を含める
 * （`-` という名前のリポジトリを、「未定・リポジトリ無し」と取り違えないため）。
 */
export const NO_REPO = ":none";
export const ACTIVE = "active";

export const EMPTY_FILTER: TaskFilter = {
  query: "",
  from: "",
  to: "",
  start: "",
  repo: "",
  status: "",
};

export function isFiltering(filter: TaskFilter): boolean {
  return Object.values(filter).some((v) => v.trim() !== "");
}

/** 最初の表示の状態：終わっていないタスクがあれば ACTIVE、無ければ「すべて」（空の一覧を最初に見せない）。 */
export function defaultStatusFor(rows: Pick<TaskRow, "status">[]): "" | typeof ACTIVE {
  return rows.some((r) => r.status.tone !== "completed" && r.status.tone !== "cancelled")
    ? ACTIVE
    : "";
}

/** 開いたときの最初の表示と違う条件があるか（「条件をクリア」を出すか）。状態は、最初の表示の状態と比べる。 */
export function differsFromInitial(filter: TaskFilter, defaultStatus: TaskFilter["status"]) {
  const { status, ...rest } = filter;
  return status !== defaultStatus || isFiltering({ ...EMPTY_FILTER, ...rest });
}

/** URL から読んだ絞り込み。指定が無い（検査に通らない）項目は undefined。 */
export type ParsedFilter = { [K in keyof TaskFilter]?: TaskFilter[K] };

type QueryParams = Record<string, string | string[] | undefined>;

const START_KINDS = {
  sacty: true,
  github_issue: true,
  github_pull_request: true,
  split: true,
  jira: true,
  deployment: true,
  audit: true,
  schedule: true,
  security: true,
} satisfies Record<TaskRow["start"], true>;
const STATUS_VALUES = new Set<string>([
  ACTIVE,
  "person",
  "working",
  "waiting",
  "completed",
  "cancelled",
]);

function isRealDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * URL のクエリ（q・from・to・start・repo・status）を絞り込みにする。空・同じ名前が 2 つ以上・知らない値・
 * 形の違う値は、その項目の指定が無いものとして扱う。状態の「すべて」は status=all（空の状態になる）。
 */
export function parseTaskFilter(params: QueryParams | URLSearchParams): ParsedFilter {
  const one = (name: string): string | undefined => {
    if (params instanceof URLSearchParams) {
      const all = params.getAll(name);
      return all.length === 1 && all[0] !== "" ? all[0] : undefined;
    }
    const v = params[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const parsed: ParsedFilter = {};
  const q = one("q");
  if (q !== undefined) parsed.query = q;
  const from = one("from");
  if (from !== undefined && isRealDay(from)) parsed.from = from;
  const to = one("to");
  if (to !== undefined && isRealDay(to)) parsed.to = to;
  const start = one("start");
  if (start !== undefined && Object.hasOwn(START_KINDS, start)) {
    parsed.start = start as TaskFilter["start"];
  }
  const repo = one("repo");
  if (repo !== undefined) parsed.repo = repo;
  const status = one("status");
  if (status === "all") parsed.status = "";
  else if (status !== undefined && STATUS_VALUES.has(status)) {
    parsed.status = status as TaskFilter["status"];
  }
  return parsed;
}

/** 日をブラウザーのタイムゾーンで決めるので、サーバーでは行を選べない（開始時期の指定があるとき）。 */
export function needsLocalDay(filter: Pick<TaskFilter, "from" | "to">): boolean {
  return filter.from !== "" || filter.to !== "";
}

const FILTER_PARAMS = ["q", "from", "to", "start", "repo", "status"] as const;

/**
 * 絞り込みを URL のクエリにする。最初の表示と違う項目だけを書き、絞り込みに関係のないクエリは残す。
 * 返すのは、先頭の `?` つきの文字列（クエリが無ければ空）。
 */
export function filterQuery(
  filter: TaskFilter,
  defaultStatus: TaskFilter["status"],
  search: string,
): string {
  const params = new URLSearchParams(search);
  for (const name of FILTER_PARAMS) params.delete(name);
  if (filter.query.trim() !== "") params.set("q", filter.query);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.start) params.set("start", filter.start);
  if (filter.repo) params.set("repo", filter.repo);
  if (filter.status !== defaultStatus) params.set("status", filter.status || "all");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** 日時（ISO 8601）を、画面のタイムゾーンの日（YYYY-MM-DD）にする。 */
export function localDay(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 行のリポジトリの名前：作業するリポジトリと、複数を指定したタスクの、指定したリポジトリ（PBI-360）。
 * 作業するリポジトリが決まる前も後も、指定したどのリポジトリでも探せるようにする。
 */
export function rowRepoNames(row: Pick<TaskRow, "repoName" | "repos">): string[] {
  return [
    ...new Set([...(row.repoName ? [row.repoName] : []), ...(row.repos ?? []).map(repoShortName)]),
  ];
}

export function matchesFilter(row: TaskRow, filter: TaskFilter): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query && !row.title.toLowerCase().includes(query)) return false;
  if (filter.from || filter.to) {
    const day = localDay(row.createdAt);
    if (filter.from && day < filter.from) return false;
    if (filter.to && day > filter.to) return false;
  }
  if (filter.start && row.start !== filter.start) return false;
  if (filter.repo) {
    const names = rowRepoNames(row);
    if (filter.repo === NO_REPO ? names.length > 0 : !names.includes(filter.repo)) return false;
  }
  if (filter.status === ACTIVE) {
    if (row.status.tone === "completed" || row.status.tone === "cancelled") return false;
  } else if (filter.status && row.status.tone !== filter.status) return false;
  return true;
}

/**
 * 絞り込みの選択肢：一覧にある開始地点と、リポジトリの名前（名前の順。決まっていないタスクがあれば NO_REPO を最後に）。
 * 選んでいる値は、取り直しで一覧から消えても残す（選択肢から消えると「すべて」と表示されたまま0件になるため）。
 */
export function filterOptions(
  rows: TaskRow[],
  filter: TaskFilter = EMPTY_FILTER,
): { starts: TaskRow["start"][]; repos: string[] } {
  const starts = [
    ...new Set([...rows.map((r) => r.start), ...(filter.start ? [filter.start] : [])]),
  ];
  const names = [
    ...new Set([
      ...rows.flatMap(rowRepoNames),
      ...(filter.repo && filter.repo !== NO_REPO ? [filter.repo] : []),
    ]),
  ].sort();
  const noRepo = filter.repo === NO_REPO || rows.some((r) => rowRepoNames(r).length === 0);
  return { starts, repos: noRepo ? [...names, NO_REPO] : names };
}
