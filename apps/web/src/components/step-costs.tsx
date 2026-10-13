import type { ActivityEvent, Task, TokenUsage } from "@sacty/core";
import { CardSection } from "@/components/card-section";
import { getMessages } from "@/i18n/server";
import { listTasks } from "@/lib/daemon";
import { formatStamp, usd } from "@/lib/labels";
import { type CostRole, type CostRun, distinctSetting, stepCosts } from "@/lib/step-costs";
import { subtaskSummary } from "@/lib/subtasks";

type Messages = Awaited<ReturnType<typeof getMessages>>;

const NUMBER_LOCALE = { ja: "ja-JP", en: "en-US" } as const;

/**
 * 工程ごとの、エージェント・設定・トークンの使用量・費用（PBI-46）。オーケストレーター・ゴールガーディアンの
 * 費用も1行ずつ出し、行の合計はタスクの費用（CostMeter）と一致する。各回の内訳は折りたたんで出す。
 */
export async function StepCosts({ task, activity }: { task: Task; activity: ActivityEvent[] }) {
  const messages = await getMessages();
  const { labels, locale } = messages;
  const m = messages.task.costs;
  const { rows, total } = stepCosts(task, activity);
  // 子タスクの費用の合計は、子タスクの一覧と同じ値を出す（PBI-27）
  const children = task.split
    ? subtaskSummary(task, new Map((await listTasks()).map((t) => [t.id, t])))
    : undefined;
  const count = new Intl.NumberFormat(NUMBER_LOCALE[locale]);
  const roleLabel = (role: CostRole) =>
    role === "orchestrator" || role === "guardian" ? labels.actor[role] : labels.step[role];
  const ran = rows.filter((r) => r.runs.length > 0);

  return (
    <CardSection id="step-costs" title={m.title} note={m.note}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {m.column.role}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {m.column.agent}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {m.column.model}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {m.column.effort}
              </th>
              <UsageHeads m={m} />
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {m.column.cost}
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">
                {m.column.runs}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.role} className="border-t border-border align-top">
                <th scope="row" className="py-2.5 pr-3 text-left font-medium whitespace-nowrap">
                  {roleLabel(row.role)}
                </th>
                <td className="px-3 py-2.5">
                  <Settings runs={row.runs} m={m} labels={labels} />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs [overflow-wrap:anywhere]">
                  <Values values={distinctSetting(row.runs, "model")} m={m} />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs">
                  <Values values={distinctSetting(row.runs, "reasoningEffort")} m={m} />
                </td>
                <UsageCells usage={row.usage} count={count} m={m} />
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  {row.runs.length > 0 ? (
                    <Cost usd={row.costUsd} estimated={row.estimated} m={m} />
                  ) : (
                    m.none
                  )}
                </td>
                <td className="py-2.5 pl-3 text-right whitespace-nowrap tabular-nums">
                  {m.runs(row.runs.length)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border font-semibold">
              <th scope="row" colSpan={4} className="py-2.5 pr-3 text-left">
                {m.total}
              </th>
              <UsageCells usage={total.usage} count={count} m={m} />
              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                <Cost usd={total.costUsd} estimated={total.estimated} m={m} />
              </td>
              <td />
            </tr>
            {children && (
              <tr className="border-t border-border">
                <th scope="row" colSpan={7} className="py-2.5 pr-3 text-left font-medium">
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
            <table className="w-full min-w-[960px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {m.column.role}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {m.column.at}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {m.column.agent}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {m.column.model}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {m.column.effort}
                  </th>
                  <UsageHeads m={m} />
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {m.column.cost}
                  </th>
                  <th scope="col" className="py-2 pl-3 font-medium">
                    {m.column.result}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ran.flatMap((row) =>
                  row.runs.map((run, i) => (
                    <tr key={run.id} className="border-t border-border">
                      <th scope="row" className="py-2 pr-3 text-left font-normal whitespace-nowrap">
                        {roleLabel(row.role)}
                        <span className="text-muted-foreground"> {m.nth(i + 1)}</span>
                      </th>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        <time dateTime={run.at}>{formatStamp(run.at, locale)}</time>
                      </td>
                      <td className="px-3 py-2">
                        <Settings runs={[run]} m={m} labels={labels} />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">
                        {run.model ?? m.none}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {run.reasoningEffort ?? m.none}
                      </td>
                      <UsageCells usage={run.usage} count={count} m={m} />
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Cost usd={run.costUsd} estimated={run.estimated} m={m} />
                      </td>
                      <td
                        className={
                          run.result === "failed"
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
      <th scope="col" className="px-3 py-2 text-right font-medium">
        {m.column.input}
      </th>
      <th scope="col" className="px-3 py-2 text-right font-medium">
        {m.column.output}
      </th>
      <th scope="col" className="px-3 py-2 text-right font-medium">
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

/** 費用。換算した値は「概算」を添えて、実際の請求と区別する。 */
function Cost({ usd: value, estimated, m }: { usd: number; estimated: boolean; m: CostMessages }) {
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className="font-mono tabular-nums">{usd(value)}</span>
      {estimated && (
        <span
          title={m.estimatedNote}
          className="rounded-full border border-input px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {m.estimated}
        </span>
      )}
    </span>
  );
}

/** エージェント（設定の名前）と接続先。設定を変えて動かした工程は、組み合わせごとに1行ずつ出す。 */
function Settings({
  runs,
  m,
  labels,
}: {
  runs: readonly CostRun[];
  m: CostMessages;
  labels: Messages["labels"];
}) {
  const pairs = [
    ...new Set(
      runs.map((r) =>
        m.setting(r.agentId ?? m.none, r.authMode ? labels.auth[r.authMode] : m.none),
      ),
    ),
  ];
  if (pairs.length === 0) return <>{m.none}</>;
  return (
    <ul className="flex flex-col gap-0.5">
      {pairs.map((p) => (
        <li key={p} className="whitespace-nowrap">
          {p}
        </li>
      ))}
    </ul>
  );
}

function Values({ values, m }: { values: (string | undefined)[]; m: CostMessages }) {
  if (values.length === 0) return <>{m.none}</>;
  return (
    <ul className="flex flex-col gap-0.5">
      {values.map((v) => (
        <li key={v ?? ""}>{v ?? m.none}</li>
      ))}
    </ul>
  );
}
