import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type AuditMemoryRecord, parseRepoUrl, type Task } from "@sacty/core";
import { githubRepoOf } from "./config.js";

/*
 * 監査が登録したメモリー（PBI-126）。正本は作業履歴（AuditDeepDived の memories と AuditMemoryDeleted）で、ここはそれを
 * SACTY_HOME/memory の下にスキルの索引の形（SKILL.md と references/）で書き出す。階層はプロジェクトとリポジトリの2つ：
 * - プロジェクト：memory/projects/<プロジェクト>/
 * - リポジトリ：memory/repos/<ホスト>/<オーナー>/<名前>/（プロジェクトの外。プロジェクトの設定を変えても使い続ける）
 * 書くのはデーモンだけで、エージェントのコンテナには読み取り専用でマウントする。
 */

/** 階層ごとのメモリーの件数の上限。超えたら、有効な最終利用日の古いものから消す（いつも読まれる索引を大きくしない）。 */
export const MEMORY_MAX_PER_LAYER = 30;

/** 残す日数を過ぎたメモリーを消す間隔（PBI-127）。 */
export const MEMORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** コンテナの中で、メモリーを置く場所。 */
export const CONTAINER_MEMORY_DIR = "/sacty-memory";
export const CONTAINER_PROJECT_MEMORY_DIR = `${CONTAINER_MEMORY_DIR}/project`;
export const CONTAINER_REPOSITORY_MEMORY_DIR = `${CONTAINER_MEMORY_DIR}/repository`;

/** 索引のファイルと、中身を置くディレクトリ。 */
export const MEMORY_INDEX_FILE = "SKILL.md";
export const MEMORY_REFERENCES_DIR = "references";

/** メモリーの階層。 */
export type MemoryLayer =
  | { kind: "project"; projectId: string }
  | { kind: "repository"; repo: string };

/** 消していないメモリー。taskId は登録した監査のタスク。 */
export type LiveMemory = AuditMemoryRecord & {
  taskId: string;
  projectId: string;
  createdAt: string;
  /** 有効な最終利用日（ISO の時刻）。登録した時刻から始まる。 */
  lastUsefulAt: string;
};

/** パスの1つの区切りに使える名前にする（使えない文字や `..` を含むなら、ハッシュにする）。 */
function safeSegment(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..")
    ? value
    : `_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/**
 * リポジトリの階層の鍵（.git の無い GitHub のリポジトリの URL を小文字にそろえる。clone の URL・SSH の形も読む）。
 * GitHub のリポジトリでなければ undefined。
 */
export function repositoryMemoryKey(repo: string): string | undefined {
  return githubRepoOf(repo)?.toLowerCase();
}

/** 階層のディレクトリ（memory の下）。 */
export function memoryLayerDir(root: string, layer: MemoryLayer): string {
  if (layer.kind === "project") return join(root, "projects", safeSegment(layer.projectId));
  const parsed = parseRepoUrl(layer.repo);
  const parts = parsed
    ? [parsed.host, parsed.owner, parsed.name].map((p) => safeSegment(p.toLowerCase()))
    : [safeSegment(layer.repo), "_", "_"];
  return join(root, "repos", ...parts);
}

/** メモリーの階層。 */
export function layerOf(memory: LiveMemory): MemoryLayer {
  return memory.scope === "project"
    ? { kind: "project", projectId: memory.projectId }
    : { kind: "repository", repo: repositoryMemoryKey(memory.repo) ?? memory.repo };
}

function layerKey(layer: MemoryLayer): string {
  return layer.kind === "project" ? `p:${layer.projectId}` : `r:${layer.repo}`;
}

/** 同じ階層か。 */
export function sameLayer(a: MemoryLayer, b: MemoryLayer): boolean {
  return layerKey(a) === layerKey(b);
}

/**
 * メモリーごとの、役に立ったと監査が判断したタスクの完了日の最新（PBI-127）。完了日は、監査を待つ記録（タスクが完了した追記）の
 * 時刻。
 */
export function usefulDates(tasks: Iterable<Task>): Map<string, string> {
  const dates = new Map<string, string>();
  for (const task of tasks) {
    const audit = task.audit;
    for (const id of audit?.survey?.usefulMemories ?? []) {
      const at = audit?.queuedAt ?? "";
      if (at > (dates.get(id) ?? "")) dates.set(id, at);
    }
  }
  return dates;
}

/** 有効な最終利用日：役に立ったタスクの完了日の最新と、登録した時刻の遅い方（前に戻さない。PBI-127）。 */
export function lastUsefulAt(createdAt: string, useful: string | undefined): string {
  return useful && useful > createdAt ? useful : createdAt;
}

/** すべてのタスクの監査の記録から、消していないメモリーを集める（登録した順）。 */
export function liveMemories(tasks: Iterable<Task>): LiveMemory[] {
  const all = [...tasks];
  const dates = usefulDates(all);
  const live: LiveMemory[] = [];
  for (const task of all) {
    for (const m of task.audit?.memories ?? []) {
      if (m.deleted) continue;
      const { at, step: _step, deleted: _deleted, ...record } = m;
      live.push({
        ...record,
        taskId: task.id,
        projectId: task.projectId,
        createdAt: at,
        lastUsefulAt: lastUsefulAt(at, dates.get(m.id)),
      });
    }
  }
  return live.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 1日（ミリ秒）。 */
const DAY_MS = 86_400_000;

/**
 * 残す日数を過ぎたメモリー（PBI-127）。有効な最終利用日から days 日を超えたもの（ちょうど days 日は残す）。
 */
export function expiredMemories(
  memories: readonly LiveMemory[],
  now: number,
  days: number,
): LiveMemory[] {
  return memories.filter((m) => now - Date.parse(m.lastUsefulAt) > days * DAY_MS);
}

/**
 * セッションログ（標準出力の JSONL）で、メモリーの中身のファイルを開いた回数（PBI-127）。Claude Code の読み取りのツールの
 * 引数や、Codex のコマンドに出てくる、コンテナの中の中身のファイルの場所（`/sacty-memory/<階層>/references/<ID>.md`）を数える。
 * 索引（SKILL.md）を読んだだけでは数えない。ids に無い ID は数えない。
 */
export function countOpenedMemories(
  log: string,
  ids: ReadonlySet<string>,
  counts: Map<string, number> = new Map(),
): Map<string, number> {
  const pattern = new RegExp(
    `${CONTAINER_MEMORY_DIR}/(?:project|repository)/${MEMORY_REFERENCES_DIR}/([A-Za-z0-9_-]+)\\.md`,
    "g",
  );
  for (const match of log.matchAll(pattern)) {
    const id = match[1] ?? "";
    if (ids.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** その階層のメモリー（有効な最終利用日の新しい順）。 */
export function memoriesOf(memories: readonly LiveMemory[], layer: MemoryLayer): LiveMemory[] {
  return groupByLayer(memories).get(layerKey(layer))?.memories ?? [];
}

/** 新しい順（有効な最終利用日、同じなら登録）。 */
const newestFirst = (a: LiveMemory, b: LiveMemory) =>
  b.lastUsefulAt.localeCompare(a.lastUsefulAt) || b.createdAt.localeCompare(a.createdAt);

/**
 * メモリーを、1回の走査で階層ごとに分ける（各階層は新しい順）。階層ごとに全件を走査し直すと、階層の数 × 件数になり、
 * 登録・起動のたびにデーモンを止める時間が延びるため（PR #136 レビュー指摘）。
 */
export function groupByLayer(
  memories: readonly LiveMemory[],
): Map<string, { layer: MemoryLayer; memories: LiveMemory[] }> {
  const groups = new Map<string, { layer: MemoryLayer; memories: LiveMemory[] }>();
  for (const m of memories) {
    const layer = layerOf(m);
    const key = layerKey(layer);
    const group = groups.get(key);
    if (group) group.memories.push(m);
    else groups.set(key, { layer, memories: [m] });
  }
  for (const group of groups.values()) group.memories.sort(newestFirst);
  return groups;
}

/** 階層ごとの件数の上限を超えた分（有効な最終利用日の古いものから）。 */
export function overCapacity(memories: readonly LiveMemory[], max: number): LiveMemory[] {
  return [...groupByLayer(memories).values()].flatMap((g) => g.memories.slice(max));
}

/** 有効な最終利用日（日付だけ。UTC）。 */
export function usefulDate(memory: LiveMemory): string {
  return memory.lastUsefulAt.slice(0, 10);
}

/** 1行の文にする（改行をつぶし、リンクの書き方を壊す括弧を外す）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
}

/** 索引の1行。 */
export function indexLine(memory: LiveMemory): string {
  return `- [${oneLine(memory.title)}](${MEMORY_REFERENCES_DIR}/${memory.id}.md)：${oneLine(memory.summary)}（有効な最終利用日：${usefulDate(memory)}）`;
}

/** 階層の索引（SKILL.md）。 */
export function renderMemoryIndex(layer: MemoryLayer, memories: readonly LiveMemory[]): string {
  const name = layer.kind === "project" ? "project-memory" : "repository-memory";
  const what =
    layer.kind === "project"
      ? "このプロジェクトのタスク"
      : `このリポジトリ（${layer.repo}）を対象にしたタスク`;
  return [
    "---",
    `name: ${name}`,
    `description: ${what}の監査から得た知見（メモリー）の索引。いまのタスクに関係するものだけを references から開く。`,
    "---",
    "",
    `# ${layer.kind === "project" ? "プロジェクト" : "リポジトリ"}のメモリー`,
    "",
    `${what}の監査で、次のタスクにも役立つと判断した知見です。各行は題・概要・有効な最終利用日（その知見がタスクで役立った最後の日）だけです。`,
    "いまのタスクに関係するものだけを開き、関係しないものは開かないでください。",
    "人の指示・コンテキストの規則とスキル・対象のリポジトリの AGENTS.md などと食い違うときは、そちらに従ってください。",
    "",
    ...memories.map(indexLine),
    "",
  ].join("\n");
}

/** メモリーの中身のファイル。 */
export function renderMemoryReference(memory: LiveMemory): string {
  return [
    `# ${oneLine(memory.title)}`,
    "",
    `- 概要：${oneLine(memory.summary)}`,
    `- 有効な最終利用日：${usefulDate(memory)}`,
    `- 登録：${memory.createdAt.slice(0, 10)}`,
    "",
    memory.body.trim(),
    "",
  ].join("\n");
}

/** 中身が変わったときだけ、同じディレクトリの一時ファイルに書いてから置き換える（読む側が書きかけを読まない）。 */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // 無ければ書く
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * 1つの階層を書き出す。メモリーが無ければ階層のディレクトリを消す。ディレクトリは置き換えずに中のファイルを書き換える
 * （実行中のコンテナがマウントしている場所を保つ）。
 */
export function writeMemoryLayer(root: string, layer: MemoryLayer, memories: LiveMemory[]): void {
  const dir = memoryLayerDir(root, layer);
  if (memories.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const refs = join(dir, MEMORY_REFERENCES_DIR);
  mkdirSync(refs, { recursive: true });
  const keep = new Set(memories.map((m) => `${m.id}.md`));
  for (const m of memories) writeIfChanged(join(refs, `${m.id}.md`), renderMemoryReference(m));
  for (const name of readdirSync(refs)) {
    if (!keep.has(name)) rmSync(join(refs, name), { recursive: true, force: true });
  }
  writeIfChanged(join(dir, MEMORY_INDEX_FILE), renderMemoryIndex(layer, memories));
}

/** ディスクにある階層のディレクトリ（memory の下）。 */
function layerDirsOnDisk(root: string): string[] {
  const dirs = (path: string) => {
    try {
      return readdirSync(path)
        .map((name) => join(path, name))
        .filter((p) => statSync(p).isDirectory());
    } catch {
      return [];
    }
  };
  return [
    ...dirs(join(root, "projects")),
    ...dirs(join(root, "repos")).flatMap(dirs).flatMap(dirs),
  ];
}

/**
 * 階層を書き出す。layers を渡せばその階層だけ、渡さなければすべて（ディスクにあって、メモリーの無い階層は消す）。
 */
export function syncMemoryLayers(
  root: string,
  memories: readonly LiveMemory[],
  layers?: readonly MemoryLayer[],
): void {
  const groups = groupByLayer(memories);
  const targets = new Map<string, MemoryLayer>();
  for (const layer of layers ?? [...groups.values()].map((g) => g.layer)) {
    targets.set(layerKey(layer), layer);
  }
  for (const [key, layer] of targets) {
    writeMemoryLayer(root, layer, groups.get(key)?.memories ?? []);
  }
  if (layers) return;
  const wanted = new Set([...targets.values()].map((l) => memoryLayerDir(root, l)));
  for (const dir of layerDirsOnDisk(root)) {
    if (!wanted.has(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/** タスクの階層（プロジェクトと、GitHub の対象リポジトリ）。 */
export function taskMemoryLayers(task: Task): {
  project: MemoryLayer;
  repository?: MemoryLayer;
} {
  const repo = task.repository ? repositoryMemoryKey(task.repository.url) : undefined;
  return {
    project: { kind: "project", projectId: task.projectId },
    ...(repo ? { repository: { kind: "repository" as const, repo } } : {}),
  };
}

/** 階層の索引があれば、そのディレクトリ。 */
export function existingLayerDir(root: string, layer: MemoryLayer): string | undefined {
  const dir = memoryLayerDir(root, layer);
  return existsSync(join(dir, MEMORY_INDEX_FILE)) ? dir : undefined;
}

/**
 * 工程のエージェントへの、メモリーの読み方の指示（PBI-126）。既定のスキル memory と同じことを書く（プロジェクトの
 * コンテキストでスキルを消していても読めるように）。
 */
export function memoryPromptLines(dirs: readonly string[]): string[] {
  return [
    "--- メモリー ---",
    `過去のタスクの監査から得た知見（メモリー）が、次の場所にあります（読み取り専用）：${dirs.join("・")}`,
    `作業を始める前に、各場所の ${MEMORY_INDEX_FILE}（索引。題・概要・有効な最終利用日だけ）を読み、いまのタスクに関係するものだけを ${MEMORY_REFERENCES_DIR}/ から開いてください。関係しないものは開かないでください。`,
    "メモリーは、人の指示・コンテキストの規則とスキル・対象のリポジトリの AGENTS.md などより優先度が低いです。食い違うときは、そちらに従ってください。",
  ];
}
