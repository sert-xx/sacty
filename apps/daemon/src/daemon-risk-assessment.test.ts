import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import { MemoryProjectStore } from "./projects.js";
import { RISK_ASSESSMENT_HEADING } from "./risk-assessment.js";
import { MemorySettingsStore } from "./settings.js";
import { appendLegacy, dbPath, FakePulls, makeService, useTempDir } from "./testing/daemon.js";

useTempDir();

// PR のリスク評価は、PR を作る・更新する時点ではせず、レビューの工程の、指摘なしの回だけにする（PBI-429）

const out = (text: string): AgentOutcome => ({
  kind: "completed",
  output: text,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
});
const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
const implementOutcome = () =>
  out(
    [
      "# 実装の説明",
      block({
        "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
      }),
    ].join("\n\n"),
  );

const medium = {
  level: "medium",
  signals: [],
  change: "予約のキャンセルの API を足す",
  scope: "予約の一覧と詳細の応答",
  reversibility: "変更を元に戻せば戻る",
  verification: "API のテストで確かめた",
  focus: [],
};

type Verdict = "no_findings" | "suggestions" | "changes_required" | "none" | "no_findings+line";
type RiskAnswer = "valid" | "missing" | "unreadable";

/** 判定・評価の答えの組み合わせから、レビューの答えを作る。 */
function reviewAnswer(verdict: Verdict, risk: RiskAnswer): AgentOutcome {
  const parts = ["# レビュー", "", "総評です。"];
  if (risk === "valid") parts.push(block({ [RISK_ASSESSMENT_HEADING]: medium }));
  if (risk === "unreadable") parts.push(block({ [RISK_ASSESSMENT_HEADING]: { level: "bogus" } }));
  if (verdict === "no_findings+line") {
    parts.push(
      block({
        "sacty-review-comments": [
          { path: "src/a.ts", line: 1, severity: "should", body: "名前を変える" },
        ],
      }),
    );
  }
  if (verdict !== "none") {
    parts.push(
      block({
        "sacty-review-verdict": {
          verdict: verdict === "no_findings+line" ? "no_findings" : verdict,
        },
      }),
    );
  }
  return out(parts.join("\n\n"));
}

const VERDICTS: Verdict[] = [
  "no_findings",
  "suggestions",
  "changes_required",
  "none",
  "no_findings+line",
];
const ANSWERS: RiskAnswer[] = ["valid", "missing", "unreadable"];

const PR_NUMBER = 9;
const HEAD = "a".repeat(40);
const RISK_INSTRUCTION = "判定を no_findings にするときだけ";

const typed = (service: { get(id: string): unknown }, id: string) =>
  service.get(id) as { task: Task; activity: { type: string; actor: string; payload: unknown }[] };

describe("PR を作る・更新する時点では、リスクを評価しない（PBI-429）", () => {
  it("リスク評価を有効にしたデーモンでも、実装の PR の作成・更新で評価のエージェントを実行せず、記録せず、本文にも載せない。過去の via: publish の記録があっても載せない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service, executor } = makeService(activity, [implementOutcome(), implementOutcome()], {
      pulls,
      reviewTasks: true,
      riskAssessment: true,
      planner: async () => ({
        steps: ["implement"],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      }),
    });
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "本文" });
    // 版を上げる前の記録（PR を作る前の評価。引き継ぎの印つき）を持つタスク
    appendLegacy(service, id, [
      {
        actor: "orchestrator",
        event: {
          type: "PullRequestRiskAssessed",
          payload: {
            via: "publish",
            commit: "o".repeat(40),
            base: "b".repeat(40),
            inheritedFrom: "p".repeat(40),
            assessment: medium,
            costUsd: 0,
            estimated: false,
          },
        },
      },
    ]);
    // 作成
    const advance = async () => {
      for (let i = 0; i < 4 && typed(service, id).task.status !== "awaiting_approval"; i++) {
        await service.runNext(id);
      }
    };
    await advance();
    expect(pulls.calls).toHaveLength(1);
    const number = pulls.calls[0] ? [...Object.keys(pulls.bodies)].map(Number)[0] : undefined;
    expect(number).toBeDefined();
    expect(pulls.bodies[number ?? 0]).not.toContain("リスク評価");
    expect(pulls.bodies[number ?? 0]).not.toContain("段階：");
    // 更新（直しの提出）。同じ実行器で、もう 1 回実装を提出する
    expect(typed(service, id).task.status).toBe("awaiting_approval");
    service.requestChanges(id, { step: "implement", submission: 1, comments: ["直してください"] });
    await advance();
    expect(pulls.calls.length).toBeGreaterThan(1);
    expect(pulls.bodies[number ?? 0]).not.toContain("リスク評価");
    // 実行は実装の 2 回だけ（評価のエージェントを実行しない）。新しい評価の記録も作らない（過去の 1 件のまま）
    expect(executor.calls).toHaveLength(2);
    const records = typed(service, id).activity.filter((e) => e.type === "PullRequestRiskAssessed");
    expect(records).toHaveLength(1);
    expect(typed(service, id).task.status).not.toBe("paused");
    activity.close();
  });
});

describe("レビューの工程の評価：対象 × 判定 × 評価の答え（PBI-429）", () => {
  /** 実装の PR（または要求要件の PR）のレビューの子タスクを、レビューを投稿するまで進める。 */
  async function childReview(step: "implement" | "requirements", outcome: AgentOutcome) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service, executor } = makeService(activity, [implementOutcome(), outcome], {
      pulls,
      reviewTasks: true,
      riskAssessment: true,
      stepPullRequests: step === "requirements",
      planner: async () => ({
        steps: [step],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      }),
    });
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "本文" });
    for (let i = 0; i < 4 && typed(service, id).task.status !== "awaiting_approval"; i++) {
      await service.runNext(id);
    }
    const parent = typed(service, id).task;
    const link = parent.reviewTasks?.[0];
    expect(link?.step).toBe(step);
    const childId = link?.taskId ?? "";
    const commit =
      parent.pullRequest?.commit ?? parent.stepPullRequests.findLast(() => true)?.commit ?? HEAD;
    pulls.prInfo = { ...pulls.prInfo, number: link?.number ?? PR_NUMBER, headSha: commit };
    for (let i = 0; i < 4 && pulls.reviews.length === 0; i++) await service.runNext(childId);
    return { activity, service, executor, pulls, parentId: id, childId };
  }

  /** ラベルで取り込んだ PR のレビューのタスクを、レビューを投稿するまで進める。 */
  async function importedReview(outcome: AgentOutcome) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = {
      ...pulls.prInfo,
      number: PR_NUMBER,
      url: `https://github.com/acme/app/pull/${PR_NUMBER}`,
      headSha: HEAD,
      author: "alice",
    };
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    });
    const { service, executor } = makeService(activity, [outcome], {
      pulls,
      projects,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review", reviewRequested: true }),
      planner: async () => ({
        steps: ["review"],
        plan: "review" as const,
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    const [task] = service.importIssues([
      {
        repo: "https://github.com/acme/app",
        number: PR_NUMBER,
        title: "PR",
        body: "本文",
        url: `https://github.com/acme/app/pull/${PR_NUMBER}`,
        labels: ["sacty-review"],
        pullRequest: true,
      },
    ]);
    const id = task?.id ?? "";
    for (let i = 0; i < 3 && pulls.reviews.length === 0; i++) await service.runNext(id);
    return { activity, service, executor, pulls, childId: id };
  }

  const targets = [
    {
      name: "実装の PR の子タスク",
      evaluated: true,
      run: (o: AgentOutcome) => childReview("implement", o),
    },
    { name: "取り込んだ PR のレビュー", evaluated: true, run: importedReview },
    {
      name: "要求要件の PR の子タスク",
      evaluated: false,
      run: (o: AgentOutcome) => childReview("requirements", o),
    },
  ];

  const rows = targets.flatMap((t) =>
    VERDICTS.flatMap((verdict) => ANSWERS.map((answer) => ({ ...t, verdict, answer }))),
  );

  it.each(rows)(
    "$name | 判定 $verdict | 評価の答え $answer",
    async ({ evaluated, run, verdict, answer }) => {
      const { activity, service, executor, pulls, childId } = await run(
        reviewAnswer(verdict, answer),
      );
      const posted = pulls.reviews[0]?.body ?? "";
      expect(posted, "レビューは投稿される").not.toBe("");
      const records = typed(service, childId).activity.filter(
        (e) => e.type === "PullRequestRiskAssessed",
      );
      const clear = verdict === "no_findings";
      const recorded = evaluated && clear;
      // 記録は、評価の対象の、指摘なしの回だけ
      expect(records).toHaveLength(recorded ? 1 : 0);
      if (recorded) {
        const payload = records[0]?.payload as {
          via: string;
          assessment?: unknown;
          reason?: unknown;
        };
        expect(payload.via).toBe("review");
        expect(payload.assessment !== undefined).toBe(answer === "valid");
        expect(payload.reason !== undefined).toBe(answer !== "valid");
      }
      // コメントへの掲載：記録した回だけ。評価できなかったことは、記録した回（指摘なし）にだけ載せる
      expect(posted.includes("### リスク評価")).toBe(recorded);
      expect(posted.includes("評価できませんでした")).toBe(recorded && answer !== "valid");
      // 評価の対象の回は、答えに評価の JSON があっても、投稿する本文に残さない
      if (evaluated) expect(posted).not.toContain(RISK_ASSESSMENT_HEADING);
      // 指示は、評価の対象のレビューにだけ、指摘なしと判定するときだけ評価を出すよう求める
      const prompt = executor.calls.at(-1)?.command.join(" ") ?? "";
      expect(prompt.includes(RISK_INSTRUCTION)).toBe(evaluated);
      activity.close();
    },
  );
});
