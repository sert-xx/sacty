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
  return (await projectExists(projectId)) === false ? null : (
    <SelectProject projectId={projectId} />
  );
}

/**
 * プロジェクトがあるか。一覧を取れなければ undefined（無いとは扱わない）。画面はこのプロジェクトをデーモンから読んで
 * 表示した直後なので、一覧の取得だけが失敗したときは合わせる（合わせないと、定期の更新が無い間はずれたまま残る。
 * PBI-98 レビュー指摘）。無いプロジェクトに合わせても、ヘッダーは最初のプロジェクトを出すだけで壊れない。
 */
async function projectExists(projectId: string): Promise<boolean | undefined> {
  try {
    return (await listProjects()).some((p) => p.id === projectId);
  } catch {
    return undefined;
  }
}
