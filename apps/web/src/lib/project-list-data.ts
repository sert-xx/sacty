import { getStatus, listProjects } from "@/lib/daemon";

/** プロジェクトの一覧の画面に出す、プロジェクトと取り込みの状況（画面が取り直す。PBI-108）。 */
export type ProjectListData = {
  projects: Awaited<ReturnType<typeof listProjects>>;
  status: { intake: Awaited<ReturnType<typeof getStatus>>["intake"] };
};

/** プロジェクトの一覧の画面のデータ。デーモンに届かなければ例外。 */
export async function loadProjectList(): Promise<ProjectListData> {
  const [projects, status] = await Promise.all([listProjects(), getStatus()]);
  return { projects, status: { intake: status.intake } };
}
