import type { Project } from "@sacty/core";

/** 表示しているプロジェクトを覚えておく cookie。 */
export const PROJECT_COOKIE = "sacty-project";
export const DEFAULT_PROJECT_ID = "default";

/** 表示しているプロジェクト。cookie のプロジェクトが無くなっていれば、既定のプロジェクト。 */
export function resolveProject(projects: readonly Project[], id: string): Project | undefined {
  return (
    projects.find((p) => p.id === id) ??
    projects.find((p) => p.id === DEFAULT_PROJECT_ID) ??
    projects[0]
  );
}

/** 画面の中の移動先か（ほかのサイトへ移らせないため）。 */
export function isLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
