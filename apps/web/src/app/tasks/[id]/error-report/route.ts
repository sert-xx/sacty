import { getLocale, getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getErrorReport } from "@/lib/daemon";
import { errorReportFileName } from "@/lib/paths";

/** タスクのエラーレポートを、Markdown のファイルとしてダウンロードさせる（見出しは画面の言語）。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let report: string | null;
  try {
    report = await getErrorReport(id, await getLocale());
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return new Response(error.message, { status: 503 });
    }
    throw error;
  }
  if (report === null) {
    return new Response((await getMessages()).task.errorReport.notFound, { status: 404 });
  }
  return new Response(report, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${errorReportFileName(id, new Date())}"`,
    },
  });
}
