import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getAgentFile } from "@/lib/daemon";

/**
 * 写したエージェントの元のファイルを、ダウンロードさせる（PBI-66）。path は一覧の相対パス（デーモンが、作業履歴に
 * 記録したファイルだけを返す）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await params;
  const m = (await getMessages()).runLog;
  const path = new URL(request.url).searchParams.get("path") ?? "";
  let res: Response | null;
  try {
    res = path ? await getAgentFile(id, runId, path) : null;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return new Response(error.message, { status: 503 });
    }
    throw error;
  }
  if (!res?.body) return new Response(m.agentFiles.notFound, { status: 404 });
  // ファイル名は、実行の ID と相対パスから作る（区切りは「_」。ヘッダーに使えない文字は除く）
  const name = `sacty-run-${runId}-${path.replace(/\//g, "_")}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
    },
  });
}
