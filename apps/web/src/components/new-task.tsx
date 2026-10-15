import { NewTaskDialog } from "@/components/new-task-dialog";
import { Button } from "@/components/ui/button";
import { currentProjectId, resolveProject } from "@/lib/current-project";
import { listProjects } from "@/lib/daemon";

/**
 * タスクの作成。表示しているプロジェクトを、作成先としてフォームに固定する。
 * 対象リポジトリの候補（Org の対象は gh で GitHub に問い合わせる）は、ここでは読まず、ダイアログを開いたときに読む
 * （ボタンを候補を待たずに出し、画面の自動の更新のたびに問い合わせ直さないため。PBI-109）。
 */
export async function NewTask() {
  try {
    const project = resolveProject(await listProjects(), await currentProjectId());
    if (!project) return null;
    return (
      <NewTaskDialog
        projectId={project.id}
        projectName={project.name}
        hasTargets={project.targets.length > 0}
      />
    );
  } catch {
    return null;
  }
}

/** プロジェクトを読むまでの「タスクを作成」ボタン（NewTaskDialog のボタンと同じ大きさ。押せない）。 */
export function NewTaskPlaceholder({ label }: { label: string }) {
  return (
    <Button size="lg" disabled aria-disabled="true">
      {label}
    </Button>
  );
}
