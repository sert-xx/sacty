import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getStatus } from "@/lib/daemon";
import { stepAgentOptions, stepImageOptions } from "@/lib/labels";

/**
 * タスクの作成のダイアログ・差し戻しのフォームで、工程ごとに選べるイメージ・エージェント。ダイアログの「工程ごとに設定」・
 * 差し戻しのフォームの工程の設定の折りたたみを開いたときにだけ読む。選択肢はタスクの詳細で変えるときと同じ（設定を読めないときは、選べない理由を返す。消えた名前と取り違えないため）。
 */
export async function GET() {
  const m = await getMessages();
  const t = m.forms.task;
  try {
    const status = await getStatus();
    const images = stepImageOptions(status, m.task.images.defaultDescription);
    // stub は、既定のエージェントが stub のとき（動作確認用の設定）だけ出す
    const agents = stepAgentOptions(status, status.agent?.id);
    if (!images || !agents) {
      return Response.json(
        { message: t.stepOptionsUnavailable },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        images,
        agents: agents.map(({ id, model, reasoningEffort }) => ({
          id,
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        })),
        stepAgents: status.stepAgents ?? {},
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return Response.json({ message: error.message }, { status: 503 });
    }
    return Response.json({ message: t.repositoriesNoAnswer }, { status: 502 });
  }
}
