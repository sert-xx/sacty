"use client";

import { renderMessage, type StepKey } from "@sacty/core";
import { cn } from "cn";
import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { DaemonError } from "@/components/daemon-error";
import { FollowProjectAfterRecovery, StaleNotice } from "@/components/live-status";
import type { Messages } from "@/i18n";
import { useMessages } from "@/i18n/client";
import type { AgentFiles, RunLogMeta } from "@/lib/daemon";
import { describeEvent, formatStamp } from "@/lib/labels";
import { fetchLive, LIVE_INTERVAL_MS, pollWhileVisible } from "@/lib/live";
import type { RunLogData } from "@/lib/run-log-data";
import { type LogEntry, parseSessionLog } from "@/lib/session-log";

/** 画面に並べる出来事の上限（多すぎるとページが重くなるため。残りは生のファイルで見る）。 */
const MAX_ENTRIES = 2_000;
/** 1つの出来事の文の、画面に出す上限の文字数。 */
const MAX_TEXT = 20_000;

function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function clip(text: string, m: Messages["runLog"]): { text: string; clipped: boolean } {
  // 長ければ、先頭と末尾を出す（エラーの原因は末尾に出ることが多いため）
  return text.length > MAX_TEXT
    ? {
        text: `${text.slice(0, MAX_TEXT / 2)}\n${m.clipped}\n${text.slice(-MAX_TEXT / 2)}`,
        clipped: true,
      }
    : { text, clipped: false };
}

/** 取り直しで受け取る、足された分（バイトの位置。PBI-108）。from が 0 なら全体を置き換える。 */
type Chunk = { from: number; text: string; next: number };
type RunLogReply = {
  taskTitle: string;
  projectId: string;
  rows: RunLogData["rows"];
  meta: RunLogMeta | null;
  events: Chunk;
  stderr: Chunk;
  finished: boolean;
  agentFiles?: AgentFiles | null;
  agentFilesFailed?: boolean;
};

/**
 * 持っている文（終わりの位置は have）に、足された分を足す。from が 0 なら全体を置き換える。from が have と違えば
 * （取り違え）、いまの文のまま undefined を返す（次は全体を求める）。
 */
export function applyChunk(current: string, have: number, chunk: Chunk): string | undefined {
  if (chunk.from === 0) return chunk.text;
  if (chunk.from === have) return current + chunk.text;
  return undefined;
}

/** 実行のログのデータを取り直す先。持っている分の終わりの位置（バイト）を伝える。 */
export function runLogLiveUrl(
  taskId: string,
  runId: string,
  have: { events: number; stderr: number },
): string {
  const q = new URLSearchParams({ events: String(have.events), stderr: String(have.stderr) });
  return `/live/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}?${q}`;
}

/** 画面の一番下を見ているか（新しい行についていくか）。 */
function atBottom(): boolean {
  const doc = document.documentElement;
  return window.innerHeight + window.scrollY >= doc.scrollHeight - 48;
}

/**
 * エージェントの実行のセッションログ（PBI-62）。実行中は、画面をリロードせず、一定の間隔で足された行だけを取って後ろに
 * 足す（PBI-108）。読んでいる途中のスクロールの位置は動かさず、一番下を見ているときだけ、新しい行についていく。
 * 実行が終わり、エージェントの元のファイルの一覧も取れたら、取り直しを止める。更新できない間は、そのことを出す。
 * initial が null（描いたときにデーモンに届かなかった）なら、届くまで error を出す。
 */
export function LiveRunLog({
  taskId,
  runId,
  initial,
  error,
}: {
  taskId: string;
  runId: string;
  initial: RunLogData | null;
  error?: string;
}) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  // 持っている分の終わりの位置（バイト）と、前に受け取った版
  const have = useRef({
    events: initial?.log?.offsets?.events.next ?? 0,
    stderr: initial?.log?.offsets?.stderr.next ?? 0,
    version: undefined as string | undefined,
  });
  const latest = useRef(data);
  latest.current = data;
  const follow = useRef(false);
  const done = Boolean(data?.log?.meta.finishedAt) && !data?.agentFilesFailed;
  useLayoutEffect(() => {
    if (follow.current) {
      follow.current = false;
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  });
  useLayoutEffect(() => {
    if (done) return;
    return pollWhileVisible({
      doc: document,
      intervalMs: LIVE_INTERVAL_MS,
      load: async () => {
        const at = { events: have.current.events, stderr: have.current.stderr };
        const next = await fetchLive<RunLogReply>(
          runLogLiveUrl(taskId, runId, at),
          have.current.version,
        );
        setStale(next === "failed");
        if (typeof next !== "object") return;
        const reply = next.data;
        const now = latest.current;
        const events = applyChunk(now?.log?.events ?? "", at.events, reply.events);
        const stderr = applyChunk(now?.log?.stderr ?? "", at.stderr, reply.stderr);
        // 取り違えたら、次は全体を求める（版も忘れる）
        have.current = {
          events: events === undefined ? 0 : reply.events.next,
          stderr: stderr === undefined ? 0 : reply.stderr.next,
          version: events === undefined || stderr === undefined ? undefined : next.version,
        };
        if (atBottom() && events !== undefined && events !== (now?.log?.events ?? "")) {
          follow.current = true;
        }
        const base: RunLogData = now ?? {
          taskId,
          taskTitle: "",
          projectId: "",
          rows: [],
          log: null,
          agentFiles: null,
        };
        setData({
          ...base,
          taskTitle: reply.taskTitle,
          projectId: reply.projectId,
          rows: reply.rows,
          log: reply.meta
            ? {
                meta: reply.meta,
                events: events ?? base.log?.events ?? "",
                stderr: stderr ?? base.log?.stderr ?? "",
              }
            : null,
          ...(reply.agentFiles !== undefined
            ? { agentFiles: reply.agentFiles, agentFilesFailed: false }
            : {}),
          ...(reply.agentFilesFailed ? { agentFilesFailed: true } : {}),
        });
      },
    });
  }, [done, taskId, runId]);
  if (!data) return <DaemonError message={error ?? ""} />;
  return (
    <>
      <StaleNotice stale={stale} />
      {initial === null && <FollowProjectAfterRecovery projectId={data.projectId || undefined} />}
      <RunLogView runId={runId} data={data} />
    </>
  );
}

function RunLogView({ runId, data }: { runId: string; data: RunLogData }) {
  const messages = useMessages();
  const m = messages.runLog;
  const back = `/tasks/${encodeURIComponent(data.taskId)}`;
  const raw = (file: "events" | "stderr") =>
    `${back}/runs/${encodeURIComponent(runId)}/raw/${file}`;
  const agentFile = (path: string) =>
    `${back}/runs/${encodeURIComponent(runId)}/agent?path=${encodeURIComponent(path)}`;

  return (
    <div className="flex flex-col gap-4">
      <nav className="text-sm text-muted-foreground">
        <Link href={back} className="text-accent-foreground underline">
          {m.back}
        </Link>
        <span>{` ・ ${data.taskTitle}`}</span>
      </nav>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{m.title}</h1>
        <p className="font-mono text-xs break-all text-muted-foreground">{m.run(runId)}</p>
      </header>

      {data.rows.length > 0 && (
        <section
          aria-labelledby="run-history"
          className="rounded-xl border border-border bg-card p-5"
        >
          <h2 id="run-history" className="pb-2 text-[15px] font-semibold">
            {m.history}
          </h2>
          <ol className="flex flex-col">
            {data.rows.map((event) => (
              <li
                key={event.id}
                className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-t border-border py-2 text-[13px]"
              >
                <time
                  dateTime={event.at}
                  className="font-mono text-xs text-muted-foreground tabular-nums"
                >
                  {formatStamp(event.at, messages.locale)}
                </time>
                <span className="[overflow-wrap:anywhere]">
                  {describeEvent(event, messages.labels)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {!data.log ? (
        <>
          <section className="rounded-xl border border-border bg-card p-5 text-sm">
            <p className="font-semibold">{m.notFound}</p>
            <p className="pt-1 text-muted-foreground">{m.notFoundHelp}</p>
          </section>
          {data.agentFiles && (
            <AgentFilesView files={data.agentFiles} href={agentFile} messages={messages} />
          )}
        </>
      ) : (
        <>
          <Summary meta={data.log.meta} messages={messages} />
          <section
            aria-labelledby="run-download"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-5 text-sm"
          >
            <h2 id="run-download" className="text-[15px] font-semibold">
              {m.download}
            </h2>
            <a href={raw("events")} download className="text-accent-foreground underline">
              {m.downloadEvents}
            </a>
            <a href={raw("stderr")} download className="text-accent-foreground underline">
              {m.downloadStderr}
            </a>
          </section>
          {data.agentFiles && (
            <AgentFilesView files={data.agentFiles} href={agentFile} messages={messages} />
          )}
          <Events text={data.log.events} messages={messages} />
          <section
            aria-labelledby="run-stderr"
            className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="run-stderr" className="text-[15px] font-semibold">
              {m.stderr}
            </h2>
            {data.log.stderr ? (
              <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                {clip(data.log.stderr, m).text}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">{m.stderrEmpty}</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Summary({ meta, messages }: { meta: RunLogMeta; messages: Messages }) {
  const m = messages.runLog;
  const role =
    messages.labels.step[meta.role as StepKey] ??
    (m.roles as Record<string, string>)[meta.role] ??
    meta.role;
  const outcome = meta.outcome;
  const files = { events: m.events, stderr: m.stderr } as const;
  return (
    <section
      aria-labelledby="run-summary"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5 text-sm"
    >
      <h2 id="run-summary" className="sr-only">
        {m.title}
      </h2>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{m.role}</dt>
        <dd>{role}</dd>
        <dt className="text-muted-foreground">{m.agent}</dt>
        <dd className="[overflow-wrap:anywhere]">
          {[meta.agentId, meta.runtime, meta.authMode, meta.model].filter(Boolean).join("・")}
        </dd>
        <dt className="text-muted-foreground">{m.started}</dt>
        <dd>{formatStamp(meta.startedAt, messages.locale)}</dd>
        <dt className="text-muted-foreground">{m.finished}</dt>
        <dd>{meta.finishedAt ? formatStamp(meta.finishedAt, messages.locale) : m.unfinished}</dd>
        {outcome && (
          <>
            <dt className="text-muted-foreground">{m.outcome}</dt>
            <dd
              className={cn("[overflow-wrap:anywhere]", outcome.kind === "failed" && "text-warn")}
            >
              {outcome.kind === "completed"
                ? m.completed
                : `${m.failed(outcome.reason)}：${renderMessage(outcome.message, messages.locale)}`}
            </dd>
          </>
        )}
      </dl>
      {(["events", "stderr"] as const).map((file) => {
        const dropped = meta.truncated?.[file];
        const limit = meta.limits[file];
        return dropped ? (
          <p
            key={file}
            role="note"
            className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-warn"
          >
            {m.truncated(
              files[file],
              bytes(limit.head),
              bytes(limit.tail),
              bytes(dropped.droppedBytes),
              dropped.droppedLines,
            )}
          </p>
        ) : null;
      })}
    </section>
  );
}

/** 写したエージェントの元のファイル（PBI-66）。作業履歴に記録したハッシュと、いまのファイルが一致するかを出す。 */
function AgentFilesView({
  files,
  href,
  messages,
}: {
  files: AgentFiles;
  href: (path: string) => string;
  messages: Messages;
}) {
  const m = messages.runLog.agentFiles;
  const unmatched = files.files.filter((f) => f.status !== "match").length;
  const truncated = files.files.some((f) => f.truncated);
  return (
    <section
      aria-labelledby="run-agent-files"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-sm"
    >
      <h2 id="run-agent-files" className="text-[15px] font-semibold">
        {m.title}
      </h2>
      <p className="text-muted-foreground">{m.help}</p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{m.session}</dt>
        <dd className="font-mono text-xs break-all">
          {[m.runtime[files.runtime] ?? files.runtime, files.sessionId].filter(Boolean).join("・")}
        </dd>
      </dl>
      {files.notArchived && (
        <p
          role="alert"
          className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-warn"
        >
          {m.notArchived[files.notArchived] ?? files.notArchived}
        </p>
      )}
      {unmatched > 0 && (
        <p
          role="alert"
          className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-warn"
        >
          {m.mismatchNote(unmatched)}
        </p>
      )}
      {truncated && (
        <p role="note" className="text-warn">
          {m.limit(bytes(files.limitBytes))}
        </p>
      )}
      <ul className="flex flex-col">
        {files.files.map((file) => (
          <li
            key={file.path}
            className="flex flex-col gap-1 border-t border-border py-2 [overflow-wrap:anywhere]"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-xs">{file.path}</span>
              <span className="text-xs text-muted-foreground">{bytes(file.bytes)}</span>
              <span
                className={cn(
                  "text-xs font-semibold",
                  file.status === "match" ? "text-accent-foreground" : "text-warn",
                )}
              >
                {m.status[file.status]}
              </span>
              {file.status !== "missing" && (
                <a
                  href={href(file.path)}
                  download
                  className="text-xs text-accent-foreground underline"
                >
                  {m.download}
                </a>
              )}
            </div>
            <span className="font-mono text-[11px] break-all text-muted-foreground">
              {`${m.hash}：${file.sha256}`}
            </span>
            {file.status === "mismatch" && file.current && (
              <span className="font-mono text-[11px] break-all text-warn">
                {m.currentHash(file.current.sha256)}
              </span>
            )}
            {file.truncated && (
              <span role="note" className="text-xs text-warn">
                {m.truncated(bytes(file.truncated.droppedBytes), file.truncated.droppedLines)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {files.skipped.length > 0 && (
        <p className="text-warn [overflow-wrap:anywhere]">{m.skipped(files.skipped.join("、"))}</p>
      )}
    </section>
  );
}

function Events({ text, messages }: { text: string; messages: Messages }) {
  const m = messages.runLog;
  const entries = parseSessionLog(text);
  // 多すぎるときは、最初と最後を出す（エラーの原因や最後の答えは末尾に出るため）
  const many = entries.length > MAX_ENTRIES;
  const half = MAX_ENTRIES / 2;
  const first = many ? entries.slice(0, half) : entries;
  const last = many ? entries.slice(-half) : [];
  const item = (entry: LogEntry, i: number) => (
    // 1行から複数の出来事を作るので、行の番号と並びの位置で区別する
    <li key={`${entry.line}-${i}`}>
      <Entry entry={entry} m={m} />
    </li>
  );
  return (
    <section
      aria-labelledby="run-events"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="run-events" className="text-[15px] font-semibold">
        {m.events}
      </h2>
      {many && (
        <p role="note" className="text-sm text-warn">
          {m.shown(half, entries.length)}
        </p>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.eventsEmpty}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {first.map((entry, i) => item(entry, i))}
          {many && (
            <li
              role="note"
              className="rounded-lg border border-dashed border-warn-line px-3 py-2 text-sm text-warn"
            >
              {m.skipped(entries.length - half * 2)}
            </li>
          )}
          {last.map((entry, i) => item(entry, half + i))}
        </ol>
      )}
    </section>
  );
}

const PRE =
  "mt-2 max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]";

function Label({ children, tone }: { children: React.ReactNode; tone?: "warn" | "muted" }) {
  return (
    <span
      className={cn(
        "text-xs font-semibold",
        tone === "warn" ? "text-warn" : tone === "muted" ? "text-muted-foreground" : "",
      )}
    >
      {children}
    </span>
  );
}

function Entry({ entry, m }: { entry: LogEntry; m: Messages["runLog"] }) {
  const box = "rounded-lg border border-border px-3 py-2 text-sm";
  const line = <span className="ml-2 text-xs text-muted-foreground">{m.line(entry.line)}</span>;
  switch (entry.kind) {
    case "session":
    case "turn":
      return (
        <div className={cn(box, "text-muted-foreground")}>
          <Label tone="muted">{m.kind[entry.kind]}</Label>
          {line}
          {entry.text && <span className="ml-2 font-mono text-xs break-all">{entry.text}</span>}
        </div>
      );
    case "thinking":
      return (
        <div className={cn(box, "text-muted-foreground")}>
          <Label tone="muted">{m.kind.thinking}</Label>
          {line}
          <p className="pt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {entry.text ? clip(entry.text, m).text : m.hiddenThinking}
          </p>
        </div>
      );
    case "message":
      return (
        <div className={box}>
          <Label>{m.kind.message}</Label>
          {line}
          <p className="pt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {clip(entry.text, m).text}
          </p>
        </div>
      );
    case "toolCall":
    case "toolResult": {
      // ツールの呼び出し・結果は畳む
      const title =
        entry.kind === "toolCall"
          ? entry.unfinished
            ? m.kind.toolCallUnfinished
            : m.kind.toolCall
          : entry.isError
            ? m.kind.toolError
            : m.kind.toolResult;
      const body = entry.kind === "toolCall" ? entry.input : entry.text;
      const warn =
        (entry.kind === "toolResult" && entry.isError) ||
        (entry.kind === "toolCall" && entry.unfinished);
      return (
        <details className={box}>
          <summary className="cursor-pointer [overflow-wrap:anywhere]">
            <Label tone={warn ? "warn" : undefined}>{title}</Label>
            {entry.kind === "toolCall" && (
              <span className="ml-2 font-mono text-xs">{entry.name}</span>
            )}
            {line}
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {body.replace(/\s+/g, " ").slice(0, 120)}
            </span>
          </summary>
          <pre className={PRE}>{clip(body, m).text}</pre>
        </details>
      );
    }
    case "result":
      return (
        <div
          className={cn(
            box,
            entry.isError ? "border-warn-line bg-warn-soft" : "border-accent-line bg-accent",
          )}
        >
          <Label tone={entry.isError ? "warn" : undefined}>
            {entry.isError ? m.kind.resultError : m.kind.result}
          </Label>
          {line}
          {entry.detail && (
            <span className="ml-2 font-mono text-xs text-muted-foreground">{entry.detail}</span>
          )}
          {entry.text && (
            <p className="pt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {clip(entry.text, m).text}
            </p>
          )}
        </div>
      );
    case "error":
      return (
        <div className={cn(box, "border-warn-line bg-warn-soft text-warn")}>
          <Label tone="warn">{m.kind.error}</Label>
          {line}
          <p className="pt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.text}</p>
        </div>
      );
    case "truncated":
      return (
        <div role="note" className={cn(box, "border-warn-line bg-warn-soft text-warn")}>
          <Label tone="warn">{m.kind.truncated}</Label>
          {line}
          <span className="ml-2 text-xs">
            {m.truncated(
              m.events,
              bytes(entry.headBytes),
              bytes(entry.tailBytes),
              bytes(entry.droppedBytes),
              entry.droppedLines,
            )}
          </span>
        </div>
      );
    case "raw":
      // 知らない形の行は、生の行のまま出す
      return (
        <div className={box}>
          <Label tone="muted">{m.kind.raw}</Label>
          {line}
          <pre className={PRE}>{clip(entry.text, m).text}</pre>
        </div>
      );
  }
}
