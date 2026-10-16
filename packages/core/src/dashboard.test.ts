import { describe, expect, it } from "vitest";
import { DashboardStats, localDayStart, median, queueOverSince } from "./dashboard.js";
import type { ActivityEvent } from "./events.js";
import type { Task } from "./projection.js";

/**
 * テストの「今」（ローカルの 2026-10-16 12:00）。期間の境は、このマシンのローカルの日付で決まるので、日付の境は暦日から作り
 * （day）、固定の 24 時間の引き算では作らない（夏時間をまたぐと 0 時からずれる。PR #128 レビュー指摘）。経過時間の検査
 * （作成から完了まで）は、暦日とは別に 24 時間の単位（DAY）で作る。
 */
const NOW = new Date(2026, 9, 16, 12, 0, 0).getTime();
/** n 日前のローカルの 0 時。 */
const day = (n: number) => localDayStart(NOW, n);
const TODAY = day(0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let seq = 0;
function event(
  type: ActivityEvent["type"],
  at: number,
  payload: Record<string, unknown> = {},
  ids: { taskId?: string; projectId?: string } = {},
): ActivityEvent {
  seq += 1;
  return {
    seq,
    id: `e${seq}`,
    taskId: ids.taskId ?? "t1",
    projectId: ids.projectId ?? "p1",
    at: new Date(at).toISOString(),
    actor: "sacty",
    type,
    payload,
  } as ActivityEvent;
}

/** 集計に要る分だけのタスク（状態・工程・作成の時刻）。 */
function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    status: "running",
    steps: [{ key: "implement", state: "active" }],
    createdAt: new Date(TODAY - 2 * DAY).toISOString(),
    ...patch,
  } as Task;
}

const completed = (patch: Partial<Task> = {}) =>
  task({ status: "idle", steps: [{ key: "implement", state: "done" }], ...patch });
const cancelled = (patch: Partial<Task> = {}) => task({ status: "cancelled", ...patch });

type Input = Parameters<DashboardStats["summary"]>[0];
function summarize(
  stats: DashboardStats,
  input: Partial<Omit<Input, "queue">> & { queue?: Partial<Input["queue"]> } = {},
) {
  return stats.summary({
    now: NOW,
    timeZone: "Asia/Tokyo",
    projects: new Set(["p1", "p2"]),
    tasks: [],
    ...input,
    queue: { running: [], waiting: [], max: 3, ...input.queue },
  });
}

const cost = (at: number, usd: number, estimated = false, ids = {}) =>
  event("AgentRunCompleted", at, { costUsd: usd, estimated }, ids);

describe("ダッシュボードの集計：期間の境（PBI-118）", () => {
  it("今日と直近7日・30日は、ローカルの日付で区切る（今日を含む）", () => {
    expect(localDayStart(NOW, 0)).toBe(new Date(2026, 9, 16).getTime());
    expect(localDayStart(NOW, 6)).toBe(new Date(2026, 9, 10).getTime());
    expect(localDayStart(NOW, 29)).toBe(new Date(2026, 8, 17).getTime());
    // 月をまたいでも日付で数える
    expect(localDayStart(new Date(2026, 10, 2, 3).getTime(), 6)).toBe(
      new Date(2026, 9, 27).getTime(),
    );
    // 夏時間の切り替えをまたいでも、暦日の 0 時になる（固定の 24 時間の引き算と違う。TZ=Australia/Sydney では 2026-10-04 に切り替わる）
    const after = new Date(2026, 9, 10, 12).getTime();
    expect(new Date(localDayStart(after, 9)).getHours()).toBe(0);
    expect(new Date(localDayStart(after, 9)).getDate()).toBe(1);
  });

  it("中央値：空なら null、奇数個は真ん中、偶数個は真ん中2つの平均", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("ダッシュボードの集計：費用（PBI-118）", () => {
  it("何も無ければ 0", () => {
    const s = summarize(new DashboardStats());
    expect(s.costs.today).toEqual({ actualUsd: 0, estimatedUsd: 0 });
    expect(s.costs.days7).toEqual({ actualUsd: 0, estimatedUsd: 0 });
    expect(s.costs.since.today).toBe(new Date(TODAY).toISOString());
    expect(s.costs.since.days7).toBe(new Date(day(6)).toISOString());
    expect(s.timeZone).toBe("Asia/Tokyo");
  });

  it("今日の分は今日に、今日より前の7日の分は直近7日だけに入り、境の前は入らない", () => {
    const stats = new DashboardStats();
    const t = task();
    stats.add(cost(TODAY, 0.1), t, t); // 今日の 0:00 ちょうど
    stats.add(cost(TODAY - 1, 0.2), t, t); // 昨日の 23:59:59.999
    stats.add(cost(day(6), 0.4), t, t); // 7日の始まりちょうど
    stats.add(cost(day(6) - 1, 0.8), t, t); // 7日の境の前
    const s = summarize(stats);
    expect(s.costs.today.actualUsd).toBe(0.1);
    expect(s.costs.days7.actualUsd).toBe(0.7);
  });

  it("概算（サブスクリプションなどの換算値）と実請求を分けて足す。1件・複数件", () => {
    const stats = new DashboardStats();
    const t = task();
    stats.add(cost(NOW, 0.3, true), t, t);
    expect(summarize(stats).costs.today).toEqual({ actualUsd: 0, estimatedUsd: 0.3 });
    stats.add(cost(NOW, 0.1), t, t);
    stats.add(cost(NOW, 0.2), t, t);
    stats.add(cost(NOW, 0.4, true), t, t);
    // 浮動小数の誤差を丸めて足す（0.1 + 0.2）
    expect(summarize(stats).costs.today).toEqual({ actualUsd: 0.3, estimatedUsd: 0.7 });
  });

  it("費用を持つイベントの種類（CHARGED_EVENT_TYPES）だけを数え、0 の費用は持たない", () => {
    const stats = new DashboardStats();
    const t = task();
    stats.add(event("StepsChosen", NOW, { costUsd: 0.5, estimated: false }), t, t);
    stats.add(event("FinalReviewed", NOW, { costUsd: 0.25, estimated: false }), t, t);
    stats.add(cost(NOW, 0), t, t);
    // 費用の欄を持たないイベント
    stats.add(event("StepSubmitted", NOW, { step: "implement", submission: 1 }), t, t);
    expect(summarize(stats).costs.today.actualUsd).toBe(0.75);
  });

  it("消したプロジェクトのタスクの費用は数えない（プロジェクトが戻れば数える）", () => {
    const stats = new DashboardStats();
    const t = task();
    stats.add(cost(NOW, 0.1), t, t);
    stats.add(cost(NOW, 0.2, false, { projectId: "gone" }), t, t);
    expect(summarize(stats).costs.today.actualUsd).toBe(0.1);
    expect(summarize(stats, { projects: new Set(["gone"]) }).costs.today.actualUsd).toBe(0.2);
    expect(summarize(stats, { projects: new Set() }).costs.today.actualUsd).toBe(0);
  });
});

describe("ダッシュボードの集計：流量（PBI-118）", () => {
  it("何も無ければ 0 件で中央値は null", () => {
    const s = summarize(new DashboardStats());
    expect(s.flow.days7).toEqual({ completed: 0, cancelled: 0, medianLeadMs: null });
    expect(s.flow.days30).toEqual({ completed: 0, cancelled: 0, medianLeadMs: null });
    expect(s.flow.since.days30).toBe(new Date(day(29)).toISOString());
  });

  it("終わっていない状態から終わった状態になった記録の時刻で数え、完了と中止を分ける", () => {
    const stats = new DashboardStats();
    // 1件：完了（作成から 8 日 = 24 時間 × 8。経過時間は暦日と関係しない）
    const finishedA = TODAY - 2 * HOUR;
    const createdA = new Date(finishedA - 8 * DAY).toISOString();
    stats.add(
      event("StepApproved", finishedA, {}, { taskId: "a" }),
      task({ id: "a", createdAt: createdA }),
      completed({ id: "a", createdAt: createdA }),
    );
    let s = summarize(stats);
    expect(s.flow.days7).toEqual({ completed: 1, cancelled: 0, medianLeadMs: 8 * DAY });
    // 複数件：中止と、もう1件の完了（作成から 2 日）。中央値は完了の 2 件の平均
    stats.add(
      event("TaskCancelled", TODAY - HOUR, {}, { taskId: "b" }),
      task({ id: "b" }),
      cancelled({ id: "b" }),
    );
    const createdC = new Date(TODAY - 2 * DAY).toISOString();
    stats.add(
      event("StepApproved", TODAY, {}, { taskId: "c" }),
      task({ id: "c", createdAt: createdC }),
      completed({ id: "c", createdAt: createdC }),
    );
    s = summarize(stats);
    expect(s.flow.days7).toEqual({ completed: 2, cancelled: 1, medianLeadMs: 5 * DAY });
  });

  it("直近7日の境の前の分は直近30日だけに入り、30日の境の前は入らない", () => {
    const stats = new DashboardStats();
    const finish = (id: string, at: number) =>
      stats.add(event("StepApproved", at, {}, { taskId: id }), task({ id }), completed({ id }));
    finish("a", day(6));
    finish("b", day(6) - 1);
    finish("c", day(29));
    finish("d", day(29) - 1);
    const s = summarize(stats);
    expect(s.flow.days7.completed).toBe(1);
    expect(s.flow.days30.completed).toBe(3);
  });

  it("終わった後に終わっていない状態に戻れば（違う内容でマージされた後の監視など）数えず、また終われば新しい時刻で数える", () => {
    const stats = new DashboardStats();
    stats.add(event("PullRequestMerged", day(3)), task(), completed());
    stats.add(event("DeploymentWatchStarted", day(3)), completed(), task());
    expect(summarize(stats).flow.days7.completed).toBe(0);
    stats.add(event("DeploymentChecked", day(1)), task(), completed());
    expect(summarize(stats).flow.days7.completed).toBe(1);
  });

  it("終わったままのタスクに続く記録では、数え直さない（時刻は最初に終わったとき）", () => {
    const stats = new DashboardStats();
    stats.add(event("StepApproved", day(10)), task(), completed());
    stats.add(event("AgentSessionArchived", TODAY), completed(), completed());
    const s = summarize(stats);
    expect(s.flow.days7.completed).toBe(0);
    expect(s.flow.days30.completed).toBe(1);
  });

  it("消したプロジェクトのタスクは数えない", () => {
    const stats = new DashboardStats();
    stats.add(
      event("StepApproved", TODAY, {}, { projectId: "gone" }),
      task({ projectId: "gone" }),
      completed({ projectId: "gone" }),
    );
    expect(summarize(stats).flow.days7.completed).toBe(0);
  });
});

describe("ダッシュボードの集計：品質の信号（PBI-118）", () => {
  it("何も無ければすべて 0 回で、工程ごとの差し戻しは空", () => {
    const s = summarize(new DashboardStats());
    expect(s.quality.counts).toEqual({
      changesRequested: 0,
      pullRequestRework: 0,
      guardianMissed: 0,
      integrationFailed: 0,
      fixTask: 0,
    });
    expect(s.quality.reworkBySteps).toEqual({});
    expect(s.quality.since).toBe(new Date(day(29)).toISOString());
  });

  it("種類ごとに数え、差し戻しは承認ゲートの工程ごとにも数える", () => {
    const stats = new DashboardStats();
    const t = task();
    const add = (type: ActivityEvent["type"], payload: Record<string, unknown>, at = NOW) =>
      stats.add(event(type, at, payload), t, t);
    add("ChangesRequested", { step: "requirements", target: "requirements", round: 1 });
    add("ChangesRequested", { step: "implement", target: "design", round: 1 });
    add("GuardianMissed", { reviewAt: "", remarkIds: [] });
    add("IntegrationReviewed", { passed: false });
    add("IntegrationReviewed", { passed: true });
    add("DeploymentFixRegistered", { kind: "ci" });
    add("DeploymentFixSuppressed", { kind: "ci", reason: "duplicate" });
    const s = summarize(stats);
    expect(s.quality.counts).toEqual({
      changesRequested: 2,
      pullRequestRework: 0,
      guardianMissed: 1,
      integrationFailed: 1,
      fixTask: 1,
    });
    // 実装の PR から設計へ戻しても、差し戻された成果物は実装のもの（1 回）
    expect(s.quality.reworkBySteps).toEqual({ requirements: 1, implement: 1 });
  });

  it("PR の指摘の差し戻しは、実際に差し戻した記録を1回だけ数え、判断（ReworkJudged）だけでは数えない（PR #128 レビュー指摘）", () => {
    const stats = new DashboardStats();
    const t = task({ status: "awaiting_approval" });
    // ゴールガーディアンの判断 → 同じ記録で差し戻し（投影が prRework にこの記録の時刻を残す）
    stats.add(event("ReworkJudged", NOW - HOUR, { target: "design" }), t, t);
    const reworkAt = new Date(NOW).toISOString();
    const reworked = task({
      status: "queued",
      prRework: { target: "design", decided: true, reason: "", at: reworkAt },
    } as Partial<Task>);
    stats.add(
      {
        ...event("ChangesRequested", NOW, { step: "implement", target: "design", round: 1 }),
        at: reworkAt,
      },
      t,
      reworked,
    );
    let s = summarize(stats);
    expect(s.quality.counts.pullRequestRework).toBe(1);
    expect(s.quality.counts.changesRequested).toBe(0);
    expect(s.quality.reworkBySteps).toEqual({ implement: 1 });
    // 判断の後、上限でエスカレーションになり差し戻されなかった：数えない
    stats.add(event("ReworkJudged", NOW, { target: "implement" }, { taskId: "t2" }), t, t);
    stats.add(
      event(
        "TaskEscalated",
        NOW,
        { step: "implement", reason: "too_many_changes" },
        { taskId: "t2" },
      ),
      t,
      task({ id: "t2", status: "escalated" }),
    );
    s = summarize(stats);
    expect(s.quality.counts.pullRequestRework).toBe(1);
    expect(s.quality.counts.changesRequested).toBe(0);
    // 前の PR の差し戻しの記録（prRework）が残っていても、人が新しく差し戻したものは人の差し戻し
    stats.add(
      event("ChangesRequested", NOW + HOUR, { step: "implement", round: 2 }),
      reworked,
      reworked,
    );
    s = summarize(stats);
    expect(s.quality.counts).toMatchObject({ pullRequestRework: 1, changesRequested: 1 });
    expect(s.quality.reworkBySteps).toEqual({ implement: 2 });
  });

  it("直近30日の境の前の記録は数えない。消したプロジェクトも数えない", () => {
    const stats = new DashboardStats();
    const t = task();
    const payload = { step: "design", round: 1 };
    stats.add(event("ChangesRequested", day(29), payload), t, t);
    stats.add(event("ChangesRequested", day(29) - 1, payload), t, t);
    stats.add(event("ChangesRequested", NOW, payload, { projectId: "gone" }), t, t);
    const s = summarize(stats);
    expect(s.quality.counts.changesRequested).toBe(1);
    expect(s.quality.reworkBySteps).toEqual({ design: 1 });
  });
});

describe("ダッシュボードの集計：対応待ちの時刻と待ち行列（PBI-118）", () => {
  it("提出・一時停止・エスカレーションの最後の記録の時刻を、対応待ちのタスクにだけ返す", () => {
    const stats = new DashboardStats();
    const t = task();
    stats.add(event("StepSubmitted", day(3), { step: "design", submission: 1 }), t, t);
    stats.add(event("ChangesRequested", day(2), { step: "design", round: 1 }), t, t);
    stats.add(event("StepSubmitted", day(1), { step: "design", submission: 2 }), t, t);
    stats.add(event("TaskPaused", TODAY, { reason: "manual" }, { taskId: "t2" }), t, t);
    stats.add(event("TaskEscalated", NOW, { step: "implement" }, { taskId: "t3" }), t, t);
    stats.add(
      event("StepSubmitted", NOW, { step: "design", submission: 1 }, { taskId: "t4" }),
      t,
      t,
    );
    // 再現できなかった（判断待ち）は提出の記録が無いので、その確認の記録が起点。再現できたなら起点にしない
    stats.add(event("ReproductionChecked", TODAY, { reproduced: false }, { taskId: "t7" }), t, t);
    stats.add(event("ReproductionChecked", NOW, { reproduced: true }, { taskId: "t8" }), t, t);
    const s = summarize(stats, {
      tasks: [
        task({ id: "t1", status: "awaiting_approval" }),
        task({ id: "t2", status: "paused" }),
        task({ id: "t3", status: "escalated" }),
        // 実行中に戻ったタスクには返さない
        task({ id: "t4", status: "running" }),
        // 記録の無い対応待ち（画面が updatedAt で補う）
        task({ id: "t5", status: "awaiting_approval" }),
        // 消したプロジェクト
        task({ id: "t6", status: "paused", projectId: "gone" }),
        task({ id: "t7", status: "awaiting_approval" }),
        task({ id: "t8", status: "awaiting_approval" }),
      ],
    });
    expect(s.waitingSince).toEqual({
      t1: new Date(day(1)).toISOString(),
      t2: new Date(TODAY).toISOString(),
      t3: new Date(NOW).toISOString(),
      t7: new Date(TODAY).toISOString(),
    });
  });

  it("実行中と実行待ちは、ワーカーの処理中と処理の対象の ID で数える。消したプロジェクトと無いタスクは数えない", () => {
    const stats = new DashboardStats();
    expect(summarize(stats).queue).toEqual({ running: 0, queued: 0, max: 3 });
    const s = summarize(stats, {
      tasks: [
        task({ id: "a", status: "running" }),
        // 実装の後のテストの実行中（status は idle）も、ワーカーが処理していれば実行中
        task({ id: "b", status: "idle" }),
        task({ id: "c", status: "queued" }),
        task({ id: "d", status: "idle" }),
        task({ id: "e", status: "queued", projectId: "gone" }),
      ],
      queue: { running: ["a", "b"], waiting: ["c", "d", "e", "missing"], max: 2 },
    });
    expect(s.queue).toEqual({ running: 2, queued: 2, max: 2 });
  });

  it("実行待ちが上限より多い状態の始まりは、呼ぶ側が追った値をそのまま返す", () => {
    const stats = new DashboardStats();
    const earlier = NOW - 15 * 60_000;
    expect(summarize(stats, { queue: { overSince: earlier } }).queue.overSince).toBe(
      new Date(earlier).toISOString(),
    );
    expect(summarize(stats).queue.overSince).toBeUndefined();
  });

  it("queueOverSince：上限より多ければ前の始まり（無ければ今）、上限以下（同じ件数を含む）なら無い", () => {
    const earlier = NOW - 15 * 60_000;
    expect(queueOverSince(3, 3, NOW, undefined)).toBeUndefined();
    expect(queueOverSince(4, 3, NOW, undefined)).toBe(NOW);
    expect(queueOverSince(4, 3, NOW, earlier)).toBe(earlier);
    expect(queueOverSince(2, 3, NOW, earlier)).toBeUndefined();
    expect(queueOverSince(1, 0, NOW, undefined)).toBe(NOW);
  });

  it("持っておく期間より古い記録は、集計のときに捨てる（集計は変わらない）", () => {
    const stats = new DashboardStats();
    const t = task();
    stats.add(cost(day(40), 1), t, t);
    stats.add(event("GuardianMissed", day(40), { reviewAt: "", remarkIds: [] }), t, t);
    stats.add(event("StepApproved", day(40)), task(), completed());
    stats.add(cost(NOW, 0.5), t, t);
    const s = summarize(stats);
    expect(s.costs.days7.actualUsd).toBe(0.5);
    expect(s.flow.days30.completed).toBe(0);
    expect(s.quality.counts.guardianMissed).toBe(0);
  });

  it("畳み込みの中でも、記録の時刻で1日に1回、古い記録を捨てる（画面を開かなくても増え続けない。PR #128 レビュー指摘）", () => {
    const stats = new DashboardStats();
    const t = task();
    // 60 日前から毎日 1 件の費用を畳み込む
    for (let n = 60; n >= 0; n--) stats.add(cost(day(n) + HOUR, 0.01), t, t);
    const kept = (stats as unknown as { costs: unknown[] }).costs.length;
    // 32 日より古いものは、集計を呼ぶ前に捨てられている（33 日分 ± 捨てる間隔の 1 日）
    expect(kept).toBeLessThanOrEqual(34);
    expect(kept).toBeGreaterThanOrEqual(32);
    expect(summarize(stats).costs.days7.actualUsd).toBe(0.07);
  });
});
