import type { AuditTarget, Project, Task } from "@sacty/core";
import { githubRepoOf } from "./config.js";
import { DEFAULT_CONTEXT_REPO } from "./context.js";

/**
 * 改修の提案の宛先の候補：対象リポジトリ・使ったコンテキストの層（プロジェクトのものが depth 0）・sacty の既定。
 * リポジトリは、改修のタスクの対象リポジトリと同じ形（.git の無い GitHub のリポジトリの URL。Task.repo）にそろえる
 * （clone の URL のまま渡すと .git.git になる。PR #135 レビュー指摘）。GitHub のリポジトリでないもの（ローカルのパスの
 * コンテキストなど）は、改修のタスクを作れないので候補にしない。
 */
export function auditTargetCandidates(task: Task, project: Project | undefined): AuditTarget[] {
  const candidates: AuditTarget[] = [];
  const repository = task.repository && githubRepoOf(task.repository.url);
  if (repository) candidates.push({ kind: "repository", repo: repository });
  const layers = (task.context?.layers ?? []).filter((l) => l.repo !== DEFAULT_CONTEXT_REPO);
  const contexts =
    layers.length > 0
      ? layers.map((layer, i) => ({ repo: layer.repo, depth: layers.length - 1 - i }))
      : project?.context?.repo
        ? [{ repo: project.context.repo, depth: 0 }]
        : [];
  for (const context of contexts) {
    const repo = githubRepoOf(context.repo);
    if (repo) candidates.push({ kind: "context", repo, depth: context.depth });
  }
  candidates.push({ kind: "sacty" });
  return candidates;
}
