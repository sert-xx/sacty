import type { ActivityEvent, Task, TaskProposal } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { labels } from "@/i18n/messages/labels";
import {
  canControl,
  describeEvent as describeIn,
  isWorking,
  needsPerson,
  personAction as personActionIn,
  statusText as statusTextIn,
  usesTestCommand,
} from "./labels";

// 既存のテストは日本語の文言で確かめる
const ja = labels.ja;
const statusText = (task: Task) => statusTextIn(task, ja);
const personAction = (task: Task) => personActionIn(task, ja);
const describeEvent = (event: ActivityEvent) => describeIn(event, ja);

const proposal = (patch: Partial<TaskProposal> = {}): TaskProposal => ({
  id: "CP-1",
  fromStep: "design",
  target: "requirements",
  reason: "r",
  facts: [],
  proposed: "p",
  proposedAt: "2026-10-10T00:00:00.000Z",
  applied: false,
  ...patch,
});

const task = (patch: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "default",
  title: "A",
  body: "",
  start: "sacty",
  status: "idle",
  steps: [],
  outputs: {},
  testViewpoints: [],
  approved: {},
  proposals: [],
  testMap: [],
  reviewComments: [],
  reproductionTests: [],
  verifyFailures: 0,
  misses: [],
  importedFeedback: [],
  submissions: {},
  remarks: [],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...patch,
});

describe("一覧と詳細の導線（PBI-9 レビュー指摘）", () => {
  it("ゴールガーディアンの判定中は、待機（idle）でも作業中として自動更新する", () => {
    expect(isWorking(task({ proposals: [proposal()] }))).toBe(true);
    expect(statusText(task({ proposals: [proposal()] }))).toBe("ゴールガーディアンが判定中");
    const judged = proposal({ judgement: { verdict: "rejected", reason: "x", at: "" } });
    expect(isWorking(task({ proposals: [judged] }))).toBe(false);
    expect(isWorking(task({ status: "running" }))).toBe(true);
    // 実装の検証中（テスト・最終レビュー）も、待機（idle）のまま作業中（PBI-10a）
    expect(isWorking(task({ verification: "pending" }))).toBe(true);
    expect(statusText(task({ verification: "tests_passed" }))).toBe(
      "ゴールガーディアンが最終レビュー中",
    );
  });

  it("判定できなかった申し出は、判断フォームのある「変更の申し出と判定」へ誘導する", () => {
    const undecided = task({
      status: "escalated",
      proposals: [proposal({ judgement: { verdict: "undecidable", reason: "x", at: "" } })],
    });
    expect(needsPerson(undecided)).toBe(true);
    expect(personAction(undecided)).toEqual({ href: "/tasks/t1#proposals", label: "判断する" });
    // 差し戻しの上限によるエスカレーションと承認待ちは、成果物チェックへ
    expect(personAction(task({ status: "escalated" })).href).toBe("/tasks/t1/review");
    expect(personAction(task({ status: "awaiting_approval" }))).toEqual({
      href: "/tasks/t1/review",
      label: "チェックする",
    });
    expect(personAction(task({ status: "paused" })).href).toBe("/tasks/t1");
  });
});

describe("成果物チェックの表示（PBI-10b）", () => {
  const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-10T00:00:00.000Z",
      actor: "person",
    }) as ActivityEvent;

  it("実装へ戻すときは承認の取り消しを書かず、設計へ戻すときは書く", () => {
    const back = (target: "implement" | "design") =>
      describeEvent(
        event({
          type: "ChangesRequested",
          payload: {
            step: "pr",
            target,
            round: 1,
            remarks: [{ id: "x", text: "y" }],
            overLimit: false,
          },
        }),
      );
    expect(back("implement")).toBe("成果物チェックで差し戻し、実装からやり直し：指摘1件（人間）");
    expect(back("design")).toBe(
      "成果物チェックで差し戻し、設計からやり直し（設計の承認を取り消し）：指摘1件（人間）",
    );
    expect(
      describeEvent(event({ type: "StepSubmitted", payload: { step: "pr", submission: 2 } })),
    ).toBe("成果物チェックに提出（2回目）→ 承認待ち");
  });

  it("成果物チェック待ちと完了を表示する", () => {
    expect(
      statusText(task({ status: "awaiting_approval", gate: { step: "pr", submission: 1 } })),
    ).toBe("成果物チェック待ち");
    const done = task({
      steps: [
        { key: "requirements", state: "done" },
        { key: "pr", state: "done" },
      ],
    });
    expect(statusText(done)).toBe("完了");
    expect(isWorking(done)).toBe(false);
  });
});

describe("英語の表示（PBI-4b）", () => {
  const en = labels.en;
  const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-10T00:00:00.000Z",
      actor: "person",
    }) as ActivityEvent;

  it("用語集の英語で、状態と作業履歴を表示する", () => {
    expect(
      statusTextIn(task({ status: "awaiting_approval", gate: { step: "pr", submission: 2 } }), en),
    ).toBe("Awaiting deliverable review (submission 2)");
    expect(
      statusTextIn(
        task({ status: "awaiting_approval", gate: { step: "requirements", submission: 1 } }),
        en,
      ),
    ).toBe("Requirements awaiting approval");
    expect(personActionIn(task({ status: "awaiting_approval" }), en).label).toBe("Review");
    expect(
      describeIn(
        event({
          type: "ChangesRequested",
          payload: {
            step: "pr",
            target: "design",
            round: 1,
            remarks: [{ id: "x", text: "y" }],
            overLimit: false,
          },
        }),
        en,
      ),
    ).toBe(
      "Changes requested in deliverable review; redo from Design (Design approval revoked): 1 comment (person)",
    );
    expect(
      describeIn(
        event({
          type: "TaskEscalated",
          payload: {
            step: "design",
            reason: "change_undecidable",
            proposalId: "CP-1",
            pendingRemarks: [],
          },
        }),
        en,
      ),
    ).toBe("Escalated: the Goal Guardian could not decide CP-1");
  });
});

describe("一時停止と中止の表示（PBI-3）", () => {
  const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-10T00:00:00.000Z",
      actor: "person",
    }) as ActivityEvent;

  it("人間の一時停止と、中止の片付けの結果を作業履歴に出す", () => {
    expect(describeEvent(event({ type: "TaskPaused", payload: { reason: "manual" } }))).toBe(
      "一時停止（人間）",
    );
    const cancelled = event({
      type: "TaskCancelled",
      payload: {
        cleanup: [
          { target: "container", result: "done" },
          { target: "branch", result: "done" },
          { target: "pull_request", result: "failed", detail: "401" },
          { target: "session", result: "skipped" },
        ],
      },
    });
    expect(describeEvent(cancelled)).toBe(
      "中止（人間）：実行中のコンテナ・sacty が作ったブランチを片付けた／失敗：sacty が作ったPR（閉じる）",
    );
    expect(describeIn(cancelled, labels.en)).toBe(
      "Cancelled (person): cleaned up Running container, Branch created by sacty; failed: PR opened by sacty (closed)",
    );
    expect(statusText(task({ status: "cancelled" }))).toBe("中止");
    expect(needsPerson(task({ status: "cancelled" }))).toBe(false);
    expect(isWorking(task({ status: "cancelled" }))).toBe(false);
  });
});

describe("作業履歴に記録したデーモンの文言（PBI-11b）", () => {
  const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-10T00:00:00.000Z",
      actor: "sacty",
    }) as ActivityEvent;
  const failed = (message: unknown) =>
    event({
      type: "AgentRunFailed",
      payload: {
        runId: "r",
        step: "implement",
        agentId: "a",
        reason: "error",
        message,
        costUsd: 0,
        estimated: false,
      },
    } as Pick<ActivityEvent, "type" | "payload">);

  it("コードと引数の文言は、画面の言語の文にする（外から来た文は引数のまま）", () => {
    const pr = failed({
      code: "pr.failed",
      params: {
        detail: {
          code: "github.failed",
          params: { action: "createPr", status: 401, detail: "Bad credentials", hint: "token" },
        },
      },
    });
    expect(describeIn(pr, labels.ja)).toBe(
      "実装の実行が失敗：PRを作れませんでした：PRを作れませんでした：GitHub API 401 Bad credentials（トークンが無効です）",
    );
    expect(describeIn(pr, labels.en)).toBe(
      "Implement failed: Could not open the PR: Could not open the PR: GitHub API 401 Bad credentials (the token is invalid)",
    );
  });

  it("古い作業履歴の日本語の文や、エージェントの文は、そのまま表示する", () => {
    expect(describeIn(failed("デーモンが停止したため、実行が中断されました。"), labels.en)).toBe(
      "Implement failed: デーモンが停止したため、実行が中断されました。",
    );
    expect(describeIn(failed("API Error: 401 Invalid authentication"), labels.ja)).toBe(
      "実装の実行が失敗：API Error: 401 Invalid authentication",
    );
  });

  it("コンテキストの注意も、画面の言語の文にする", () => {
    const resolved = event({
      type: "ContextResolved",
      payload: {
        runId: "r",
        layers: [{ repo: "c.git", commit: "a".repeat(40) }],
        warnings: [
          {
            code: "context.lockedOverride",
            params: { from: "t@1", kind: "skills", name: "review", lockedBy: "c@2" },
          },
        ],
      },
    });
    expect(describeIn(resolved, labels.en)).toContain(
      'notes: t@1 tried to override the skill "review", but c@2 locks it, so the upper one was used.',
    );
  });
});

describe("一時停止・中止の操作（PBI-12）", () => {
  it("完了したタスクと中止したタスクには出さない", () => {
    const done = task({
      status: "idle",
      steps: [
        { key: "requirements", state: "done" },
        { key: "design", state: "done" },
        { key: "implement", state: "done" },
        { key: "pr", state: "done" },
      ],
    });
    expect(canControl(done)).toBe(false);
    expect(canControl(task({ status: "cancelled" }))).toBe(false);
    expect(canControl(task({ status: "running" }))).toBe(true);
    expect(canControl(task({ status: "awaiting_approval" }))).toBe(true);
  });
});

describe("PR で判断する成果物チェック（PBI-14a）", () => {
  const atPrGate = (state: Task["pullRequestState"]) =>
    task({
      status: "awaiting_approval",
      gate: { step: "pr", submission: 1 },
      pullRequestState: state,
    });
  it("PR の状態に合わせて、状態を表示する", () => {
    expect(statusText(atPrGate("open"))).toBe("PR のマージ待ち");
    expect(statusText(atPrGate("closed"))).toBe("PR が閉じられた（判断待ち）");
    expect(statusText(atPrGate("merged_outdated"))).toBe("古い提出がマージされた（判断待ち）");
    // PR を作っていなければ、これまでどおり画面で承認する
    expect(statusText(atPrGate(undefined))).toBe("成果物チェック待ち");
    expect(statusTextIn(atPrGate("open"), labels.en)).toBe("Awaiting PR merge");
  });

  it("作業履歴に、PR のマージ・クローズ・開き直しを表示する", () => {
    const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
      ({
        ...e,
        seq: 1,
        id: "e1",
        taskId: "t1",
        projectId: "default",
        at: "2026-10-11T00:00:00.000Z",
        actor: "person",
      }) as ActivityEvent;
    expect(
      describeEvent(event({ type: "PullRequestMerged", payload: { number: 7, by: "reviewer" } })),
    ).toBe("PR #7 がマージされた（reviewer）→ 成果物チェックを承認");
    expect(describeEvent(event({ type: "PullRequestClosed", payload: { number: 7 } }))).toBe(
      "PR #7 がマージされずに閉じられた → 人間の判断待ち",
    );
  });
});

describe("PR の指摘の取り込み（PBI-14b）", () => {
  it("判断中・戻し先の確認待ちを表示する", () => {
    expect(
      statusText(
        task({
          status: "awaiting_approval",
          gate: { step: "pr", submission: 1 },
          pendingReview: { keys: ["comment:1"], remarks: ["x"] },
        }),
      ),
    ).toBe("ゴールガーディアンが PR の指摘を判断中");
    expect(
      statusText(
        task({
          status: "escalated",
          gate: { step: "pr", submission: 1 },
          escalation: {
            step: "pr",
            target: "design",
            pendingRemarks: [],
            reason: "rework_confirmation",
          },
        }),
      ),
    ).toBe("PR の指摘の戻し先の確認待ち");
  });
});

describe("オーケストレーターが選んだ工程（PBI-17）", () => {
  it("作業履歴に、選んだ工程と理由を表示する", () => {
    const event = {
      type: "StepsChosen",
      payload: {
        steps: ["requirements", "implement", "pr"],
        plan: "skip-design",
        reason: "小さな変更",
        fallback: false,
        costUsd: 0,
        estimated: false,
      },
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-11T00:00:00.000Z",
      actor: "orchestrator",
    } as ActivityEvent;
    expect(describeEvent(event)).toBe("工程を決定：要求要件 → 実装 → PR作成（小さな変更）");
  });
});

describe("調査の工程（PBI-18）", () => {
  it("作業履歴に、Issue へのコメントを表示する", () => {
    const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
      ({
        ...e,
        seq: 1,
        id: "e1",
        taskId: "t1",
        projectId: "default",
        at: "2026-10-11T00:00:00.000Z",
        actor: "sacty",
      }) as ActivityEvent;
    expect(
      describeEvent(event({ type: "IssueCommented", payload: { url: "https://x/issues/5#c" } })),
    ).toBe("調査の結果を Issue にコメントした（https://x/issues/5#c）");
    expect(statusText(task({ steps: [{ key: "investigate", state: "done" }] }))).toBe("完了");
  });
});

describe("レビューの工程（PBI-19）", () => {
  it("作業履歴に、対象の PR の確認とレビューの投稿を表示する", () => {
    const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
      ({
        ...e,
        seq: 1,
        id: "e1",
        taskId: "t1",
        projectId: "default",
        at: "2026-10-11T00:00:00.000Z",
        actor: "sacty",
      }) as ActivityEvent;
    expect(
      describeEvent(
        event({
          type: "ReviewTargetResolved",
          payload: {
            repo: "acme/app",
            number: 12,
            url: "https://github.com/acme/app/pull/12",
            title: "再試行",
            body: "",
            headCommit: "abcdef1234".padEnd(40, "0"),
            baseCommit: "b".repeat(40),
          },
        }),
      ),
    ).toBe("レビューの対象の PR を確認（https://github.com/acme/app/pull/12・abcdef1）");
    expect(
      describeEvent(
        event({ type: "PullRequestReviewPosted", payload: { url: "https://x/pull/12#r" } }),
      ),
    ).toBe("レビューを PR に投稿した（https://x/pull/12#r）");
    expect(statusText(task({ steps: [{ key: "review", state: "done" }] }))).toBe("完了");
  });
});

describe("テストのコマンドの表示（PBI-28）", () => {
  const withSteps = (...keys: Task["steps"][number]["key"][]) =>
    ({ steps: keys.map((key) => ({ key, state: "todo" })) }) as unknown as Task;

  it("工程に実装があるタスクだけに出す（調査・レビュー・分割の親・工程を選ぶ前には出さない）", () => {
    expect(usesTestCommand(withSteps("requirements", "design", "implement", "pr"))).toBe(true);
    expect(usesTestCommand(withSteps("requirements", "implement", "pr"))).toBe(true);
    expect(usesTestCommand(withSteps("investigate"))).toBe(false);
    expect(usesTestCommand(withSteps("review"))).toBe(false);
    expect(usesTestCommand(withSteps("requirements", "design", "split"))).toBe(false);
    expect(usesTestCommand(withSteps())).toBe(false);
  });
});

describe("再現の表示（PBI-29）", () => {
  it("再現できなかったときは承認待ちではなく判断待ちと出し、作業履歴に結果を出す", () => {
    expect(
      statusText(task({ status: "awaiting_approval", gate: { step: "reproduce", submission: 1 } })),
    ).toBe("再現できなかった（判断待ち）");
    // 再現のテストを実行している間は作業中（画面を自動で更新する）
    const checking = task({ status: "idle", reproductionPending: true });
    expect(isWorking(checking)).toBe(true);
    expect(statusText(checking)).toBe("テストを実行中");
    const event = (payload: Record<string, unknown>) =>
      ({
        type: "ReproductionChecked",
        payload: { tests: [], output: "", durationMs: 0, ...payload },
        actor: "sacty",
      }) as unknown as ActivityEvent;
    expect(describeEvent(event({ reproduced: true, exitCode: 1 }))).toBe(
      "再現を確認：再現のテストが失敗した（終了コード 1）→ 実装へ",
    );
    expect(describeEvent(event({ reproduced: false, exitCode: 0 }))).toBe(
      "再現できなかった（テストが通った・終了コード 0）→ 人間の判断待ち",
    );
    expect(
      describeEvent(event({ reproduced: false, note: { code: "reproduce.noTests" } })),
    ).toMatch(/^再現できなかった（再現のエージェントが、再現のテストを申告しませんでした/);
    expect(describeIn(event({ reproduced: true, exitCode: 1 }), labels.en)).toBe(
      "Reproduced: the reproduction test failed (exit code 1) → implement",
    );
    expect(
      describeEvent({
        type: "StepCompleted",
        payload: { step: "investigate", next: "queued" },
        actor: "sacty",
      } as unknown as ActivityEvent),
    ).toBe("調査を完了（前段の調査のため承認なし）→ 次の工程へ");
  });
});
