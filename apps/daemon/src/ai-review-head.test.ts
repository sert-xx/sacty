import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { aiReviewOfHead, aiReviewsOfHeads } from "./ai-review-head.js";

const REPO = "https://github.com/acme/app";
const sameRepo = (a: string, b: string) => a === b;

const base = (patch: Partial<Task> & { id: string }): Task =>
  ({
    projectId: "default",
    title: patch.id,
    body: "",
    status: "running",
    steps: [],
    stepPullRequests: [],
    ...patch,
  }) as Task;

/** 承認待ちで、実装の PR（number）が開いているタスク。 */
const awaiting = (id: string, number: number, patch: Partial<Task> = {}) =>
  base({
    id,
    status: "awaiting_approval",
    gate: { step: "implement", submission: 1 },
    pullRequest: { number, repo: REPO, commit: `commit-${number}` },
    pullRequestState: "open",
    ...patch,
  } as Partial<Task> & { id: string });

/** PR をレビューするタスク（sacty の AI のレビュー）。 */
const reviewOf = (id: string, number: number, patch: Partial<Task> = {}) =>
  base({
    id,
    repository: { url: REPO },
    title: `${REPO}/pull/${number} をレビュー`,
    steps: [{ key: "review", state: "active" }],
    ...patch,
  } as Partial<Task> & { id: string });

describe("一覧のための AI のレビューの状況（aiReviewsOfHeads。PBI-442）", () => {
  const heads: Record<string, string | undefined> = {
    reviewing: "head-1",
    attached: "head-2",
    unknown: undefined,
    closed: "head-4",
  };
  const tasks = [
    awaiting("reviewing", 1),
    awaiting("attached", 2),
    awaiting("unknown", 3),
    awaiting("closed", 4, { pullRequestState: "closed" }),
    base({
      id: "paused",
      status: "paused",
      pullRequest: { number: 5, repo: REPO, commit: "c" } as never,
    }),
    base({ id: "no-pr", status: "awaiting_approval" }),
    reviewOf("review-1", 1),
    reviewOf("review-2", 2, {
      reviewPost: { url: "https://github.com/acme/app/pull/2#review" } as never,
      reviewTarget: { headCommit: "head-2" } as never,
    }),
    reviewOf("review-other", 99),
  ];
  const latest = (t: Task) => heads[t.id];

  it("承認待ちで PR が開いているタスクにだけ付き、値は aiReviewOfHead（詳細）と同じ", () => {
    const got = aiReviewsOfHeads(tasks, sameRepo, latest);
    expect([...got.keys()].sort()).toEqual(["attached", "reviewing", "unknown"]);
    expect(got.get("reviewing")?.status).toBe("reviewing");
    expect(got.get("attached")).toMatchObject({ status: "attached", head: "head-2" });
    expect(got.get("unknown")?.status).toBe("unknown");
    for (const [id, review] of got) {
      const t = tasks.find((x) => x.id === id) as Task;
      expect(review).toEqual(aiReviewOfHead(t, tasks, sameRepo, latest(t)));
    }
  });

  it("別の PR のレビューは影響しない：同じ番号のレビューだけを突き合わせる", () => {
    const got = aiReviewsOfHeads([awaiting("a", 7), reviewOf("r", 8)], sameRepo, () => "h");
    expect(got.get("a")?.status).toBe("none");
  });
});
