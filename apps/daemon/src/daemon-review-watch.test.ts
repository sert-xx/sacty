import { join } from "node:path";
import { isDone, isFinished, reviewWatching, type Task } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { PullRequestFeedback } from "./github.js";
import { MemoryProjectStore } from "./projects.js";
import { FEEDBACK_QUIET_MS, type TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";
import { dbPath, dir, FakePulls, makeService, useTempDir } from "./testing/daemon.js";

useTempDir();

type Verdict = "changes_required" | "suggestions" | "no_findings";

const out = (text: string): AgentOutcome => ({
  kind: "completed",
  output: text,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
});
/** 判定つきのレビューの答え（判定が無ければ、判定のブロックを付けない）。 */
const review = (title: string, verdict?: Verdict) =>
  out(
    verdict
      ? `# ${title}\n\n\`\`\`json\n${JSON.stringify({ "sacty-review-verdict": { verdict } })}\n\`\`\``
      : `# ${title}`,
  );
const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  repo: "https://github.com/acme/app",
  number,
  title: `PR ${number}`,
  body: "本文",
  url: `https://github.com/acme/app/pull/${number}`,
  labels: ["sacty-review"] as string[],
  pullRequest: true,
  ...extra,
});
const HEAD_A = "a".repeat(40);
const HEAD_B = "b1".repeat(20);
const HEAD_C = "c2".repeat(20);
const MINUTE = 60_000;

/**
 * ラベルで取り込んだ PR 9 を、判定 verdicts[0] でレビューして投稿するところまで進める。PR の作者と sacty のレビューを投稿する
 * アカウントは、同じ（me）。時計は clock.now を進めて動かす。
 */
async function posted(
  verdicts: (Verdict | undefined)[],
  options: {
    author?: string;
    outputTokens?: number[];
    runMs?: number;
    draftTimeoutMs?: number;
    failPost?: string;
  } = {},
) {
  const clock = { now: Date.parse("2026-11-20T00:00:00.000Z") };
  const now = () => clock.now;
  const activity = new SqliteActivityStore(dbPath, () => new Date(now()));
  const pulls = new FakePulls();
  pulls.prInfo = {
    ...pulls.prInfo,
    number: 9,
    url: "https://github.com/acme/app/pull/9",
    headSha: HEAD_A,
    author: options.author ?? "me",
  };
  const settings = new MemorySettingsStore({ reviewLabel: "sacty-review", reviewRequested: true });
  const projects = new MemoryProjectStore();
  projects.put("default", {
    name: "デフォルト",
    targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
    githubAccounts: { "github.com": "me" },
  });
  const { service, executor } = makeService(
    activity,
    verdicts.map((v, i) => ({
      ...review(`${i + 1}回目`, v),
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: options.outputTokens?.[i] ?? 1 },
    })),
    {
      pulls,
      settings,
      projects,
      now,
      // 人が作るタスク（取り込みを通さないもの）には、レビューの工程だけを選ぶ
      planner: async () => ({
        steps: ["review"],
        plan: "review" as const,
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
      ...(options.draftTimeoutMs ? { draftTimeoutMs: options.draftTimeoutMs } : {}),
    },
  );
  if (options.failPost) pulls.reviewFail = options.failPost;
  const [task] = service.importIssues([pr(9)]);
  const id = task?.id ?? "";
  await service.runNext(id);
  // レビューの実行にかかった時間（対象を確かめてから、投稿するまで）
  clock.now += options.runMs ?? 0;
  await service.runNext(id);
  expect(pulls.reviews).toHaveLength(options.failPost ? 0 : 1);
  const get = () => service.get(id)?.task as Task;
  const events = (type: string) => (service.get(id)?.activity ?? []).filter((e) => e.type === type);
  /** 時計を進めて、PR の確認（60秒ごとの見回り）を 1 回行う。 */
  const tick = async (ms = MINUTE) => {
    clock.now += ms;
    await service.checkPullRequests();
  };
  /** 実行待ちになった再レビューを、実行して投稿する。 */
  const run = async () => {
    await service.runNext(id);
    await service.runNext(id);
  };
  return {
    activity,
    pulls,
    settings,
    projects,
    service,
    executor,
    id,
    clock,
    get,
    events,
    tick,
    run,
  };
}

/** PR に書かれたコメント（clock の時刻から ms 後）。 */
const comment = (
  clock: { now: number },
  key: string,
  author: string,
  body: string,
  ms = 0,
): PullRequestFeedback => ({
  key,
  kind: "comment",
  author,
  at: new Date(clock.now + ms).toISOString(),
  body,
});

const restarts = (service: TaskService, id: string) =>
  (service.get(id)?.activity ?? []).flatMap((e) =>
    e.type === "ReviewRestarted" ? [e.payload] : [],
  );

describe("レビューを投稿した後の、PR の変化の見守り（PBI-411）", () => {
  it.each([["changes_required" as const], ["suggestions" as const], [undefined]])(
    "判定が %s の投稿では完了にならず、PR の変化を見守る。実行待ちにも、人の出番にもならない",
    async (verdict) => {
      const { activity, service, id, get, tick } = await posted([verdict]);
      expect(get().status).toBe("idle");
      expect(reviewWatching(get())).toBe(true);
      expect(isFinished(get())).toBe(false);
      // 実行の枠を使わない（実行待ちに出ない）
      expect(service.queuedTaskIds()).not.toContain(id);
      // 先頭が同じ・返信も無ければ、何も始めない
      await tick();
      await tick(FEEDBACK_QUIET_MS);
      expect(restarts(service, id)).toEqual([]);
      expect(reviewWatching(get())).toBe(true);
      activity.close();
    },
  );

  it("判定が指摘なしなら、投稿で完了する。見守りの状態は持たない", async () => {
    const { activity, get } = await posted(["no_findings"]);
    expect(isDone(get())).toBe(true);
    expect(reviewWatching(get())).toBe(false);
    expect(get().reviewWatch).toBeUndefined();
    activity.close();
  });

  it("見守り中に PR の先頭が変わったら、静かになってから自動で再レビューを始める。同じ先頭では 1 回だけ（条件 3）", async () => {
    const { activity, pulls, service, id, get, tick, run } = await posted([
      "changes_required",
      "suggestions",
      "suggestions",
    ]);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    // 初めて見た確認では、まだ始めない（続けての push を待つ）
    await tick();
    expect(restarts(service, id)).toEqual([]);
    await tick(FEEDBACK_QUIET_MS - 1);
    expect(restarts(service, id)).toEqual([]);
    await tick(1);
    expect(restarts(service, id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    expect(get().status).toBe("queued");
    expect(get().reviewRound).toBe(2);
    // 始めた再レビューが実行される前の確認で、重ねて始めない
    await tick(FEEDBACK_QUIET_MS * 2);
    expect(restarts(service, id)).toHaveLength(1);
    await run();
    expect(pulls.reviews).toHaveLength(2);
    expect(pulls.reviews[1]?.commit).toBe(HEAD_B);
    // 提案ありなので、また見守る。同じ先頭では、何度確認しても始めない
    expect(reviewWatching(get())).toBe(true);
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toHaveLength(1);
    activity.close();
  });

  it("対象の先頭を読み違えて、レビューした先頭が今の先頭と違うままでも、同じ先頭の再レビューは 1 回だけ", async () => {
    const { activity, pulls, service, id, tick, run } = await posted([
      "suggestions",
      "suggestions",
      "suggestions",
    ]);
    // 状態の確認は B を返すが、レビューの対象の確認は A のまま（読み違え）
    pulls.states[9] = { state: "open", headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toHaveLength(1);
    await run();
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toHaveLength(1);
    activity.close();
  });

  it("続けての push は、最後の push から静かになるまで待って、1 回にまとめる（条件 5）", async () => {
    const { activity, pulls, service, id, tick, run } = await posted([
      "suggestions",
      "suggestions",
    ]);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS - MINUTE);
    // 待っている間に、もう一度 push された：待ち直す
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_C };
    await tick();
    await tick(FEEDBACK_QUIET_MS - MINUTE);
    expect(restarts(service, id)).toEqual([]);
    await tick();
    expect(restarts(service, id)).toEqual([{ reason: "pushed", commit: HEAD_C }]);
    await run();
    expect(pulls.reviews).toHaveLength(2);
    expect(pulls.reviews[1]?.commit).toBe(HEAD_C);
    activity.close();
  });

  it("再レビューの実行中に来た push は、重ねて始めず、投稿の後に拾う（条件 5）", async () => {
    const { activity, pulls, service, id, get, tick, run } = await posted([
      "suggestions",
      "suggestions",
      "no_findings",
    ]);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toHaveLength(1);
    // レビューの実行（対象は B）が終わって、投稿の前に、C が push された
    await service.runNext(id);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_C };
    await tick(FEEDBACK_QUIET_MS * 2);
    expect(restarts(service, id)).toHaveLength(1);
    await service.runNext(id);
    expect(pulls.reviews[1]?.commit).toBe(HEAD_B);
    expect(get().reviewPost?.latestCommit).toBe(HEAD_C);
    // 投稿の後の確認で、C を拾う
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([
      { reason: "pushed", commit: HEAD_B },
      { reason: "pushed", commit: HEAD_C },
    ]);
    await run();
    expect(pulls.reviews[2]?.commit).toBe(HEAD_C);
    expect(isDone(get())).toBe(true);
    activity.close();
  });

  it("見守り中に、push 無しで作者が返信したら、同じ先頭を 1 回だけ判定し直す（条件 4）", async () => {
    const { activity, pulls, service, id, clock, get, tick, run } = await posted([
      "changes_required",
      "changes_required",
    ]);
    // 作者（sacty の投稿と同じアカウント）が、目印の無いコメントで反論した
    pulls.feedbackList = [comment(clock, "comment:1", "me", "これは直しません。理由は…", MINUTE)];
    await tick(MINUTE);
    expect(restarts(service, id)).toEqual([]);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "replied", commit: HEAD_A }]);
    await run();
    expect(pulls.reviews).toHaveLength(2);
    expect(pulls.reviews[1]?.commit).toBe(HEAD_A);
    expect(reviewWatching(get())).toBe(true);
    // 同じ先頭への返信が続いても、判定のし直しは 1 回だけ
    pulls.feedbackList = [
      ...pulls.feedbackList,
      comment(clock, "comment:2", "me", "やはり直しません", MINUTE),
    ];
    await tick(MINUTE);
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toHaveLength(1);
    activity.close();
  });

  it("続けての返信は、最後の返信から静かになるまで待って、1 回にまとめる（条件 5）", async () => {
    const { activity, pulls, service, id, clock, tick } = await posted([
      "changes_required",
      "suggestions",
    ]);
    pulls.feedbackList = [comment(clock, "comment:1", "me", "1つ目の返信", MINUTE)];
    await tick(MINUTE);
    await tick(FEEDBACK_QUIET_MS - MINUTE);
    pulls.feedbackList = [...pulls.feedbackList, comment(clock, "comment:2", "me", "2つ目の返信")];
    await tick(MINUTE);
    expect(restarts(service, id)).toEqual([]);
    await tick(FEEDBACK_QUIET_MS - MINUTE);
    expect(restarts(service, id)).toHaveLength(1);
    activity.close();
  });

  it("sacty 自身の投稿・知らせ、作者でない人の投稿、対象を確かめる前の投稿では、判定し直さない（条件 4。Bot の投稿は、PR の読み取りが除く）", async () => {
    const { activity, pulls, service, id, clock, get, tick } = await posted(["changes_required"]);
    const round1 = `<!-- sacty-review:${id} -->`;
    pulls.feedbackList = [
      // sacty のレビューの本文と行へのコメント（作者と同じアカウントが投稿する）
      { ...comment(clock, "review:1", "me", `${round1}\n# 1回目`, MINUTE), kind: "review" },
      {
        ...comment(clock, "review_comment:1", "me", `${round1}\n[要修正] 上限が無い`, MINUTE),
        kind: "review_comment",
        path: "src/a.ts",
        line: 1,
      },
      // ほかの sacty のレビューのタスクの投稿（このデーモンが知らない目印）
      comment(clock, "review:2", "me", "<!-- sacty-review:other-task:3 -->\n# 総評", MINUTE),
      // sacty の知らせ
      comment(
        clock,
        "comment:3",
        "me",
        "<!-- sacty-review-stopped:x:error -->\n止まりました",
        MINUTE,
      ),
      comment(clock, "comment:4", "me", "<!-- sacty-human-ask:x:implement:1 -->\n確認", MINUTE),
      comment(clock, "comment:5", "me", "<!-- sacty-deferral:x:1 -->\n決定", MINUTE),
      comment(
        clock,
        "comment:51",
        "me",
        "<!-- sacty-rework-notice:x:1 -->\n設計に戻しました",
        MINUTE,
      ),
      // マージを承認として扱った知らせと、扱わなかった知らせ（PBI-462）。作者（me）の投稿でも、目印だけで返信から外す
      comment(
        clock,
        "comment:52",
        "me",
        "<!-- sacty-merge-approval:x:8 -->\n承認として扱いました",
        MINUTE,
      ),
      comment(
        clock,
        "comment:53",
        "me",
        "<!-- sacty-merge-not-approved:x:8 -->\n承認として扱っていません",
        MINUTE,
      ),
      comment(clock, "comment:6", "me", "<!-- sacty-comment:x -->\nコメント", MINUTE),
      // 作者でない人のコメント
      comment(clock, "comment:7", "bob", "横から失礼します", MINUTE),
      // 対象を確かめる前に、作者が書いたコメント
      comment(clock, "comment:8", "me", "レビューをお願いします", -10 * MINUTE),
    ];
    await tick(MINUTE);
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([]);
    expect(reviewWatching(get())).toBe(true);
    // 返信を探すときは、この PR をレビューした sacty のタスクのどの回も、指摘として含めない
    expect(pulls.feedbackSactyRounds.at(-1)?.every((r) => !r.allowed)).toBe(true);
    activity.close();
  });

  it("指摘なしで完了した後は、PR の先頭が変わっても、作者が返信しても、自動では何も始めない（PR を読みに行かない）。人が「再レビュー」した回が指摘なしでなければ、また見守る", async () => {
    const { activity, pulls, service, id, clock, get, tick, run } = await posted([
      "no_findings",
      "suggestions",
      "suggestions",
    ]);
    expect(isDone(get())).toBe(true);
    const before = service.get(id)?.activity.length;
    const checked = pulls.checked.length;
    const read = pulls.feedbackNumbers.length;
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    pulls.feedbackList = [comment(clock, "comment:1", "me", "ありがとうございます", MINUTE)];
    await tick(MINUTE);
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([]);
    expect(isDone(get())).toBe(true);
    expect(service.get(id)?.activity).toHaveLength(before ?? -1);
    // 完了したタスクの PR は、状態もコメントも読みに行かない
    expect(pulls.checked).toHaveLength(checked);
    expect(pulls.feedbackNumbers).toHaveLength(read);
    expect(service.queuedTaskIds()).not.toContain(id);
    // 人が「再レビュー」して、その回の判定が指摘なしでなければ、また見守りに入り、PR の変化で再レビューする
    pulls.feedbackList = [];
    service.rereview(id);
    await run();
    expect(pulls.reviews.at(-1)?.commit).toBe(HEAD_B);
    expect(reviewWatching(get())).toBe(true);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_C };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id).at(-1)).toEqual({ reason: "pushed", commit: HEAD_C });
    activity.close();
  });

  it.each([["merged" as const], ["closed" as const]])(
    "見守り中に PR が %s になったら、中止ではなく完了になり、理由が作業履歴に残る（条件 7）",
    async (state) => {
      const { activity, pulls, service, id, get, events, tick } = await posted([
        "changes_required",
      ]);
      pulls.state = { state };
      await tick();
      expect(get().status).toBe("idle");
      expect(isDone(get())).toBe(true);
      expect(get().reviewWatchEnded?.reason).toBe(state);
      expect(events("ReviewWatchEnded").map((e) => e.payload)).toEqual([{ reason: state }]);
      expect(events("TaskCancelled")).toEqual([]);
      // 終えた後は、確認のたびに記録しない・PR を読みに行かない
      const checked = pulls.checked.length;
      await tick();
      await tick();
      expect(events("ReviewWatchEnded")).toHaveLength(1);
      expect(pulls.checked).toHaveLength(checked);
      // 人の「再レビュー」は、完了の後も使える
      expect(service.rereview(id).status).toBe("queued");
      activity.close();
    },
  );

  it("指摘なしで完了した後に PR がマージ・クローズされても、完了のまま、何も記録しない", async () => {
    const { activity, pulls, get, events, tick } = await posted(["no_findings"]);
    const checked = pulls.checked.length;
    pulls.state = { state: "merged" };
    await tick();
    await tick();
    expect(isDone(get())).toBe(true);
    expect(events("ReviewWatchEnded")).toEqual([]);
    expect(events("TaskCancelled")).toEqual([]);
    expect(pulls.checked).toHaveLength(checked);
    activity.close();
  });

  it("レビューの実行中（投稿の前）に PR がマージされたら、今までどおり中止する（条件 7）", async () => {
    const { activity, pulls, service, id, get, events, tick } = await posted([
      "changes_required",
      "suggestions",
    ]);
    service.rereview(id);
    pulls.state = { state: "merged" };
    await tick();
    expect(get().status).toBe("cancelled");
    const cancelled = events("TaskCancelled")[0];
    expect(cancelled?.type === "TaskCancelled" && cancelled.payload.reason).toBe(
      "pull_request_merged",
    );
    expect(events("ReviewWatchEnded")).toEqual([]);
    activity.close();
  });

  it("見守り中に一時停止すると、PR が変わっても始めない。再開すると見守りに戻り、止めていた間の変化を拾う", async () => {
    const { activity, pulls, service, id, get, tick } = await posted([
      "suggestions",
      "suggestions",
    ]);
    await service.pause(id);
    expect(get().status).toBe("paused");
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([]);
    service.resume(id, {});
    expect(get().status).toBe("idle");
    expect(reviewWatching(get())).toBe(true);
    expect(service.queuedTaskIds()).not.toContain(id);
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    activity.close();
  });

  it("見守り中のタスクは、人が中止できる。中止の後は、PR が変わっても何もしない", async () => {
    const { activity, pulls, service, id, get, tick } = await posted([
      "suggestions",
      "suggestions",
    ]);
    await service.cancel(id);
    expect(get().status).toBe("cancelled");
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    const checked = pulls.checked.length;
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([]);
    expect(pulls.checked).toHaveLength(checked);
    activity.close();
  });

  it("デーモンを起動し直しても見守りは続く。静かになるまでの待ちは、起動の後に数え直す", async () => {
    const first = await posted(["suggestions", "suggestions"]);
    first.pulls.prInfo = { ...first.pulls.prInfo, headSha: HEAD_B };
    await first.tick();
    // 起動し直す（作業履歴から状態を作り直す。初めて見た時刻は、メモリーにしか無い）
    const { service } = makeService(first.activity, [review("2回目", "suggestions")], {
      pulls: first.pulls,
      settings: first.settings,
      projects: first.projects,
      now: () => first.clock.now,
    });
    const task = () => service.get(first.id)?.task as Task;
    expect(reviewWatching(task())).toBe(true);
    first.clock.now += FEEDBACK_QUIET_MS;
    await service.checkPullRequests();
    expect(restarts(service, first.id)).toEqual([]);
    first.clock.now += FEEDBACK_QUIET_MS;
    await service.checkPullRequests();
    expect(restarts(service, first.id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    first.activity.close();
  });

  it("PR の状態を読めない・先頭を読めない確認では、何も決めない（次の確認でやり直す）", async () => {
    const { activity, pulls, service, id, get, tick } = await posted([
      "suggestions",
      "suggestions",
    ]);
    pulls.statusFail = "boom";
    await tick();
    expect(reviewWatching(get())).toBe(true);
    pulls.statusFail = undefined;
    pulls.states[9] = { state: "open", headSha: "" };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([]);
    activity.close();
  });

  it("投稿から時間がたった PR は、間を空けて読む。変化を見つけたら、静かになるまでは毎回読む", async () => {
    const { activity, pulls, service, id, clock, tick } = await posted([
      "suggestions",
      "suggestions",
    ]);
    const reads = () => pulls.checked.filter((c) => c.number === 9).length;
    const HOUR = 60 * MINUTE;
    // 投稿から 1 時間までは、確認のたびに読む
    let before = reads();
    for (let i = 0; i < 5; i++) await tick();
    expect(reads()).toBe(before + 5);
    // 1 時間を過ぎたら、5 分ごと
    clock.now += HOUR;
    await service.checkPullRequests();
    before = reads();
    for (let i = 0; i < 10; i++) await tick();
    expect(reads()).toBe(before + 2);
    // 24 時間を過ぎたら、30 分ごと
    clock.now += 24 * HOUR;
    await service.checkPullRequests();
    before = reads();
    for (let i = 0; i < 60; i++) await tick();
    expect(reads()).toBe(before + 2);
    // 先頭の変化を見つけたら、静かになるまでは毎回読み、待ちが明けたら再レビューを始める
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick(30 * MINUTE);
    before = reads();
    await tick();
    await tick();
    expect(reads()).toBe(before + 2);
    expect(restarts(service, id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    activity.close();
  });

  it("PR の状態を読めなかった確認は、読んだことにしない。間を空けて読む PR でも、次の確認で読み直す", async () => {
    const { activity, pulls, service, clock, get, tick } = await posted(["suggestions"]);
    const reads = () => pulls.checked.filter((c) => c.number === 9).length;
    // 投稿から 1 時間を過ぎた（5 分ごとに読む）。読めた確認の後は、5 分たつまで読まない
    clock.now += 61 * MINUTE;
    await service.checkPullRequests();
    let before = reads();
    await tick();
    expect(reads()).toBe(before);
    // 5 分たった確認で、読めなかった
    pulls.statusFail = "boom";
    await tick(5 * MINUTE);
    expect(reads()).toBe(before + 1);
    // 次の確認（1 分後）で、読み直す。その間にマージされていれば、遅れずに完了にする
    pulls.statusFail = undefined;
    pulls.state = { state: "merged" };
    before = reads();
    await tick();
    expect(reads()).toBe(before + 1);
    expect(isDone(get())).toBe(true);
    activity.close();
  });

  it("続けて読めない PR は、読めたときと同じ間隔を空けて読む（読めないままの PR を、毎分読んで警告を出し続けない）", async () => {
    const { activity, pulls, service, clock, tick } = await posted(["suggestions"]);
    const reads = () => pulls.checked.filter((c) => c.number === 9).length;
    clock.now += 61 * MINUTE;
    await service.checkPullRequests();
    pulls.statusFail = "boom";
    await tick(5 * MINUTE);
    // 1 回目の失敗の次の確認では、読み直す。2 回続けて読めなければ、5 分の間隔を空ける
    let before = reads();
    await tick();
    expect(reads()).toBe(before + 1);
    before = reads();
    for (let i = 0; i < 4; i++) await tick();
    expect(reads()).toBe(before);
    await tick();
    expect(reads()).toBe(before + 1);
    activity.close();
  });

  it("答えの返らない PR の状態・コメントの読み取りは、期限で打ち切って確認を終え、次の確認で読み直す。コメントの通信は中断する", async () => {
    const { activity, pulls, service, id, clock, get, tick } = await posted(
      ["changes_required", "suggestions"],
      { draftTimeoutMs: 20 },
    );
    // PR の状態の答えが返らない
    const status = vi.spyOn(pulls, "status").mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await tick();
    expect(warn.mock.calls.flat().join("\n")).toContain(`レビューのタスク ${id} の PR #9`);
    status.mockRestore();
    // コメントの答えが返らない：期限で打ち切り、通信を中断する
    pulls.feedbackList = [comment(clock, "comment:1", "me", "直しません", MINUTE)];
    let signal: AbortSignal | undefined;
    const feedback = vi
      .spyOn(pulls, "feedback")
      .mockImplementation((input: { signal?: AbortSignal }) => {
        signal = input.signal;
        return new Promise(() => {});
      });
    await tick(2 * MINUTE);
    expect(signal?.aborted).toBe(true);
    expect(warn.mock.calls.flat().join("\n")).toContain("見守りを進められませんでした");
    feedback.mockRestore();
    warn.mockRestore();
    // 次の確認で読み直して、返信を拾う
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "replied", commit: HEAD_A }]);
    expect(reviewWatching(get())).toBe(false);
    activity.close();
  });

  it("消したプロジェクトのタスクは、見守らない（PR を読みに行かない）", async () => {
    const { activity, pulls, projects, service, tick } = await posted(["suggestions"]);
    projects.delete("default");
    const checked = pulls.checked.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await tick();
    await tick();
    expect(pulls.checked).toHaveLength(checked);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    void service;
    activity.close();
  });

  it("再レビューを始めた後に別の先頭をレビューし、その後に元の先頭へ戻されたら、その先頭を再レビューする（古い歯止めで、レビューしないままにしない）", async () => {
    const { activity, pulls, service, id, get, tick, run } = await posted([
      "suggestions",
      "suggestions",
      "suggestions",
    ]);
    // B の push で再レビューを始めたが、実行の前に C が push され、C をレビューした
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_C };
    await run();
    expect(get().reviewTarget?.headCommit).toBe(HEAD_C);
    expect(get().reviewRestartCommit).toBe(HEAD_B);
    // force push で B に戻された：B は、まだレビューしていない
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([
      { reason: "pushed", commit: HEAD_B },
      { reason: "pushed", commit: HEAD_B },
    ]);
    await run();
    expect(get().reviewTarget?.headCommit).toBe(HEAD_B);
    // B をレビューした後は、繰り返さない
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toHaveLength(2);
    activity.close();
  });

  it("予算の上限を超える実行で終えたレビューも、止まらずに投稿する。次の再レビューは実行の前に予算で止まり、上限を上げて再開するとその時点の先頭をレビューする。回数の上限は無い（PBI-418 条件 1・2・3）", async () => {
    // 1 回目のレビューが、その実行で初めて予算（1 ドル）を超える
    const { activity, pulls, service, id, get, tick } = await posted(
      ["changes_required", "suggestions", "suggestions"],
      { outputTokens: [70_000, 1, 1] },
    );
    // 投稿された。一時停止せず、PR の変化を見守る
    expect(pulls.reviews).toHaveLength(1);
    expect(get().reviewPost).toBeDefined();
    expect(get().status).toBe("idle");
    expect(reviewWatching(get())).toBe(true);
    // PR が変わると再レビューを始めるが、実行の前に予算で止まる（レビューしない）
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    await service.runNext(id);
    expect(get().status).toBe("paused");
    expect(get().pausedReason).toBe("budget");
    expect(pulls.reviews).toHaveLength(1);
    // 止まっている間は、PR が変わっても始めない
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_C };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toHaveLength(1);
    // 上限を上げずには再開できない。上げて再開すると、その時点の先頭（C）をレビューして投稿し、見守りに戻る
    expect(() => service.resume(id, {})).toThrow(/新しい上限が必要/);
    service.resume(id, { capUsd: 5 });
    for (let i = 0; i < 4 && pulls.reviews.length < 2; i++) await service.runNext(id);
    expect(pulls.reviews).toHaveLength(2);
    expect(get().status).toBe("idle");
    expect(reviewWatching(get())).toBe(true);
    expect(get().reviewTarget?.headCommit).toBe(HEAD_C);
    activity.close();
  });

  it("予算の上限を超える実行で終えたレビューの判定が指摘なしなら、投稿して完了する（PBI-418 条件 2）", async () => {
    const { activity, pulls, get } = await posted(["no_findings"], { outputTokens: [70_000] });
    expect(pulls.reviews).toHaveLength(1);
    expect(isDone(get())).toBe(true);
    expect(reviewWatching(get())).toBe(false);
    activity.close();
  });

  it("予算の上限を超える実行の後の投稿に失敗したら、理由つきで止まり、上限を上げずに再開すると、レビューをやり直さず投稿からやり直す（PBI-418 条件 4）", async () => {
    const { activity, pulls, service, executor, id, get } = await posted(["changes_required"], {
      outputTokens: [70_000],
      failPost: "GitHub に届かない",
    });
    expect(get().status).toBe("paused");
    expect(get().pausedReason).toBe("error");
    expect(
      (service.get(id)?.activity ?? []).some((e) =>
        JSON.stringify(e).includes("GitHub に届かない"),
      ),
    ).toBe(true);
    const runs = executor.calls.length;
    pulls.reviewFail = undefined;
    service.resume(id, {});
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(executor.calls.length).toBe(runs);
    expect(get().reviewPost).toBeDefined();
    activity.close();
  });

  it("この版より前に、投稿の前に予算で止まったタスクは、上限を上げて再開すると、レビューをやり直さず投稿する（PBI-418 条件 6）", async () => {
    const { activity, pulls, service, executor, id, get } = await posted(["changes_required"], {
      outputTokens: [70_000],
      failPost: "GitHub に届かない",
    });
    // 投稿の前（未投稿）に、予算で一時停止した状態にする
    pulls.reviewFail = undefined;
    service.resume(id, {});
    (service as unknown as { append: (t: unknown, e: unknown[]) => void }).append(get(), [
      { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
    ]);
    expect(get().status).toBe("paused");
    expect(get().pausedReason).toBe("budget");
    expect(get().reviewPost).toBeUndefined();
    const runs = executor.calls.length;
    expect(() => service.resume(id, {})).toThrow(/新しい上限が必要/);
    service.resume(id, { capUsd: 5 });
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(get().reviewPost).toBeDefined();
    expect(executor.calls.length).toBe(runs);
    activity.close();
  });

  it("上限を超える実行の途中で人が一時停止を頼んだら、投稿しない（PBI-418 条件 5）", async () => {
    const { activity, pulls, service, executor, id, get } = await posted(["changes_required"], {
      outputTokens: [70_000],
      failPost: "GitHub に届かない",
    });
    pulls.reviewFail = undefined;
    service.resume(id, {});
    const runs = executor.calls.length;
    const paused = service.pause(id);
    await service.runNext(id);
    await paused;
    expect(pulls.reviews).toHaveLength(0);
    expect(get().reviewPost).toBeUndefined();
    expect(executor.calls.length).toBe(runs);
    activity.close();
  });

  it("作者の返信で判定し直す回には、対象を確かめた後・投稿の前に書かれた返信も作者の返答として渡し、判定し直す回であることを伝える", async () => {
    const { activity, pulls, service, executor, id, tick } = await posted(
      ["changes_required", "suggestions", "suggestions"],
      { author: "alice", runMs: 10 * MINUTE },
    );
    const at = (iso: string | undefined) => Date.parse(iso ?? "");
    const task = service.get(id)?.task as Task;
    const resolved = at(task.reviewWatch?.since);
    const postedAt = at(task.reviewPost?.at);
    expect(postedAt - resolved).toBe(10 * MINUTE);
    // 対象を確かめた後・投稿の前（レビューの実行中）に、作者が返信していた
    pulls.feedbackList = [
      {
        key: "comment:1",
        kind: "comment",
        author: "alice",
        at: new Date(resolved + 5 * MINUTE).toISOString(),
        body: "上限は呼び出し側で決めているので、ここでは直しません",
      },
    ];
    await tick(MINUTE);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "replied", commit: HEAD_A }]);
    await service.runNext(id);
    const prompt = executor.calls.at(-1)?.command.join(" ") ?? "";
    expect(prompt).toContain(
      "今回は、前回と同じ先頭のコミットを判定し直す回。PR の作者は、コードを変えずに、前回の指摘に返信した",
    );
    const data = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"previousReview"')) ?? "{}",
    );
    expect(data.authorReplies.map((r: { body: string }) => r.body)).toEqual([
      "上限は呼び出し側で決めているので、ここでは直しません",
    ]);
    await service.runNext(id);
    // その後の push による再レビューには、判定し直す回の指示を足さない
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    await service.runNext(id);
    expect(executor.calls.at(-1)?.command.join(" ")).not.toContain(
      "コードを変えずに、前回の指摘に返信した",
    );
    activity.close();
  });

  it("PR が更新されていなければ、コメントを読み直さない", async () => {
    const { activity, pulls, service, id, clock, tick } = await posted([
      "changes_required",
      "suggestions",
    ]);
    const reads = () => pulls.feedbackNumbers.filter((n) => n === 9).length;
    pulls.states[9] = { state: "open", headSha: HEAD_A, updatedAt: "2026-11-20T00:10:00Z" };
    const before = reads();
    await tick();
    expect(reads()).toBe(before + 1);
    await tick();
    await tick();
    expect(reads()).toBe(before + 1);
    // 作者が返信して、PR が更新された
    pulls.feedbackList = [comment(clock, "comment:1", "me", "直しません")];
    pulls.states[9] = { state: "open", headSha: HEAD_A, updatedAt: "2026-11-20T00:20:00Z" };
    await tick();
    expect(reads()).toBe(before + 2);
    // 待っている返信があるときは、更新が無くても読んで確かめる
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "replied", commit: HEAD_A }]);
    activity.close();
  });
});

describe("取り込みを通さずに、人が作ったレビューのタスク（本文に PR の URL。source 無し）の見守り（PBI-411）", () => {
  /** 人の PR 9 をレビューするタスクを人が作り、判定 verdicts[0] で投稿するところまで進める。 */
  async function manual(verdicts: Verdict[]) {
    const clock = { now: Date.parse("2026-11-20T00:00:00.000Z") };
    const activity = new SqliteActivityStore(dbPath, () => new Date(clock.now));
    const pulls = new FakePulls();
    pulls.prInfo = {
      ...pulls.prInfo,
      number: 9,
      url: "https://github.com/acme/app/pull/9",
      headSha: HEAD_A,
      author: "alice",
    };
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    });
    const { service } = makeService(
      activity,
      verdicts.map((v, i) => review(`${i + 1}回目`, v)),
      {
        pulls,
        projects,
        now: () => clock.now,
        planner: async () => ({
          steps: ["review"],
          plan: "review" as const,
          fallback: false,
          costUsd: 0,
          estimated: false,
        }),
      },
    );
    const { id } = service.createTask({
      projectId: "default",
      title: "PR 9 のレビュー",
      body: "https://github.com/acme/app/pull/9 をレビューする",
    });
    for (let i = 0; i < 6 && !service.get(id)?.task.reviewPost; i++) await service.runNext(id);
    const get = () => service.get(id)?.task as Task;
    expect(get().source).toBeUndefined();
    expect(get().reviewPost).toBeDefined();
    const tick = async (ms = MINUTE) => {
      clock.now += ms;
      await service.checkPullRequests();
    };
    return { activity, pulls, service, id, get, tick };
  }

  it("指摘なしでなければ見守り、PR の先頭が変われば再レビューを始め、PR がマージされたら完了する（見守りのまま残らない）", async () => {
    const { activity, pulls, service, id, get, tick } = await manual([
      "suggestions",
      "suggestions",
    ]);
    expect(reviewWatching(get())).toBe(true);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    for (let i = 0; i < 4 && !get().reviewPost; i++) await service.runNext(id);
    expect(reviewWatching(get())).toBe(true);
    pulls.state = { state: "merged" };
    await tick();
    expect(isDone(get())).toBe(true);
    expect(get().reviewWatchEnded?.reason).toBe("merged");
    activity.close();
  });
});

describe("同じ PR を見守るレビューのタスクが 2 つあるとき（PBI-411）", () => {
  it("取り込んだ PR を、人が作ったレビューのタスクでもレビューしたら、PR の変化では、後に作ったタスクだけが再レビューする。後のタスクを中止したら、前のタスクが再レビューする", async () => {
    const base = await posted(["suggestions", "suggestions", "suggestions", "suggestions"]);
    const { activity, pulls, service, id, clock, tick } = base;
    // 後から、人が、同じ PR をレビューするタスクを作る（対象リポジトリの PR の URL を本文に書く）
    clock.now += MINUTE;
    const manual = service.createTask({
      projectId: "default",
      title: "PR 9 をもう一度見る",
      body: "https://github.com/acme/app/pull/9 をレビューする",
    });
    for (let i = 0; i < 8 && !service.get(manual.id)?.task.reviewPost; i++) {
      await service.runNext(manual.id);
    }
    const second = service.get(manual.id)?.task as Task;
    expect(second.reviewPost).toBeDefined();
    expect(reviewWatching(second)).toBe(true);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B };
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([]);
    expect(restarts(service, manual.id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    // 後のタスクを中止したら、前のタスクが引き継ぐ
    await service.cancel(manual.id);
    await tick();
    await tick(FEEDBACK_QUIET_MS);
    expect(restarts(service, id)).toEqual([{ reason: "pushed", commit: HEAD_B }]);
    activity.close();
  });
});

describe("更新の前に完了していたレビューのタスク（PBI-411 条件 10）", () => {
  it.each([["changes_required" as const], ["suggestions" as const], [undefined]])(
    "更新の前の版が判定 %s で投稿して完了したタスクは、更新の後も完了のまま。PR の先頭が変わっても、作者が返信しても、PR が閉じられても、再レビューも記録も始まらず、PR を読みにも行かない",
    async (verdict) => {
      const first = await posted([verdict]);
      // 更新の前の版の作業履歴にする：投稿の記録から、見守りの印（watch）を除いて、別の DB に写す（作業履歴は追記だけ）
      first.activity.close();
      const { DatabaseSync } = await import("node:sqlite");
      const oldPath = join(dir, "before-update.db");
      new SqliteActivityStore(oldPath).close();
      const source = new DatabaseSync(dbPath);
      const rows = source.prepare("SELECT * FROM activity ORDER BY seq").all() as Record<
        string,
        string
      >[];
      source.close();
      const old = new DatabaseSync(oldPath);
      const insert = old.prepare(
        "INSERT INTO activity (id, task_id, project_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      let stripped = 0;
      for (const row of rows) {
        let payload = row.payload ?? "";
        if (row.type === "PullRequestReviewPosted") {
          const { watch, ...rest } = JSON.parse(payload) as Record<string, unknown>;
          expect(watch).toBe(true);
          payload = JSON.stringify(rest);
          stripped += 1;
        }
        insert.run(
          row.id ?? "",
          row.task_id ?? "",
          row.project_id ?? "",
          row.at ?? "",
          row.actor ?? "",
          row.type ?? "",
          payload,
        );
      }
      old.close();
      expect(stripped).toBe(1);
      const activity = new SqliteActivityStore(oldPath, () => new Date(first.clock.now));
      const { service } = makeService(activity, [review("2回目", "suggestions")], {
        pulls: first.pulls,
        settings: first.settings,
        projects: first.projects,
        now: () => first.clock.now,
      });
      const task = () => service.get(first.id)?.task as Task;
      expect(isDone(task())).toBe(true);
      expect(reviewWatching(task())).toBe(false);
      expect(task().reviewWatch).toBeUndefined();
      const before = service.get(first.id)?.activity.length;
      const checked = first.pulls.checked.length;
      const tick = async (ms: number) => {
        first.clock.now += ms;
        await service.checkPullRequests();
      };
      first.pulls.prInfo = { ...first.pulls.prInfo, headSha: HEAD_B };
      first.pulls.feedbackList = [comment(first.clock, "comment:1", "me", "直しません", MINUTE)];
      await tick(MINUTE);
      await tick(FEEDBACK_QUIET_MS);
      await tick(FEEDBACK_QUIET_MS);
      first.pulls.state = { state: "merged" };
      await tick(MINUTE);
      expect(service.get(first.id)?.activity).toHaveLength(before ?? -1);
      expect(isDone(task())).toBe(true);
      expect(first.pulls.checked).toHaveLength(checked);
      expect(service.queuedTaskIds()).not.toContain(first.id);
      // 人が「再レビュー」した回からは、見守る
      service.rereview(first.id);
      await service.runNext(first.id);
      await service.runNext(first.id);
      expect(reviewWatching(task())).toBe(true);
      activity.close();
    },
  );
});

describe("依頼で取り込んだ PR の GitHub の再依頼と、見守り（PBI-411）", () => {
  const requested = (number: number) =>
    pr(number, { labels: [], review: "requested" as const, requestedFor: "me" });

  /** 依頼で取り込んだ PR 9 を、判定 verdict でレビューして投稿する（見守り中か、指摘なしで完了）。 */
  async function requestedAndPosted(verdict: Verdict) {
    const base = await posted(["suggestions", verdict, "suggestions", "suggestions"], {
      author: "alice",
    });
    // posted はラベルで取り込むので、依頼で取り込んだタスクを作り直す
    const [task] = base.service.importIssues([requested(10)]);
    const id = task?.id ?? "";
    base.pulls.prInfo = {
      ...base.pulls.prInfo,
      number: 10,
      url: "https://github.com/acme/app/pull/10",
    };
    await base.service.runNext(id);
    await base.service.runNext(id);
    const get = () => base.service.get(id)?.task as Task;
    expect(get().reviewPost).toBeDefined();
    return { ...base, id, get };
  }

  it("見守り中のタスクの PR に再依頼が来たら、新しいタスクを作り、元のタスクには何も記録しない。PR の変化では、新しいタスクだけが再レビューする（二重にしない）", async () => {
    const { activity, pulls, service, id, get, clock } =
      await requestedAndPosted("changes_required");
    expect(reviewWatching(get())).toBe(true);
    const before = service.get(id);
    // 作者が push して、再依頼した
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B, requestedReviewers: ["me"] };
    pulls.lastRequestAt = new Date(clock.now + MINUTE).toISOString();
    clock.now += 2 * MINUTE;
    const { restarted } = await service.restartRerequestedReviews([requested(10)]);
    expect(restarted).toHaveLength(1);
    const next = restarted[0]?.id ?? "";
    expect(next).not.toBe(id);
    expect(restarted[0]?.reviewRerequest?.taskId).toBe(id);
    // 元のタスクは、状態も作業履歴も変えない（再依頼は新しいタスク）
    expect(service.get(id)).toEqual(before);
    // 新しいタスクが、B をレビューして投稿する
    await service.runNext(next);
    await service.runNext(next);
    expect(pulls.reviews.at(-1)?.commit).toBe(HEAD_B);
    // 元のタスクは、先頭が変わっていても、再レビューを始めない
    for (let i = 0; i < 3; i++) {
      clock.now += FEEDBACK_QUIET_MS;
      await service.checkPullRequests();
    }
    expect(restarts(service, id)).toEqual([]);
    expect(service.get(id)).toEqual(before);
    // さらに push されたら、新しいタスクだけが再レビューを始める
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_C };
    for (let i = 0; i < 3; i++) {
      clock.now += FEEDBACK_QUIET_MS;
      await service.checkPullRequests();
    }
    expect(restarts(service, id)).toEqual([]);
    expect(restarts(service, next)).toEqual([{ reason: "pushed", commit: HEAD_C }]);
    // 同じ依頼で、もう1つ作らない
    expect((await service.restartRerequestedReviews([requested(10)])).restarted).toEqual([]);
    // PR がマージされたら、元のタスクも見守りを終えて完了する
    pulls.state = { state: "merged" };
    await service.checkPullRequests();
    expect(isDone(get())).toBe(true);
    expect(get().reviewWatchEnded?.reason).toBe("merged");
    activity.close();
  });

  it("指摘なしで完了したタスクの PR に再依頼が来たら、新しいタスクを作り、元のタスクは完了のまま、先頭が変わっても再レビューを始めない", async () => {
    const { activity, pulls, service, id, get, clock } = await requestedAndPosted("no_findings");
    expect(isDone(get())).toBe(true);
    const before = service.get(id);
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B, requestedReviewers: ["me"] };
    pulls.lastRequestAt = new Date(clock.now + MINUTE).toISOString();
    clock.now += 2 * MINUTE;
    const { restarted } = await service.restartRerequestedReviews([requested(10)]);
    expect(restarted).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      clock.now += FEEDBACK_QUIET_MS;
      await service.checkPullRequests();
    }
    expect(restarts(service, id)).toEqual([]);
    expect(service.get(id)).toEqual(before);
    expect(isDone(get())).toBe(true);
    activity.close();
  });

  it("作者の返信を読んでいる間に、再依頼の取り込みが新しいタスクを作ったら、元のタスクは判定し直しを始めない", async () => {
    const { activity, pulls, service, id, clock } = await requestedAndPosted("changes_required");
    pulls.feedbackList = [comment(clock, "comment:1", "alice", "直しません", MINUTE)];
    clock.now += 2 * MINUTE;
    await service.checkPullRequests();
    // 静かになるまでの待ちが明ける確認で、コメントを読んでいる間に、再依頼の取り込みが割り込む
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    pulls.lastRequestAt = new Date(clock.now + MINUTE).toISOString();
    clock.now += FEEDBACK_QUIET_MS;
    const original = pulls.feedback.bind(pulls);
    let created = 0;
    const spy = vi.spyOn(pulls, "feedback").mockImplementation(async (input) => {
      const result = await original(input);
      // 元のタスク（PR 10）がコメントを読んでいる間に
      if (created === 0 && input.number === 10) {
        created = (await service.restartRerequestedReviews([requested(10)])).restarted.length;
      }
      return result;
    });
    await service.checkPullRequests();
    spy.mockRestore();
    expect(created).toBe(1);
    expect(restarts(service, id)).toEqual([]);
    activity.close();
  });

  it("見守りが先に再レビューを始めていたら（実行中）、再依頼では新しいタスクを作らない", async () => {
    const { activity, pulls, service, id, clock } = await requestedAndPosted("changes_required");
    pulls.prInfo = { ...pulls.prInfo, headSha: HEAD_B, requestedReviewers: ["me"] };
    pulls.lastRequestAt = new Date(clock.now + MINUTE).toISOString();
    clock.now += MINUTE;
    await service.checkPullRequests();
    clock.now += FEEDBACK_QUIET_MS;
    await service.checkPullRequests();
    expect(restarts(service, id)).toHaveLength(1);
    expect((await service.restartRerequestedReviews([requested(10)])).restarted).toEqual([]);
    // 再レビューを投稿した後は、依頼が投稿より前なので、作らない
    await service.runNext(id);
    await service.runNext(id);
    expect((await service.restartRerequestedReviews([requested(10)])).restarted).toEqual([]);
    activity.close();
  });
});
