import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type ActivityEvent, type ArchivedAgentFile, ERROR_ANALYSIS_ROLE } from "@sacty/core";
import { AGENT_FILES_DIR, archivedFilePath } from "./agent-sessions.js";
import {
  type SessionLogFile,
  type SessionLogMeta,
  type SessionLogStore,
  validLogId,
} from "./session-logs.js";

/**
 * オーケストレーターへの質問の答え（PBI-91）で読ませる、タスクの各実行のセッションログ。実行ごとのセッションログ（PBI-62）と
 * エージェントの元のファイル（PBI-66）のうち、このタスクの終わった実行の分だけを、答えの実行ごとの場所に並べ、コンテナに
 * 読み取り専用でマウントする（指示には一覧だけを入れ、中身は必要な部分を探して読ませる）。
 * - ほかのタスクのログは並べない（タスクごとの場所だけを見る）。ログ以外のファイルも並べない（決まった名前と、作業履歴に
 *   記録したエージェントのファイルだけ）。
 * - 実行中の実行（このデーモンで開いていて、まだ閉じていないログ）は、includeRunning のときだけ、いまの写しを並べる。
 *   写しは、書き始めた後に分かった秘密情報も含めて、写したときの秘密情報で伏せ直す（閉じる前のファイルには残っていることが
 *   あるため、ファイルそのものは並べない）。エージェントの元のファイルは、実行が終わるまで無い。
 * - 終わりが記録されていない実行のうち、実行中でないもの（デーモンが止まって終わりを記録できなかった）は並べない。
 * - 元のファイルは同じ場所の中ならハードリンクにし（写さない）、できなければ写す。
 * - タスクのログの場所が無ければ（まだ実行が無い）実行の無いタスクとし、開けなければ（権限が無い・ディレクトリでないなど）
 *   例外を投げる（呼ぶ側が、ログを読めないことを伝えて台帳から答えさせる）。
 */

/** コンテナの中で、セッションログを置く場所（作業領域の外）。 */
export const CONTAINER_LOGS_DIR = "/sacty-logs";

/** 並べた場所での、実行ごとのファイルの名前。 */
export const QUESTION_LOG_FILES: Record<SessionLogFile | "meta", string> = {
  events: "events.jsonl",
  stderr: "stderr.log",
  meta: "meta.json",
};

/** 実行の一覧のファイルの名前（並べた場所の直下）。 */
export const QUESTION_LOG_INDEX = "index.json";

/**
 * 実行の状態。available：読める（files にあるもの）、running：実行中（files は写したときまでの分）、
 * unfinished：終わりが記録されていない（並べない）、missing：作業履歴にはあるがログが無い、
 * unreadable：ログの記録（meta.json）を読めない。
 */
export type QuestionLogStatus = "available" | "running" | "unfinished" | "missing" | "unreadable";

export type QuestionLogRun = {
  runId: string;
  status: QuestionLogStatus;
  /** 何として実行したか（工程・orchestrator・guardian・chat など）。分からなければ undefined。 */
  role?: string;
  /** 同じ role の中で何回目の実行か（始めた順。1から）。 */
  attempt?: number;
  agentId?: string;
  runtime?: string;
  model?: string;
  startedAt?: string;
  finishedAt?: string;
  /** 実行中の実行のログを写した時刻（running のとき）。 */
  snapshotAt?: string;
  /** 実行の結果（completed / failed の理由）。 */
  result?: string;
  /** 並べたファイル（並べた場所からの相対パス）と大きさ。 */
  files: { path: string; bytes: number }[];
  /** 上限で間を省いたログ（events・stderr）。 */
  truncated: SessionLogFile[];
  /** エージェントの元のファイル（PBI-66）。記録が無ければ undefined。 */
  agentFiles?: {
    count: number;
    /** 上限で間を省いたファイルの数。 */
    truncated: number;
    /** 写せなかった（実行の後に読めなかった）ファイルの数。 */
    skipped: number;
    /** 写さなかった理由（コンテナの停止を確かめられなかった）。 */
    notArchived?: string;
  };
  /** 並べられなかったファイル（相対パス）。 */
  unreadable: string[];
};

export type QuestionLogs = { runs: QuestionLogRun[] };

type Archived = Extract<ActivityEvent, { type: "AgentSessionArchived" }>["payload"];

/** ファイルを並べる（同じ場所の中ならハードリンク、できなければ写す）。通常のファイルでなければ並べない。 */
function place(source: string, dest: string): number | undefined {
  try {
    const stat = lstatSync(source);
    if (!stat.isFile()) return undefined;
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    try {
      linkSync(source, dest);
    } catch {
      copyFileSync(source, dest);
    }
    return stat.size;
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function readMeta(path: string): SessionLogMeta | undefined {
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as SessionLogMeta;
    return typeof meta === "object" && meta !== null && typeof meta.runId === "string"
      ? meta
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * タスクの各実行のセッションログを dest に並べ、実行の一覧（index.json にも書く）を返す。
 * activity はこのタスクの作業履歴（エージェントの元のファイルの記録と、ログの無い実行を知るため）。
 * exclude は並べない実行（答えの実行そのもの）。
 */
export function stageQuestionLogs(input: {
  store: SessionLogStore;
  taskId: string;
  activity: readonly ActivityEvent[];
  dest: string;
  exclude?: readonly string[];
  /** 実行中の実行のログの、いまの写しも並べるか。 */
  includeRunning?: boolean;
}): QuestionLogs {
  const { store, taskId, activity, dest } = input;
  const exclude = new Set(input.exclude ?? []);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const archives = new Map<string, Archived>();
  const roles = new Map<string, string>();
  // 作業履歴に出てくる実行（ログの無い実行も一覧に出す）
  const referenced: string[] = [];
  for (const event of activity) {
    const payload = event.payload as Record<string, unknown>;
    for (const key of ["runId", "failedRunId"] as const) {
      const id = payload[key];
      if (typeof id === "string" && validLogId(id) && !referenced.includes(id)) {
        referenced.push(id);
      }
    }
    if (event.type === "AgentSessionArchived") {
      archives.set(event.payload.runId, event.payload);
      roles.set(event.payload.runId, event.payload.role);
    }
    if (event.type === "OrchestratorSessionUsed")
      roles.set(event.payload.runId, event.payload.role);
    if (
      event.type === "AgentRunStarted" ||
      event.type === "AgentRunCompleted" ||
      event.type === "AgentRunFailed"
    ) {
      roles.set(event.payload.runId, event.payload.step);
    }
    if (event.type === "ExportStarted" || event.type === "OutputExported") {
      roles.set(event.payload.runId, "export");
    }
    // エラーの分析は、セッションログでは chat（質問と同じ仕組み）なので、作業履歴から読み替える
    if (event.type === "ErrorAnalyzed" && event.payload.runId) {
      roles.set(event.payload.runId, ERROR_ANALYSIS_ROLE);
    }
  }

  const metas = new Map<string, SessionLogMeta | undefined>();
  const dir = store.taskDir(taskId);
  if (dir) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch (error) {
      // まだ実行が無い（場所が無い）ときだけ、実行の無いタスクとして扱う。開けない（権限が無い・ディレクトリでないなど）なら、
      // ログが無いのではなく読めないので、呼ぶ側に伝える（ログの無い実行として記録しない）
      if (!isNotFound(error)) throw error;
    }
    for (const name of names) {
      const match = /^(.+)\.meta\.json$/.exec(name);
      const runId = match?.[1];
      if (!runId || !validLogId(runId) || exclude.has(runId)) continue;
      const path = join(dir, name);
      try {
        if (!lstatSync(path).isFile()) continue;
      } catch (error) {
        // 一覧を読んだ後に消えたなら無いものとし、ほかの失敗は読めない記録にする
        if (isNotFound(error)) continue;
        metas.set(runId, undefined);
        continue;
      }
      metas.set(runId, readMeta(path));
    }
  }

  const runs: QuestionLogRun[] = [];
  for (const [runId, meta] of metas) {
    if (!meta) {
      runs.push({
        runId,
        status: "unreadable",
        ...(roles.get(runId) ? { role: roles.get(runId) } : {}),
        files: [],
        truncated: [],
        unreadable: [QUESTION_LOG_FILES.meta],
      });
      continue;
    }
    const run: QuestionLogRun = {
      runId,
      status: meta.finishedAt ? "available" : "unfinished",
      role: roles.get(runId) === ERROR_ANALYSIS_ROLE ? ERROR_ANALYSIS_ROLE : meta.role,
      agentId: meta.agentId,
      runtime: meta.runtime,
      ...(meta.model ? { model: meta.model } : {}),
      startedAt: meta.startedAt,
      ...(meta.finishedAt ? { finishedAt: meta.finishedAt } : {}),
      ...(meta.outcome
        ? {
            result:
              meta.outcome.kind === "completed" ? "completed" : `failed（${meta.outcome.reason}）`,
          }
        : {}),
      files: [],
      truncated: (["events", "stderr"] as const).filter((f) => meta.truncated?.[f]),
      unreadable: [],
    };
    const archived = archives.get(runId);
    if (archived) {
      run.agentFiles = {
        count: archived.files.length,
        truncated: archived.files.filter((f) => f.truncated).length,
        skipped: archived.skipped.length,
        ...(archived.notArchived ? { notArchived: archived.notArchived } : {}),
      };
    }
    if (run.status === "available") stageRun(store, taskId, runId, dest, run, archived?.files);
    else if (input.includeRunning) stageRunning(store, taskId, runId, dest, run);
    runs.push(run);
  }
  for (const runId of referenced) {
    if (metas.has(runId) || exclude.has(runId)) continue;
    runs.push({
      runId,
      status: "missing",
      ...(roles.get(runId) ? { role: roles.get(runId) } : {}),
      files: [],
      truncated: [],
      unreadable: [],
    });
  }
  // 始めた順（始めた時刻の無いもの＝ログの無い実行は、作業履歴に出た順で後ろに）
  runs.sort((a, b) => (a.startedAt ?? "￿").localeCompare(b.startedAt ?? "￿"));
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (!run.role) continue;
    const n = (counts.get(run.role) ?? 0) + 1;
    counts.set(run.role, n);
    run.attempt = n;
  }
  writeFileSync(join(dest, QUESTION_LOG_INDEX), `${JSON.stringify({ taskId, runs }, null, 2)}\n`, {
    mode: 0o600,
  });
  return { runs };
}

/**
 * 実行中の実行のログの、いまの写しを dest/<実行>/ に書く。このデーモンで開いていない（デーモンが止まって
 * 終わりを記録できなかった）なら、何もしない（unfinished のまま）。
 */
function stageRunning(
  store: SessionLogStore,
  taskId: string,
  runId: string,
  dest: string,
  run: QuestionLogRun,
): void {
  const snapshot = store.snapshot(taskId, runId);
  if (!snapshot) return;
  run.status = "running";
  run.snapshotAt = snapshot.at;
  run.truncated = snapshot.truncated;
  const runDir = join(dest, runId);
  const contents: [keyof typeof QUESTION_LOG_FILES, string][] = [
    ["meta", `${JSON.stringify(snapshot.meta, null, 2)}\n`],
    ["events", snapshot.events],
    ["stderr", snapshot.stderr],
  ];
  for (const [file, text] of contents) {
    const rel = QUESTION_LOG_FILES[file];
    // まだ出力の無いログは置かない（終わった実行で、ファイルが無いのと同じ）
    if (file !== "meta" && text.length === 0) continue;
    try {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(runDir, rel), text, { mode: 0o600 });
      run.files.push({ path: `${runId}/${rel}`, bytes: Buffer.byteLength(text) });
    } catch {
      run.unreadable.push(rel);
    }
  }
}

/** 終わった実行のログとエージェントの元のファイルを、dest/<実行>/ に並べる。 */
function stageRun(
  store: SessionLogStore,
  taskId: string,
  runId: string,
  dest: string,
  run: QuestionLogRun,
  agentFiles: readonly ArchivedAgentFile[] | undefined,
): void {
  const runDir = join(dest, runId);
  const put = (source: string | undefined, rel: string, optional: boolean) => {
    const bytes = source ? place(source, join(runDir, ...rel.split("/"))) : undefined;
    if (bytes === undefined) {
      if (!optional) run.unreadable.push(rel);
      return;
    }
    run.files.push({ path: `${runId}/${rel}`, bytes });
  };
  put(store.metaPath(taskId, runId), QUESTION_LOG_FILES.meta, false);
  for (const file of ["events", "stderr"] as const) {
    const source = store.path(taskId, runId, file);
    // 出力の無かった実行は、ファイルが無い（読めないのではない）。ほかの失敗で確かめられなければ、読めないファイルにする
    if (!source) continue;
    try {
      lstatSync(source);
    } catch (error) {
      if (isNotFound(error)) continue;
    }
    put(source, QUESTION_LOG_FILES[file], false);
  }
  const root = store.agentFilesDir(taskId, runId);
  if (!root) return;
  // 作業履歴に記録したファイルだけ（記録と大きさが違うものは並べない）
  for (const file of agentFiles ?? []) {
    const rel = `${AGENT_FILES_DIR}/${file.path}`;
    const source = archivedFilePath(root, file.path);
    let size: number | undefined;
    try {
      size = source ? lstatSync(source).size : undefined;
    } catch {
      size = undefined;
    }
    if (!source || size !== file.bytes) {
      run.unreadable.push(rel);
      continue;
    }
    put(source, rel, false);
  }
}
