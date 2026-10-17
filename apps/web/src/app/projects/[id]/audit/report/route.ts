import { getMessages } from "@/i18n/server";
import { auditReport, reportPeriod } from "@/lib/audit-report";
import { DaemonUnavailableError, getProjectAudits, listProjects } from "@/lib/daemon";

/** プロジェクトの監査のレポートを、Markdown のファイルとしてダウンロードさせる（PBI-124）。期間は ?from=&to=。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const messages = await getMessages();
  const url = new URL(request.url);
  const period = reportPeriod(url.searchParams.get("from"), url.searchParams.get("to"));
  if (!period) return new Response(messages.audit.report.invalidRange, { status: 400 });
  let data: Awaited<ReturnType<typeof getProjectAudits>>;
  let name: string | undefined;
  try {
    const [projects, audits] = await Promise.all([listProjects(), getProjectAudits(id)]);
    name = projects.find((p) => p.id === id)?.name;
    data = audits;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return new Response(error.message, { status: 503 });
    }
    throw error;
  }
  if (!data || name === undefined) {
    return new Response(messages.projects.exportNotFound, { status: 404 });
  }
  const file = `sacty-audit-${name}-${period.from}-${period.to}.md`;
  return new Response(auditReport(data, name, period, messages), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // 日本語の名前は filename* で渡し、古い環境向けには ASCII の名前も付ける
      "content-disposition": `attachment; filename="sacty-audit.md"; filename*=UTF-8''${encodeURIComponent(file)}`,
    },
  });
}
