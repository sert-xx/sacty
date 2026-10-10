import type { Task } from "@sacty/core";
import { cn } from "cn";
import { formatStamp } from "@/lib/labels";

const OK = "border-accent-line bg-accent text-accent-foreground";
const NG = "border-warn-line bg-warn-soft text-warn";
const NONE = "border-input text-muted-foreground";

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs whitespace-nowrap", tone)}>
      {children}
    </span>
  );
}

/**
 * 実装の成果物。実装の説明と、「観点 → テスト → 実行結果」の対応、
 * sacty が実行したテストの結果、ゴールガーディアンの最終レビューを出す。
 */
export function Implementation({ task }: { task: Task }) {
  const step = task.steps.find((s) => s.key === "implement");
  const viewpoints = task.approved.design?.testViewpoints ?? [];
  const tests = task.lastTests;
  const review = task.lastReview;
  // 最終レビューは、最新のテストの結果のあとに行われたものだけを対応表に出す
  const reviewIsCurrent = Boolean(review && tests && review.at >= tests.at);
  const mapped = new Map(task.testMap.map((m) => [m.viewpointId, m.tests]));
  const running = task.status === "running" && step?.state === "active";

  return (
    <section
      aria-labelledby="deliverable-implement"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="deliverable-implement" className="text-[15px] font-semibold">
        実装{" "}
        <span className="text-[13px] font-normal text-muted-foreground">
          {step?.state === "done" ? "最終レビューに合格" : "工程エージェントの作業"}
        </span>
      </h2>
      {task.repository && (
        <p className="text-xs break-all text-muted-foreground">
          対象リポジトリ：{task.repository.url}（{task.repository.baseBranch}・
          <span className="font-mono">{task.repository.baseCommit.slice(0, 7)}</span> から）
        </p>
      )}
      {task.outputs.implement ? (
        <pre className="font-sans text-sm leading-7 break-words whitespace-pre-wrap">
          {task.outputs.implement}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          {running ? "工程エージェントが実装しています…" : "まだ実装されていません。"}
        </p>
      )}

      {task.outputs.implement && (
        <>
          <h3 className="pt-2 text-sm font-semibold">
            観点 → テスト → 実行結果{" "}
            <span className="text-[13px] font-normal text-muted-foreground">
              テストの対応は工程エージェントの申告、検証はゴールガーディアンの判定
            </span>
          </h3>
          <ol className="flex flex-col gap-2.5">
            {viewpoints.map((v) => {
              const list = mapped.get(v.id) ?? [];
              const judged = reviewIsCurrent
                ? review?.viewpoints.find((r) => r.viewpointId === v.id)
                : undefined;
              return (
                <li key={v.id} className="rounded-lg border border-border p-3.5 text-sm leading-6">
                  <p className="flex flex-wrap items-baseline gap-2 font-medium">
                    <span className="font-mono text-xs text-muted-foreground">{v.id}</span>
                    {v.title}
                  </p>
                  <dl className="mt-1.5 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <dt className="pt-0.5 text-xs text-muted-foreground">テスト</dt>
                    <dd className="break-words">
                      {list.length > 0 ? (
                        <ul className="flex flex-col">
                          {list.map((t) => (
                            <li key={t} className="font-mono text-xs leading-6">
                              {t}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-warn">対応するテストがありません</span>
                      )}
                    </dd>
                    <dt className="pt-0.5 text-xs text-muted-foreground">実行結果</dt>
                    <dd className="flex flex-col gap-1">
                      <span className="flex flex-wrap gap-1.5">
                        {!tests ? (
                          <Pill tone={NONE}>未実行</Pill>
                        ) : tests.exitCode === 0 && list.length > 0 ? (
                          <Pill tone={OK}>テスト合格</Pill>
                        ) : (
                          <Pill tone={NG}>テスト不合格</Pill>
                        )}
                        {judged && (
                          <Pill tone={judged.verified ? OK : NG}>
                            {judged.verified ? "観点を検証している" : "観点を検証していない"}
                          </Pill>
                        )}
                      </span>
                      {judged && <span className="break-words">{judged.reason}</span>}
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {tests && (
        <details className="rounded-lg border border-border p-3.5 text-sm">
          <summary className="cursor-pointer">
            <span className="font-semibold">テストの実行</span>{" "}
            <Pill tone={tests.passed ? OK : NG}>{tests.passed ? "合格" : "不合格"}</Pill>{" "}
            <span className="text-xs text-muted-foreground">
              終了コード {tests.exitCode}・{(tests.durationMs / 1000).toFixed(1)}秒・
              {formatStamp(tests.at)}
            </span>
          </summary>
          <p className="mt-2 font-mono text-xs break-all">{tests.command}</p>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border bg-muted px-4 py-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
            {tests.output || "（出力なし）"}
          </pre>
        </details>
      )}

      {review && (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-lg border p-3.5 text-sm leading-6",
            review.passed ? "border-accent-line" : "border-warn-line",
          )}
        >
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">最終レビュー</span>
            <Pill tone={review.passed ? OK : NG}>{review.passed ? "合格" : "不合格"}</Pill>
            <span className="text-xs text-muted-foreground">
              ゴールガーディアン・{formatStamp(review.at)}
            </span>
          </p>
          {review.summary && <p className="break-words">{review.summary}</p>}
          {review.remarks.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">過去の指摘の再発</p>
              <ul className="flex flex-col gap-1.5">
                {review.remarks.map((r) => (
                  <li key={r.remarkId} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{r.remarkId}</span>
                    <Pill tone={r.notRecurred ? OK : NG}>
                      {r.notRecurred ? "再発なし" : "再発している"}
                    </Pill>
                    <span className="break-words">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
