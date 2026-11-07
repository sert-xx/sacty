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
  /**
   * テストを指す識別子（リポジトリ・ファイル・名前から作る）。画面の name・file は秘密情報を伏せた値なので、直すタスクを作る
   * ときは、これでデーモンが元のテストを探す。
   */
  id: string;
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

/**
 * ファイルのパスを比べられる形にする。先頭の / を除き、途中の . と .. を解決する（最終レビューの確かめ方とそろえる。
 * 先頭からはみ出す .. は残す）。
 */
export const repoPath = (path: string) => {
  const parts: string[] = [];
  for (const part of path.trim().replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
};

/** タスクの作業するリポジトリ。 */
const taskRepo = (task: Task) => task.repository?.url ?? task.source?.repo ?? task.repo;

const testKey = (repo: string, file: string, name: string) =>
  JSON.stringify([repoKey(repo), repoPath(file), name]);

/** 識別子（cyrb53。秘密情報を含みうる元の値を、画面に出さずに指すため）。 */
function flakyTestId(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 分割で作った子孫のタスク（直すタスクの PR は、分割すると子にだけ記録される）。 */
function descendants(task: Task, children: ReadonlyMap<string, Task[]>): Task[] {
  const out: Task[] = [];
  const queue = [...(children.get(task.id) ?? [])];
  while (queue.length > 0) {
    const child = queue.shift() as Task;
    if (out.includes(child)) continue;
    out.push(child);
    queue.push(...(children.get(child.id) ?? []));
  }
  return out;
}

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
  const children = new Map<string, Task[]>();
  for (const task of own) {
    if (task.parent)
      children.set(task.parent.taskId, [...(children.get(task.parent.taskId) ?? []), task]);
  }
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
      .flatMap((t) => [t, ...descendants(t, children)])
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
      id: flakyTestId(key),
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

/**
 * 識別子から、伏せる前のテストを探す（直すタスクを作るとき）。repo はテストのリポジトリ。台帳に無ければ undefined。
 */
export function findFlakyTest(
  tasks: readonly Task[],
  projectId: string,
  id: string,
): { name: string; file: string; repo: string } | undefined {
  const test = flakyTests(tasks, projectId).find((t) => t.id === id);
  return test && { name: test.name, file: test.file, repo: test.repo };
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
