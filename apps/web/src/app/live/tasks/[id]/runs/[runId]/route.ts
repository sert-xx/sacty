import { getAgentFiles, getRunLog, getTask } from "@/lib/daemon";
import { LIVE_VERSION_HEADER } from "@/lib/live";
import { liveVersion } from "@/lib/live-server";
import { appendedText } from "@/lib/run-log-data";
import { runLogId } from "@/lib/session-log";

/**
 * 実行のログの画面の、足された分（PBI-108）。画面が一定の間隔で取り直す。`?events=<文字数>&eventsMark=<目印>`
 * （stderr も同じ）で、画面が持っている分を伝えると、続きだけを返す（持っている分が変わっていれば全体）。
 * エージェントの元のファイルの一覧は、実行が終わってから返す（ハッシュを計算するため、取り直しのたびには取らない）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await params;
  const query = new URL(request.url).searchParams;
  const reply = (body: unknown) =>
    Response.json(body, { headers: { "cache-control": "no-store" } });
  try {
    const found = await getTask(id);
    if (!found) return reply({ missing: true });
    const log = await getRunLog(id, runId);
    const rows = found.activity.filter((e) => runLogId(e) === runId);
    const events = appendedText(
      log?.events ?? "",
      Number(query.get("events") ?? 0) || 0,
      query.get("eventsMark") ?? undefined,
    );
    const stderr = appendedText(
      log?.stderr ?? "",
      Number(query.get("stderr") ?? 0) || 0,
      query.get("stderrMark") ?? undefined,
    );
    const meta = log?.meta ?? null;
    const finished = Boolean(meta?.finishedAt);
    const version = liveVersion({ rows, meta, events: events.mark, stderr: stderr.mark });
    if (request.headers.get(LIVE_VERSION_HEADER) === version) return reply({ unchanged: true });
    const agentFiles = finished ? await getAgentFiles(id, runId) : undefined;
    return reply({
      data: {
        taskTitle: found.task.title,
        rows,
        meta,
        events,
        stderr,
        finished,
        ...(agentFiles !== undefined ? { agentFiles } : {}),
      },
      version,
    });
  } catch {
    // デーモンに届かない・読めないときは、画面をそのまま残す（エラーを出し続けない）
    return reply({ unavailable: true });
  }
}
