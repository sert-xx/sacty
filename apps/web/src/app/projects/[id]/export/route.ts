import { DaemonUnavailableError, exportProject } from "@/lib/daemon";

/** プロジェクトの定義を、JSON ファイルとしてダウンロードさせる。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let exported: unknown;
  try {
    exported = await exportProject(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return new Response(error.message, { status: 503 });
    }
    throw error;
  }
  if (!exported) return new Response("プロジェクトが見つかりません。", { status: 404 });
  const name = (exported as { project?: { name?: string } }).project?.name ?? "project";
  return new Response(`${JSON.stringify(exported, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 日本語の名前は filename* で渡し、古い環境向けには ASCII の名前も付ける
      "content-disposition": `attachment; filename="sacty-project.json"; filename*=UTF-8''${encodeURIComponent(`sacty-project-${name}.json`)}`,
    },
  });
}
