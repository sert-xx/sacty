import { getMessages } from "@/i18n/server";
import { getNotificationFeed, listProjects } from "@/lib/daemon";
import type { DesktopFeed } from "@/lib/desktop-notifications";
import { taskPath } from "@/lib/paths";

/**
 * デスクトップ通知に出すもの（画面の言語）。after より後の通知を、題名（タスクの題名）・本文（プロジェクトの名前と
 * 通知の種類）・開く画面にする。デーモンに届かなければ例外。
 */
export async function loadDesktopFeed(after: number | undefined): Promise<DesktopFeed> {
  const feed = await getNotificationFeed(after);
  if (feed.items.length === 0) return { boot: feed.boot, latest: feed.latest, items: [] };
  // 題名とプロジェクトは、デーモンが通知と一緒に持っている（タスクは取らない）
  const [m, projects] = await Promise.all([getMessages(), listProjects()]);
  const t = m.shell.desktop;
  const items = feed.items.map((item) => ({
    seq: item.seq,
    title: item.title,
    body: t.body(
      projects.find((p) => p.id === item.projectId)?.name ?? item.projectId,
      t.kind[item.kind],
    ),
    href: taskPath(item.taskId),
  }));
  return { boot: feed.boot, latest: feed.latest, items };
}
