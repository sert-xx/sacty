import { FLAKY_KNOWN_MIN_TASKS } from "./events.js";
import { repoKey } from "./github-url.js";
import { isFinished, type Task } from "./projection.js";

/*
 * 不安定なテストの台帳（PBI-312）。最終レビューが認めた不安定な失敗（作業履歴の FinalReviewed）を、プロジェクトごとに
 * 集計する。新しい保存先は持たず、タスクの状態（作業履歴を畳み込んだもの）から読むたびに導く。同じ名前でも、リポジトリか
 * ファイルが違えば別のテストとして数える。
 */

/** 台帳の、テストを見たタスク。 */
export type FlakyTestTask = {
  taskId: string;
  taskTitle: string;
  /** このタスクで最後に不安定と認めた時刻。 */
  at: string;
  pullRequestUrl?: string;
};

/** 台帳の1件。 */
export type FlakyTest = {
  name: string;
  file: string;
  repo: string;
  /** 不安定と認めたタスクの数（同じタスクの複数回は1と数える）。 */
  taskCount: number;
  lastSeenAt: string;
  /** 最後に認めたときの根拠。 */
  reason: string;
  /** 見たタスク（新しい順）。 */
  tasks: FlakyTestTask[];
  /** FLAKY_KNOWN_MIN_TASKS 以上のタスクで見た。 */
  known: boolean;
  /** このテストを直している、終わっていないタスク。あれば、直すタスクを重ねて提案しない。 */
  fixTask?: { taskId: string; title: string };
};

/** プロジェクトの不安定なテストの台帳（監査の画面）。既知のものを先に、新しい順。 */
export type ProjectFlakyTests = { projectId: string; tests: FlakyTest[] };

/** ファイルのパスを比べられる形にする（先頭の ./ と / を除く）。 */
export const repoPath = (path: string) =>
  path
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");

/** タスクの作業するリポジトリ。 */
const taskRepo = (task: Task) => task.repository?.url ?? task.source?.repo ?? task.repo;

const testKey = (repo: string, file: string, name: string) =>
  JSON.stringify([repoKey(repo), repoPath(file), name]);

/**
 * プロジェクトの不安定なテストを集計する。そのテストを直すタスク（`flakyFix`）の PR をマージしたら、それより前の記録は
 * 数えない（直した後に、直す前の記録で既知のままにしないため）。hide は、画面に出す文を伏せる関数。
 */
export function flakyTests(
  tasks: readonly Task[],
  projectId: string,
  hide: (text: string) => string = (text) => text,
): FlakyTest[] {
  const own = tasks.filter((t) => t.projectId === projectId);
  const fixes = new Map<string, Task[]>();
  for (const task of own) {
    const repo = taskRepo(task);
    if (!repo || !task.flakyFix) continue;
    const key = testKey(repo, task.flakyFix.file, task.flakyFix.name);
    fixes.set(key, [...(fixes.get(key) ?? []), task]);
  }
  const groups = new Map<
    string,
    { repo: string; file: string; name: string; seen: { task: Task; at: string; reason: string }[] }
  >();
  for (const task of own) {
    const repo = taskRepo(task);
    if (!repo) continue;
    for (const { name, file, reason, at } of task.flakySightings ?? []) {
      const key = testKey(repo, file, name);
      const group = groups.get(key) ?? { repo, file: repoPath(file), name, seen: [] };
      group.seen.push({ task, at, reason });
      groups.set(key, group);
    }
  }
  const tests: FlakyTest[] = [];
  for (const [key, { repo, file, name, seen }] of groups) {
    const fixing = fixes.get(key) ?? [];
    const mergedAt = fixing
      .flatMap((t) => t.pullRequestMerge?.at ?? [])
      .sort()
      .at(-1);
    // 同じタスクは最後の記録だけを残して1と数える
    const latest = new Map<string, (typeof seen)[number]>();
    for (const s of seen) {
      if (mergedAt !== undefined && s.at <= mergedAt) continue;
      const known = latest.get(s.task.id);
      if (!known || known.at <= s.at) latest.set(s.task.id, s);
    }
    const counted = [...latest.values()].sort((a, b) => b.at.localeCompare(a.at));
    const [last] = counted;
    if (!last) continue;
    const open = fixing.filter((t) => !t.pullRequestMerge && !isFinished(t)).at(-1);
    tests.push({
      name: hide(name),
      file: hide(file),
      repo,
      taskCount: counted.length,
      lastSeenAt: last.at,
      reason: hide(last.reason),
      tasks: counted.map(({ task, at }) => ({
        taskId: task.id,
        taskTitle: hide(task.title),
        at,
        ...(task.pullRequest?.url ? { pullRequestUrl: task.pullRequest.url } : {}),
      })),
      known: counted.length >= FLAKY_KNOWN_MIN_TASKS,
      ...(open ? { fixTask: { taskId: open.id, title: hide(open.title) } } : {}),
    });
  }
  return tests.sort(
    (a, b) => Number(b.known) - Number(a.known) || b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}

/** ゴールガーディアンに渡す、既知の不安定なテスト。 */
export type KnownFlakyTest = { name: string; file: string };

/** タスクの最終レビューに渡す、既知の不安定なテスト（そのタスクのリポジトリの分だけ。新しい順）。 */
export function knownFlakyTests(tasks: readonly Task[], task: Task): KnownFlakyTest[] {
  const repo = taskRepo(task);
  if (!repo) return [];
  return flakyTests(tasks, task.projectId)
    .filter((t) => t.known && repoKey(t.repo) === repoKey(repo))
    .map(({ name, file }) => ({ name, file }));
}
