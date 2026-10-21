import { type DaemonText, message, parseRepoUrl, sameGitHubUrl, type Task } from "@sacty/core";
import { headingSpans, jsonCandidates, withoutCandidates } from "./agent-json.js";
import {
  GITHUB_COMMENT_BODY_MAX,
  GITHUB_COMMENTS_HEADING,
  GITHUB_COMMENTS_MAX,
} from "./github-relay.js";

/**
 * 工程のエージェントが、出力の sacty-github-comments で頼んだ、GitHub の PR・Issue へのコメント。sacty が、人間が
 * その工程の成果を承認した後に、プロジェクトの gh のアカウントで投稿する（エージェントは書き込めない）。
 */
export type RequestedComment = {
  /** エージェントが書いた PR・Issue の URL。 */
  target: string;
  /** 投稿先のリポジトリ（https://<ホスト>/<owner>/<name>）と番号。読めなければ無い。 */
  repo?: string;
  number?: number;
  body: string;
};

/** 出力が、コメントを頼んでいるか（見出しがあるか。読めるかは問わない）。 */
export function mentionsGitHubComments(output: string): boolean {
  return output.includes(`"${GITHUB_COMMENTS_HEADING}"`);
}

/**
 * 出力の sacty-github-comments を読む。見出しが無ければ undefined。見出しが2つ以上ある・JSON として読めない・形が
 * 違うときは、理由を返す（どれも投稿しない。一部だけを投稿すると、頼んだものと違う結果になるため）。
 */
export function requestedGitHubComments(
  output: string,
): { ok: true; comments: RequestedComment[] } | { ok: false; reason: DaemonText } | undefined {
  if (!mentionsGitHubComments(output)) return undefined;
  const spans = headingSpans(output, GITHUB_COMMENTS_HEADING);
  const candidates = jsonCandidates(output).filter((c) =>
    Object.hasOwn(c.value, GITHUB_COMMENTS_HEADING),
  );
  if (spans.length !== 1 || candidates.length !== 1) {
    return { ok: false, reason: message("githubComments.unreadable") };
  }
  const value = candidates[0]?.value[GITHUB_COMMENTS_HEADING];
  const list =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { comments?: unknown }).comments
      : undefined;
  if (!Array.isArray(list)) return { ok: false, reason: message("githubComments.unreadable") };
  if (list.length > GITHUB_COMMENTS_MAX) {
    return {
      ok: false,
      reason: message("githubComments.tooMany", { max: GITHUB_COMMENTS_MAX }),
    };
  }
  const comments: RequestedComment[] = [];
  for (const item of list) {
    const url = (item as { url?: unknown })?.url;
    const body = (item as { body?: unknown })?.body;
    if (typeof url !== "string" || typeof body !== "string" || !body.trim()) {
      return { ok: false, reason: message("githubComments.unreadable") };
    }
    if (body.length > GITHUB_COMMENT_BODY_MAX) {
      return {
        ok: false,
        reason: message("githubComments.tooLong", { max: GITHUB_COMMENT_BODY_MAX }),
      };
    }
    comments.push({ target: url.trim(), ...commentTarget(url), body: body.trim() });
  }
  return { ok: true, comments };
}

/** PR・Issue の URL の、リポジトリと番号。読めなければ空。 */
export function commentTarget(url: string): { repo?: string; number?: number } {
  const match = url
    .trim()
    .match(/^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)\/?$/);
  const repo = match?.[1] ? parseRepoUrl(match[1]) : undefined;
  const number = Number(match?.[2]);
  return repo && Number.isSafeInteger(number) && number > 0 ? { repo: repo.url, number } : {};
}

/**
 * 投稿してよいリポジトリか。プロジェクトの対象（リポジトリか、その Org）と、タスクの取り込み元・作業するリポジトリ
 * だけ（エージェントに、ほかのリポジトリへ書かせない）。
 */
export function commentAllowed(
  repo: string,
  targets: readonly { scope: "org" | "repo"; target: string }[],
  task: Pick<Task, "source" | "repo">,
): boolean {
  const parsed = parseRepoUrl(repo);
  if (!parsed) return false;
  if (task.source && sameGitHubUrl(task.source.repo, repo)) return true;
  if (task.repo && sameGitHubUrl(task.repo, repo)) return true;
  return targets.some((t) =>
    t.scope === "repo"
      ? sameGitHubUrl(t.target, repo)
      : sameGitHubUrl(t.target, `https://${parsed.host}/${parsed.owner}`),
  );
}

/** 同じコメントを二度投稿しないための目印（デーモンが投稿の後・記録の前に止まったとき、見つけて使う）。 */
export function githubCommentMarker(
  taskId: string,
  step: string,
  approvedAt: string,
  index: number,
): string {
  return `<!-- sacty-comment:${taskId}:${step}:${approvedAt}:${index} -->`;
}

/** 投稿するコメントの本文。AI が書き、人間が承認したことを添える。 */
export function buildGitHubComment(input: {
  taskId: string;
  step: string;
  stepName: string;
  approvedAt: string;
  index: number;
  body: string;
}): string {
  return [
    githubCommentMarker(input.taskId, input.step, input.approvedAt, input.index),
    input.body,
    "",
    "---",
    `sacty のタスク ${input.taskId} の${input.stepName}の工程で AI が書き、人間が承認しました。`,
  ].join("\n");
}

/** 表示・投稿する成果から、コメントの頼み（sacty-github-comments）を取り除く。 */
export function withoutGitHubComments(output: string): string {
  if (!mentionsGitHubComments(output)) return output;
  return withoutCandidates(output, headingSpans(output, GITHUB_COMMENTS_HEADING)).trimEnd();
}
