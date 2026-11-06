"use client";

import { FLAKY_KNOWN_MIN_TASKS, type FlakyTest, TASK_BODY_MAX, TASK_TITLE_MAX } from "@sacty/core";
import Link from "next/link";
import { CardSection } from "@/components/card-section";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { WithHint } from "@/components/ui/hint";
import type { Messages } from "@/i18n";
import { useMessages } from "@/i18n/client";
import { formatStamp } from "@/lib/labels";
import { taskPath } from "@/lib/paths";

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * 提案から作るタスクに入れておく題と内容（人が直してから作る）。内容に PR のリンクは書かない（タスクの内容にある PR は、
 * そのタスクが扱う PR と読まれるため）。
 */
export function flakyFixDraft(
  test: FlakyTest,
  m: Messages["audit"]["screen"]["flaky"],
): { title: string; body: string } {
  return {
    title: cut(m.fixTitle(test.name), TASK_TITLE_MAX),
    body: cut(m.fixBody(test), TASK_BODY_MAX),
  };
}

/**
 * 監査の画面の「不安定なテスト」（PBI-312）。既知のテストには、直すタスクの提案を出す。提案はタスクの作成のダイアログを
 * 開くだけで、人が作成を押すまでタスクは作らない（テストの隔離・無効化もしない）。
 */
export function FlakyTestsCard({
  tests,
  project,
}: {
  tests: readonly FlakyTest[];
  project: { id: string; name: string; hasTargets: boolean };
}) {
  const messages = useMessages();
  const m = messages.audit.screen.flaky;
  return (
    <CardSection
      id="audit-flaky-tests"
      title={m.title}
      hint={m.hint}
      note={tests.length > 0 ? m.note(tests.length) : undefined}
    >
      {tests.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.none}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tests.map((test) => (
            <li
              key={`${test.repo}\n${test.file}\n${test.name}`}
              data-testid="flaky-test"
              className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                {test.known && (
                  <WithHint hint={m.knownHint(FLAKY_KNOWN_MIN_TASKS)}>
                    <span className="rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-xs text-warn">
                      {m.known}
                    </span>
                  </WithHint>
                )}
                <span className="text-sm font-semibold [overflow-wrap:anywhere]">{test.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {m.taskCount(test.taskCount)}
                </span>
              </div>
              <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {test.file}
              </p>
              <p className="text-xs text-muted-foreground">
                {m.lastSeen}{" "}
                <time dateTime={test.lastSeenAt} className="font-mono">
                  {formatStamp(test.lastSeenAt, messages.locale)}
                </time>
              </p>
              <ul className="flex flex-col gap-0.5 text-[13px]">
                <li className="text-muted-foreground">{m.tasks}</li>
                {test.tasks.map((t) => (
                  <li key={t.taskId} className="flex flex-wrap gap-x-3">
                    <Link
                      href={taskPath(t.taskId)}
                      className="text-accent-foreground underline [overflow-wrap:anywhere]"
                    >
                      {t.taskTitle}
                    </Link>
                    {t.pullRequestUrl && (
                      <a
                        href={t.pullRequestUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent-foreground underline"
                      >
                        {m.pullRequest}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              {test.fixTask ? (
                <p className="text-[13px]">
                  <span className="text-muted-foreground">{m.fixTask}</span>{" "}
                  <Link
                    href={taskPath(test.fixTask.taskId)}
                    className="text-accent-foreground underline [overflow-wrap:anywhere]"
                  >
                    {test.fixTask.title}
                  </Link>
                </p>
              ) : (
                test.known && (
                  <div
                    data-testid="flaky-test-proposal"
                    className="flex flex-wrap items-center gap-3 border-t border-border pt-2"
                  >
                    <p className="text-[13px]">{m.proposal}</p>
                    <NewTaskDialog
                      projectId={project.id}
                      projectName={project.name}
                      hasTargets={project.hasTargets}
                      prefill={{
                        label: m.createFix,
                        repo: test.repo,
                        flakyFix: { name: test.name, file: test.file },
                        ...flakyFixDraft(test, m),
                      }}
                    />
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </CardSection>
  );
}
