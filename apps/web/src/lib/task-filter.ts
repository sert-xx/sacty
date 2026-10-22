import type { StatusTone } from "@/lib/labels";
import type { TaskRow } from "@/lib/task-list-data";

/**
 * タスクの一覧の絞り込み。空の項目は絞り込まない。
 * - query：題に含む文字（大文字と小文字を区別しない）
 * - from・to：作った日（画面のタイムゾーンの YYYY-MM-DD。両端を含む）
 * - start：開始地点
 * - repo：作業するリポジトリの名前（NO_REPO はリポジトリがまだ決まっていない・指定せずに作ったタスク）
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

export const NO_REPO = "-";
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

/** 日時（ISO 8601）を、画面のタイムゾーンの日（YYYY-MM-DD）にする。 */
export function localDay(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  if (filter.repo && (row.repoName ?? NO_REPO) !== filter.repo) return false;
  if (filter.status === ACTIVE) {
    if (row.status.tone === "completed" || row.status.tone === "cancelled") return false;
  } else if (filter.status && row.status.tone !== filter.status) return false;
  return true;
}

/** 絞り込みの選択肢：一覧にある開始地点と、リポジトリの名前（名前の順。決まっていないタスクがあれば NO_REPO を最後に）。 */
export function filterOptions(rows: TaskRow[]): { starts: TaskRow["start"][]; repos: string[] } {
  const starts = [...new Set(rows.map((r) => r.start))];
  const names = [...new Set(rows.flatMap((r) => (r.repoName ? [r.repoName] : [])))].sort();
  const repos = rows.some((r) => !r.repoName) ? [...names, NO_REPO] : names;
  return { starts, repos };
}
