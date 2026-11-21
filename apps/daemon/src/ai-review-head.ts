import type { AiReviewOfHead, Task } from "@sacty/core";
import { gatePullRequest } from "@sacty/core";
import { referencedPullRequest } from "./prompts.js";

/** コミットの表記（短い・長い）の違いを許して、同じコミットか。 */
function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * PR の head に、sacty 自身の AI のレビューが付いているか（PBI-302 D1。実験 S14・S18：作り直した head に AI のレビューが
 * 届く前に、人がマージに進んだ）。同じ PR を指す、ほかの sacty のレビューのタスクを見る。
 * - attached：レビューのタスクが head をレビューして投稿した（前回の投稿を含む）
 * - reviewing：レビューのタスクが動いていて、対象の head がこの head（まだ決まっていなければ、これから決まる）
 * - none：どちらでもない
 */
export function aiReviewFor(
  pr: { repo: string; number: number | undefined; head: string },
  selfId: string,
  tasks: Iterable<Task>,
  sameRepo: (a: string, b: string) => boolean,
): AiReviewOfHead {
  const { head } = pr;
  if (pr.number === undefined) return { head, status: "none" };
  let reviewing = false;
  let url: string | undefined;
  for (const other of tasks) {
    if (other.id === selfId || other.status === "cancelled") continue;
    if (!other.steps.some((s) => s.key === "review")) continue;
    const ref = referencedPullRequest(other);
    if (!ref || ref.number !== pr.number || !sameRepo(ref.repo, pr.repo)) continue;
    if (other.reviewPost && sameCommit(other.reviewTarget?.headCommit, head)) {
      url = other.reviewPost.url;
    } else if (!other.reviewPost && other.status !== "paused" && other.status !== "escalated") {
      if (!other.reviewTarget || sameCommit(other.reviewTarget.headCommit, head)) reviewing = true;
    }
    if (other.previousReview && sameCommit(other.previousReview.headCommit, head)) {
      url ??= other.previousReview.url;
    }
  }
  if (url) return { head, status: "attached", url };
  return { head, status: reviewing ? "reviewing" : "none" };
}

/**
 * 承認待ちの PR の今の head の AI のレビューの状況。承認待ちでない・PR が開いていないタスクは undefined。
 * latestHead は、PR が開いている間に GitHub から読んだ最新の head（提出したコミットとは別。人が未レビューのコミットを足すと
 * 変わる。PR #304 のレビュー）。読めていなければ、提出したコミットで計算せず unknown にする（誤って「付いた」と出さない）。
 */
export function aiReviewOfHead(
  task: Task,
  tasks: Iterable<Task>,
  sameRepo: (a: string, b: string) => boolean,
  latestHead: string | undefined,
): AiReviewOfHead | undefined {
  const pr = gatePullRequest(task);
  if (task.status !== "awaiting_approval" || !pr || pr.state !== "open" || !pr.repo)
    return undefined;
  if (!latestHead) return { head: pr.commit, status: "unknown" };
  return aiReviewFor(
    { repo: pr.repo, number: pr.number, head: latestHead },
    task.id,
    tasks,
    sameRepo,
  );
}

/**
 * 一覧のために、承認待ちで PR が開いているタスクだけの AI のレビューの状況をまとめて計算する（`aiReviewOfHead` と同じ
 * 結果）。対象が無ければ何もしない。あれば全タスクを 1 回だけなめて、レビューのタスクを PR の番号ごとに分け、対象ごとに同じ
 * 番号のものだけを突き合わせる（全タスクどうしの突き合わせにしない）。
 */
export function aiReviewsOfHeads(
  tasks: readonly Task[],
  sameRepo: (a: string, b: string) => boolean,
  latestHeadOf: (task: Task) => string | undefined,
): Map<string, AiReviewOfHead> {
  const out = new Map<string, AiReviewOfHead>();
  const targets = tasks.filter((t) => {
    if (t.status !== "awaiting_approval") return false;
    const pr = gatePullRequest(t);
    return Boolean(pr && pr.state === "open" && pr.repo);
  });
  if (targets.length === 0) return out;
  const reviewsByNumber = new Map<number, Task[]>();
  for (const other of tasks) {
    if (other.status === "cancelled" || !other.steps.some((s) => s.key === "review")) continue;
    const ref = referencedPullRequest(other);
    if (!ref) continue;
    const bucket = reviewsByNumber.get(ref.number);
    if (bucket) bucket.push(other);
    else reviewsByNumber.set(ref.number, [other]);
  }
  for (const task of targets) {
    const number = gatePullRequest(task)?.number;
    const sameNumber = (number !== undefined && reviewsByNumber.get(number)) || [];
    const review = aiReviewOfHead(task, sameNumber, sameRepo, latestHeadOf(task));
    if (review) out.set(task.id, review);
  }
  return out;
}
