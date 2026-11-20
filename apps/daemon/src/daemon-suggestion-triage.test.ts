import { rmSync } from "node:fs";
import type { StepKey, Task } from "@sacty/core";
import { isCompleted, renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { PullRequestFeedback } from "./github.js";
import type { MemoryProjectStore } from "./projects.js";
import type { ServiceDeps, TaskService } from "./service.js";
import {
  dbPath,
  type FakeExecutor,
  FakePulls,
  FakeRepos,
  makeService,
  projectsWithAccount,
  useTempDir,
} from "./testing/daemon.js";
import { TRIAGE_REPLY_NOTE } from "./triage-reply.js";

useTempDir();

/*
 * AI のレビューの提案を、直しに入る前に AI が PR の範囲で選り分ける（PBI-436）の、偽の GitHub を使った結合のテスト。
 */
describe("AI のレビューの提案の、直しに入る前の選り分け（PBI-436）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const at = "2026-10-11T00:00:00Z";
  const later = () => Date.parse(at) + 3 * 60_000;
  const CI = {
    snapshot: async () => ({ checks: [], jobs: [], failedRuns: [] }),
  } as unknown as ServiceDeps["ci"];
  const taskOf = (svc: TaskService, id: string) => svc.get(id)?.task as Task;
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];
  const count = (svc: TaskService, id: string, type: string) =>
    types(svc, id).filter((t) => t === type).length;
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";

  const implement = (text = "# 実装の説明") =>
    out(
      [
        text,
        block({
          "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
        }),
      ].join("\n\n"),
    );
  /** 指摘への対応を添えた、実装の実行。 */
  const responded = (responses: { remarkId: string; status: string; text: string }[]) =>
    out(
      [
        "# 実装の説明",
        block({
          "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
        }),
        block({ "sacty-responses": responses }),
      ].join("\n\n"),
    );
  const verdictOut = (verdict: string, text = "# 評価\n\n指摘なし") =>
    out(`${text}\n\n${block({ "sacty-review-verdict": { verdict } })}`);
  /** 提案の本文（指摘の節に、太字の見出しで並ぶ）。 */
  const finding = (tag: "要修正" | "提案", title: string) =>
    `**[${tag}] ${title}**（src/pay.ts）\n${title}の説明。`;
  const body = (...findings: string[]) => ["# 評価", "", "## 指摘", "", ...findings].join("\n\n");
  /** 選り分けの答え。 */
  const triage = (...items: [string, "address" | "decline", string?][]) =>
    out(
      block({
        "sacty-triage": {
          items: items.map(([id, decision, reason]) => ({
            id,
            decision,
            reason: reason ?? `${id}の理由`,
          })),
        },
      }),
    );
  const item = (key: string, patch: Partial<PullRequestFeedback> = {}): PullRequestFeedback => ({
    key,
    kind: "comment",
    author: "reviewer",
    at,
    body: "受け入れ条件が曖昧",
    ...patch,
  });

  const replies = (pulls: FakePulls) =>
    pulls.issueComments.filter((c) => c.body.startsWith("<!-- sacty-reply:"));
  const restarts = (svc: TaskService, childId: string) =>
    svc
      .get(childId)
      ?.activity.filter((e) => e.type === "ReviewRestarted" && e.payload.reason === "declined") ??
    [];
  const triaged = (svc: TaskService, id: string) =>
    (svc.get(id)?.activity ?? []).flatMap((e) => (e.type === "SuggestionsTriaged" ? [e] : []));
  const childOf = (svc: TaskService, id: string, number = 7) =>
    taskOf(svc, id).reviewTasks?.find((r) => r.number === number)?.taskId ?? "";
  const commitOf = (svc: TaskService, id: string) => taskOf(svc, id).pullRequest?.commit ?? "";
  const runReview = async (svc: TaskService, childId: string) => {
    for (let i = 0; i < 4 && !isCompleted(taskOf(svc, childId)); i++) await svc.runNext(childId);
  };
  const posted = (pulls: FakePulls, n: number) =>
    item(`review:${50 + n}`, { kind: "review", author: "me", body: pulls.reviews[n]?.body ?? "" });
  async function settle(service: TaskService, id: string, max = 12) {
    for (let i = 0; i < max; i++) {
      const status = taskOf(service, id).status;
      if (status === "awaiting_approval" || status === "paused") return;
      await service.runNext(id);
    }
  }

  function make(
    outcomes: AgentOutcome[],
    shared: { pulls?: FakePulls; repos?: FakeRepos; projects?: MemoryProjectStore } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = shared.pulls ?? new FakePulls();
    const repos = shared.repos ?? new FakeRepos();
    const projects = shared.projects ?? projectsWithAccount();
    const made = makeService(activity, outcomes, {
      stepPullRequests: true,
      ci: CI,
      draftPullRequests: true,
      reviewTasks: true,
      now: later,
      pulls,
      repos,
      projects,
      planner: async () => ({
        steps: ["implement"] as StepKey[],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      }),
    });
    return { activity, ...made, pulls, repos, projects };
  }

  /**
   * 実装の PR を作り、レビューの子タスクが、与えた本文・判定でレビューして投稿し、その指摘を取り込むところまで進める
   * （outcomes は、実装・レビューの後ろに続く実行：選り分け・直しなど）。
   */
  async function reviewed(
    verdict: string,
    reviewBody: string,
    after: AgentOutcome[],
    options: { importNow?: boolean } = {},
  ) {
    const made = make([implement(), verdictOut(verdict, reviewBody), ...after]);
    const created = made.service.createTask({
      projectId: "default",
      title: "決済API",
      body: "タスクの本文",
    });
    const taskId = created.id;
    await made.service.runNext(taskId);
    await settle(made.service, taskId);
    const childId = childOf(made.service, taskId);
    const first = commitOf(made.service, taskId);
    made.pulls.prInfo = {
      ...made.pulls.prInfo,
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      headSha: first,
    };
    await runReview(made.service, childId);
    made.pulls.feedbackBy[7] = [posted(made.pulls, 0)];
    if (options.importNow !== false) await made.service.checkPullRequests();
    return { ...made, id: taskId, childId, first };
  }

  it("提案だけの回で、すべて対応しないと判断：直しに入らず、理由を返信し、同じ先頭を 1 回だけ判定し直し、指摘なしならドラフトを外す", async () => {
    const made = await reviewed(
      "suggestions",
      body(finding("提案", "名前の付け方"), finding("提案", "言い回し")),
      [
        triage(
          ["S1", "decline", "好みの範囲で、この PR の目的の外"],
          ["S2", "decline", "言い回し"],
        ),
        verdictOut("no_findings", "# 評価\n\n指摘なし"),
      ],
    );
    const { activity, service, executor, pulls, id, childId, first } = made;
    // 実装は実行しない：選り分けの 1 回だけが増える。差し戻し・コミット・push も起きない
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    expect(types(service, id)).toContain("SuggestionsTriaged");
    expect(types(service, id)).not.toContain("ChangesRequested");
    expect(count(service, id, "BranchPushed")).toBe(1);
    expect(
      service
        .get(id)
        ?.activity.filter((e) => e.type === "AgentRunStarted" && e.payload.step === "implement"),
    ).toHaveLength(1);
    expect(taskOf(service, id).reviewRejudge).toMatchObject({
      number: 7,
      commit: first,
      reason: "triaged",
    });
    const record = triaged(service, id)[0]?.payload;
    expect(record?.items.map((i) => [i.id, i.decision])).toEqual([
      ["S1", "decline"],
      ["S2", "decline"],
    ]);
    expect(record?.dropped).toEqual([0]);
    // 返信が済むまでは、判定し直しを始めない
    await service.checkPullRequests();
    expect(restarts(service, childId)).toHaveLength(0);
    // 理由が、元の投稿に 1 通だけ返信される（AI の判断である旨と、要対応とコメントすれば直せる旨を添える）
    expect(service.queuedTaskIds()).toContain(id);
    await service.runNext(id);
    expect(replies(pulls)).toHaveLength(1);
    const reply = replies(pulls)[0]?.body ?? "";
    expect(reply).toContain("**対応していません。** 理由：");
    expect(reply).toContain(TRIAGE_REPLY_NOTE);
    expect(reply).toContain("好みの範囲で、この PR の目的の外");
    expect(reply).toContain("言い回し");
    // 返信の後、同じ先頭を 1 回だけ判定し直す
    await service.checkPullRequests();
    await service.checkPullRequests();
    expect(restarts(service, childId)).toHaveLength(1);
    const before = executor.calls.length;
    await runReview(service, childId);
    const prompt = promptOf(executor, before);
    // その回の指示に、対応しないとした提案がデータとして渡り、未対応に数えない指示になっている
    expect(prompt).toContain("declinedByAuthor");
    expect(prompt).toContain("名前の付け方");
    expect(prompt).toContain("未対応に数えず");
    expect(prompt).toContain("PR を作った側が対応しないと判断した");
    // 指摘なし：ドラフトを外して人の承認を待つ。判定し直しは繰り返さない
    await service.checkPullRequests();
    await service.checkPullRequests();
    expect(taskOf(service, id).pullRequest?.draft).toBeUndefined();
    expect(types(service, id)).toContain("PullRequestMarkedReady");
    expect(restarts(service, childId)).toHaveLength(1);
    expect(count(service, id, "SuggestionsTriaged")).toBe(1);
    activity.close();
  });

  /** 直しの後の PR の先頭（偽の GitHub の先頭も進める）を返す。 */
  const advance = (made: { service: TaskService; pulls: FakePulls; id: string }) => {
    const head = commitOf(made.service, made.id);
    made.pulls.prInfo = { ...made.pulls.prInfo, number: 7, headSha: head };
    return head;
  };

  it("一部だけ対応する：対応する分だけが直しの対象。対応しない提案は返信の後ろに続き、再レビューの指示に毎回（前々回以前の分も）渡る", async () => {
    const made = await reviewed(
      "suggestions",
      body(finding("提案", "提案A"), finding("提案", "提案X"), finding("提案", "提案Y")),
      [
        triage(
          ["S1", "address"],
          ["S2", "decline", "Xの理由：範囲の外"],
          ["S3", "decline", "Yの理由"],
        ),
        responded([{ remarkId: "implement-1-1", status: "addressed", text: "Aを直しました" }]),
        verdictOut("suggestions", body(finding("提案", "提案B"), finding("提案", "提案Z"))),
        triage(["S1", "address"], ["S2", "decline", "Zの理由：好み"]),
        responded([{ remarkId: "implement-2-1", status: "addressed", text: "Bを直しました" }]),
        verdictOut("no_findings"),
      ],
    );
    const { activity, service, executor, pulls, id, childId } = made;
    // 直しの対象は、1 件の指摘（本文）だけ。選り分けた 2 件は、「この PR では直さず、対応も書かない」の節にある
    expect(taskOf(service, id).status).toBe("queued");
    expect(taskOf(service, id).remarks).toHaveLength(1);
    expect(taskOf(service, id).remarks[0]?.declinedParts?.map((d) => d.reason)).toEqual([
      "Xの理由：範囲の外",
      "Yの理由",
    ]);
    await settle(service, id);
    const rework = executor.calls
      .map((c) => c.command.join(" "))
      .find((c) => c.includes("この PR では直さない提案"));
    expect(rework).toBeDefined();
    const section = (rework ?? "").slice((rework ?? "").indexOf("この PR では直さない提案"));
    expect(section).toContain("提案X");
    expect(section).toContain("提案Y");
    expect(section).toContain("対応も書きません");
    expect(section).not.toContain("提案A の説明");
    // 1 つの投稿への返信は 1 通のまま：実装の対応の後ろに、対応しない提案の文と理由と、AI の判断である旨が続く
    await service.runNext(id);
    expect(replies(pulls)).toHaveLength(1);
    const reply = replies(pulls)[0]?.body ?? "";
    expect(reply.startsWith("<!-- sacty-reply:")).toBe(true);
    expect(reply).toContain("**対応しました。**");
    expect(reply.indexOf("Aを直しました")).toBeLessThan(reply.indexOf("提案X"));
    expect(reply).toContain(TRIAGE_REPLY_NOTE);
    expect(reply).toContain("Xの理由：範囲の外");
    expect(reply).toContain("Yの理由");
    // PR の更新で再レビューが始まる：対応しないとした 2 件が、再レビューの指示のデータに入る
    advance(made);
    await service.checkPullRequests();
    let before = executor.calls.length;
    await runReview(service, childId);
    const second = promptOf(executor, before);
    expect(second).toContain("declinedByAuthor");
    expect(second).toContain("提案X");
    expect(second).toContain("Yの理由");
    // 2 回目の選り分け：提案Zを対応しない。直しの後の 3 回目の再レビューに、前々回以前の提案X・Y と、今回の Z が揃って渡る
    pulls.feedbackBy[7] = [...(pulls.feedbackBy[7] ?? []), posted(pulls, 1)];
    await service.checkPullRequests();
    await settle(service, id);
    await service.runNext(id);
    advance(made);
    await service.checkPullRequests();
    before = executor.calls.length;
    await runReview(service, childId);
    const third = promptOf(executor, before);
    for (const expected of ["提案X", "Xの理由：範囲の外", "提案Y", "提案Z", "Zの理由：好み"]) {
      expect(third).toContain(expected);
    }
    expect(third).toContain("https://github.com/acme/app/pull/7#pullrequestreview-50");
    expect(taskOf(service, id).declinedSuggestions?.map((d) => d.round)).toEqual([1, 1, 2]);
    activity.close();
  });

  const reworkOut = out(
    block({ "sacty-rework": { target: "implement", reason: "決定は変えない" } }),
  );
  /** すべて対応しないとして、返信まで進める（直しに入らない）。 */
  async function declinedAll(
    after: AgentOutcome[],
    reviewBody = body(finding("提案", "名前の付け方")),
    answer = triage(["S1", "decline", "好みの範囲"]),
  ) {
    const made = await reviewed("suggestions", reviewBody, [answer, ...after]);
    await made.service.runNext(made.id);
    expect(replies(made.pulls)).toHaveLength(1);
    return made;
  }

  it("要修正と提案が混ざる回：要修正は必ず直しに入り、提案 2 件は選り分けて、対応を求めない節に入る", async () => {
    const made = await reviewed(
      "changes_required",
      body(finding("要修正", "必須の題"), finding("提案", "提案P"), finding("提案", "提案Q")),
      [
        // S1 は要修正（選り分けの対象外。答えに入れても読み捨てる）
        triage(
          ["S1", "decline", "要修正を断る答え"],
          ["S2", "decline", "Pの理由"],
          ["S3", "decline", "Qの理由"],
        ),
        responded([{ remarkId: "implement-1-1", status: "addressed", text: "必須を直しました" }]),
      ],
    );
    const { activity, service, executor, id } = made;
    const record = triaged(service, id)[0]?.payload;
    // 提案の 2 件だけが対象。要修正は対象に入らない
    expect(record?.items.map((i) => i.id)).toEqual(["S2", "S3"]);
    expect(record?.dropped).toEqual([]);
    expect(types(service, id)).toContain("ChangesRequested");
    await settle(service, id);
    const prompt =
      executor.calls
        .map((c) => c.command.join(" "))
        .find((c) => c.includes("この PR では直さない提案")) ?? "";
    expect(prompt).toContain("[要修正] 必須の題");
    const declinedSection = prompt.slice(prompt.indexOf("この PR では直さない提案"));
    expect(declinedSection).toContain("提案P");
    expect(declinedSection).toContain("提案Q");
    expect(declinedSection).not.toContain("必須の題");
    activity.close();
  });

  it("人の指摘と AI のレビューの提案が同じ回に届く：人の指摘は選り分けず、戻し先を判断する実行で直しに入る。提案はすべて対応しない", async () => {
    const made = await reviewed(
      "suggestions",
      body(finding("提案", "名前の付け方")),
      [
        triage(["S1", "decline", "好みの範囲"]),
        reworkOut,
        responded([
          { remarkId: "implement-1-1", status: "addressed", text: "人の指摘を直しました" },
        ]),
      ],
      { importNow: false },
    );
    const { activity, service, pulls, executor, id } = made;
    // 人のコメントが先、AI のレビューが後
    pulls.feedbackBy[7] = [
      item("comment:1", { body: "人のコメント：金額の検証を足してください" }),
      posted(pulls, 0),
    ];
    await service.checkPullRequests();
    // 選り分けの対象は AI の提案だけ（人の指摘は 1 件も入らない）
    const record = triaged(service, id)[0]?.payload;
    expect(record?.items.map((i) => i.remark)).toEqual([1]);
    expect(record?.dropped).toEqual([1]);
    // 人の指摘は、戻し先を判断する実行（工程のエージェント）で判断して、直しに入る
    const judged = service.get(id)?.activity.find((e) => e.type === "ReworkJudged");
    expect(judged?.actor).toBe("agent");
    expect(
      executor.calls.some((c) =>
        c.command.join(" ").includes("どの工程からやり直せば解消できるか"),
      ),
    ).toBe(true);
    const changes = service.get(id)?.activity.find((e) => e.type === "ChangesRequested");
    expect(
      changes?.type === "ChangesRequested" && changes.payload.remarks.map((r) => r.text),
    ).toEqual(["人のコメント：金額の検証を足してください"]);
    await settle(service, id);
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    // 返信は、元の投稿ごとに 1 通：人の指摘への対応と、AI のレビューへの理由
    await service.runNext(id);
    expect(replies(pulls)).toHaveLength(2);
    expect(replies(pulls).some((c) => c.body.includes(TRIAGE_REPLY_NOTE))).toBe(true);
    activity.close();
  });

  it("人が PR に要対応とコメントすると、人の指摘として取り込まれ、選り分けを通らずに直しに入る", async () => {
    const made = await declinedAll([
      reworkOut,
      responded([{ remarkId: "implement-1-1", status: "addressed", text: "直しました" }]),
    ]);
    const { activity, service, pulls, id } = made;
    expect(count(service, id, "ChangesRequested")).toBe(0);
    pulls.feedbackBy[7] = [
      ...(pulls.feedbackBy[7] ?? []),
      item("comment:9", { body: "名前の付け方も直してください（要対応）" }),
    ];
    await service.checkPullRequests();
    // 選り分けは増えず、直しに入る
    expect(count(service, id, "SuggestionsTriaged")).toBe(1);
    expect(count(service, id, "ChangesRequested")).toBe(1);
    expect(taskOf(service, id).status).toBe("queued");
    await settle(service, id);
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    expect(
      service
        .get(id)
        ?.activity.filter((e) => e.type === "AgentRunStarted" && e.payload.step === "implement"),
    ).toHaveLength(2);
    expect(taskOf(service, id).remarks.filter((r) => r.triaged)).toHaveLength(1);
    activity.close();
  });

  it("選り分けの実行が失敗する・答えを読めない：すべての提案を、対応する側（defaulted）として記録し、今までどおり直しに入る", async () => {
    const failed: AgentOutcome = { kind: "failed", reason: "error", message: "exit code 1" };
    for (const answer of [failed, out("読めない答え")]) {
      const made = await reviewed(
        "suggestions",
        body(finding("提案", "提案A"), finding("提案", "提案B")),
        [answer],
      );
      const { activity, service, id } = made;
      const record = triaged(service, id)[0]?.payload;
      expect(record?.items.map((i) => [i.decision, i.defaulted])).toEqual([
        ["address", true],
        ["address", true],
      ]);
      expect(record?.runResult).toBe(answer.kind === "failed" ? "failed" : "completed");
      // 直しに入る（差し戻し）。対応しない提案は無い
      expect(types(service, id)).toContain("ChangesRequested");
      expect(taskOf(service, id).declinedSuggestions).toBeUndefined();
      expect(taskOf(service, id).remarks).toHaveLength(1);
      expect(taskOf(service, id).remarks[0]?.declinedParts).toBeUndefined();
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("一部の提案に判断が無い答え：判断の無い提案は対応する側（defaulted）で直しの対象になり、判断のある 2 件は対応しない", async () => {
    const made = await reviewed(
      "suggestions",
      body(finding("提案", "提案A"), finding("提案", "提案B"), finding("提案", "提案C")),
      [triage(["S2", "decline", "Bの理由"], ["S3", "decline", "Cの理由"])],
    );
    const { activity, service, id } = made;
    const record = triaged(service, id)[0]?.payload;
    expect(record?.items.map((i) => [i.id, i.decision, i.defaulted === true])).toEqual([
      ["S1", "address", true],
      ["S2", "decline", false],
      ["S3", "decline", false],
    ]);
    // 1 件の指摘（本文）は残り、対応しない 2 件が付く
    expect(taskOf(service, id).remarks).toHaveLength(1);
    expect(taskOf(service, id).remarks[0]?.declinedParts?.map((d) => d.reason)).toEqual([
      "Bの理由",
      "Cの理由",
    ]);
    expect(types(service, id)).toContain("ChangesRequested");
    activity.close();
  });

  it("判定し直しの回が要修正を出したら、一時停止せずに直しに入る", async () => {
    const made = await declinedAll([
      verdictOut("changes_required", body(finding("要修正", "新しい不具合"))),
      reworkOut,
    ]);
    const { activity, service, pulls, id, childId } = made;
    await service.checkPullRequests();
    await service.checkPullRequests();
    expect(restarts(service, childId)).toHaveLength(1);
    await runReview(service, childId);
    pulls.feedbackBy[7] = [...(pulls.feedbackBy[7] ?? []), posted(pulls, 1)];
    await service.checkPullRequests();
    // 一時停止ではなく、直しに入る（差し戻して実行待ち）
    const task = taskOf(service, id);
    expect(task.status).toBe("queued");
    expect(task.pausedReason).toBeUndefined();
    expect(count(service, id, "ChangesRequested")).toBe(1);
    expect(count(service, id, "SuggestionsTriaged")).toBe(1);
    activity.close();
  });

  it("判定し直しの回が提案を残し、それもすべて対応しない：理由を返信し、2 回目の判定し直しは始めず、提案が残った旨で一時停止する", async () => {
    const made = await declinedAll([
      verdictOut("suggestions", body(finding("提案", "別の提案"))),
      triage(["S1", "decline", "同じ原因の別の現れ"]),
    ]);
    const { activity, service, pulls, id, childId } = made;
    await service.checkPullRequests();
    await service.checkPullRequests();
    expect(restarts(service, childId)).toHaveLength(1);
    await runReview(service, childId);
    pulls.feedbackBy[7] = [...(pulls.feedbackBy[7] ?? []), posted(pulls, 1)];
    await service.checkPullRequests();
    // 2 回目の選り分け：すべて対応しない。判定し直しは求めず、stop を記録する
    expect(triaged(service, id)).toHaveLength(2);
    expect(triaged(service, id)[1]?.payload.stop).toBe(true);
    expect(count(service, id, "ReviewRejudgeRequested")).toBe(1);
    // 返信が先（承認待ちのまま）。返信の後に、一時停止する
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    await service.runNext(id);
    expect(replies(pulls)).toHaveLength(2);
    expect(replies(pulls)[1]?.body).toContain("同じ原因の別の現れ");
    await service.checkPullRequests();
    const task = taskOf(service, id);
    expect(task.status).toBe("paused");
    expect(task.pausedMessage).toEqual({ code: "triage.left", params: { number: 7 } });
    expect(renderMessage(task.pausedMessage as never, "ja")).toContain("提案が残り");
    // 往復は続かない：判定し直しは 1 回のまま。再開して確認しても、もう一度は止めない・始めない
    service.resume(id, {});
    await service.checkPullRequests();
    await service.checkPullRequests();
    expect(restarts(service, childId)).toHaveLength(1);
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    expect(count(service, id, "ChangesRequested")).toBe(0);
    activity.close();
  });

  it("デーモンを起動し直しても、選り分けの実行・返信・判定し直しは、重ならず・抜けずに続く", async () => {
    const made = await reviewed("suggestions", body(finding("提案", "名前の付け方")), [
      triage(["S1", "decline", "好みの範囲"]),
      verdictOut("no_findings"),
    ]);
    const { pulls, repos, projects, id, childId } = made;
    expect(count(made.service, id, "SuggestionsTriaged")).toBe(1);
    made.activity.close();
    // 選り分けの記録の後：選り分けを実行し直さず、返信する
    const again = make([], { pulls, repos, projects });
    await again.service.checkPullRequests();
    expect(again.executor.calls).toHaveLength(0);
    expect(count(again.service, id, "SuggestionsTriaged")).toBe(1);
    await again.service.runNext(id);
    expect(replies(pulls)).toHaveLength(1);
    again.activity.close();
    // 返信の後・判定し直しの前：返信を重ねず、判定し直しを 1 回だけ始める
    const third = make([verdictOut("no_findings")], { pulls, repos, projects });
    await third.service.checkPullRequests();
    await third.service.checkPullRequests();
    expect(replies(pulls)).toHaveLength(1);
    expect(restarts(third.service, childId)).toHaveLength(1);
    third.activity.close();
    // 判定し直しを始めた後：もう一度は始めない
    const fourth = make([], { pulls, repos, projects });
    await fourth.service.checkPullRequests();
    await fourth.service.checkPullRequests();
    expect(restarts(fourth.service, childId)).toHaveLength(1);
    expect(replies(pulls)).toHaveLength(1);
    expect(count(fourth.service, id, "SuggestionsTriaged")).toBe(1);
    fourth.activity.close();
  });
});
