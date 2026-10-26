import { getMessages } from "@/i18n/server";
import { getNotificationFeed, getTask, listProjects } from "@/lib/daemon";
import type { DesktopFeed } from "@/lib/desktop-notifications";
import { taskPath } from "@/lib/paths";

/**
 * デスクトップ通知に出すもの（画面の言語）。after より後の通知を、題名（タスクの題名）・本文（プロジェクトの名前と
 * 通知の種類）・開く画面にする。消えたタスクの通知は出さない。デーモンに届かなければ例外。
 */
export async function loadDesktopFeed(after: number | undefined): Promise<DesktopFeed> {
  const feed = await getNotificationFeed(after);
  if (feed.items.length === 0) return { boot: feed.boot, latest: feed.latest, items: [] };
  const [m, projects, tasks] = await Promise.all([
    getMessages(),
    listProjects(),
    Promise.all(feed.items.map((item) => getTask(item.taskId))),
  ]);
  const t = m.shell.desktop;
  const items = feed.items.flatMap((item, i) => {
    const task = tasks[i]?.task;
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
