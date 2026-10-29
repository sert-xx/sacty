import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ActivityEvent,
  ERROR_ANALYSIS_ROLE,
  errorAnalysisRunIds,
  type FailureKind,
  failureKind,
  isChargedEvent,
  type LogEntry,
  parseSessionLog,
  renderMessage,
  type Task,
} from "@sacty/core";
import { STEP_NAME } from "./prompts.js";
import {
  type SessionLogFile,
  type SessionLogMeta,
  type SessionLogStore,
  validLogId,
} from "./session-logs.js";

/**
 * タスクのエラーレポート（Markdown）。通信できない環境でも、ファイルとして渡して調べられるよう、sacty の処理（作業履歴）・
 * 各実行のエージェントの動き（セッションログ）・エラーの記録を1つの文書にまとめる。エラーの箇所は詳しく、ほかは短くし、
 * 全体の大きさに上限を置く（テキストファイルとして重くしない）。
 * 作業履歴とセッションログは、書くときに秘密情報を伏せてあるので、ここでは伏せ直さない。
 */

/** レポートの大きさの上限と、部分ごとの上限（バイトか文字数）。 */
export const ERROR_REPORT_LIMITS = {
  /** レポート全体（バイト）。超えたら末尾を切る。 */
  totalBytes: 256_000,
  /** 詳しく書くエラー（新しいものから）。ほかは一覧に1行で出す。 */
  detailedFailures: 5,
  /** エラーの前に添える、sacty の記録の数。 */
  contextEvents: 8,
  /** エラーの記録の JSON（文字数）。 */
  payloadChars: 4_000,
  /** JSON の中の1つの文字列（文字数）。 */
  payloadStringChars: 1_200,
  /** エラーの実行の、標準エラー出力の末尾（文字数）。 */
  stderrTailChars: 6_000,
  /** エラーの実行の、最後のエージェントの出来事の数と、全体の文字数。 */
  tailEntries: 30,
  tailChars: 10_000,
  /** 出来事1つの文字数。 */
  entryChars: 700,
  /** 実行の要約の、最後のメッセージの文字数。 */
  lastMessageChars: 400,
  /** セッションログを読む末尾の大きさ（バイト）。大きいログは末尾だけを集計する。 */
  logReadBytes: 2_000_000,
  /** 作業履歴の1行（文字数）。 */
  timelineLineChars: 260,
  /** 作業履歴の先頭に必ず残す行の数（残りは新しいものから入るだけ）。 */
  timelineHead: 20,
  /** オーケストレーターの分析（文字数）。 */
  analysisChars: 20_000,
  /** 要約を書く実行の数（新しいものから）。 */
  summarizedRuns: 30,
} as const;

export type ReportLocale = "ja" | "en";

export type ErrorReportInput = {
  task: Task;
  activity: readonly ActivityEvent[];
  projectName?: string;
  logs?: SessionLogStore;
  generatedAt: string;
  locale: ReportLocale;
  /** オーケストレーターの分析の節を入れるか（分析の指示に渡すときは入れない）。既定は入れる。 */
  includeAnalysis?: boolean;
  /**
   * デーモンが止まって閉じられなかった実行のログ（閉じるときの伏せ直しを経ていない）の中身を入れず、省いたことだけを書く
   * （分析の指示に渡すとき）。
   */
  omitStaleLogs?: boolean;
  /** 大きさの上限（テストで小さくする）。 */
  limits?: Partial<typeof ERROR_REPORT_LIMITS>;
};

const T = {
  ja: {
    title: (t: string) => `# エラーレポート：${t}`,
    notice:
      "> sacty が作ったエラーレポートです。作業履歴とセッションログは記録のときに秘密情報を伏せていますが、タスクの内容・コードの一部・URL を含みます。共有する先に注意してください。",
    meta: "## 基本の情報",
    task: "タスク",
    project: "プロジェクト",
    status: "状態",
    pausedReason: "一時停止の理由",
    pausedMessage: "止まった理由の詳細",
    steps: "工程",
    repository: "リポジトリ",
    pullRequest: "PR",
    cost: "費用",
    created: "作成",
    updated: "最終更新",
    generated: "レポートの作成",
    noSteps: "（まだ決めていない）",
    summary: "## エラーの概要",
    noFailures: "エラーの記録はありません。",
    failureCount: (n: number) => `エラーの記録：${n} 件`,
    kind: { error: "失敗", stop: "停止", check: "確認の不合格" } satisfies Record<
      FailureKind,
      string
    >,
    columns: ["#", "時刻", "種類", "記録", "工程・役割", "内容"],
    analysis: "## オーケストレーターの分析",
    analysisAt: (at: string) => `分析の時刻：${at}`,
    analysisPending: "オーケストレーターが分析しているところです。",
    analysisFailed: (why: string) => `分析できませんでした：${why}`,
    noAnalysis:
      "まだ分析していません。画面の「エラーレポート」の「オーケストレーターに分析させる」で、原因の推定と対処を足せます。",
    details: "## エラーの詳細",
    detailOmitted: (n: number) => `ほかに古いエラーが ${n} 件あります（上の一覧を参照）。`,
    before: "直前の sacty の記録",
    record: "記録（JSON）",
    run: "実行",
    runMeta: (role: string, agent: string, model: string, result: string) =>
      `役割 ${role}・エージェント ${agent}${model ? `・モデル ${model}` : ""}・結果 ${result}`,
    runLogMissing: "この実行のセッションログはありません。",
    staleLog:
      "（デーモンが止まって閉じられなかった実行の、保存済みのログです。実行の途中で分かった秘密情報は、伏せ直していない場合があります）",
    staleOmitted:
      "デーモンが止まって閉じられなかった実行のため、ログの中身を省きました（秘密情報を伏せ直していない場合があるため）。",
    stderrTail: "標準エラー出力（末尾）",
    agentTail: (n: number) => `エージェントの最後の動き（最後の ${n} 件）`,
    runs: "## 実行の一覧（各工程のエージェントの動き）",
    noRuns: "実行の記録はありません。",
    runColumns: ["#", "実行", "役割", "エージェント・モデル", "開始", "時間", "結果", "費用"],
    activity: "### エージェントの動き",
    runSummary: (s: RunStats) =>
      `メッセージ ${s.messages}・ツールの呼び出し ${s.toolCalls}（失敗 ${s.toolErrors}）・エラー ${s.errors}`,
    tools: "よく使ったツール",
    lastMessage: "最後のメッセージ",
    partial: (mb: string) => `（ログが大きいので、末尾 ${mb} だけを集計）`,
    truncatedLog: "（記録の上限で、ログの間を省いています）",
    unfinished: "終わりの記録なし",
    timeline: "## 作業履歴（sacty の処理）",
    timelineOmitted: (n: number) => `… 間の ${n} 件を省きました …`,
    rowsOmitted: (n: number) => `（大きさの上限のため、古い ${n} 件を省きました）`,
    summariesOmitted: (n: number) => `（大きさの上限のため、古い ${n} 件の実行の要約を省きました）`,
    footer: "## このレポートについて",
    footerLines: (l: typeof ERROR_REPORT_LIMITS) => [
      `- 詳しく書くのは、新しいエラー ${l.detailedFailures} 件まで。`,
      `- エージェントの動きは、セッションログを読み分けた要約です。全体のログは画面の実行のログ、またはデーモンの \`runs/<タスク ID>/\` にあります。`,
      `- レポートは ${Math.round(l.totalBytes / 1000)}KB までにします。基本の情報・分析・エラーの詳細を先に入れ、エラーの概要・実行の一覧・作業履歴は入りきらない古いものを省きます。`,
    ],
    cut: "（レポートの大きさの上限に達したため、ここから後を省きました）",
    none: "（なし）",
  },
  en: {
    title: (t: string) => `# Error report: ${t}`,
    notice:
      "> An error report created by sacty. Secrets are masked in the activity and session logs when they are recorded, but the report includes the task's content, parts of the code, and URLs. Be careful about whom you share it with.",
    meta: "## Basic information",
    task: "Task",
    project: "Project",
    status: "Status",
    pausedReason: "Pause reason",
    pausedMessage: "Why it stopped",
    steps: "Steps",
    repository: "Repository",
    pullRequest: "PR",
    cost: "Cost",
    created: "Created",
    updated: "Last updated",
    generated: "Report created",
    noSteps: "(not decided yet)",
    summary: "## Summary of errors",
    noFailures: "There are no error records.",
    failureCount: (n: number) => `Error records: ${n}`,
    kind: { error: "Failure", stop: "Stopped", check: "Check failed" } satisfies Record<
      FailureKind,
      string
    >,
    columns: ["#", "Time", "Kind", "Record", "Step / role", "Details"],
    analysis: "## Orchestrator's analysis",
    analysisAt: (at: string) => `Analyzed at: ${at}`,
    analysisPending: "The Orchestrator is analyzing the errors.",
    analysisFailed: (why: string) => `Could not analyze: ${why}`,
    noAnalysis:
      'Not analyzed yet. Use "Ask the Orchestrator to analyze" under "Error report" on the task page to add the likely cause and what to do.',
    details: "## Error details",
    detailOmitted: (n: number) => `There are ${n} older errors (see the list above).`,
    before: "sacty's records just before",
    record: "Record (JSON)",
    run: "Run",
    runMeta: (role: string, agent: string, model: string, result: string) =>
      `role ${role} · agent ${agent}${model ? ` · model ${model}` : ""} · result ${result}`,
    runLogMissing: "There is no session log for this run.",
    staleLog:
      "(The saved log of a run that the daemon stopped before closing. Secrets found during the run may not have been masked again.)",
    staleOmitted:
      "The log's content is left out because the daemon stopped this run before closing it (secrets may not have been masked again).",
    stderrTail: "Standard error (tail)",
    agentTail: (n: number) => `The agent's last actions (last ${n})`,
    runs: "## Runs (what each step's agent did)",
    noRuns: "There are no runs.",
    runColumns: ["#", "Run", "Role", "Agent / model", "Started", "Duration", "Result", "Cost"],
    activity: "### What the agents did",
    runSummary: (s: RunStats) =>
      `messages ${s.messages} · tool calls ${s.toolCalls} (failed ${s.toolErrors}) · errors ${s.errors}`,
    tools: "Most used tools",
    lastMessage: "Last message",
    partial: (mb: string) => `(the log is large, so only the last ${mb} is counted)`,
    truncatedLog: "(part of the log was left out because of the recording limit)",
    unfinished: "no end recorded",
    timeline: "## Activity (what sacty did)",
    timelineOmitted: (n: number) => `… ${n} records in between are left out …`,
    rowsOmitted: (n: number) => `(The oldest ${n} rows are left out because of the size limit.)`,
    summariesOmitted: (n: number) =>
      `(Summaries of the oldest ${n} runs are left out because of the size limit.)`,
    footer: "## About this report",
    footerLines: (l: typeof ERROR_REPORT_LIMITS) => [
      `- Only the newest ${l.detailedFailures} errors are described in detail.`,
      "- The agents' actions are summaries read from the session logs. The full logs are on the run log page, or in the daemon's `runs/<task ID>/`.",
      `- The report is kept within ${Math.round(l.totalBytes / 1000)}KB. The basic information, the analysis, and the error details go in first; the oldest parts of the error summary, the runs, and the activity are left out when they do not fit.`,
    ],
    cut: "(The rest is left out because the report reached its size limit.)",
    none: "(none)",
  },
} as const;

type Words = (typeof T)[ReportLocale];

export type RunStats = {
  messages: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
};

/** 文字数で切り詰める（切ったら … を付ける）。 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** 末尾を残して切り詰める。 */
function clipHead(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

/** 1行にする（表のセル・一覧の行に入れる）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 表のセルにする（1行にし、バックスラッシュと | をエスケープする。中身の \| で表の区切りが崩れないように）。 */
export function cell(text: string): string {
  return oneLine(text).replace(/[\\|]/g, "\\$&");
}

/** 中身の ` の並びより長いフェンスで囲む（中身のコードブロックで閉じないように）。 */
export function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const mark = "`".repeat(longest + 1);
  return `${mark}${lang}\n${text.replace(/\n+$/, "")}\n${mark}`;
}

/** 利用者に見せる文（DaemonText）と、その他の値を文にする。 */
function textOf(value: unknown, locale: ReportLocale): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "code" in (value as object)) return renderMessage(value, locale);
  return JSON.stringify(value);
}

/** JSON の中の長い文字列を切り詰める（記録の JSON を読める大きさにする）。 */
function shrink(value: unknown, max: number, locale: ReportLocale): unknown {
  if (typeof value === "string") return clip(value, max);
  if (Array.isArray(value)) return value.map((v) => shrink(v, max, locale));
  if (value && typeof value === "object") {
    // 文言のコードは、読める文にする
    if ("code" in value && typeof (value as { code: unknown }).code === "string") {
      return clip(renderMessage(value, locale), max);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shrink(v, max, locale)]),
    );
  }
  return value;
}

const SHORT_KEYS = [
  "step",
  "role",
  "reason",
  "result",
  "passed",
  "verdict",
  "runResult",
  "exitCode",
  "command",
  "message",
  "failed",
  "note",
  "summary",
  "url",
  "branch",
  "number",
  "target",
  "costUsd",
] as const;

/** 作業履歴の1件の、短い説明（主な項目だけ）。 */
function shortPayload(event: ActivityEvent, locale: ReportLocale): string {
  const payload = event.payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SHORT_KEYS) {
    const value = payload[key];
    if (value === undefined || value === null || value === "") continue;
    if (key === "costUsd" && value === 0) continue;
    parts.push(`${key}=${oneLine(textOf(value, locale))}`);
  }
  const runId = runOf(event);
  if (runId) parts.push(`run=${runId.slice(0, 8)}`);
  return parts.join(" ");
}

/** 記録が指す実行の ID。 */
function runOf(event: ActivityEvent): string | undefined {
  const id = (event.payload as { runId?: unknown }).runId;
  return typeof id === "string" && id ? id : undefined;
}

/** 記録の工程・役割。 */
function roleOf(event: ActivityEvent): string {
  const payload = event.payload as { step?: unknown; role?: unknown };
  if (typeof payload.step === "string") return payload.step;
  if (typeof payload.role === "string") return payload.role;
  return event.actor;
}

function stepLabel(step: string, locale: ReportLocale): string {
  const name =
    step === ERROR_ANALYSIS_ROLE ? "エラーの分析" : (STEP_NAME as Record<string, string>)[step];
  return locale === "ja" && name ? `${name}（${step}）` : step;
}

type RunInfo = {
  runId: string;
  meta?: SessionLogMeta;
  role?: string;
  costUsd: number;
  /** 作業履歴で最初に出た位置（ログの無い実行の並び）。 */
  order: number;
};

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

/** タスクの実行（作業履歴に出てくる実行と、セッションログのある実行）。始めた順。 */
function collectRuns(input: ErrorReportInput): RunInfo[] {
  const runs = new Map<string, RunInfo>();
  const get = (runId: string) => {
    let run = runs.get(runId);
    if (!run) {
      run = { runId, costUsd: 0, order: runs.size };
      runs.set(runId, run);
    }
    return run;
  };
  for (const event of input.activity) {
    const runId = runOf(event);
    if (!runId || !validLogId(runId)) continue;
    const run = get(runId);
    run.role ??= roleOf(event);
    if (isChargedEvent(event)) run.costUsd += event.payload.costUsd;
  }
  const dir = input.logs?.taskDir(input.task.id);
  const analyses = errorAnalysisRunIds(input.activity);
  if (dir) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const runId = /^(.+)\.meta\.json$/.exec(name)?.[1];
      if (!runId || !validLogId(runId)) continue;
      const meta = readMeta(join(dir, name));
      if (meta) get(runId).meta = meta;
    }
  }
  // エラーの分析の実行は、セッションログでは chat（質問と同じ仕組み）なので、作業履歴から読み替える
  for (const run of runs.values()) {
    if (analyses.has(run.runId)) {
      run.role = ERROR_ANALYSIS_ROLE;
      if (run.meta) run.meta = { ...run.meta, role: ERROR_ANALYSIS_ROLE };
    }
  }
  return [...runs.values()].sort((a, b) => {
    const x = a.meta?.startedAt ?? "￿";
    const y = b.meta?.startedAt ?? "￿";
    return x === y ? a.order - b.order : x.localeCompare(y);
  });
}

/** ファイルの末尾 max バイトを読む（途中から読んだら、最初の改行までを捨てる）。 */
function readTail(path: string, max: number): { text: string; partial: boolean } | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, partial: start > 0 };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 文字列の末尾 max バイト（UTF-8）。途中から切ったら、切れた文字と最初の改行までを捨てる（途中の JSONL の行を読まない）。 */
function tailBytes(text: string, max: number): { text: string; partial: boolean } {
  const buf = Buffer.from(text);
  if (buf.length <= max) return { text, partial: false };
  const cut = buf.subarray(buf.length - max).toString("utf8");
  return { text: cut.slice(cut.indexOf("\n") + 1), partial: true };
}

/**
 * stale：終わりの記録が無く、このデーモンで開いてもいない（デーモンが止まって閉じられなかった）実行の、保存済みのファイル。
 * 閉じるときの伏せ直し（書き始めた後に分かった秘密情報）を経ていない。
 */
type RunLog = { events?: string; stderr?: string; partial: boolean; stale?: true; omitted?: true };

/** 実行のセッションログ（実行中なら、いまの写し）の末尾。stderr は求めたときだけ読む。 */
function readRunLog(
  input: ErrorReportInput,
  run: RunInfo,
  max: number,
  withStderr: boolean,
): RunLog | undefined {
  const store = input.logs;
  if (!store || !run.meta) return undefined;
  if (!run.meta.finishedAt) {
    const snapshot = store.snapshot(input.task.id, run.runId);
    // デーモンが止まって閉じられなかった実行は、保存済みのファイルの末尾を読む（画面の実行のログと同じ中身）
    if (!snapshot) {
      if (input.omitStaleLogs) return { partial: false, stale: true, omitted: true };
      return { ...readSaved(input, store, run, max, withStderr), stale: true };
    }
    const events = tailBytes(snapshot.events, max);
    return {
      events: events.text,
      ...(withStderr ? { stderr: tailBytes(snapshot.stderr, max).text } : {}),
      partial: events.partial,
    };
  }
  return readSaved(input, store, run, max, withStderr);
}

/** 保存済みのセッションログのファイルの末尾。 */
function readSaved(
  input: ErrorReportInput,
  store: SessionLogStore,
  run: RunInfo,
  max: number,
  withStderr: boolean,
): RunLog {
  const read = (file: SessionLogFile) => {
    const path = store.path(input.task.id, run.runId, file);
    return path ? readTail(path, max) : undefined;
  };
  const events = read("events");
  const stderr = withStderr ? read("stderr") : undefined;
  return {
    ...(events ? { events: events.text } : {}),
    ...(stderr ? { stderr: stderr.text } : {}),
    partial: events?.partial ?? false,
  };
}

/**
 * 実行のログの要約（集計と、詳しく書くときの末尾）。原文は要約したら持たない（多くの実行のログを、レポートを作り終える
 * まで抱えないように）。
 */
type RunDigest = {
  /** ログが無い（読めない）。 */
  missing: boolean;
  /** デーモンが止まって閉じられなかった実行の、保存済みのログ。 */
  stale: boolean;
  /** stale のログの中身を入れなかった（omitStaleLogs）。 */
  omitted: boolean;
  partial: boolean;
  stats: RunStats;
  tools: [string, number][];
  lastMessage?: string;
  truncated: boolean;
  /** エージェントの最後の出来事（詳しく書く実行だけ）。 */
  tail: string[];
  /** 標準エラー出力の末尾（詳しく書く実行だけ）。 */
  stderr?: string;
};

function digestRun(
  input: ErrorReportInput,
  run: RunInfo,
  L: typeof ERROR_REPORT_LIMITS,
  detailed: boolean,
): RunDigest | undefined {
  const log = readRunLog(input, run, L.logReadBytes, detailed);
  if (!log) return undefined;
  const entries = log.events ? parseSessionLog(log.events) : [];
  const digest: RunDigest = {
    missing: log.omitted !== true && log.events === undefined && log.stderr === undefined,
    stale: log.stale === true,
    omitted: log.omitted === true,
    partial: log.partial,
    ...statsOf(entries),
    tail: [],
  };
  if (!detailed) return digest;
  const tail = entries.filter((x) => x.kind !== "thinking").slice(-L.tailEntries);
  let room = L.tailChars;
  for (const entry of [...tail].reverse()) {
    const line = entryLine(entry, L.entryChars);
    if (line.length + 1 > room) break;
    digest.tail.unshift(line);
    room -= line.length + 1;
  }
  if (log.stderr?.trim()) digest.stderr = clipHead(log.stderr, L.stderrTailChars);
  return digest;
}

function statsOf(entries: readonly LogEntry[]): {
  stats: RunStats;
  tools: [string, number][];
  lastMessage?: string;
  truncated: boolean;
} {
  const stats: RunStats = { messages: 0, toolCalls: 0, toolErrors: 0, errors: 0 };
  const tools = new Map<string, number>();
  let lastMessage: string | undefined;
  let truncated = false;
  for (const e of entries) {
    if (e.kind === "message" && e.text.trim()) {
      stats.messages++;
      lastMessage = e.text;
    } else if (e.kind === "toolCall") {
      stats.toolCalls++;
      tools.set(e.name || "?", (tools.get(e.name || "?") ?? 0) + 1);
    } else if (e.kind === "toolResult" && e.isError) stats.toolErrors++;
    else if (e.kind === "error" || (e.kind === "result" && e.isError)) stats.errors++;
    else if (e.kind === "truncated") truncated = true;
  }
  return {
    stats,
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    ...(lastMessage !== undefined ? { lastMessage } : {}),
    truncated,
  };
}

/** エージェントの出来事1つを、1行（と必要なら中身）にする。 */
function entryLine(e: LogEntry, max: number): string {
  const body = (() => {
    switch (e.kind) {
      case "session":
        return `session ${e.text}`;
      case "thinking":
        return `thinking ${e.text}`;
      case "message":
        return `message ${e.text}`;
      case "toolCall":
        return `tool ${e.name}${e.unfinished ? " (unfinished)" : ""} ${e.input}`;
      case "toolResult":
        return `${e.isError ? "tool-error" : "tool-result"} ${e.text}`;
      case "result":
        return `${e.isError ? "result-error" : "result"} ${e.detail} ${e.text}`;
      case "turn":
        return `turn ${e.text}`;
      case "error":
        return `error ${e.text}`;
      case "truncated":
        return `truncated ${e.droppedBytes} bytes / ${e.droppedLines} lines`;
      case "raw":
        return `raw ${e.text}`;
    }
  })();
  return `- L${e.line} ${clip(oneLine(body), max)}`;
}

/** レポートの部分。重要な順に並べて、全体の上限に入るだけ入れる。 */
export function buildErrorReport(input: ErrorReportInput): string {
  const L = { ...ERROR_REPORT_LIMITS, ...input.limits };
  const w: Words = T[input.locale];
  const { task, activity, locale } = input;
  const failures = activity.filter((e) => failureKind(e) !== undefined);
  const runs = collectRuns(input);
  const runIndex = new Map(runs.map((r, i) => [r.runId, i + 1]));

  const detailed = failures.slice(-L.detailedFailures).reverse();
  const detailedRuns = new Set(detailed.map(runOf).filter((id) => id !== undefined));
  const digests = new Map<string, RunDigest | undefined>();
  const digestOf = (run: RunInfo) => {
    if (!digests.has(run.runId)) {
      digests.set(run.runId, digestRun(input, run, L, detailedRuns.has(run.runId)));
    }
    return digests.get(run.runId);
  };
  const bytes = (lines: readonly string[]) => Buffer.byteLength(lines.join("\n")) + 2;

  // 基本の情報
  const sep = locale === "ja" ? "：" : ": ";
  const meta = [
    w.title(oneLine(task.title)),
    "",
    w.notice,
    "",
    w.meta,
    "",
    `- ${w.task}${sep}${task.id}`,
    `- ${w.project}${sep}${input.projectName ? `${input.projectName}（${task.projectId}）` : task.projectId}`,
    `- ${w.status}${sep}${task.status}`,
    ...(task.pausedReason ? [`- ${w.pausedReason}${sep}${task.pausedReason}`] : []),
    ...(task.pausedMessage
      ? [`- ${w.pausedMessage}${sep}${oneLine(textOf(task.pausedMessage, locale))}`]
      : []),
    `- ${w.steps}${sep}${task.steps.length > 0 ? task.steps.map((s) => `${s.key}（${s.state}）`).join(" → ") : w.noSteps}`,
    ...(task.repository
      ? [
          `- ${w.repository}${sep}${task.repository.url}（${task.repository.baseBranch}・${task.repository.baseCommit.slice(0, 7)}）`,
        ]
      : task.repo
        ? [`- ${w.repository}${sep}${task.repo}`]
        : []),
    ...(task.pullRequest?.url ? [`- ${w.pullRequest}${sep}${task.pullRequest.url}`] : []),
    `- ${w.cost}${sep}$${task.budget.usedUsd.toFixed(4)} / $${task.budget.capUsd.toFixed(2)}`,
    `- ${w.created}${sep}${task.createdAt}`,
    `- ${w.updated}${sep}${task.updatedAt}`,
    `- ${w.generated}${sep}${input.generatedAt}`,
  ];

  // オーケストレーターの分析
  const analysis: string[] = [];
  if (input.includeAnalysis !== false) {
    const latest = task.errorAnalyses.at(-1);
    const done = [...task.errorAnalyses].reverse().find((a) => a.result?.text);
    analysis.push(w.analysis, "");
    if (latest && !latest.result) analysis.push(w.analysisPending, "");
    if (latest?.result?.failed !== undefined) {
      analysis.push(w.analysisFailed(oneLine(textOf(latest.result.failed, locale))), "");
    }
    if (done?.result?.text) {
      analysis.push(w.analysisAt(done.result.at), "", clip(done.result.text, L.analysisChars));
    } else if (!latest) analysis.push(w.noAnalysis);
    while (analysis.at(-1) === "") analysis.pop();
  }

  // エラーの詳細（新しいものから）
  const details: string[] = [];
  if (failures.length > 0) {
    details.push(w.details);
    for (const e of detailed) {
      const n = failures.indexOf(e) + 1;
      details.push(
        "",
        `### ${n}. ${w.kind[failureKind(e) as FailureKind]}${sep}${e.type} (${stepLabel(roleOf(e), locale)}, ${e.at})`,
        "",
      );
      const position = activity.indexOf(e);
      const context = activity.slice(Math.max(0, position - L.contextEvents), position);
      if (context.length > 0) {
        details.push(`**${w.before}**`, "");
        for (const c of context) {
          details.push(
            `- ${c.at} ${c.actor} ${c.type} ${clip(oneLine(shortPayload(c, locale)), L.timelineLineChars)}`,
          );
        }
        details.push("");
      }
      const json = JSON.stringify(shrink(e.payload, L.payloadStringChars, locale), null, 2);
      details.push(`**${w.record}**`, "", fence(clip(json, L.payloadChars), "json"));
      const runId = runOf(e);
      const run = runId ? runs.find((r) => r.runId === runId) : undefined;
      if (!run) continue;
      details.push("", `**${w.run} #${runIndex.get(run.runId)}** (${run.runId})`, "");
      if (run.meta) {
        details.push(
          `- ${w.runMeta(
            run.meta.role,
            run.meta.agentId,
            run.meta.model ?? "",
            resultOf(run.meta, w),
          )}`,
        );
      }
      const digest = digestOf(run);
      if (!digest || digest.missing) {
        details.push(`- ${w.runLogMissing}`);
        continue;
      }
      if (digest.omitted) {
        details.push(`- ${w.staleOmitted}`);
        continue;
      }
      if (digest.stale) details.push(`- ${w.staleLog}`);
      if (digest.stderr) details.push("", `**${w.stderrTail}**`, "", fence(digest.stderr));
      if (digest.tail.length > 0) {
        details.push("", `**${w.agentTail(digest.tail.length)}**`, "", ...digest.tail);
      }
    }
    if (failures.length > detailed.length) {
      details.push("", w.detailOmitted(failures.length - detailed.length));
    }
  }

  const footer = [w.footer, "", ...w.footerLines(L)];

  // 大きさの上限の中で、基本の情報・分析・エラーの詳細・この節を先に取り、残りを
  // エラーの概要（3分の1まで）→ 実行の一覧（その残りの半分まで）→ 作業履歴の順に分ける
  let room = L.totalBytes - bytes(meta) - bytes(analysis) - bytes(details) - bytes(footer) - 400;

  // エラーの概要（新しいものから、入る分だけ）
  const summary: string[] = [w.summary, ""];
  if (failures.length === 0) summary.push(w.noFailures);
  else {
    summary.push(w.failureCount(failures.length), "");
    const head = [`| ${w.columns.join(" | ")} |`, `|${w.columns.map(() => " --- ").join("|")}|`];
    const rows = newestThatFit(
      failures.map((e, i) => {
        const kind = failureKind(e) as FailureKind;
        return `| ${i + 1} | ${e.at} | ${w.kind[kind]} | ${e.type} | ${cell(roleOf(e))} | ${cell(clip(shortPayload(e, locale), 300))} |`;
      }),
      Math.max(0, Math.floor(room / 3) - bytes([...summary, ...head]) - 200),
    );
    if (rows.omitted > 0) summary.push(w.rowsOmitted(rows.omitted), "");
    summary.push(...head, ...rows.lines);
  }
  room -= bytes(summary);

  // 実行の一覧と、各実行のエージェントの動き（新しいものから、入る分だけ）
  const runLines: string[] = [w.runs, ""];
  if (runs.length === 0) runLines.push(w.noRuns);
  else {
    let runRoom = Math.max(0, Math.floor(room / 2) - 200);
    const head = [
      `| ${w.runColumns.join(" | ")} |`,
      `|${w.runColumns.map(() => " --- ").join("|")}|`,
    ];
    runRoom -= bytes(head);
    const rows = newestThatFit(
      runs.map((run, i) => {
        const m = run.meta;
        return `| ${i + 1} | ${run.runId.slice(0, 8)} | ${cell(m?.role ?? run.role ?? "")} | ${cell([m?.agentId, m?.model].filter(Boolean).join(" / "))} | ${m?.startedAt ?? ""} | ${durationOf(m)} | ${cell(m ? resultOf(m, w) : "")} | ${run.costUsd > 0 ? `$${run.costUsd.toFixed(4)}` : ""} |`;
      }),
      Math.floor(runRoom / 2),
    );
    if (rows.omitted > 0) runLines.push(w.rowsOmitted(rows.omitted), "");
    runLines.push(...head, ...rows.lines);
    runRoom -= bytes(rows.lines);
    // エージェントの動きの要約は、ログのある新しい実行から summarizedRuns 件までを読む（入らなかった実行も読んだ数に
    // 数え、古い実行のログまで読み続けない）
    const summaries: string[][] = [];
    let skipped = 0;
    let read = 0;
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i] as RunInfo;
      if (!run.meta) continue;
      if (read >= L.summarizedRuns) {
        skipped++;
        continue;
      }
      read++;
      const digest = digestOf(run);
      if (!digest || digest.missing) continue;
      const title = `#### ${i + 1}. ${stepLabel(run.meta?.role ?? run.role ?? "", locale)} (${run.runId.slice(0, 8)})`;
      const block = digest.omitted
        ? ["", title, "", `- ${w.staleOmitted}`]
        : [
            "",
            title,
            "",
            `- ${w.runSummary(digest.stats)}${digest.partial ? ` ${w.partial(`${Math.round(L.logReadBytes / 1_000_000)}MB`)}` : ""}${digest.truncated ? ` ${w.truncatedLog}` : ""}${digest.stale ? ` ${w.staleLog}` : ""}`,
            ...(digest.tools.length > 0
              ? [`- ${w.tools}${sep}${digest.tools.map(([name, n]) => `${name}×${n}`).join("、")}`]
              : []),
            ...(digest.lastMessage
              ? [`- ${w.lastMessage}${sep}${clip(oneLine(digest.lastMessage), L.lastMessageChars)}`]
              : []),
          ];
      if (bytes(block) > runRoom) {
        skipped++;
        continue;
      }
      runRoom -= bytes(block);
      summaries.unshift(block);
    }
    runLines.push("", w.activity);
    if (skipped > 0) runLines.push("", w.summariesOmitted(skipped));
    for (const block of summaries) runLines.push(...block);
  }
  room -= bytes(runLines);

  // 作業履歴：残りに入る分だけ（先頭の数件と、新しいものから）
  const lineOf = (e: ActivityEvent) =>
    `- ${e.seq} ${e.at} ${e.actor} ${e.type}${failureKind(e) ? " ⚠" : ""} ${clip(oneLine(shortPayload(e, locale)), L.timelineLineChars)}`.trimEnd();
  const timeline: string[] = [w.timeline, ""];
  room -= bytes(timeline);
  const head: string[] = [];
  const tail: string[] = [];
  let i = 0;
  for (; i < Math.min(L.timelineHead, activity.length); i++) {
    const line = lineOf(activity[i] as ActivityEvent);
    const size = Buffer.byteLength(line) + 1;
    if (size > room) break;
    head.push(line);
    room -= size;
  }
  let j = activity.length - 1;
  for (; j >= i; j--) {
    const line = lineOf(activity[j] as ActivityEvent);
    const size = Buffer.byteLength(line) + 1;
    if (size > room) break;
    tail.unshift(line);
    room -= size;
  }
  const omitted = j - i + 1;
  timeline.push(
    ...(activity.length === 0 ? [w.none] : head),
    ...(omitted > 0 ? [w.timelineOmitted(omitted)] : []),
    ...tail,
  );

  const sections = [meta, summary, analysis, details, runLines, timeline, footer]
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"));
  return limitBytes(`${sections.join("\n\n")}\n`, L.totalBytes, w.cut);
}

/** 行のうち、新しいもの（末尾）から max バイトに入る分（元の順のまま）と、省いた数。 */
function newestThatFit(
  lines: readonly string[],
  max: number,
): { lines: string[]; omitted: number } {
  const kept: string[] = [];
  let room = max;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i] as string) + 1;
    if (size > room) break;
    kept.unshift(lines[i] as string);
    room -= size;
  }
  return { lines: kept, omitted: lines.length - kept.length };
}

/** 上限のバイト数を超えたら、行の切れ目で切り、省いたことを書く。 */
function limitBytes(text: string, max: number, note: string): string {
  if (Buffer.byteLength(text) <= max) return text;
  const room = max - Buffer.byteLength(note) - 4;
  let cut = Buffer.from(text).subarray(0, room).toString("utf8");
  // 切れた文字（U+FFFD）と、途中の行を捨てる
  cut = cut.replace(/�+$/, "");
  const newline = cut.lastIndexOf("\n");
  if (newline > 0) cut = cut.slice(0, newline);
  return `${cut}\n\n${note}\n`;
}

function resultOf(meta: SessionLogMeta, w: Words): string {
  if (!meta.finishedAt) return w.unfinished;
  if (!meta.outcome) return "";
  return meta.outcome.kind === "completed" ? "completed" : `failed（${meta.outcome.reason}）`;
}

function durationOf(meta: SessionLogMeta | undefined): string {
  if (!meta?.finishedAt) return "";
  const ms = Date.parse(meta.finishedAt) - Date.parse(meta.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
