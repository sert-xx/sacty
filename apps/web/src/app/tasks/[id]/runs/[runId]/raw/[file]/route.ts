import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getRunLogFile } from "@/lib/daemon";

const FILES = {
  events: { suffix: ".jsonl", type: "application/x-ndjson; charset=utf-8" },
  stderr: { suffix: ".stderr.log", type: "text/plain; charset=utf-8" },
} as const;

/** セッションログの生のファイルを、ダウンロードさせる（PBI-62）。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string; file: string }> },
) {
  const { id, runId, file } = await params;
  const m = (await getMessages()).runLog;
  if (file !== "events" && file !== "stderr") return new Response(m.notFound, { status: 404 });
  let res: Response | null;
  try {
    res = await getRunLogFile(id, runId, file);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return new Response(error.message, { status: 503 });
    }
    throw error;
  }
  if (!res?.body) return new Response(m.notFound, { status: 404 });
  // 実行の ID はデーモンが形を確かめている（英数字・ハイフン・下線だけ）ので、そのままファイル名に使える
  return new Response(res.body, {
    headers: {
      "content-type": FILES[file].type,
      "content-disposition": `attachment; filename="sacty-run-${runId}${FILES[file].suffix}"`,
    },
  });
}
