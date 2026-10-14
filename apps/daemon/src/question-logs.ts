import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ActivityEvent, ArchivedAgentFile } from "@sacty/core";
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
 * - 終わっていない実行（実行中・デーモンが止まって終わりを記録できなかった）は並べない。書き始めた後に分かった秘密情報は
 *   閉じるときに伏せ直すので、閉じる前のファイルには残っていることがあるため。
 * - 元のファイルは同じ場所の中ならハードリンクにし（写さない）、できなければ写す。
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
 * 実行の状態。available：読める（files にあるもの）、unfinished：終わりが記録されていない（並べない）、
 * missing：作業履歴にはあるがログが無い、unreadable：ログの記録（meta.json）を読めない。
 */
export type QuestionLogStatus = "available" | "unfinished" | "missing" | "unreadable";

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
  }

  const metas = new Map<string, SessionLogMeta | undefined>();
  const dir = store.taskDir(taskId);
  if (dir) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // まだ実行が無い
    }
    for (const name of names) {
      const match = /^(.+)\.meta\.json$/.exec(name);
      const runId = match?.[1];
      if (!runId || !validLogId(runId) || exclude.has(runId)) continue;
      const path = join(dir, name);
      try {
        if (!lstatSync(path).isFile()) continue;
      } catch {
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
      role: meta.role,
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
    // 出力の無かった実行は、ファイルが無い（読めないのではない）
    if (source && existsSync(source)) put(source, QUESTION_LOG_FILES[file], false);
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
