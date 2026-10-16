import { NewTaskDialog } from "@/components/new-task-dialog";
import { Button } from "@/components/ui/button";
import { listProjects } from "@/lib/daemon";

/**
 * タスクの作成。一覧のプロジェクト（URL の ID。PBI-114）を、作成先としてフォームに固定する。プロジェクトが無ければ出さない。
 * 対象リポジトリの候補（Org の対象は gh で GitHub に問い合わせる）は、ここでは読まず、ダイアログを開いたときに読む
 * （ボタンを候補を待たずに出し、画面の自動の更新のたびに問い合わせ直さないため。PBI-109）。
 */
export async function NewTask({ projectId }: { projectId: string }) {
  try {
    const project = (await listProjects()).find((p) => p.id === projectId);
    if (!project) return null;
    return (
      // 別のプロジェクトの一覧へ移ったら、ダイアログを作り直す（作成先を開いた時のプロジェクトに固定しているため。PBI-114）
      <NewTaskDialog
        key={project.id}
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
