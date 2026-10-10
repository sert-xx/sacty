import { cookies } from "next/headers";
import { DEFAULT_PROJECT_ID, PROJECT_COOKIE } from "./project-select";

export { DEFAULT_PROJECT_ID, isLocalPath, PROJECT_COOKIE, resolveProject } from "./project-select";

/** 表示しているプロジェクトの ID（cookie）。サーバー側でだけ使う。 */
export async function currentProjectId(): Promise<string> {
  const store = await cookies();
  return store.get(PROJECT_COOKIE)?.value || DEFAULT_PROJECT_ID;
}
