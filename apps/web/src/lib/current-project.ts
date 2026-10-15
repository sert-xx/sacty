import { cookies } from "next/headers";
import { isProjectId, PROJECT_COOKIE, PROJECT_COOKIE_OPTIONS } from "./project-select";

export {
  PROJECT_COOKIE,
  resolveProject,
  safeLocalPath,
} from "./project-select";

/** 表示しているプロジェクトの ID（cookie）。サーバー側でだけ使う。 */
export async function currentProjectId(): Promise<string> {
  const store = await cookies();
  return store.get(PROJECT_COOKIE)?.value ?? "";
}

/**
 * 表示するプロジェクトを変える（サーバーアクションの中でだけ使う。cookie を変えると、Next.js が画面とレイアウト＝ヘッダー
 * を描き直す。PBI-98）。ID の形が違えば変えない。
 */
export async function selectProject(id: string): Promise<boolean> {
  if (!isProjectId(id)) return false;
  (await cookies()).set(PROJECT_COOKIE, id, PROJECT_COOKIE_OPTIONS);
  return true;
}
