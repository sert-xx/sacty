import { getRunLog, getTask, type RunLog } from "@/lib/daemon";
import { withDaemonSignal } from "@/lib/daemon-signal";
import { LIVE_VERSION_HEADER } from "@/lib/live";
import { liveVersion } from "@/lib/live-server";
import { loadAgentFiles } from "@/lib/run-log-data";
import { runLogId } from "@/lib/session-log";

/** 足された分（from から next の手前まで。バイト）。from が 0 なら全体。 */
function chunk(log: RunLog | null, file: "events" | "stderr") {
  if (!log) return { from: 0, text: "", next: 0 };
  return { from: log.offsets[file].from, text: log[file], next: log.offsets[file].next };
}

/**
 * 実行のログの画面の、足された分（PBI-108）。画面が一定の間隔で取り直す。`?events=<バイト>&stderr=<バイト>` で、
 * 画面が持っている分の終わりを伝えると、デーモンもその位置より後だけを読み、続きだけを返す（PR #119 レビュー指摘）。
 * エージェントの元のファイルの一覧は、実行が終わってから返す。一覧を読めなくても、ログと終わったことは返し、
 * `agentFilesFailed` を付ける（画面は一覧だけを取り直す）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await params;
  // ブラウザの中断と期限を、デーモンへの問い合わせ（タスク・ログ・ファイルの一覧）まで渡す（PR #119 再レビュー指摘）
  return withDaemonSignal(request, () => reply(request, id, runId));
}

async function reply(request: Request, id: string, runId: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const offset = (name: string) => {
    const value = Number(query.get(name));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const send = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });
  let found: Awaited<ReturnType<typeof getTask>>;
  let log: RunLog | null;
  try {
    found = await getTask(id);
    if (!found) return send({ missing: true });
    log = await getRunLog(id, runId, { events: offset("events"), stderr: offset("stderr") });
  } catch {
    // デーモンに届かない・読めないときは、画面をそのまま残す（エラーを出し続けない）
    return send({ unavailable: true });
  }
  const rows = found.activity.filter((e) => runLogId(e) === runId);
  const events = chunk(log, "events");
  const stderr = chunk(log, "stderr");
  const meta = log?.meta ?? null;
  const finished = Boolean(meta?.finishedAt);
  const files = finished ? await loadAgentFiles(id, runId) : undefined;
  const filesFailed = files !== undefined && "failed" in files;
  const version = liveVersion({
    rows,
    meta,
    events: [events.from, events.next],
    stderr: [stderr.from, stderr.next],
    files: files === undefined ? "none" : filesFailed ? "failed" : "ok",
  });
  if (request.headers.get(LIVE_VERSION_HEADER) === version) return send({ unchanged: true });
  return send({
    data: {
      taskTitle: found.task.title,
      projectId: found.task.projectId,
      rows,
      meta,
      events,
      stderr,
      finished,
      ...(files === undefined ? {} : "failed" in files ? { agentFilesFailed: true } : files),
    },
    version,
  });
}
