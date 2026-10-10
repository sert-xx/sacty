import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { getMessages, languagePreference } from "@/i18n/server";
import { currentProjectId, resolveProject } from "@/lib/current-project";
import { listProjects, listTasks } from "@/lib/daemon";
import { isWorking, needsPerson, personAction, statusText } from "@/lib/labels";
import { type Notice, NotificationsMenu, ProjectMenu, UserMenu } from "./menus";

function Frame({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-chrome px-2.5 sm:gap-3 sm:px-4">
      <Link href="/" className="text-xl font-bold tracking-wide text-foreground">
        sacty
      </Link>
      <span aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
      {children}
    </header>
  );
}

/** デーモンにつながらない間や読み込み中のヘッダー（テーマは変えられる）。 */
export function HeaderFallback() {
  return (
    <Frame>
      <span className="flex-1" />
      <UserMenu language="system" />
    </Frame>
  );
}

/** ヘッダー：ロゴ、プロジェクトの切り替え（対応待ちの件数つき）、お知らせ、ユーザーメニュー。 */
export async function AppHeader() {
  let data: [Awaited<ReturnType<typeof listProjects>>, Awaited<ReturnType<typeof listTasks>>];
  try {
    data = await Promise.all([listProjects(), listTasks()]);
  } catch {
    return <HeaderFallback />;
  }
  const [projects, tasks] = data;
  const [m, language] = await Promise.all([getMessages(), languagePreference()]);
  const current = resolveProject(projects, await currentProjectId());
  const waiting = tasks.filter(needsPerson);
  const options = projects.map((p) => ({
    id: p.id,
    name: p.name,
    needsYou: waiting.filter((t) => t.projectId === p.id).length,
  }));
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const notices: Notice[] = [...waiting]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: name(t.projectId),
      status: statusText(t, m.labels),
      href: personAction(t, m.labels).href,
    }));
  const currentOption = options.find((o) => o.id === current?.id) ?? {
    id: "default",
    name: m.shell.project.fallbackName,
    needsYou: 0,
  };
  return (
    <Frame>
      {/* お知らせは全プロジェクトが対象なので、どのプロジェクトのタスクが動いていても最新にする */}
      <AutoRefresh active={tasks.some(isWorking)} />
      <ProjectMenu projects={options} current={currentOption} />
      <span className="flex-1" />
      <NotificationsMenu
        others={notices.filter((n) => n.projectId !== currentOption.id)}
        here={notices.filter((n) => n.projectId === currentOption.id)}
        currentName={currentOption.name}
      />
      <UserMenu language={language} />
    </Frame>
  );
}
