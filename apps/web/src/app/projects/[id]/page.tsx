import { redirect } from "next/navigation";
import { projectTasksPath } from "@/lib/paths";

/** プロジェクトの URL は、そのプロジェクトのタスクの一覧へ移す（PBI-114。設定は `/projects/<ID>/settings`）。 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  redirect(projectTasksPath((await params).id));
}
