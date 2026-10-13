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
  statusTone,
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
  integrationFailures: 0,
  misses: [],
  importedFeedback: [],
  questions: [],
  exports: {},
  stepPullRequests: [],
  stepBranches: [],
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
    ).toBe("PR #7 がマージされた（reviewer）→ 承認");
    expect(describeEvent(event({ type: "PullRequestClosed", payload: { number: 7 } }))).toBe(
      "PR #7 がマージされずに閉じられた → 人間の判断待ち",
    );
  });
});

describe("要求要件・設計の PR（PBI-57）", () => {
  const pr = (state: Task["stepPullRequests"][number]["state"], submission = 1) =>
    task({
      status: "awaiting_approval",
      gate: { step: "design", submission },
      stepPullRequests: [
        {
          step: "design",
          branch: "sacty/task-t1-design-1",
          commit: "c",
          base: "b",
          path: "docs/sacty/t1/design.md",
          url: "https://github.com/acme/app/pull/8",
          number: 8,
          repo: "https://github.com/acme/app",
          submission,
          state,
        },
      ],
    });
  it("PR を作った工程は、PR の状態に合わせて表示する。PR が無ければ、これまでどおり承認待ち", () => {
    expect(statusText(pr("open"))).toBe("設計の PR のマージ待ち");
    expect(statusText(pr("open", 2))).toBe("設計の PR のマージ待ち（2回目）");
    expect(statusText(pr("closed"))).toBe("PR が閉じられた（判断待ち）");
    expect(statusText(pr("merged_outdated"))).toBe("古い提出がマージされた（判断待ち）");
    expect(statusTextIn(pr("open"), labels.en)).toBe("Design PR awaiting merge");
    expect(
      statusText(task({ status: "awaiting_approval", gate: { step: "design", submission: 1 } })),
    ).toBe("設計の承認待ち");
  });

  it("作業履歴に、タスクブランチと工程の PR を表示する", () => {
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
          type: "TaskBranchCreated",
          payload: { branch: "sacty/task-t1", commit: "a".repeat(40) },
        }),
      ),
    ).toBe("タスクブランチを作成（sacty/task-t1・aaaaaaa）");
    expect(
      describeEvent(
        event({
          type: "StepPullRequestPublished",
          payload: {
            step: "design",
            branch: "sacty/task-t1-design-2",
            commit: "c",
            base: "b",
            path: "docs/sacty/t1/design.md",
            url: "u",
            number: 10,
            repo: "r",
            supersedes: 8,
          },
        }),
      ),
    ).toBe("設計の PR を作成・更新（#10・docs/sacty/t1/design.md）。作り直したので PR #8 を閉じた");
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

  it("工程ごとのイメージと、決めたのが誰か（理由）も表示する（PBI-41）", () => {
    const chosen = (payload: Record<string, unknown>) =>
      ({
        type: "StepsChosen",
        payload: {
          steps: ["requirements", "implement", "pr"],
          reason: "小さな変更",
          fallback: false,
          costUsd: 0,
          estimated: false,
          ...payload,
        },
        seq: 1,
        id: "e1",
        taskId: "t1",
        projectId: "default",
        at: "2026-10-11T00:00:00.000Z",
        actor: "orchestrator",
      }) as ActivityEvent;
    expect(
      describeEvent(
        chosen({
          images: { implement: "java17", pr: "java17" },
          imageSource: "orchestrator",
          imageReason: "pom.xml が Java 17",
        }),
      ),
    ).toBe(
      "工程を決定：要求要件 → 実装 → PR作成（小さな変更） / イメージ：実装＝java17、PR作成＝java17（オーケストレーター：pom.xml が Java 17）",
    );
    expect(
      describeIn(chosen({ images: { implement: "py" }, imageSource: "project" }), labels.en),
    ).toContain("images: Implement=py (set on the project target)");
  });

  it("サービスの起動を表示する（PBI-47）", () => {
    const started = (forTests?: boolean, sharedPorts?: number[]) =>
      ({
        type: "ServicesStarted",
        payload: {
          runId: "r",
          step: "implement",
          file: "compose.yaml",
          services: [
            { name: "db", ports: [5432] },
            { name: "mock", ports: [] },
          ],
          ...(forTests ? { forTests } : {}),
          ...(sharedPorts ? { sharedPorts } : {}),
        },
        seq: 1,
        id: "e1",
        taskId: "t1",
        projectId: "default",
        at: "2026-10-11T00:00:00.000Z",
        actor: "sacty",
      }) as ActivityEvent;
    expect(describeEvent(started())).toBe(
      "実装のためにサービスを起動：db、mock（compose.yaml。実行の後に消す）",
    );
    expect(describeEvent(started(true))).toBe(
      "実装のテストのためにサービスを起動：db、mock（compose.yaml。実行の後に消す）",
    );
    // 複数のサービスが使うため、localhost に転送しなかったポート（PBI-60）
    expect(describeEvent(started(false, [8080, 9000]))).toBe(
      "実装のためにサービスを起動：db、mock（compose.yaml。実行の後に消す） / 複数のサービスが使うため localhost に転送しないポート：8080、9000",
    );
    // ホストに出すポートからの転送（PBI-60）
    const withHostPorts = {
      ...started(),
      payload: {
        runId: "r",
        step: "implement",
        file: "compose.yaml",
        services: [
          { name: "db", ports: [5432], hostPorts: [{ port: 15432, target: 5432 }] },
          { name: "mock", ports: [] },
        ],
      },
    } as ActivityEvent;
    expect(describeEvent(withHostPorts)).toBe(
      "実装のためにサービスを起動：db（localhost:15432 → db:5432）、mock（compose.yaml。実行の後に消す）",
    );
    expect(describeIn(withHostPorts, labels.en)).toContain("db (localhost:15432 → db:5432)");
    expect(describeIn(started(false, [8080]), labels.en)).toContain(
      "not forwarded to localhost because several services use them: 8080",
    );
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

describe("統合レビューの表示（PBI-31）", () => {
  const review = (passed: boolean) =>
    ({
      passed,
      baseBranch: "main",
      commit: "c".repeat(40),
      viewpoints: [],
      remarks: [],
      findings: passed ? [] : ["つなぐ", "表示する"],
      summary: "",
      at: "",
    }) as Task["integration"];
  it("合格なら統合レビューの承認待ち、続けて通らなければ判断待ちと出し、作業履歴に結果を出す", () => {
    const gate = {
      status: "awaiting_approval" as const,
      gate: { step: "integrate" as const, submission: 1 },
    };
    expect(statusText(task({ ...gate, integration: review(true) }))).toBe("統合レビューの承認待ち");
    expect(statusText(task({ ...gate, integration: review(false) }))).toBe(
      "統合レビューに通らない（判断待ち）",
    );
    const event = (passed: boolean) =>
      ({
        type: "IntegrationReviewed",
        payload: review(passed),
        actor: "guardian",
      }) as unknown as ActivityEvent;
    expect(describeEvent(event(true))).toBe("統合レビュー（main・ccccccc）：合格 → 人間の承認待ち");
    expect(describeEvent(event(false))).toBe(
      "統合レビュー（main・ccccccc）：不合格（足りないこと2件）",
    );
    expect(describeIn(event(false), labels.en)).toBe(
      "Integration review (main · ccccccc): failed (2 missing items)",
    );
  });
});

describe("オーケストレーターの失敗の表示（PBI-32）", () => {
  it("止まった理由と、使った分の費用を作業履歴に出す", () => {
    const event = {
      type: "OrchestratorFailed",
      payload: {
        reason: "usage_limit",
        message: { code: "orchestrator.failed", params: { detail: "ThrottlingException" } },
        agentId: "codex-bedrock",
        costUsd: 0.3,
        estimated: false,
      },
      actor: "orchestrator",
    } as unknown as ActivityEvent;
    expect(describeEvent(event)).toBe(
      "オーケストレーターを実行できませんでした：ThrottlingException。再開すると、工程の選択からやり直します。（$0.3000）",
    );
  });
});

describe("ゲートウェイのリトライの表示（PBI-37）", () => {
  it("リトライした回数・原因・待った時間と、あきらめたかを出す", () => {
    const event = (gaveUp: boolean) =>
      ({
        type: "AiRequestsRetried",
        payload: {
          runId: "r",
          agentId: "a",
          retries: 3,
          waitedMs: 21_400,
          statuses: [429, 0],
          gaveUp,
        },
        actor: "sacty",
      }) as unknown as ActivityEvent;
    expect(describeEvent(event(false))).toBe(
      "ゲートウェイが AI の呼び出しを3回リトライ（429, connection・合計21秒待った）",
    );
    expect(describeEvent(event(true))).toBe(
      "ゲートウェイが AI の呼び出しを3回リトライ（429, connection・合計21秒待った）→ 上限に達したため、あきらめた",
    );
    expect(describeIn(event(true), labels.en)).toBe(
      "The gateway retried the AI call 3 times (429, connection; waited 21s in total) → gave up at the limit",
    );
  });
});

describe("状態の表示の種類（PBI-42）", () => {
  it("完了と中止を、ほかの状態とも別の種類にする", () => {
    const done = task({ steps: [{ key: "investigate", state: "done" }] });
    expect(statusText(done)).toBe("完了");
    expect(statusTone(done)).toBe("completed");
    expect(statusTone(task({ status: "cancelled" }))).toBe("cancelled");
  });

  it("AI・sacty が進めている状態は working", () => {
    expect(statusTone(task({ status: "running" }))).toBe("working");
    expect(statusTone(task({ status: "waiting_children" }))).toBe("working");
    // テストの実行を待っている idle（完了していない）
    const verifying = task({
      steps: [{ key: "implement", state: "active" }],
      verification: "pending",
    });
    expect(statusText(verifying)).toBe("テストを実行中");
    expect(statusTone(verifying)).toBe("working");
  });

  it("順番・依存を待っている状態は waiting", () => {
    expect(statusTone(task({ status: "queued" }))).toBe("waiting");
    expect(statusTone(task({ status: "blocked" }))).toBe("waiting");
  });

  it("人の出番は person", () => {
    expect(statusTone(task({ status: "paused" }))).toBe("person");
    expect(statusTone(task({ status: "escalated" }))).toBe("person");
    expect(
      statusTone(task({ status: "awaiting_approval", gate: { step: "design", submission: 1 } })),
    ).toBe("person");
  });

  it("ゴールガーディアンが PR の指摘を判断している間は、承認待ちでも working", () => {
    const judging = task({
      status: "awaiting_approval",
      gate: { step: "pr", submission: 1 },
      pendingReview: { keys: ["comment:1"], remarks: ["x"] },
    });
    expect(statusText(judging)).toBe("ゴールガーディアンが PR の指摘を判断中");
    expect(statusTone(judging)).toBe("working");
  });
});

describe("PR のレビューの取り込み（PBI-44）", () => {
  const ev = (type: string, payload: Record<string, unknown>, actor = "sacty") =>
    ({
      type,
      payload,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-11T00:00:00.000Z",
      actor,
    }) as ActivityEvent;
  it("PR のマージ・クローズで中止した理由と、再レビューを表示する", () => {
    expect(describeEvent(ev("TaskCancelled", { reason: "pull_request_merged", cleanup: [] }))).toBe(
      `${describeEvent(ev("TaskCancelled", { cleanup: [] }))}（PR がマージされたため）`,
    );
    expect(
      describeEvent(ev("TaskCancelled", { reason: "pull_request_closed", cleanup: [] })),
    ).toContain("（PR が閉じられたため）");
    expect(describeEvent(ev("ReviewRestarted", {}, "person"))).toBe(
      "再レビューを始めた（PR の最新のコミットをレビューする。人間）",
    );
    expect(
      describeIn(ev("TaskCancelled", { reason: "pull_request_merged", cleanup: [] }), labels.en),
    ).toContain("(the PR was merged)");
  });
});

describe("オーケストレーターへの質問の作業履歴（PBI-54）", () => {
  const event = (e: Pick<ActivityEvent, "type" | "payload" | "actor">): ActivityEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-13T00:00:00.000Z",
    }) as ActivityEvent;

  it("質問の本文・答えは作業履歴に出さず、ID・費用・答えられなかった理由を出す", () => {
    expect(
      describeEvent(
        event({
          type: "QuestionAsked",
          actor: "person",
          payload: { questionId: "Q-1", text: "本文は出さない" },
        }),
      ),
    ).toBe("オーケストレーターに質問した（Q-1・人間）");
    const answered = (payload: Record<string, unknown>) =>
      event({
        type: "QuestionAnswered",
        actor: "orchestrator",
        payload: {
          questionId: "Q-1",
          runResult: "completed",
          agentId: "o",
          costUsd: 0.0123,
          estimated: false,
          ...payload,
        },
      } as Pick<ActivityEvent, "type" | "payload" | "actor">);
    expect(describeEvent(answered({ answer: "答えの本文" }))).toBe(
      "オーケストレーターが質問に答えた（Q-1・$0.0123）",
    );
    expect(describeEvent(answered({ failed: { code: "chat.emptyAnswer" } }))).toBe(
      "オーケストレーターが質問に答えられなかった（Q-1・$0.0123）：オーケストレーターの答えが空でした。",
    );
    expect(describeIn(answered({ answer: "x" }), labels.en)).toBe(
      "The Orchestrator answered the question (Q-1, $0.0123)",
    );
  });
});

describe("成果の書き出しの作業履歴（PBI-56）", () => {
  const event = (e: Pick<ActivityEvent, "type" | "payload" | "actor">): ActivityEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-13T00:00:00.000Z",
    }) as ActivityEvent;
  const exported = (payload: Record<string, unknown>) =>
    event({
      type: "OutputExported",
      actor: "agent",
      payload: {
        step: "requirements",
        runId: "x1",
        approvedAt: "a",
        submission: 1,
        via: "platform",
        name: "confluence",
        agentId: "a",
        costUsd: 0.015,
        estimated: false,
        ...payload,
      },
    } as Pick<ActivityEvent, "type" | "payload" | "actor">);

  it("工程ごとの書き出し先（書き出さないことも含む）と理由を、工程の決定の行に出す", () => {
    const chosen = event({
      type: "StepsChosen",
      actor: "orchestrator",
      payload: {
        steps: ["requirements", "design", "implement", "pr"],
        fallback: false,
        costUsd: 0,
        estimated: false,
        exports: {
          requirements: {
            to: { via: "platform", name: "confluence", location: "DEV" },
            reason: "規約",
          },
          design: { reason: { code: "export.notDecided" } },
        },
      },
    } as Pick<ActivityEvent, "type" | "payload" | "actor">);
    expect(describeEvent(chosen)).toBe(
      "工程を決定：要求要件 → 設計 → 実装 → PR作成 / 書き出し：要求要件＝confluence：DEV（規約）、設計＝書き出さない（オーケストレーターが書き出し先を決めなかったため、書き出しません。）",
    );
  });

  it("書き出した URL・書き出せなかった理由・中断と費用を出す", () => {
    expect(describeEvent(exported({ url: "https://wiki/1", runResult: "completed" }))).toBe(
      "要求要件を confluence に書き出した（https://wiki/1・$0.0150）",
    );
    expect(
      describeEvent(
        exported({
          failed: { code: "export.failed", params: { detail: "権限が無い" } },
          runResult: "completed",
        }),
      ),
    ).toBe(
      "要求要件を confluence に書き出せなかった（$0.0150）：書き出せませんでした：権限が無い。",
    );
    expect(
      describeEvent(exported({ failed: { code: "export.stopped" }, runResult: "interrupted" })),
    ).toBe(
      "要求要件の confluence への書き出しを中断した（$0.0150）：人間が止めたため、書き出しを中断しました。",
    );
    expect(
      describeEvent(
        event({ type: "ExportRequested", actor: "person", payload: { step: "design" } }),
      ),
    ).toBe("設計の書き出し直しを求めた（人間）");
    expect(describeIn(exported({ url: "https://wiki/1", runResult: "completed" }), labels.en)).toBe(
      "Exported the Requirements to confluence (https://wiki/1, $0.0150)",
    );
  });
});
