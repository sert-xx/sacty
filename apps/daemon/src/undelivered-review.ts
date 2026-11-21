import type { PreviousReview, Task } from "@sacty/core";

/** 2 つのコミットが同じか（短い形と長い形を同じとみなす）。 */
function same(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
}

/** レビューの URL（`…#pullrequestreview-<ID>`）から、取り込みの目印（`review:<ID>`）を作る。読めなければ undefined。 */
function importKey(url: string): string | undefined {
  const id = /pullrequestreview-(\d+)/.exec(url)?.[1];
  return id === undefined ? undefined : `review:${id}`;
}

/**
 * 親（PR を作ったタスク）に届かなかった、前回・前々回以前の回の番号（PBI-465）。作業履歴の欄は足さず、今回の対象を決めたときに、
 * 作業履歴の記録（親の discardedReviews・importedFeedback、前の回の先頭）から決める。
 * - 子（親がある）：親が古い先頭宛てとして捨てた回（捨てた項目の url が、その回のレビューの URL と同じ）。親がまだ取り込みも
 *   捨てもしていない回は、その回の先頭が今回の対象の先頭と違えば（親は取り込むとき、今の先頭と比べて捨てる）届かなかった
 * - 親のいないタスク：その回を投稿したとき、PR の先頭が変わっていた（latestCommit がある）回。人も新しい先頭では読めない。
 *   GitHub の再依頼で作ったタスクの前回の回は、latestCommit を持たないので判定しない
 */
export function undeliveredRounds(
  task: Pick<Task, "previousReview" | "earlierReviews">,
  parent: Pick<Task, "discardedReviews" | "importedFeedback"> | undefined,
  currentHead: string | undefined,
): Set<number> {
  const reviews: PreviousReview[] = [
    ...(task.earlierReviews ?? []),
    ...(task.previousReview ? [task.previousReview] : []),
  ];
  const result = new Set<number>();
  for (const review of reviews) {
    if (!parent) {
      if (review.latestCommit) result.add(review.round);
      continue;
    }
    const discarded = (parent.discardedReviews ?? []).some((d) =>
      d.items.some((item) => item.url === review.url),
    );
    if (discarded) {
      result.add(review.round);
      continue;
    }
    const key = importKey(review.url);
    const imported = key !== undefined && parent.importedFeedback.includes(key);
    if (key !== undefined && !imported && currentHead && !same(review.headCommit, currentHead)) {
      result.add(review.round);
    }
  }
  return result;
}
