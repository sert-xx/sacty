import { currentProjectId } from "@/lib/current-project";
import { listProjects } from "@/lib/daemon";
import { needsProjectSelect } from "@/lib/project-select";
import { SelectProject } from "./select-project";

/**
 * プロジェクトの画面（タスク・プロジェクトの設定）で、表示しているプロジェクト（cookie）が画面のプロジェクトと違えば、
 * 画面のプロジェクトに合わせる（ヘッダーと本文がずれないように。PBI-98）。Slack の通知・ほかのプロジェクトのタスクへの
 * リンク・URL の直接入力・プロジェクトの一覧から開いたときなど。同じなら何もしない（問い合わせを増やさない）。
 * 画面のプロジェクトが無くなっていれば（削除したプロジェクトのタスク）、選んでいるプロジェクトを変えない。
 */
export async function FollowProject({ projectId }: { projectId: string }) {
  if (!needsProjectSelect(await currentProjectId(), projectId)) return null;
  const exists = await listProjects()
    .then((projects) => projects.some((p) => p.id === projectId))
    .catch(() => false);
  return exists ? <SelectProject projectId={projectId} /> : null;
}
