"use client";

import {
  type DaemonText,
  type PullRequestMerge,
  type PullRequestTemplateUse,
  parseRepoUrl,
  type Task,
} from "@sacty/core";
import { useMessages } from "@/i18n/client";

type PullRequestMessages = ReturnType<typeof useMessages>["parts"]["pullRequest"];

/**
 * 人が PR の中で直してからマージしたこと（PBI-63）。sacty が出したコミットと人が直した最終のコミット、GitHub の
 * 比較へのリンク、マージのコミット（取れれば）を出す。
 */
function EditedMerge({
  merge,
  repo,
  m,
}: {
  merge: PullRequestMerge | undefined;
  repo: string | undefined;
  m: PullRequestMessages;
}) {
  if (!merge?.edited) return null;
  const submitted = merge.submitted ?? "";
  const final = merge.commit ?? "";
  const github = repo ? parseRepoUrl(repo) : undefined;
  const compare =
    github && /^[0-9a-f]{7,64}$/.test(submitted) && /^[0-9a-f]{7,64}$/.test(final)
      ? `${github.url}/compare/${submitted}...${final}`
      : undefined;
  return (
    <span className="block text-xs text-warn [overflow-wrap:anywhere]">
      <span className="font-semibold">{m.edited}</span>{" "}
      <span className="font-mono">{m.editedCommits(submitted.slice(0, 7), final.slice(0, 7))}</span>
      {compare && (
        <>
          {" "}
          <a
            href={compare}
            target="_blank"
            rel="noreferrer"
            className="text-accent-foreground underline"
          >
            {m.compare}
          </a>
        </>
      )}
      {merge.mergeCommit && (
        <span className="block font-mono text-muted-foreground">
          {m.mergeCommit(merge.mergeCommit.slice(0, 7))}
        </span>
      )}
    </span>
  );
}

/**
 * PR の本文に使った PR テンプレート（PBI-87）。使ったテンプレートの場所か、sacty の決まった形にした理由。
 * それより前の記録（template が無い）では何も出さない。
 */
function TemplateUse({
  template,
  m,
  text,
}: {
  template: PullRequestTemplateUse | undefined;
  m: PullRequestMessages;
  text: (value: DaemonText) => string;
}) {
  if (!template) return null;
  const github = template.repo ? parseRepoUrl(template.repo) : undefined;
  return (
    <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {template.path
        ? m.templateUsed(template.path, github?.path ?? template.repo ?? "")
        : template.fallback === "unusable"
          ? m.templateUnusable
          : m.templateNone}
      {template.message !== undefined && (
        <span className="block text-warn">{text(template.message)}</span>
      )}
      {template.truncated && <span className="block text-warn">{m.templateTruncated}</span>}
    </span>
  );
}

/**
 * sacty が作ったPR（またはブランチ）と、ゴールガーディアンの見逃しの記録。要求要件・設計の PR とタスクブランチ
 * （PBI-57）も並べる。
 */
export function PullRequestCard({ task }: { task: Task }) {
  const messages = useMessages();
  const pr = task.pullRequest;
  const steps = task.stepPullRequests;
  if (!pr && task.misses.length === 0 && steps.length === 0) return null;
  const m = messages.parts.pullRequest;
  const { step, text } = messages.labels;
  // 最後に PR の指摘で差し戻した戻し先と、ゴールガーディアンの判断の理由（PBI-58・PBI-57）
  const rework = task.prRework;
  return (
    <section
      aria-labelledby="pull-request"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="pull-request" className="text-[15px] font-semibold">
        PR <span className="text-[13px] font-normal text-muted-foreground">{m.note}</span>
      </h2>
      {(pr || steps.length > 0 || rework) && (
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm leading-6">
          {pr && (
            <>
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
              <dd className="font-mono text-xs leading-6">
                {pr.commit.slice(0, 12)}
                <EditedMerge merge={task.pullRequestMerge} repo={pr.repo} m={m} />
              </dd>
              {pr.template && (
                <>
                  <dt className="pt-0.5 text-xs text-muted-foreground">{m.body}</dt>
                  <dd className="leading-6">
                    <TemplateUse template={pr.template} m={m} text={text} />
                  </dd>
                </>
              )}
            </>
          )}
          {task.taskBranch && !pr && (
            <>
              <dt className="pt-0.5 text-xs text-muted-foreground">{m.taskBranch}</dt>
              <dd className="font-mono text-xs leading-6 break-all">{task.taskBranch.branch}</dd>
            </>
          )}
          {steps.length > 0 && (
            <>
              <dt className="pt-0.5 text-xs text-muted-foreground">{m.stepPullRequests}</dt>
              <dd>
                <ul className="flex flex-col gap-1">
                  {steps.map((p) => (
                    <li key={p.number} className="[overflow-wrap:anywhere]">
                      <span className="font-medium">{step[p.step]}</span>{" "}
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold text-accent-foreground underline"
                      >
                        {m.open(p.number)}
                      </a>{" "}
                      <span className="text-muted-foreground">
                        {p.superseded ? m.stepState.superseded : m.stepState[p.state]}
                      </span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {p.path}
                      </span>
                      <TemplateUse template={p.template} m={m} text={text} />
                      <EditedMerge merge={p.merge} repo={p.repo} m={m} />
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
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
