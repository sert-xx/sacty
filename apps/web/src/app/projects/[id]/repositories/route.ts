import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, listProjectRepositories } from "@/lib/daemon";
import { isProjectId } from "@/lib/project-select";

/**
 * タスクの作成のダイアログで使う、対象リポジトリの候補（PBI-25・PBI-109）。ダイアログを開いたときにだけ読む
 * （Org の対象は gh で GitHub に問い合わせるので、画面の描画・自動の更新では読まない）。
 * 読めなかった Org の理由と、失敗の理由は、画面の言語の文言にして返す。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await getMessages();
  const noAnswer = m.forms.task.repositoriesNoAnswer;
  if (!isProjectId(id)) return Response.json({ message: noAnswer }, { status: 404 });
  try {
    const { repositories, errors } = await listProjectRepositories(id);
    return Response.json(
      {
        repositories,
        problems: errors.map((e) => m.forms.task.listFailed(e.org, m.labels.text(e.message))),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return Response.json({ message: error.message }, { status: 503 });
    }
    return Response.json({ message: noAnswer }, { status: 502 });
  }
}
