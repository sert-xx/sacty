import type { ActivityEvent, Task, TaskProposal } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { labels } from "@/i18n/messages/labels";
import { task as taskMessages } from "@/i18n/messages/task";
import {
  addedTestsResult,
  canControl,
  describeEventParts,
  describeEvent as describeIn,
  judgedByGoalForCurrent,
  needsPerson,
  personAction as personActionIn,
  statusText as statusTextIn,
  statusTone,
  stepImageOptions,
  stepImageRows,
  testCommandOfNoTests,
  usesTestCommand,
  verificationResults,
} from "./labels";
import { runLogId } from "./session-log";

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
  errorAnalyses: [],
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
  it("ゴールガーディアンの判定中・最終レビュー中は、待機（idle）でもそれと分かるように出す", () => {
    expect(statusText(task({ proposals: [proposal()] }))).toBe("ゴールガーディアンが判定中");
    // 実装の検証中（テスト・最終レビュー）は、待機（idle）のまま（PBI-10a）
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
    // 差し戻しの上限によるエスカレーションと承認待ちは、承認の画面へ
    expect(personAction(task({ status: "escalated" })).href).toBe("/tasks/t1/review");
    expect(personAction(task({ status: "awaiting_approval" }))).toEqual({
      href: "/tasks/t1/review",
      label: "チェックする",
    });
    expect(personAction(task({ status: "paused" })).href).toBe("/tasks/t1");
  });
});

describe("実装の承認の表示（PBI-10b・PBI-110）", () => {
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
      describeEventParts(
        event({
          type: "ChangesRequested",
          payload: {
            step: "implement",
            target,
            round: 1,
            remarks: [{ id: "x", text: "y" }],
            overLimit: false,
          },
        }),
        ja,
      ).text;
    expect(back("implement")).toBe("実装を差し戻し：指摘1件（人間）");
    // 原因を決めた差し戻しは、原因を添える（PBI-268）
    const because = (cause: "guardian_missed" | "base_changed" | "new_request") =>
      describeEventParts(
        event({
          type: "ChangesRequested",
          payload: {
            step: "implement",
            target: "implement",
            cause,
            round: 1,
            remarks: [{ id: "x", text: "y" }],
            overLimit: false,
          },
        }),
        ja,
      ).text;
    expect(because("guardian_missed")).toBe(
      "実装を差し戻し：指摘1件（人間）（原因：ゴールガーディアンの見逃し）",
    );
    expect(because("base_changed")).toBe(
      "実装を差し戻し：指摘1件（人間）（原因：ベースの変化による競合）",
    );
    expect(because("new_request")).toBe(
      "実装を差し戻し：指摘1件（人間）（原因：新しい要望・方針の変更）",
    );
    expect(back("design")).toBe(
      "実装を差し戻し、設計からやり直し（設計の承認を取り消し）：指摘1件（人間）",
    );
    expect(
      describeEvent(
        event({ type: "StepSubmitted", payload: { step: "implement", submission: 2 } }),
      ),
    ).toBe("実装を提出（2回目）");
    expect(
      describeEvent(event({ type: "StepApproved", payload: { step: "implement", next: "idle" } })),
    ).toBe("実装を承認・凍結（人間）");
  });

  it("作成の行に、進め方の工程ごとに人が指定したイメージ・エージェントを出す", () => {
    const created = (payload: Record<string, unknown>) =>
      describeEvent(
        event({
          type: "TaskCreated",
          payload: { title: "t", body: "", start: "sacty", budgetCapUsd: 1, ...payload },
        } as unknown as Pick<ActivityEvent, "type" | "payload">),
      );
    expect(created({ plan: "standard" })).toBe("タスクを作成（人間）");
    expect(
      created({
        plan: "standard",
        images: { design: "java17", implement: "java17" },
        agents: { implement: "codex_advanced" },
      }),
    ).toBe(
      "タスクを作成（人間） / イメージの指定：設計＝java17、実装＝java17 / エージェントの指定：実装＝codex_advanced",
    );
  });

  it("差し戻しの行は、人が書いた指摘の本文を、1件ずつ詳細に出す", () => {
    const requested = event({
      type: "ChangesRequested",
      payload: {
        step: "requirements",
        round: 2,
        remarks: [
          { id: "requirements-2-1", text: "異常系を詳しく" },
          { id: "requirements-2-2", text: "移行の手順を書いて" },
        ],
        overLimit: false,
      },
    });
    expect(describeEventParts(requested, ja)).toEqual({
      text: "要求要件を差し戻し：指摘2件（人間）",
      detail: "requirements-2-1：異常系を詳しく\nrequirements-2-2：移行の手順を書いて",
    });
    expect(describeEventParts(requested, labels.en).detail).toBe(
      "requirements-2-1: 異常系を詳しく\nrequirements-2-2: 移行の手順を書いて",
    );
  });

  it("再開で足した補足は、再開の行に「補足あり」を付け、本文を詳細に出す（日英）", () => {
    const resumed = event({
      type: "TaskResumed",
      payload: { retry: true, note: "ACME_TOKEN を使う" },
    });
    expect(describeEventParts(resumed, ja)).toEqual({
      text: "再開（人間）・補足あり",
      detail: "ACME_TOKEN を使う",
    });
    expect(describeEventParts(resumed, labels.en)).toEqual({
      text: "Resumed (person), with notes",
      detail: "ACME_TOKEN を使う",
    });
    // 工程の選択からやり直す再開でも、区切りのコロンを続けない
    const rechosen = event({
      type: "TaskResumed",
      payload: { retry: true, rechooseSteps: true, note: "補足" },
    });
    expect(describeEventParts(rechosen, ja).text).toBe(
      "再開（人間）：工程の選択からやり直します・補足あり",
    );
  });

  it("人がテストの扱いを決めた記録と、工程の選択からやり直す再開を、日英で作業履歴に出す", () => {
    expect(
      describeEvent(event({ type: "TestsDecided", payload: { testCommand: "make check" } })),
    ).toBe("テストのコマンドを make check に決定（人間）");
    expect(
      describeEvent(event({ type: "TestsDecided", payload: { noTestsReason: "スキル集" } })),
    ).toBe("テストなしで進めると決定（人間）：スキル集");
    expect(
      describeEvent(event({ type: "TaskResumed", payload: { retry: true, rechooseSteps: true } })),
    ).toBe("再開（人間）：工程の選択からやり直します");
    expect(describeEvent(event({ type: "TaskResumed", payload: { retry: true } }))).toBe(
      "再開（人間）",
    );
    expect(
      describeIn(
        event({ type: "TestsDecided", payload: { noTestsReason: "docs only" } }),
        labels.en,
      ),
    ).toBe("Decided to proceed without tests (person): docs only");
  });

  it("実装の承認待ちと完了を表示する", () => {
    expect(
      statusText(task({ status: "awaiting_approval", gate: { step: "implement", submission: 1 } })),
    ).toBe("実装の承認待ち");
    const done = task({
      steps: [{ key: "requirements", state: "done" }],
    });
    expect(statusText(done)).toBe("完了");
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
      statusTextIn(
        task({ status: "awaiting_approval", gate: { step: "implement", submission: 2 } }),
        en,
      ),
    ).toBe("Implement awaiting approval (submission 2)");
    expect(
      statusTextIn(
        task({ status: "awaiting_approval", gate: { step: "requirements", submission: 1 } }),
        en,
      ),
    ).toBe("Requirements awaiting approval");
    expect(personActionIn(task({ status: "awaiting_approval" }), en).label).toBe("Review");
    expect(
      describeEventParts(
        event({
          type: "ChangesRequested",
          payload: {
            step: "implement",
            target: "design",
            round: 1,
            remarks: [{ id: "x", text: "y" }],
            overLimit: false,
          },
        }),
        en,
      ).text,
    ).toBe(
      "Changes requested on Implement; redo from Design (Design approval revoked): 1 comment (person)",
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
      "中止（人間）：実行中のコンテナ・Sacty が作ったブランチを片付けた／失敗：Sacty が作った PR",
    );
    expect(describeIn(cancelled, labels.en)).toBe(
      "Cancelled (person): cleaned up Running container, Branch created by Sacty; failed: PR opened by Sacty",
    );
    expect(statusText(task({ status: "cancelled" }))).toBe("中止");
    expect(needsPerson(task({ status: "cancelled" }))).toBe(false);
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
      ],
    });
    expect(canControl(done)).toBe(false);
    expect(canControl(task({ status: "cancelled" }))).toBe(false);
    expect(canControl(task({ status: "running" }))).toBe(true);
    expect(canControl(task({ status: "awaiting_approval" }))).toBe(true);
  });
});

describe("PR で判断する実装の承認（PBI-14a・PBI-110）", () => {
  const atPrGate = (state: Task["pullRequestState"]) =>
    task({
      status: "awaiting_approval",
      gate: { step: "implement", submission: 1 },
      pullRequestState: state,
    });
  it("PR の状態に合わせて、状態を表示する", () => {
    expect(statusText(atPrGate("open"))).toBe("実装の PR のマージ待ち");
    expect(statusText(atPrGate("closed"))).toBe("PR が閉じられた・判断待ち");
    expect(statusText(atPrGate("merged_outdated"))).toBe("別の内容でマージ・承認へ");
    // PR を作っていなければ、これまでどおり画面で承認する
    expect(statusText(atPrGate(undefined))).toBe("実装の承認待ち");
    expect(statusTextIn(atPrGate("open"), labels.en)).toBe("Implement PR awaiting merge");
  });

  it("ベースブランチと競合しているときは、競合を状態に出す", () => {
    const conflicting = (submission = 1) =>
      task({
        status: "awaiting_approval",
        gate: { step: "implement", submission },
        pullRequest: { branch: "b", commit: "c1", url: "u", number: 7 },
        pullRequestState: "open",
        pullRequestConflict: { number: 7, commit: "c1", at: "2026-10-10T00:00:00.000Z" },
      });
    expect(statusText(conflicting())).toBe("実装の PR がベースブランチと競合");
    expect(statusText(conflicting(2))).toBe("実装の PR がベースブランチと競合（2回目）");
    expect(statusTextIn(conflicting(), labels.en)).toBe(
      "Implement PR conflicts with the base branch",
    );
    // 競合を出しても人の出番のまま
    expect(statusTone(conflicting())).toBe("person");
  });

  it("作業履歴に、PR の競合と解消を表示する", () => {
    const event = (e: Pick<ActivityEvent, "type" | "payload">): ActivityEvent =>
      ({
        ...e,
        seq: 1,
        id: "e1",
        taskId: "t",
        projectId: "p",
        at: "",
        actor: "sacty",
      }) as ActivityEvent;
    expect(
      describeEvent(event({ type: "PullRequestConflicted", payload: { number: 7 } } as never)),
    ).toBe("PR #7 がベースブランチと競合している（取り込みは、差し戻しか指摘のときに行う）");
    expect(
      describeEvent(
        event({ type: "PullRequestConflictResolved", payload: { number: 7 } } as never),
      ),
    ).toBe("PR #7 の競合が解消された");
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
    ).toBe("PR #7 がマージされ、承認（reviewer）");
    // 前の版の作業履歴（古い内容でのマージ）も読める
    expect(
      describeEvent(event({ type: "PullRequestMerged", payload: { number: 7, outdated: true } })),
    ).toBe("PR #7 が最新の提出より前の内容でマージされた・判断待ち");
    // 人が直してからのマージは、両方のコミットと、成果のファイルを読めなかったことを出す（PBI-63）
    const edited = (document?: { path: string; fallback?: "deleted" | "unreadable" }) =>
      event({
        type: "PullRequestMerged",
        payload: {
          number: 7,
          by: "reviewer",
          commit: "e".repeat(40),
          submitted: "a".repeat(40),
          edited: true,
          ...(document ? { document } : {}),
        },
      });
    expect(describeEvent(edited())).toBe(
      "PR #7 が人の直した内容でマージされ、承認（reviewer）（aaaaaaa → eeeeeee）",
    );
    expect(describeEvent(edited({ path: "d.md", fallback: "deleted" }))).toContain(
      "成果のファイルが消されていたため、Sacty の版を承認済みにした",
    );
    expect(describeEvent(edited({ path: "d.md", fallback: "unreadable" }))).toContain(
      "成果のファイルを読めなかったため",
    );
    expect(describeIn(edited(), labels.en)).toBe(
      "PR #7 was merged with a person's edits and approved (reviewer) (aaaaaaa → eeeeeee)",
    );
    expect(describeEvent(event({ type: "PullRequestClosed", payload: { number: 7 } }))).toBe(
      "PR #7 がマージされずに閉じられた・判断待ち",
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
    expect(statusText(pr("closed"))).toBe("PR が閉じられた・判断待ち");
    expect(statusText(pr("merged_outdated"))).toBe("別の内容でマージ・承認へ");
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
    ).toBe("設計の PR を作成・更新（#10・docs/sacty/t1/design.md）。PR #8 を閉じた");
  });
});

describe("PR の指摘の取り込み（PBI-14b）", () => {
  it("判断中・戻し先の確認待ちを表示する", () => {
    expect(
      statusText(
        task({
          status: "awaiting_approval",
          gate: { step: "implement", submission: 1 },
          pendingReview: { keys: ["comment:1"], remarks: ["x"] },
        }),
      ),
    ).toBe("ゴールガーディアンが PR の指摘を判断中");
    expect(
      statusText(
        task({
          status: "escalated",
          gate: { step: "implement", submission: 1 },
          escalation: {
            step: "implement",
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
        steps: ["requirements", "implement"],
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
    expect(describeEvent(event)).toBe("工程を決定：要求要件 → 実装（小さな変更）");
  });

  it("工程ごとのイメージと、決めたのが誰か（理由）も表示する（PBI-41）", () => {
    const chosen = (payload: Record<string, unknown>) =>
      ({
        type: "StepsChosen",
        payload: {
          steps: ["requirements", "implement"],
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
          images: { implement: "java17" },
          imageSource: "orchestrator",
          imageReason: "pom.xml が Java 17",
        }),
      ),
    ).toBe(
      "工程を決定：要求要件 → 実装（小さな変更） / イメージ：実装＝java17（オーケストレーター：pom.xml が Java 17）",
    );
    expect(
      describeIn(chosen({ images: { implement: "py" }, imageSource: "project" }), labels.en),
    ).toContain("images: Implement=py (set on the project target)");
    // 既定のイメージで動かす工程の、images のどれも合わない理由と、理由が無い工程（PBI-105）
    const defaults = chosen({
      images: { implement: "java17" },
      imageSource: "orchestrator",
      defaultImageReasons: { requirements: "文書だけ" },
      imagesUnexplained: ["investigate"],
    });
    expect(describeEvent(defaults)).toContain(
      " / 既定のイメージ：要求要件＝文書だけ / 理由なく既定のイメージ：調査",
    );
    expect(describeIn(defaults, labels.en)).toContain(
      " / Default image: Requirements: 文書だけ / Default image without a reason: Investigate",
    );
    // イメージを1つも書かなかったときも出す
    expect(describeEvent(chosen({ imagesUnexplained: ["implement"] }))).toBe(
      "工程を決定：要求要件 → 実装（小さな変更） / 理由なく既定のイメージ：実装",
    );
  });

  it("人が工程のイメージを変えた記録を、誰が・どの工程を・何から何にで表示する（PBI-106）", () => {
    const changed = {
      type: "StepImageChanged",
      payload: { step: "implement", from: "default", to: "playwright" },
      seq: 2,
      id: "e2",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-15T00:00:00.000Z",
      actor: "person",
    } as ActivityEvent;
    expect(describeEvent(changed)).toBe("実装のイメージを default から playwright に変更（人間）");
    expect(describeIn(changed, labels.en)).toBe(
      "Implement image changed from default to playwright (person)",
    );
  });

  it("サービスを使う・使わない判断と理由、どの共用の compose を使うかを表示する（PBI-70）", () => {
    const chosen = (payload: Record<string, unknown>) =>
      ({
        type: "StepsChosen",
        payload: {
          steps: ["implement"],
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
    // 共用の compose を設定していない・判断の理由も無いなら、これまでどおり
    expect(describeEvent(chosen({}))).toBe("工程を決定：実装（小さな変更）");
    // 共用の compose を使う
    const shared = chosen({
      sharedComposes: ["infra", "kafka"],
      services: {
        file: "compose/redis.yml",
        names: ["redis"],
        steps: ["implement"],
        compose: { name: "infra", repo: "https://github.com/acme/test-infra", ref: "main" },
      },
      servicesReason: "結合テストが Redis を使う",
    });
    expect(describeEvent(shared)).toBe(
      "工程を決定：実装（小さな変更） / サービス：redis（共用の compose「infra」の compose/redis.yml（https://github.com/acme/test-infra#main）。実装で使う）：結合テストが Redis を使う",
    );
    expect(describeIn(shared, labels.en)).toContain(
      'Services: redis (compose/redis.yml of the shared compose "infra" (https://github.com/acme/test-infra#main); used in Implement): 結合テストが Redis を使う',
    );
    // 対象リポジトリの compose（names が空ならすべて）
    expect(
      describeEvent(
        chosen({ services: { file: "compose.yaml", names: [], steps: ["implement"] } }),
      ),
    ).toBe("工程を決定：実装（小さな変更） / サービス：すべて（compose.yaml。実装で使う）");
    // 共用の compose を使わない（理由あり・なし）
    expect(
      describeEvent(chosen({ sharedComposes: ["infra"], servicesReason: "単体テストだけ" })),
    ).toBe("工程を決定：実装（小さな変更） / 共用の compose（infra）：使わない（単体テストだけ）");
    expect(describeEvent(chosen({ sharedComposes: ["infra", "kafka"] }))).toBe(
      "工程を決定：実装（小さな変更） / 共用の compose（infra、kafka）：使わない",
    );
    expect(describeIn(chosen({ sharedComposes: ["infra"] }), labels.en)).toContain(
      "Shared compose (infra): not used",
    );
  });

  it("共用の compose から起動したサービスは、どの共用の compose のどのコミットかを表示する（PBI-70）", () => {
    const event = {
      type: "ServicesStarted",
      payload: {
        runId: "r",
        step: "implement",
        file: "compose/redis.yml",
        services: [{ name: "redis", ports: [6379] }],
        compose: { name: "infra", commit: "abc1234def5678" },
      },
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-11T00:00:00.000Z",
      actor: "sacty",
    } as ActivityEvent;
    expect(describeEvent(event)).toBe(
      "実装のためにサービスを起動：redis（共用の compose「infra」の compose/redis.yml（abc1234））",
    );
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
    expect(describeEvent(started())).toBe("実装のためにサービスを起動：db、mock（compose.yaml）");
    expect(describeEvent(started(true))).toBe(
      "実装のテストのためにサービスを起動：db、mock（compose.yaml）",
    );
    // 複数のサービスが使うため、localhost に転送しなかったポート（PBI-60）
    expect(describeEvent(started(false, [8080, 9000]))).toBe(
      "実装のためにサービスを起動：db、mock（compose.yaml） / localhost に転送しないポート：8080、9000",
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
      "実装のためにサービスを起動：db（localhost:15432 → db:5432）、mock（compose.yaml）",
    );
    expect(describeIn(withHostPorts, labels.en)).toContain("db (localhost:15432 → db:5432)");
    expect(describeIn(started(false, [8080]), labels.en)).toContain(
      "not forwarded to localhost: 8080",
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
    expect(usesTestCommand(withSteps("requirements", "design", "implement"))).toBe(true);
    expect(usesTestCommand(withSteps("requirements", "implement"))).toBe(true);
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
    ).toBe("再現できなかった・判断待ち");
    // 再現のテストを実行している間（PBI-29）
    const checking = task({ status: "idle", reproductionPending: true });
    expect(statusText(checking)).toBe("テストを実行中");
    const event = (payload: Record<string, unknown>) =>
      ({
        type: "ReproductionChecked",
        payload: { tests: [], output: "", durationMs: 0, ...payload },
        actor: "sacty",
      }) as unknown as ActivityEvent;
    expect(describeEvent(event({ reproduced: true, exitCode: 1 }))).toBe(
      "再現を確認（終了コード 1）・実装へ",
    );
    expect(describeEvent(event({ reproduced: false, exitCode: 0 }))).toBe(
      "再現できなかった（テストが通った・終了コード 0）・判断待ち",
    );
    expect(
      describeEvent(event({ reproduced: false, note: { code: "reproduce.noTests" } })),
    ).toMatch(/^再現できなかった（再現のエージェントが、再現のテストを申告しませんでした/);
    expect(describeIn(event({ reproduced: true, exitCode: 1 }), labels.en)).toBe(
      "Reproduced (exit code 1) · on to Implement",
    );
    expect(
      describeEvent({
        type: "StepCompleted",
        payload: { step: "investigate", next: "queued" },
        actor: "sacty",
      } as unknown as ActivityEvent),
    ).toBe("調査を完了（承認なし）");
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
      "統合レビュー不合格・判断待ち",
    );
    const event = (passed: boolean) =>
      ({
        type: "IntegrationReviewed",
        payload: review(passed),
        actor: "guardian",
      }) as unknown as ActivityEvent;
    expect(describeEvent(event(true))).toBe("統合レビュー（main・ccccccc）：合格・承認待ち");
    expect(describeEvent(event(false))).toBe("統合レビュー（main・ccccccc）：不合格（2件）");
    expect(describeIn(event(false), labels.en)).toBe(
      "Integration review (main · ccccccc): failed (2)",
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
      "ゲートウェイが AI の呼び出しを3回リトライ（429, connection・計21秒）",
    );
    expect(describeEvent(event(true))).toBe(
      "ゲートウェイが AI の呼び出しを3回リトライ（429, connection・計21秒）・上限であきらめた",
    );
    expect(describeIn(event(true), labels.en)).toBe(
      "The gateway retried the AI call 3 times (429, connection; 21s in total) · gave up at the limit",
    );
  });
});

describe("オーケストレーターのセッションの記録の表示（PBI-67）", () => {
  const event = (payload: Record<string, unknown>) =>
    ({
      type: "OrchestratorSessionUsed",
      payload: {
        runId: "r",
        role: "orchestrator",
        agentId: "a",
        runtime: "claude-code",
        ...payload,
      },
      actor: "sacty",
    }) as unknown as ActivityEvent;
  it("再開・新しく始めた理由・複製・保存できなかった理由を出す", () => {
    expect(describeEvent(event({ mode: "resumed", sessionId: "s1", saved: true }))).toBe(
      "オーケストレーターのセッション（s1）を再開した",
    );
    expect(
      describeEvent(event({ mode: "new", reason: "agent_changed", sessionId: "s2", saved: true })),
    ).toBe("オーケストレーターのセッションを新しく始めた（エージェントを変えたため）：s2");
    expect(
      describeEvent(
        event({ mode: "new", reason: "resume_failed", saved: false, notSaved: "no_session" }),
      ),
    ).toBe(
      "オーケストレーターのセッションを新しく始めた（AI が再開を受け付けなかったため）。セッションは保存できなかった（セッションの ID が分からない）",
    );
    expect(
      describeEvent(event({ role: "chat", mode: "forked", resumedFrom: "s1", sessionId: "f1" })),
    ).toBe("質問のためにセッション（s1）を複製した：f1");
    expect(describeEvent(event({ role: "chat", mode: "new", reason: "first" }))).toBe(
      "質問のために新しいセッションを始めた（このタスクで初めて）",
    );
    expect(
      describeIn(event({ mode: "new", reason: "truncated", sessionId: "s3" }), labels.en),
    ).toBe("Started a new orchestrator session (the saved session was cut at the size limit): s3");
  });
  it("セッションログを開ける行にする", () => {
    expect(runLogId(event({ mode: "new", reason: "first" }))).toBe("r");
  });
});

describe("エージェントの元のファイルを写した記録の表示（PBI-66）", () => {
  it("写したファイルの数と、上限で間を省いたファイルの数を出す", () => {
    const file = (truncated: boolean) => ({
      path: "projects/-workspace/s.jsonl",
      bytes: 1,
      sha256: "a".repeat(64),
      sourceBytes: 1,
      ...(truncated ? { truncated: { droppedBytes: 1, droppedLines: 1 } } : {}),
    });
    const event = (files: unknown[]) =>
      ({
        type: "AgentSessionArchived",
        payload: {
          runId: "r",
          role: "orchestrator",
          agentId: "a",
          runtime: "codex",
          files,
          limitBytes: 1,
          skipped: [],
        },
        actor: "sacty",
      }) as unknown as ActivityEvent;
    expect(describeEvent(event([file(false), file(false)]))).toBe(
      "エージェントの元のファイル2件を写した",
    );
    expect(describeEvent(event([file(true), file(false)]))).toBe(
      "エージェントの元のファイル2件を写した（1件は間を省いた）",
    );
    expect(describeIn(event([file(false)]), labels.en)).toBe(
      "Copied 1 original file written by the agent",
    );
  });

  it("コンテナの停止を確かめられず写さなかったときは、その理由を出す", () => {
    const event = {
      type: "AgentSessionArchived",
      payload: {
        runId: "r",
        role: "orchestrator",
        agentId: "a",
        runtime: "claude-code",
        files: [],
        limitBytes: 1,
        skipped: [],
        notArchived: "container_not_confirmed",
      },
      actor: "sacty",
    } as unknown as ActivityEvent;
    expect(describeEvent(event)).toBe(
      "コンテナの停止を確かめられず、エージェントの元のファイルを写さなかった",
    );
    expect(describeIn(event, labels.en)).toBe(
      "Did not copy the agent's original files; the container could not be confirmed to have stopped",
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
      gate: { step: "implement", submission: 1 },
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
    expect(describeEvent(ev("ReviewRestarted", {}, "person"))).toBe("再レビューを始めた（人間）");
    // PR でのレビューの再依頼を受けて、sacty が始めた（PBI-143）
    expect(describeEvent(ev("ReviewRestarted", { reason: "rerequested" }, "sacty"))).toBe(
      "PR でレビューが再依頼されたので、再レビューを始めた（Sacty）",
    );
    expect(describeIn(ev("ReviewRestarted", { reason: "rerequested" }, "sacty"), labels.en)).toBe(
      "Started a re-review because a review was re-requested on the PR (Sacty)",
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
        steps: ["requirements", "design", "implement"],
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
      "工程を決定：要求要件 → 設計 → 実装 / 書き出し：要求要件＝confluence：DEV（規約）、設計＝書き出さない（オーケストレーターが書き出し先を決めなかったため、書き出しません。）",
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

describe("テンプレートで作ったタスクの作業履歴（PBI-90）", () => {
  const created = (template?: "sacty-setup"): ActivityEvent =>
    ({
      type: "TaskCreated",
      payload: {
        title: "t",
        body: "",
        start: "sacty",
        budgetCapUsd: 5,
        ...(template ? { template } : {}),
      },
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-15T00:00:00.000Z",
      actor: "person",
    }) as ActivityEvent;

  it("作成の行に、テンプレートの名前を出す（無ければ今と同じ）", () => {
    expect(describeEvent(created("sacty-setup"))).toBe(
      "タスクを作成（人間・テンプレート：Sacty セットアップ）",
    );
    expect(describeIn(created("sacty-setup"), labels.en)).toBe(
      "Task created (person · template: Sacty setup)",
    );
    expect(describeEvent(created())).toBe("タスクを作成（人間）");
  });
});

describe("実装に変更が無い実装の承認（PBI-90・PBI-110）", () => {
  const prGate = (patch: Partial<Task> = {}) =>
    task({
      status: "awaiting_approval",
      steps: [{ key: "implement", state: "active" }],
      gate: { step: "implement", submission: 2 },
      submissions: { implement: 2 },
      noChanges: { submission: 2 },
      ...patch,
    });

  it("PR を作らなかった提出回は、変更なしの実装の承認待ちとし、承認すると「完了（変更なし）」と出す", () => {
    expect(statusText(prGate())).toBe("変更なしの実装の承認待ち（2回目）");
    expect(statusTextIn(prGate(), labels.en)).toBe(
      "Implement awaiting approval with no changes (submission 2)",
    );
    const done = prGate({
      status: "idle",
      gate: undefined,
      steps: [{ key: "implement", state: "done" }],
    });
    expect(statusText(done)).toBe("完了（変更なし）");
    expect(statusTextIn(done, labels.en)).toBe("Done (no changes)");
  });

  it("前の提出回の変更なし・PR を作った提出回は、今までどおり", () => {
    // 差し戻して作り直した提出回（3回目）には、2回目の変更なしを引き継がない
    expect(
      statusText(
        prGate({ gate: { step: "implement", submission: 3 }, submissions: { implement: 3 } }),
      ),
    ).toBe("実装の承認待ち（3回目）");
    expect(
      statusText(
        prGate({
          pullRequest: { branch: "b", commit: "c", url: "u", number: 7 },
          pullRequestState: "open",
        }),
      ),
    ).toBe("実装の PR のマージ待ち（2回目）");
  });

  it("作業履歴の行", () => {
    const event = {
      type: "NoChangesFound",
      payload: { submission: 1 },
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-15T00:00:00.000Z",
      actor: "sacty",
    } as ActivityEvent;
    expect(describeEvent(event)).toBe("実装に変更が無いため、PR を作らずに承認待ち");
  });
});

describe("テストの仕組みが無いタスクの作業履歴（PBI-94）", () => {
  const at = {
    seq: 1,
    id: "e1",
    taskId: "t1",
    projectId: "default",
    at: "2026-10-15T00:00:00.000Z",
  };
  it("工程の決定にテストの仕組みが無い根拠を、テストを飛ばしたことを、それぞれ表示する", () => {
    const chosen = {
      type: "StepsChosen",
      payload: {
        steps: ["implement"],
        reason: "小さな変更",
        fallback: false,
        noTestsReason: "README だけ",
        costUsd: 0,
        estimated: false,
      },
      ...at,
      actor: "orchestrator",
    } as ActivityEvent;
    expect(describeEvent(chosen)).toBe(
      "工程を決定：実装（小さな変更） / テストの仕組みが無い：README だけ",
    );
    expect(describeIn(chosen, labels.en)).toContain(" / No tests in the repository: README だけ");
    const skipped = { type: "TestsSkipped", payload: {}, ...at, actor: "sacty" } as ActivityEvent;
    expect(describeEvent(skipped)).toBe(
      "テストのコマンドが無いため、テストを飛ばして最終レビューへ",
    );
  });
});

describe("実装で用意したテストの結果（PBI-94・PR #105 レビュー指摘）", () => {
  const ran = (passed: boolean) => ({
    command: "make test",
    exitCode: passed ? 0 : 1,
    unmappedViewpoints: [],
    passed,
    output: "",
    durationMs: 1,
    at: "2026-10-15T00:00:00.000Z",
  });
  it("最新の検証でテストを実行したときだけ、合格・不合格を返す", () => {
    expect(addedTestsResult(task({ noTestsReason: "無い", lastTests: ran(true) }))).toBe("passed");
    // 不合格を「検証しました」と見せない（PR #105 再レビュー指摘）
    expect(addedTestsResult(task({ noTestsReason: "無い", lastTests: ran(false) }))).toBe("failed");
    expect(
      addedTestsResult(task({ noTestsReason: "無い", testsSkippedAt: "2026-10-15T00:00:00.000Z" })),
    ).toBeUndefined();
    expect(addedTestsResult(task({ noTestsReason: "無い" }))).toBeUndefined();
    // テストのコマンドがあるタスクは対象外
    expect(addedTestsResult(task({ lastTests: ran(true) }))).toBeUndefined();
  });

  it("やり直した実装の検証が始まったら、前の提出の結果を使わない（PR #105 再々レビュー指摘）", () => {
    const redone = {
      noTestsReason: "無い",
      lastTests: ran(false),
      verification: "pending" as const,
    };
    expect(addedTestsResult(task({ ...redone, addedTestCommand: "make test" }))).toBe("pending");
    // 今の提出がテストを申告していなければ、テストを飛ばす（前の不合格を出さない）
    expect(addedTestsResult(task(redone))).toBeUndefined();
    // やり直しを待っている間（検証の前）は、前の不合格が最新の結果
    expect(
      addedTestsResult(task({ noTestsReason: "無い", lastTests: ran(false), status: "queued" })),
    ).toBe("failed");
  });

  it("工程の欄は、合格・不合格・実行待ちをそれぞれの文にする（PR #105 再々レビュー指摘。根拠は補足に出す。PBI-117）", () => {
    const m = taskMessages.ja;
    const of = (patch: Partial<Task>) =>
      testCommandOfNoTests(task({ noTestsReason: "無い", ...patch }), m);
    expect(of({ lastTests: ran(true) })).toBe(m.testCommandAdded("make test"));
    expect(of({ lastTests: ran(false) })).toBe(m.testCommandAddedFailed("make test"));
    expect(of({ lastTests: ran(false) })).not.toContain("目的から判定");
    expect(
      of({ lastTests: ran(false), verification: "pending", addedTestCommand: "make check" }),
    ).toBe(m.testCommandAddedPending("make check"));
    expect(of({})).toBe(m.testCommandNone);
    // 根拠は文に入れず、画面が補足で出す
    for (const text of [of({ lastTests: ran(true) }), of({})]) expect(text).not.toContain("無い");
  });
});

describe("今の提出の検証の結果か（PR #105 再レビュー指摘）", () => {
  const tests = (at: string, passed: boolean) => ({
    command: "npm test",
    exitCode: passed ? 0 : 1,
    unmappedViewpoints: [],
    passed,
    output: "",
    durationMs: 1,
    at,
  });
  const review = (at: string) => ({
    passed: false,
    viewpoints: [],
    remarks: [],
    summary: "所見",
    agentId: "a",
    runId: "r",
    costUsd: 0,
    estimated: false,
    at,
  });
  const T1 = "2026-10-15T00:00:00.000Z";
  const T2 = "2026-10-15T00:01:00.000Z";
  it("やり直した実装の検証が始まったら、テストも最終レビューも前の提出のものとして返す", () => {
    const failed = { lastTests: tests(T1, false), lastReview: review(T1) } as Partial<Task>;
    expect(verificationResults(task(failed))).toMatchObject({
      testsCurrent: true,
      reviewCurrent: true,
    });
    expect(verificationResults(task({ ...failed, verification: "pending" }))).toMatchObject({
      testsCurrent: false,
      reviewCurrent: false,
    });
    // 今の提出のテストに通り、最終レビューを待っている：前の最終レビューは前の提出のもの
    expect(
      verificationResults(
        task({ lastTests: tests(T2, true), lastReview: review(T1), verification: "tests_passed" }),
      ),
    ).toMatchObject({ testsCurrent: true, reviewCurrent: false });
    // テストを飛ばしたタスク：飛ばした時より前の最終レビューは前の提出のもの
    expect(
      verificationResults(task({ testsSkippedAt: T2, lastReview: review(T1) })).reviewCurrent,
    ).toBe(false);
    expect(verificationResults(task({})).testsCurrent).toBe(false);
  });
});

describe("ゴールガーディアンが最終レビューの中で実行したテスト", () => {
  const review = (exitCode: number | undefined) => ({
    passed: exitCode === 0,
    viewpoints: [],
    remarks: [],
    summary: "所見",
    agentId: "g",
    runId: "r",
    costUsd: 0,
    estimated: false,
    at: "2026-10-15T00:00:00.000Z",
    tests: {
      command: "make test",
      ...(exitCode === undefined ? {} : { exitCode }),
      output: "2 passed",
    },
  });
  it("最終レビューの tests を、テストの実行として出す（終了コードを申告しなければ不合格）", () => {
    expect(verificationResults(task({ lastReview: review(0) }))).toMatchObject({
      tests: { command: "make test", exitCode: 0, passed: true, byGuardian: true },
      testsCurrent: true,
      reviewCurrent: true,
    });
    expect(verificationResults(task({ lastReview: review(undefined) })).tests?.passed).toBe(false);
    // 環境による失敗だけなら、終了コードが 0 でなくても通ったものとする（PBI-155）
    const environment = review(1);
    const failures = ["processes.test.ts：起点でも失敗する"];
    expect(
      verificationResults(
        task({
          lastReview: {
            ...environment,
            tests: { ...environment.tests, environmentFailures: failures },
          },
        }),
      ).tests,
    ).toMatchObject({ exitCode: 1, passed: true, environmentFailures: failures });
    expect(verificationResults(task({ lastReview: review(1) })).tests).not.toHaveProperty(
      "environmentFailures",
    );
    // 差分が文書だけで、ツールが無くて実行できなかった検証を人の確認へ回したときも、通ったものとする（PBI-158）
    expect(
      verificationResults(
        task({
          lastReview: {
            ...environment,
            tests: { ...environment.tests, exitCode: 127, missingCommands: ["go"] },
          },
        }),
      ).tests,
    ).toMatchObject({ exitCode: 127, passed: true, missingCommands: ["go"] });
    expect(verificationResults(task({ lastReview: review(127) })).tests).toMatchObject({
      passed: false,
    });
    expect(verificationResults(task({ lastReview: review(127) })).tests).not.toHaveProperty(
      "missingCommands",
    );
    // 実装で用意したテスト（PBI-94）の結果も、ゴールガーディアンが実行したものから決める
    const m = taskMessages.ja;
    const noTests = { noTestsReason: "無い", addedTestCommand: "make test" };
    expect(addedTestsResult(task({ ...noTests, lastReview: review(1) }))).toBe("failed");
    expect(testCommandOfNoTests(task({ ...noTests, lastReview: review(0) }), m)).toBe(
      m.testCommandAdded("make test"),
    );
  });
});

describe("テストの無い観点を、今の提出について目的から判定し終えたか（PR #105 再レビュー指摘）", () => {
  const review = (at: string) => ({
    passed: true,
    viewpoints: [],
    remarks: [],
    summary: "所見",
    agentId: "a",
    runId: "r",
    costUsd: 0,
    estimated: false,
    at,
  });
  const T1 = "2026-10-15T00:00:00.000Z";
  const T2 = "2026-10-15T00:01:00.000Z";
  it("今の提出の最終レビューがあるときだけ true にし、検証待ちの間は「未実行」にする", () => {
    const judged = { noTestsReason: "無い", testsSkippedAt: T1, lastReview: review(T2) };
    expect(judgedByGoalForCurrent(task(judged))).toBe(true);
    // やり直した実装の検証待ち：前の提出の判定は使わない
    expect(judgedByGoalForCurrent(task({ ...judged, verification: "pending" }))).toBe(false);
    // テストを飛ばした後、最終レビューの前
    expect(
      judgedByGoalForCurrent(
        task({ noTestsReason: "無い", testsSkippedAt: T2, lastReview: review(T1) }),
      ),
    ).toBe(false);
    expect(judgedByGoalForCurrent(task({ noTestsReason: "無い" }))).toBe(false);
    expect(judgedByGoalForCurrent(task({ testsSkippedAt: T1, lastReview: review(T2) }))).toBe(
      false,
    );
  });
});

describe("工程のイメージの表示（PBI-106）", () => {
  it("工程ごとのイメージ・選んだ元・いつから使うかを出す。すべての工程を出す", () => {
    const rows = stepImageRows(
      task({
        status: "running",
        steps: [
          { key: "requirements", state: "done" },
          { key: "design", state: "active" },
          { key: "implement", state: "todo" },
        ],
        images: { design: "java", implement: "playwright" },
        imageSource: "orchestrator",
        imageChanges: {
          implement: { from: "java", to: "playwright", at: "2026-10-15T01:02:00.000Z" },
        },
      }),
    );
    expect(rows).toEqual([
      { step: "requirements", image: "default", source: { by: "none" }, when: "done" },
      { step: "design", image: "java", source: { by: "orchestrator" }, when: "running" },
      {
        step: "implement",
        image: "playwright",
        source: { by: "person", at: "2026-10-15T01:02:00.000Z", from: "java" },
        when: "next",
      },
    ]);
  });

  it("既定のイメージにした理由（PBI-105）は人が変えるまで出し、人が変えたら人の変更を出す", () => {
    const steps = [
      { key: "investigate" as const, state: "done" as const },
      { key: "requirements" as const, state: "active" as const },
      { key: "design" as const, state: "todo" as const },
    ];
    const chosen = {
      status: "awaiting_approval" as const,
      steps,
      images: { requirements: "default" },
      imageSource: "orchestrator" as const,
      defaultImageReasons: { requirements: "文書だけを書く" },
      imagesUnexplained: ["investigate" as const, "design" as const],
    };
    expect(stepImageRows(task(chosen)).map((r) => r.source)).toEqual([
      { by: "orchestrator", unexplained: true },
      { by: "orchestrator", default: "文書だけを書く" },
      { by: "orchestrator", unexplained: true },
    ]);
    const changed = stepImageRows(
      task({
        ...chosen,
        images: { requirements: "playwright", design: "java" },
        imageChanges: {
          requirements: { from: "default", to: "playwright", at: "2026-10-15T01:00:00.000Z" },
          design: { from: "default", to: "java", at: "2026-10-15T01:01:00.000Z" },
        },
      }),
    );
    expect(changed.map((r) => [r.image, r.source.by])).toEqual([
      ["default", "orchestrator"],
      ["playwright", "person"],
      ["java", "person"],
    ]);
  });

  it("実装の検証（テスト）の間は実行中、止まっている工程は次の実行から。プロジェクトの指定はその旨を出す", () => {
    const steps = [{ key: "implement" as const, state: "active" as const }];
    const testing = task({ status: "idle", verification: "pending", steps });
    expect(stepImageRows(testing)[0]?.when).toBe("running");
    const paused = task({
      status: "paused",
      steps,
      images: { implement: "java" },
      imageSource: "project",
    });
    expect(stepImageRows(paused)[0]).toMatchObject({ when: "next", source: { by: "project" } });
  });
});

describe("作成時に指定した工程のイメージの表示", () => {
  it("人が作成時に指定した工程は、そのことを出し、後で人が変えたら人の変更を出す", () => {
    const steps = [
      { key: "requirements" as const, state: "active" as const },
      { key: "implement" as const, state: "todo" as const },
    ];
    const requested = {
      status: "awaiting_approval" as const,
      steps,
      requestedImages: { implement: "java" },
      images: { requirements: "playwright", implement: "java" },
      imageSource: "orchestrator" as const,
    };
    expect(stepImageRows(task(requested)).map((r) => r.source)).toEqual([
      { by: "orchestrator" },
      { by: "request" },
    ]);
    const changed = stepImageRows(
      task({
        ...requested,
        images: { requirements: "playwright", implement: "default" },
        imageChanges: { implement: { from: "java", to: "default", at: T_CHANGED } },
      }),
    );
    expect(changed[1]?.source).toEqual({ by: "person", at: T_CHANGED, from: "java" });
  });
});

const T_CHANGED = "2026-10-15T01:00:00.000Z";

describe("工程のイメージの選択肢（PBI-106・PR #116 レビュー指摘）", () => {
  const java = { name: "java", description: "Java 17" };
  it("既定のイメージと images の名前を、説明つきで出す", () => {
    expect(stepImageOptions({ problems: [], images: [java] }, "既定")).toEqual([
      { name: "default", description: "既定" },
      java,
    ]);
    // images を書いていなければ、既定のイメージだけ
    expect(stepImageOptions({ problems: [], images: [] }, "既定")).toEqual([
      { name: "default", description: "既定" },
    ]);
  });

  it("状態を取得できない・設定を読めない・古いデーモンなら、候補を確かめられない（消した名前と取り違えない）", () => {
    expect(stepImageOptions(undefined, "既定")).toBeUndefined();
    expect(
      stepImageOptions({ problems: [{ code: "config.missing" }], images: [] }, "既定"),
    ).toBeUndefined();
    expect(stepImageOptions({ problems: [] }, "既定")).toBeUndefined();
  });
});

describe("マージの後の監視の工程の表示（PBI-116）", () => {
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
  const watching = (phase: "ci" | "check") =>
    task({
      steps: [
        { key: "implement", state: "done" },
        { key: "deployment", state: "active" },
      ],
      deployment: {
        number: 7,
        repo: "https://github.com/acme/app",
        branch: "main",
        commit: "m1",
        startedAt: "2026-10-10T00:00:00.000Z",
        state: "waiting",
        phase,
      },
    });

  it("監視の間は、完了でも人の出番でもなく、監視していることを出す", () => {
    expect(statusText(watching("ci"))).toBe("マージの後の監視・CI/CD 待ち");
    expect(statusText(watching("check"))).toBe("マージの後の監視・確認中");
    expect(statusTone(watching("ci"))).toBe("working");
    expect(needsPerson(watching("ci"))).toBe(false);
    // 英語の工程の名前も、ほかの工程とそろえる
    expect(labels.en.step.deployment).toBe("After-merge watch");
    expect(statusTextIn(watching("ci"), labels.en)).toBe("After-merge watch · waiting for CI/CD");
  });

  it("工程を決めた記録に、監視をするか（スキル）・飛ばす理由を出す", () => {
    const chosen = (deployment: unknown) =>
      describeEvent(
        event({
          type: "StepsChosen",
          payload: {
            steps: ["implement", "deployment"],
            fallback: false,
            costUsd: 0,
            estimated: false,
            deployment,
          },
        } as Pick<ActivityEvent, "type" | "payload">),
      );
    expect(chosen({ skill: ".agents/skills/deployment-observer/SKILL.md" })).toBe(
      "工程を決定：実装 → マージの後の監視 / マージの後の監視：する（スキル .agents/skills/deployment-observer/SKILL.md）",
    );
    expect(
      chosen({
        skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
      }),
    ).toContain(
      "マージの後の監視：飛ばす（マージの後の監視の工程を飛ばします（CI/CD も見ません）。",
    );
  });

  it("確認の結果は、CI/CD・デプロイの確認それぞれを出し、止めた確認は確かめ直すと出す", () => {
    expect(
      describeEvent(
        event({
          type: "DeploymentChecked",
          payload: {
            result: "healthy",
            ci: { result: "passed" },
            deployment: { result: "skipped", reason: "デプロイしていない" },
            evidence: [],
            runResult: "completed",
            agentId: "a",
            costUsd: 0,
            estimated: false,
          },
        } as Pick<ActivityEvent, "type" | "payload">),
      ),
    ).toBe(
      "スキルの確認：問題なし（$0.0000） / CI/CD の確認：通った / デプロイの確認：飛ばした（デプロイしていない）",
    );
    expect(
      describeEvent(
        event({
          type: "DeploymentChecked",
          payload: {
            result: "unknown",
            retry: true,
            failed: { code: "deploy.stopped" },
            evidence: [],
            runResult: "interrupted",
            agentId: "a",
            costUsd: 0,
            estimated: false,
          },
        } as Pick<ActivityEvent, "type" | "payload">),
      ),
    ).toContain("スキルの確認を中断した。再開すると確かめ直す");
  });
});

describe("代わりのエージェントへの切り替え（AgentFellBack）", () => {
  const fellBack = (reason?: "usage_limit" | "auth" | "error"): ActivityEvent =>
    ({
      type: "AgentFellBack",
      payload: {
        runId: "r1",
        role: "requirements",
        agentId: "claude",
        fallbackAgentId: "codex",
        ...(reason ? { reason } : {}),
        until: "2026-10-20T01:00:00.000Z",
      },
    }) as ActivityEvent;

  it("失敗の理由を書き、利用制限でなければ、このタスクでだけ使わないと書く", () => {
    expect(describeEvent(fellBack("usage_limit"))).toMatch(/^claude が利用制限に達したので、codex/);
    expect(describeEvent(fellBack("auth"))).toMatch(/^claude が認証に失敗したので、codex/);
    expect(describeEvent(fellBack("error"))).toMatch(/^claude が失敗したので、codex/);
    expect(describeEvent(fellBack("error"))).toContain("このタスクでは claude を使わない");
    expect(describeEvent(fellBack("usage_limit"))).not.toContain("このタスクでは");
  });

  it("理由の無い記録（前の版）は、利用制限として書く", () => {
    expect(describeEvent(fellBack())).toMatch(/^claude が利用制限に達したので/);
    expect(describeIn(fellBack("auth"), labels.en)).toMatch(
      /^claude failed to authenticate, so retrying with codex .* for this task until/,
    );
  });
});
