"use client";

import { CircleX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ActionLink } from "@/components/action-link";
import { DaemonError } from "@/components/daemon-error";
import { FollowProjectAfterRecovery, StaleNotice } from "@/components/live-status";
import { StatusLabelView, StepChipsView } from "@/components/task-bits";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { useMessages } from "@/i18n/client";
import { repoLabels } from "@/lib/repo-label";
import {
  ACTIVE,
  defaultStatusFor,
  differsFromInitial,
  EMPTY_FILTER,
  filterOptions,
  filterQuery,
  matchesFilter,
  NO_REPO,
  needsLocalDay,
  type ParsedFilter,
  parseTaskFilter,
  type TaskFilter,
} from "@/lib/task-filter";
import type { TaskListData, TaskRow } from "@/lib/task-list-data";
import { indentShown } from "@/lib/task-rows";
import { useLiveData } from "@/lib/use-live-data";

/** タスクの一覧のデータを取り直す先。プロジェクトは、URL のプロジェクト（PBI-114）。 */
export function taskListLiveUrl(projectId: string): string {
  return `/live/tasks?project=${encodeURIComponent(projectId)}`;
}

/** 一度に出す行の数（子タスクの行も 1 行と数える）。「さらに表示」で、この数ずつ足す。 */
const TASK_PAGE_SIZE = 50;

/** 絞り込みの状態。status が undefined の間は、開いたときに決めた最初の表示の状態に従う。 */
type FilterState = Omit<TaskFilter, "status"> & { status?: TaskFilter["status"] };

const subscribeNothing = () => () => {};

/** URL の絞り込みのクエリを書き換える（履歴は増やさない。ほかのクエリとハッシュは残す）。 */
function writeFilterUrl(filter: TaskFilter, defaultStatus: TaskFilter["status"]) {
  const url = new URL(window.location.href);
  url.search = filterQuery(filter, defaultStatus, url.search);
  // state は null にする。App Router の state（__NA つき）を渡すと、ルーターが URL の変更を知らず、あとで描き直したときに
  // クエリが消える。null なら、Next.js が内部の state を写してルーターの URL も合わせる
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * 人間の判断が必要なタスクと、すべてのタスク（PBI-108）。画面をリロードせず、一定の間隔でデータだけを取り直し、
 * 新しいタスク・状態の変化を出す（タブが隠れている間は止め、見えたらすぐに取り直す）。
 * projectId は URL のプロジェクト（PBI-114）。描いたときにデーモンに届かなくても、そのプロジェクトを取り直す。
 * initial が null（描いたときにデーモンに届かなかった）なら、届くまで error を出し、届いたら一覧を出し、表示している
 * プロジェクトを URL のプロジェクトに合わせる（ヘッダーとずらさない）。
 */
export function LiveTaskList(props: LiveTaskListProps) {
  // 戻る・進むでは、絞り込みと足した行数を保つ。新しく開いたときは、URL から作り直す（PBI-441）
  const { bfcacheId } = useRouter();
  return <LiveTaskListBody key={bfcacheId} {...props} />;
}

type LiveTaskListProps = {
  projectId: string;
  initial: TaskListData | null;
  initialVersion?: string;
  error?: string;
  /** URL の絞り込み（検査した後。指定の無い項目は undefined）。 */
  initialFilter?: ParsedFilter;
};

function LiveTaskListBody({
  projectId,
  initial,
  initialVersion,
  error,
  initialFilter,
}: LiveTaskListProps) {
  const url = taskListLiveUrl(projectId);
  const { data, stale } = useLiveData(() => url, initial, initialVersion);
  const { tasks: m, labels } = useMessages();
  // 絞り込みと足した行数は画面の中で持つ（取り直しても消さない。別のプロジェクトへ移ると、key が変わって消える）。
  // 絞り込みは URL のクエリにも書く
  // 最初の値は今の URL から作る（戻るで、サーバーが最初に描いたときの値のまま作り直されても、アドレス欄と食い違わない）
  const [picked, setPicked] = useState<FilterState>(() => {
    const start =
      typeof window === "undefined"
        ? initialFilter
        : parseTaskFilter(new URLSearchParams(window.location.search));
    return { ...EMPTY_FILTER, ...start, status: start?.status };
  });
  const [limit, setLimit] = useState(TASK_PAGE_SIZE);
  // 最初の表示の状態は、開いたときに 1 回だけ決める（取り直しでは切り替えない）。デーモンに届かずに開いたときは、
  // 最初にデータが届いた時点で決める
  const [defaultStatus, setDefaultStatus] = useState<TaskFilter["status"] | null>(() =>
    initial ? defaultStatusFor(initial.rows) : null,
  );
  if (defaultStatus === null && data) setDefaultStatus(defaultStatusFor(data.rows));
  const initialStatus = defaultStatus ?? "";
  const filter: TaskFilter = { ...picked, status: picked.status ?? initialStatus };
  // サーバーが渡す絞り込みが変わった（同じ一覧へのリンクでクエリ無しへ移ったなど）とき、いまの絞り込みと違えば、
  // その絞り込みに合わせる（自分が URL に書いた絞り込みでサーバーが描き直されたときは、行数も保つ）
  const propsFilter: TaskFilter = {
    ...EMPTY_FILTER,
    ...initialFilter,
    status: initialFilter?.status ?? initialStatus,
  };
  const propsKey = filterQuery(propsFilter, initialStatus, "");
  const [seenPropsKey, setSeenPropsKey] = useState(propsKey);
  if (seenPropsKey !== propsKey) {
    setSeenPropsKey(propsKey);
    if (propsKey !== filterQuery(filter, initialStatus, "")) {
      setPicked({ ...EMPTY_FILTER, ...initialFilter, status: initialFilter?.status });
      setLimit(TASK_PAGE_SIZE);
    }
  }
  // 開始時期は日をブラウザーのタイムゾーンで決めるので、サーバーの描画と描き直しでは行を出さない
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const waitingForBrowser = !hydrated && needsLocalDay(filter);
  const matching =
    data && !waitingForBrowser ? data.rows.filter((r) => matchesFilter(r, filter)) : [];
  const rows = indentShown(matching).slice(0, limit);
  const totalRows = data?.rows.length ?? 0;
  const pendingFocus = useRef<string | null>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    // 「さらに表示」で足した最初の行へ、フォーカスを移す（ボタンが消えても、フォーカスが行方不明にならない）
    const id = pendingFocus.current;
    pendingFocus.current = null;
    if (id === null) return;
    const row = [...(tbody.current?.rows ?? [])].find(
      (r) => r.getAttribute("data-testid") === `task-row-${id}`,
    );
    row?.querySelector("a")?.focus();
  });
  const change = (next: TaskFilter) => {
    setPicked(next);
    setLimit(TASK_PAGE_SIZE);
    writeFilterUrl(next, initialStatus);
  };
  const clear = () => {
    setPicked({ ...EMPTY_FILTER, status: undefined });
    setLimit(TASK_PAGE_SIZE);
    writeFilterUrl({ ...EMPTY_FILTER, status: initialStatus }, initialStatus);
  };
  const showMore = () => {
    pendingFocus.current = matching[limit]?.id ?? null;
    setLimit((n) => n + TASK_PAGE_SIZE);
  };
  return (
    <>
      <StaleNotice stale={stale} />
      {initial === null && data && <FollowProjectAfterRecovery projectId={data.projectId} />}
      {data && data.needsYou.length > 0 && (
        <section aria-labelledby="needs-you" className="flex flex-col gap-3">
          <h2 id="needs-you" className="text-[15px] font-semibold">
            {m.needsYou}
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
            {data.needsYou.map((task) => (
              <li
                key={task.id}
                className="flex flex-col gap-2.5 rounded-xl border border-warn-line bg-card p-5"
              >
                <span className="w-fit rounded-full border border-warn-line bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">
                  {task.status}
                </span>
                <span className="text-[17px] font-semibold">{task.title}</span>
                {task.note && (
                  <span data-testid={`needs-you-note-${task.id}`} className="text-sm text-warn">
                    {task.note}
                  </span>
                )}
                <ActionLink
                  href={task.action.href}
                  external={task.action.external}
                  className="text-sm font-semibold text-accent-foreground"
                >
                  {task.action.label}
                  {!task.action.external && " →"}
                </ActionLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      <TasksSection>
        {!data ? (
          <div className="px-5 pb-5">
            <DaemonError message={error ?? ""} />
          </div>
        ) : data.rows.length === 0 ? (
          <p className="px-5 pb-8 text-sm text-muted-foreground">{m.empty}</p>
        ) : (
          <>
            <TaskFilterBar
              rows={data.rows}
              count={
                waitingForBrowser
                  ? ""
                  : matching.length > limit
                    ? m.filter.countPartial(matching.length, totalRows, limit)
                    : m.filter.count(matching.length, totalRows)
              }
              filter={filter}
              canClear={differsFromInitial(filter, initialStatus)}
              onChange={change}
              onClear={clear}
            />
            {waitingForBrowser ? (
              <p className="px-5 pb-8 text-sm text-muted-foreground">{m.loading}</p>
            ) : rows.length === 0 ? (
              <p className="px-5 pb-8 text-sm text-muted-foreground">{m.filter.none}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-5 py-2.5 font-medium">
                        {m.column.task}
                      </th>
                      <th scope="col" className="px-3 py-2.5 font-medium">
                        {m.column.start}
                      </th>
                      <th scope="col" className="px-3 py-2.5 font-medium">
                        {m.column.steps} <Hint text={m.stepsHint} className="size-4" />
                      </th>
                      <th scope="col" className="px-5 py-2.5 font-medium">
                        {m.column.status}
                      </th>
                    </tr>
                  </thead>
                  <tbody ref={tbody}>
                    {/* 分割で作った子タスク・PR のレビューの子タスクは、親のすぐ下に字下げして出す（PBI-27・PBI-341） */}
                    {/* 絞り込みで親が隠れた子は、無関係なタスクの子に見えないよう字下げしない（PBI-341） */}
                    {rows.map((task) => (
                      <tr
                        key={task.id}
                        className="border-t border-border hover:bg-muted"
                        data-testid={`task-row-${task.id}`}
                      >
                        <td
                          className={
                            task.shownDepth >= 2
                              ? "py-3.5 pr-5 pl-16"
                              : task.shownDepth === 1
                                ? "py-3.5 pr-5 pl-10"
                                : "px-5 py-3.5"
                          }
                        >
                          {task.shownDepth > 0 && (
                            <span aria-hidden="true" className="mr-1.5 text-muted-foreground">
                              ↳
                            </span>
                          )}
                          <Link
                            href={`/tasks/${task.id}`}
                            className="font-medium text-foreground hover:underline"
                          >
                            {task.title}
                          </Link>
                          {/* 字下げは読み上げられないので、親を文で伝える（PBI-341） */}
                          {task.parentTitle !== undefined && (
                            <span className="sr-only">{m.childOf(task.parentTitle)}</span>
                          )}
                          {/* 作業するリポジトリ（repo だけ。PBI-141） */}
                          {/* 複数を指定したタスクも、単数と同じリポジトリ名で出す（同じ名前があれば owner/name）。URL の全体は、
                              名前のツールチップと、キーボード・タップでも開ける補足に出す（リンクは増やさない。PBI-360） */}
                          {task.repos?.length ? (
                            <span
                              className="mt-0.5 block font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
                              data-testid={`task-repos-${task.id}`}
                            >
                              {m.specifiedRepositories}:{" "}
                              {repoLabels(task.repos).map((repo, index) => (
                                <span key={repo.url}>
                                  {index > 0 && ", "}
                                  <span title={repo.url}>{repo.label}</span>
                                </span>
                              ))}{" "}
                              <Hint text={task.repos.join("\n")} className="size-4 font-sans" />
                            </span>
                          ) : null}
                          {task.repoName && (
                            <span
                              className="mt-0.5 block font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
                              data-testid={`task-repo-${task.id}`}
                            >
                              {task.repos?.length ? `${m.workingRepository}: ` : ""}
                              {task.repoName}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap text-muted-foreground">
                          {labels.start[task.start]}
                          {/* テンプレートで作ったタスク（PBI-90） */}
                          {task.template && (
                            <span className="mt-0.5 block w-fit rounded border border-border px-1.5 text-xs">
                              {labels.template[task.template]}
                            </span>
                          )}
                          {/* 取り込み元の番号（リポジトリは題の下に出す。PBI-141） */}
                          {task.source && (
                            <span className="block font-mono text-xs">#{task.source.number}</span>
                          )}
                          {/* リポジトリを指定せずに作ったタスク（PBI-73） */}
                          {task.repoless && !task.repos?.length && (
                            <span
                              className="mt-0.5 block w-fit rounded border border-border px-1.5 text-xs"
                              data-testid="no-repository"
                            >
                              {m.noRepository}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3.5">
                          <StepChipsView steps={task.steps} />
                        </td>
                        <td className="px-5 py-3.5">
                          <StatusLabelView text={task.status.text} tone={task.status.tone} />
                          {/* 承認待ちの実装の PR の CI が失敗していた印（状態は変えない。色だけに頼らず、
                              アイコンと文字で出す。PBI-371） */}
                          {task.ciFailed && (
                            <span
                              className="mt-1 flex w-fit items-center gap-1 text-xs font-medium whitespace-nowrap text-warn"
                              data-testid={`task-ci-failed-${task.id}`}
                            >
                              <CircleX aria-hidden="true" className="size-3.5" />
                              {m.ciFailed}
                              <Hint text={m.ciFailedHint} className="size-4" />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {matching.length > limit && (
              <div className="px-5 py-4">
                <Button type="button" variant="outline" onClick={showMore}>
                  {m.filter.more(matching.length - limit)}
                </Button>
              </div>
            )}
          </>
        )}
      </TasksSection>
    </>
  );
}

const SELECT =
  "h-8 rounded-lg border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** 一覧の絞り込み（題の検索・開始時期・開始地点・リポジトリ・状態）。選択肢は、一覧にあるものだけを出す。 */
function TaskFilterBar({
  rows,
  count,
  filter,
  canClear,
  onChange,
  onClear,
}: {
  rows: TaskRow[];
  count: string;
  filter: TaskFilter;
  canClear: boolean;
  onChange: (filter: TaskFilter) => void;
  onClear: () => void;
}) {
  const { tasks: m, labels } = useMessages();
  const uid = useId();
  const { starts, repos } = filterOptions(rows, filter);
  const set = <K extends keyof TaskFilter>(key: K, value: TaskFilter[K]) =>
    onChange({ ...filter, [key]: value });
  const field = "flex flex-col gap-1 text-xs text-muted-foreground";
  return (
    <search
      aria-label={m.filter.label}
      className="flex flex-wrap items-end gap-3 px-5 pb-4"
      data-testid="task-filter"
    >
      <label htmlFor={`${uid}-query`} className={`${field} min-w-48 flex-1`}>
        {m.filter.query}
        <Input
          id={`${uid}-query`}
          type="search"
          value={filter.query}
          placeholder={m.filter.queryPlaceholder}
          onChange={(e) => set("query", e.target.value)}
        />
      </label>
      <label htmlFor={`${uid}-from`} className={field}>
        {m.filter.from}
        <Input
          id={`${uid}-from`}
          type="date"
          className="w-auto"
          value={filter.from}
          max={filter.to || undefined}
          onChange={(e) => set("from", e.target.value)}
        />
      </label>
      <label htmlFor={`${uid}-to`} className={field}>
        {m.filter.to}
        <Input
          id={`${uid}-to`}
          type="date"
          className="w-auto"
          value={filter.to}
          min={filter.from || undefined}
          onChange={(e) => set("to", e.target.value)}
        />
      </label>
      <label className={field}>
        {m.filter.start}
        <select
          className={SELECT}
          value={filter.start}
          onChange={(e) => set("start", e.target.value as TaskFilter["start"])}
        >
          <option value="">{m.filter.all}</option>
          {starts.map((start) => (
            <option key={start} value={start}>
              {labels.start[start]}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        {m.filter.repo}
        <select
          className={SELECT}
          value={filter.repo}
          onChange={(e) => set("repo", e.target.value)}
        >
          <option value="">{m.filter.all}</option>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo === NO_REPO ? m.filter.noRepo : repo}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        {m.filter.status}
        <select
          className={SELECT}
          value={filter.status}
          onChange={(e) => set("status", e.target.value as TaskFilter["status"])}
        >
          <option value="">{m.filter.all}</option>
          {([ACTIVE, "person", "working", "waiting", "completed", "cancelled"] as const).map(
            (tone) => (
              <option key={tone} value={tone}>
                {m.filter.tone[tone]}
              </option>
            ),
          )}
        </select>
      </label>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span role="status" data-testid="task-filter-count" className="[overflow-wrap:anywhere]">
          {count}
        </span>
        {canClear && (
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            {m.filter.clear}
          </Button>
        )}
      </div>
    </search>
  );
}

/** すべてのタスクの枠（読み込み中の仮表示と同じ）。 */
export function TasksSection({ children }: { children: React.ReactNode }) {
  const m = useMessages().tasks;
  return (
    <section aria-labelledby="all-tasks" className="rounded-xl border border-border bg-card">
      <h2 id="all-tasks" className="px-5 pt-4 pb-3 text-[15px] font-semibold">
        {m.allTasks}
      </h2>
      {children}
    </section>
  );
}
