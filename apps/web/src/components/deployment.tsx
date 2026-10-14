import { DEPLOYMENT_CI_TIMEOUT_MS, isFailedCiCheck, MAX_FIX_CHAIN, type Task } from "@sacty/core";
import Link from "next/link";
import { CardSection } from "@/components/card-section";
import { getMessages } from "@/i18n/server";
import { getTask } from "@/lib/daemon";
import { formatStamp } from "@/lib/labels";

/** 画面に出す CI/CD の実行・チェックの数（失敗・実行中のものを先に）。 */
const CHECKS_SHOWN = 20;

/**
 * マージの後の監視（PBI-89）。状態・CI/CD の実行とチェック・失敗したジョブとログの抜粋・デプロイの確認の結果・
 * 登録した修正のタスク（作らなかった理由）を出す。監視していないタスクでは出さない。
 */
export async function DeploymentWatchCard({ task }: { task: Task }) {
  const watch = task.deployment;
  if (!watch) return null;
  const { task: messages, labels, locale } = await getMessages();
  const m = messages.deployment;
  const commitUrl = watch.commit
    ? `${watch.repo.replace(/\/+$/, "")}/commit/${watch.commit}`
    : undefined;
  const checks = [...(watch.ci?.checks ?? [])]
    .sort(
      (a, b) =>
        Number(isFailedCiCheck(b)) - Number(isFailedCiCheck(a)) ||
        Number(b.status === "pending") - Number(a.status === "pending"),
    )
    .slice(0, CHECKS_SHOWN);
  const fixTask = watch.fix ? (await getTask(watch.fix.taskId).catch(() => undefined))?.task : null;
  const tone =
    watch.state === "failed" || watch.state === "timed_out"
      ? "text-warn"
      : watch.state === "passed"
        ? "text-accent-foreground"
        : "text-muted-foreground";
  const stateText =
    watch.state === "waiting"
      ? watch.check && !watch.check.result
        ? m.checking
        : m.phase[watch.phase ?? "ci"]
      : m.state[watch.state];

  return (
    <CardSection id="deployment" title={m.title} note={m.note}>
      <p className="flex flex-wrap items-baseline gap-2 text-sm">
        <span
          data-testid="deployment-state"
          data-state={watch.state}
          className={`font-semibold ${tone}`}
        >
          {m.state[watch.state]}
        </span>
        {watch.state === "waiting" && <span className="text-muted-foreground">{stateText}</span>}
      </p>
      {watch.reason && (
        <p className="text-sm text-muted-foreground">
          {m.reason[watch.reason]}
          {watch.detail !== undefined && ` ${labels.text(watch.detail)}`}
        </p>
      )}
      <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
        {m.commit}
        {commitUrl ? (
          <a
            href={commitUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-accent-foreground underline"
          >
            {watch.commit?.slice(0, 7)}
          </a>
        ) : (
          "—"
        )}
        {m.branch}
        <span className="font-mono">{watch.branch}</span>
        <br />
        {m.startedAt(formatStamp(watch.startedAt, locale))}
        {watch.state === "waiting" && watch.phase === "ci" && (
          <>
            {" ・ "}
            {m.deadline(
              formatStamp(
                new Date(Date.parse(watch.startedAt) + DEPLOYMENT_CI_TIMEOUT_MS).toISOString(),
                locale,
              ),
            )}
          </>
        )}
      </p>

      {checks.length > 0 && (
        <div className="flex flex-col gap-1 text-sm">
          <h3 className="font-semibold">{m.checks}</h3>
          <ul className="flex flex-col gap-1">
            {checks.map((c) => (
              <li
                key={`${c.kind}:${c.name}:${c.url ?? ""}`}
                className="flex flex-wrap items-baseline gap-2 [overflow-wrap:anywhere]"
              >
                <span className="text-xs text-muted-foreground">{m.checkKind[c.kind]}</span>
                <span className="font-medium">{c.name}</span>
                <span className={isFailedCiCheck(c) ? "text-warn" : "text-muted-foreground"}>
                  {c.status === "pending" ? m.pending : c.conclusion}
                </span>
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-accent-foreground underline"
                  >
                    {m.open}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(watch.ci?.failures.length ?? 0) > 0 && (
        <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-semibold">{m.failures}</h3>
          {watch.ci?.failures.map((f) => (
            <div
              key={`${f.workflow}:${f.job ?? ""}:${f.url ?? ""}`}
              className="flex flex-col gap-1"
            >
              <p className="flex flex-wrap items-baseline gap-2 [overflow-wrap:anywhere]">
                <span className="font-medium">
                  {f.job ? `${f.workflow} / ${f.job}` : f.workflow}
                </span>
                <span className="text-warn">{f.conclusion}</span>
                {f.url && (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-accent-foreground underline"
                  >
                    {m.open}
                  </a>
                )}
              </p>
              {f.excerpt && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {m.log}
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                    {f.excerpt}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {(watch.check || watch.ci?.skill) && (
        <div className="flex flex-col gap-1 text-sm">
          <h3 className="font-semibold">{m.check}</h3>
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {m.skill}
            <span className="font-mono">{watch.check?.skill ?? watch.ci?.skill}</span>
          </p>
          {watch.check?.result && (
            <p
              data-testid="deployment-check-result"
              className={
                watch.check.result === "unhealthy" ? "font-medium text-warn" : "font-medium"
              }
            >
              {m.result[watch.check.result]}
            </p>
          )}
          {watch.check?.summary && <p className="whitespace-pre-line">{watch.check.summary}</p>}
          {(watch.check?.evidence?.length ?? 0) > 0 && (
            <>
              <p className="font-medium">{m.evidence}</p>
              <ul className="list-disc pl-5 [overflow-wrap:anywhere]">
                {watch.check?.evidence?.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {watch.fix && (
        <p className="text-sm [overflow-wrap:anywhere]" data-testid="deployment-fix">
          {m.fix}
          <Link
            href={`/tasks/${encodeURIComponent(watch.fix.taskId)}`}
            className="text-accent-foreground underline"
          >
            {fixTask?.title ?? watch.fix.title}
          </Link>
        </p>
      )}
      {watch.suppressed && (
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {watch.suppressed.reason === "duplicate" ? (
            <>
              {m.suppressed.duplicate}
              {watch.suppressed.existing && (
                <Link
                  href={`/tasks/${encodeURIComponent(watch.suppressed.existing)}`}
                  className="text-accent-foreground underline"
                >
                  {watch.suppressed.existing.slice(0, 8)}
                </Link>
              )}
            </>
          ) : (
            m.suppressed.chain_limit(MAX_FIX_CHAIN)
          )}
        </p>
      )}
    </CardSection>
  );
}
