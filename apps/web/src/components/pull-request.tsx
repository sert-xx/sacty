import type { Task } from "@sacty/core";

/** sacty が作ったPR（またはブランチ）と、ゴールガーディアンの見逃しの記録。 */
export function PullRequestCard({ task }: { task: Task }) {
  const pr = task.pullRequest;
  if (!pr && task.misses.length === 0) return null;
  return (
    <section
      aria-labelledby="pull-request"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="pull-request" className="text-[15px] font-semibold">
        PR{" "}
        <span className="text-[13px] font-normal text-muted-foreground">
          sacty が作業をコミットして作成
        </span>
      </h2>
      {pr && (
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm leading-6">
          <dt className="pt-0.5 text-xs text-muted-foreground">PR</dt>
          <dd className="break-all">
            {pr.url ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-accent-foreground underline"
              >
                #{pr.number} を開く
              </a>
            ) : (
              <span className="text-muted-foreground">
                作っていません（設定でPRの作成先が指定されていないため、ブランチまで）
              </span>
            )}
          </dd>
          <dt className="pt-0.5 text-xs text-muted-foreground">ブランチ</dt>
          <dd className="font-mono text-xs leading-6 break-all">{pr.branch}</dd>
          <dt className="pt-0.5 text-xs text-muted-foreground">コミット</dt>
          <dd className="font-mono text-xs leading-6">{pr.commit.slice(0, 12)}</dd>
        </dl>
      )}
      {task.misses.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-warn-line bg-warn-soft p-3.5 text-sm leading-6 text-warn">
          <p className="font-semibold">ゴールガーディアンの見逃し {task.misses.length}件</p>
          <p>
            最終レビューで合格にした成果物を、人間が成果物チェックで差し戻しました。ゴールガーディアンの精度の記録として残しています。
          </p>
          <ul className="list-disc pl-5">
            {task.misses.map((m) => (
              <li key={m.reviewAt}>
                指摘：{m.remarkIds.length > 0 ? m.remarkIds.join(", ") : "（なし）"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
