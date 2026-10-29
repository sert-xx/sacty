"use client";

import type { ActivityEvent, Task, TokenUsage } from "@sacty/core";
import { CardSection } from "@/components/card-section";
import { useMessages } from "@/i18n/client";
import { formatStamp, usd } from "@/lib/labels";
import { type CostRole, type CostRun, stepCosts } from "@/lib/step-costs";
import { subtaskSummary } from "@/lib/subtasks";

type Messages = ReturnType<typeof useMessages>;

const NUMBER_LOCALE = { ja: "ja-JP", en: "en-US" } as const;

/**
 * 工程ごとの、エージェント・設定・トークンの使用量・費用（PBI-46）。工程の外の費用（チケットの読み取り・リポジトリの
 * 選択・オーケストレーター・質問への答え・書き出し・ゴールガーディアン）も1行ずつ出し、合計はタスクの費用（CostMeter）と
 * 一致する（PBI-86）。各回の内訳は折りたたんで出す。
 */
/** subtasks は、分割で作った子タスク（PBI-27）。 */
export function StepCosts({
  task,
  activity,
  subtasks,
}: {
  task: Task;
  activity: ActivityEvent[];
  subtasks: Task[];
}) {
  const messages = useMessages();
  const { labels, locale } = messages;
  const m = messages.task.costs;
  const { rows, total } = stepCosts(task, activity);
  // 子タスクの費用の合計は、子タスクの一覧と同じ値を出す（PBI-27）
  const children = task.split
    ? subtaskSummary(task, new Map(subtasks.map((t) => [t.id, t])))
    : undefined;
  const count = new Intl.NumberFormat(NUMBER_LOCALE[locale]);
  const roleLabel = (role: CostRole) =>
    role === "chat" ||
    role === "errorAnalysis" ||
    role === "export" ||
    role === "gather" ||
    role === "triage" ||
    role === "repository"
      ? m[role]
      : role === "orchestrator" || role === "guardian"
        ? labels.actor[role]
        : labels.step[role];
  const ran = rows.filter((r) => r.runs.length > 0);

  return (
    <CardSection id="step-costs" title={m.title} hint={m.hint}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {m.column.role}
              </th>
              <UsageHeads m={m} />
              <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                {m.column.cost}
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-medium whitespace-nowrap">
                {m.column.runs}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.role} className="border-t border-border align-top">
                <th scope="row" className="py-2.5 pr-3 text-left font-medium">
                  {roleLabel(row.role)}
                  <Settings runs={row.runs} m={m} labels={labels} />
                </th>
                <UsageCells usage={row.usage} count={count} m={m} />
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  {row.runs.length > 0 ? <Cost usd={row.costUsd} /> : m.none}
                </td>
                <td className="py-2.5 pl-3 text-right whitespace-nowrap tabular-nums">
                  {m.runs(row.runs.length)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border font-semibold">
              <th scope="row" className="py-2.5 pr-3 text-left">
                {m.total}
              </th>
              <UsageCells usage={total.usage} count={count} m={m} />
              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                <Cost usd={total.costUsd} />
              </td>
              <td />
            </tr>
            {children && (
              <tr className="border-t border-border">
                <th scope="row" colSpan={4} className="py-2.5 pr-3 text-left font-medium">
                  {m.children}
                </th>
                <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap tabular-nums">
                  {usd(children.costUsd)}
                </td>
                <td />
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {ran.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground marker:text-muted-foreground">
            {m.breakdown(ran.reduce((n, r) => n + r.runs.length, 0))}
          </summary>
          <div className="overflow-x-auto pt-2">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {m.column.run}
                  </th>
                  <UsageHeads m={m} />
                  <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    {m.column.cost}
                  </th>
                  <th scope="col" className="py-2 pl-3 font-medium whitespace-nowrap">
                    {m.column.result}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ran.flatMap((row) =>
                  row.runs.map((run, i) => (
                    <tr key={run.id} className="border-t border-border">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        {roleLabel(row.role)}
                        <span className="text-muted-foreground"> {m.nth(i + 1)}</span>
                        <time
                          dateTime={run.at}
                          className="block font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          {formatStamp(run.at, locale)}
                        </time>
                        <Settings runs={[run]} m={m} labels={labels} />
                      </th>
                      <UsageCells usage={run.usage} count={count} m={m} />
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Cost usd={run.costUsd} />
                      </td>
                      <td
                        className={
                          run.result === "failed" || run.result === "interrupted"
                            ? "py-2 pl-3 whitespace-nowrap text-warn"
                            : "py-2 pl-3 whitespace-nowrap text-muted-foreground"
                        }
                      >
                        {m.result[run.result]}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </CardSection>
  );
}

type CostMessages = Messages["task"]["costs"];

function UsageHeads({ m }: { m: CostMessages }) {
  return (
    <>
      <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
        {m.column.input}
      </th>
      <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
        {m.column.output}
      </th>
      <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
        {m.column.cache}
      </th>
    </>
  );
}

function UsageCells({
  usage,
  count,
  m,
}: {
  usage?: TokenUsage;
  count: Intl.NumberFormat;
  m: CostMessages;
}) {
  const cell = "px-3 py-2.5 text-right font-mono whitespace-nowrap tabular-nums";
  if (!usage) {
    return (
      <>
        <td className={cell}>{m.none}</td>
        <td className={cell}>{m.none}</td>
        <td className={cell}>{m.none}</td>
      </>
    );
  }
  return (
    <>
      <td className={cell}>{count.format(usage.input)}</td>
      <td className={cell}>{count.format(usage.output)}</td>
      <td className={cell}>
        {count.format(usage.cacheRead)} / {count.format(usage.cacheWrite)}
      </td>
    </>
  );
}

/** 費用。換算した概算かどうかはセルに出さず、見出しの補足で説明する（PBI-138。セルごとの印は表を読みにくくするため）。 */
function Cost({ usd: value }: { usd: number }) {
  return <span className="font-mono tabular-nums">{usd(value)}</span>;
}

/**
 * エージェント（設定の名前）・接続先・モデル・エフォート。工程の名前の下に小さく出す（列を増やさず、表を狭い幅に
 * 収めるため）。設定を変えて動かした工程は、組み合わせごとに出す。記録に無い項目は「—」。
 */
function Settings({
  runs,
  m,
  labels,
}: {
  runs: readonly CostRun[];
  m: CostMessages;
  labels: Messages["labels"];
}) {
  const lines = [
    ...new Set(
      runs.map((r) =>
        m.setting(
          r.agentId ?? m.none,
          r.authMode ? labels.auth[r.authMode] : m.none,
          r.model ?? m.none,
          r.reasoningEffort ?? m.none,
        ),
      ),
    ),
  ];
  if (lines.length === 0) return null;
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5 text-xs font-normal text-muted-foreground">
      {lines.map((line) => (
        <li key={line} className="[overflow-wrap:anywhere]">
          {line}
        </li>
      ))}
    </ul>
  );
}
