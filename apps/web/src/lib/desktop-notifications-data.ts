import { getMessages } from "@/i18n/server";
import { getNotificationFeed, listProjects, listTasks } from "@/lib/daemon";
import type { DesktopFeed } from "@/lib/desktop-notifications";
import { taskPath } from "@/lib/paths";

/**
 * デスクトップ通知に出すもの（画面の言語）。after より後の通知を、題名（タスクの題名）・本文（プロジェクトの名前と
 * 通知の種類）・開く画面にする。消えたタスクの通知は出さない。デーモンに届かなければ例外。
 */
export async function loadDesktopFeed(after: number | undefined): Promise<DesktopFeed> {
  const feed = await getNotificationFeed(after);
  if (feed.items.length === 0) return { boot: feed.boot, latest: feed.latest, items: [] };
  // タスクは、作業履歴を含まない一覧から一度に取る（通知ごとに作業履歴まで取らない。完了したタスクも要るので、すべて）
  const [m, projects, tasks] = await Promise.all([getMessages(), listProjects(), listTasks()]);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const t = m.shell.desktop;
  const items = feed.items.flatMap((item) => {
    const task = byId.get(item.taskId);
    if (!task) return [];
    const project = projects.find((p) => p.id === task.projectId)?.name ?? task.projectId;
    return [
      {
        seq: item.seq,
        title: task.title,
        body: t.body(project, t.kind[item.kind]),
        href: taskPath(task.id),
      },
    ];
  });
  return { boot: feed.boot, latest: feed.latest, items };
}
