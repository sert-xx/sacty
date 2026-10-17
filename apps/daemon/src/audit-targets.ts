import type { AuditTarget, Project, Task } from "@sacty/core";
import { DEFAULT_CONTEXT_REPO } from "./context.js";

/** 改修の提案の宛先の候補：対象リポジトリ・使ったコンテキストの層（プロジェクトのものが depth 0）・sacty の既定。 */
export function auditTargetCandidates(task: Task, project: Project | undefined): AuditTarget[] {
  const candidates: AuditTarget[] = [];
  if (task.repository) candidates.push({ kind: "repository", repo: task.repository.url });
  const layers = (task.context?.layers ?? []).filter((l) => l.repo !== DEFAULT_CONTEXT_REPO);
  if (layers.length > 0) {
    layers.forEach((layer, i) => {
      candidates.push({ kind: "context", repo: layer.repo, depth: layers.length - 1 - i });
    });
  } else if (project?.context?.repo) {
    candidates.push({ kind: "context", repo: project.context.repo, depth: 0 });
  }
  candidates.push({ kind: "sacty" });
  return candidates;
}
