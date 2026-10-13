import type { Task } from "@sacty/core";
import { getMessages } from "@/i18n/server";

/** sacty が作ったPR（またはブランチ）と、ゴールガーディアンの見逃しの記録。 */
export async function PullRequestCard({ task }: { task: Task }) {
  const pr = task.pullRequest;
  if (!pr && task.misses.length === 0) return null;
  const messages = await getMessages();
  const m = messages.parts.pullRequest;
  const { step, text } = messages.labels;
  // 最後に PR の指摘で差し戻した戻し先と、ゴールガーディアンの判断の理由（PBI-58）
  const rework = task.prRework;
  return (
    <section
      aria-labelledby="pull-request"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="pull-request" className="text-[15px] font-semibold">
        PR <span className="text-[13px] font-normal text-muted-foreground">{m.note}</span>
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
                {m.open(pr.number)}
              </a>
            ) : (
              <span className="text-muted-foreground">{m.notCreated}</span>
            )}
          </dd>
          <dt className="pt-0.5 text-xs text-muted-foreground">{m.branch}</dt>
          <dd className="font-mono text-xs leading-6 break-all">{pr.branch}</dd>
          <dt className="pt-0.5 text-xs text-muted-foreground">{m.commit}</dt>
          <dd className="font-mono text-xs leading-6">{pr.commit.slice(0, 12)}</dd>
          {rework && (
            <>
              <dt className="pt-0.5 text-xs text-muted-foreground">{m.rework}</dt>
              <dd>
                {rework.decided
                  ? m.reworkJudged(step[rework.target], text(rework.reason))
                  : m.reworkUndecided(step[rework.target], text(rework.reason))}
              </dd>
            </>
          )}
        </dl>
      )}
      {task.misses.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-warn-line bg-warn-soft p-3.5 text-sm leading-6 text-warn">
          <p className="font-semibold">{m.misses(task.misses.length)}</p>
          <p>{m.missesHelp}</p>
          <ul className="list-disc pl-5">
            {task.misses.map((miss) => (
              <li key={miss.reviewAt}>
                {m.remarks(miss.remarkIds.length > 0 ? miss.remarkIds.join(", ") : m.none)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
