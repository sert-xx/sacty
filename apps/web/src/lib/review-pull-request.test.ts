import type { Project, StepPullRequest, Task } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import { labels } from "@/i18n/messages/labels";

const listTasks = vi.fn(async (_options?: { open?: boolean }): Promise<Task[]> => []);
vi.mock("@/lib/daemon", () => ({
  listProjects: async () => [{ id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" }],
  listTasks,
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "p1",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));

const { personAction, personLink, reviewPullRequestUrl } = await import("./labels");
const { attentionRows } = await import("./dashboard-data");
const { loadHeaderData } = await import("./header-data");

/*
 * PR で確かめる工程（実装・要求要件・設計）の承認待ちは、「チェックする」から直接 PR を開く（PBI-136）。
 */

const ja = labels.ja;
const PR_URL = "https://github.com/acme/app/pull/12";

const task = (patch: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "p1",
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

const stepPr = (patch: Partial<StepPullRequest> = {}): StepPullRequest => ({
  step: "requirements",
  branch: "sacty/t1-requirements",
  commit: "abc",
  base: "sacty/t1",
  path: "docs/requirements.md",
  url: PR_URL,
  number: 12,
  repo: "acme/app",
  submission: 1,
  state: "open",
  ...patch,
});

/** 要求要件・設計の承認待ち（今の提出の PR がある）。 */
const stepGate = (
  step: "requirements" | "design",
  pr: Partial<StepPullRequest> = {},
  patch: Partial<Task> = {},
) =>
  task({
    status: "awaiting_approval",
    gate: { step, submission: 1 },
    stepPullRequests: [stepPr({ step, ...pr })],
    ...patch,
  });

/** 実装の承認待ち（実装の PR がある）。 */
const implementGate = (patch: Partial<Task> = {}) =>
  task({
    status: "awaiting_approval",
    gate: { step: "implement", submission: 1 },
    pullRequest: {
      number: 12,
      url: PR_URL,
      repo: "acme/app",
      commit: "abc",
    } as Task["pullRequest"],
    pullRequestState: "open",
    ...patch,
  });

const REVIEW = { href: "/tasks/t1/review", label: "チェックする" };
const ON_PR = { href: PR_URL, label: "PR でチェックする", external: true };

describe("「チェックする」の行き先", () => {
  it("要求要件・設計・実装の承認待ちで、今の提出の PR が開いていれば、PR を開く", () => {
    expect(personAction(stepGate("requirements"), ja)).toEqual(ON_PR);
    expect(personAction(stepGate("design"), ja)).toEqual(ON_PR);
    expect(personAction(implementGate(), ja)).toEqual(ON_PR);
    expect(personAction(implementGate(), labels.en)).toEqual({
      ...ON_PR,
      label: "Review on the PR",
    });
  });

  it("PR が閉じられた・マージ済み・提出と違う内容でマージされたときは、sacty のレビュー画面", () => {
    for (const state of ["closed", "merged", "merged_outdated"] as const) {
      expect(personAction(stepGate("design", { state }), ja), state).toEqual(REVIEW);
      expect(personAction(implementGate({ pullRequestState: state }), ja), state).toEqual(REVIEW);
    }
  });

  it("今の提出の PR でない（前の提出・置き換えた PR・別の工程）・PR が無いときは、sacty のレビュー画面", () => {
    expect(personAction(stepGate("design", { submission: 2 }), ja)).toEqual(REVIEW);
    expect(personAction(stepGate("design", { superseded: true }), ja)).toEqual(REVIEW);
    expect(
      personAction(
        task({
          status: "awaiting_approval",
          gate: { step: "design", submission: 1 },
          stepPullRequests: [stepPr({ step: "requirements" })],
        }),
        ja,
      ),
    ).toEqual(REVIEW);
    expect(
      personAction(
        task({ status: "awaiting_approval", gate: { step: "design", submission: 1 } }),
        ja,
      ),
    ).toEqual(REVIEW);
    expect(personAction(implementGate({ pullRequest: undefined }), ja)).toEqual(REVIEW);
  });

  it("戻し先を人が選ぶ（エスカレーション）ときは、PR が開いていても sacty のレビュー画面", () => {
    expect(personAction(stepGate("design", {}, { status: "escalated" }), ja)).toEqual({
      href: "/tasks/t1/review",
      label: "判断する",
    });
    expect(personAction(implementGate({ status: "escalated" }), ja).href).toBe("/tasks/t1/review");
  });

  it("PR の URL が無い・https でないときは開かない（作業履歴の値をそのまま href にしない）", () => {
    for (const url of [
      "",
      "javascript:alert(1)",
      "http://github.com/acme/app/pull/12",
      'https://x" onclick="y',
    ]) {
      expect(reviewPullRequestUrl(stepGate("design", { url })), url).toBeUndefined();
    }
    expect(reviewPullRequestUrl(stepGate("design"))).toBe(PR_URL);
    // 承認待ちでなければ（エスカレーションなど）返さない
    expect(reviewPullRequestUrl(stepGate("design", {}, { status: "escalated" }))).toBeUndefined();
  });
});

describe("導線のある場所で同じにする", () => {
  const projects: Project[] = [
    { id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" } as unknown as Project,
  ];

  it("一覧の行・お知らせ用のリンクは、PR のときだけ外部の印を付ける", () => {
    expect(personLink(stepGate("design"), ja)).toEqual({ href: PR_URL, external: true });
    expect(personLink(stepGate("design", { state: "closed" }), ja)).toEqual({
      href: "/tasks/t1/review",
    });
  });

  it("ダッシュボードの「あなたの出番」とヘッダーのお知らせも PR を開く", async () => {
    const pr = stepGate("design");
    const closed = { ...stepGate("design", { state: "closed" }), id: "t2" };
    const rows = attentionRows(projects, [pr, closed], {}, ja);
    expect(rows.find((r) => r.id === "t1")).toMatchObject({ href: PR_URL, external: true });
    expect(rows.find((r) => r.id === "t2")).toMatchObject({ href: "/tasks/t2/review" });
    expect(rows.find((r) => r.id === "t2")).not.toHaveProperty("external");

    listTasks.mockResolvedValueOnce([pr, closed]);
    const header = await loadHeaderData();
    expect(header?.notices.find((n) => n.taskId === "t1")).toMatchObject({
      href: PR_URL,
      external: true,
    });
    expect(header?.notices.find((n) => n.taskId === "t2")).toMatchObject({
      href: "/tasks/t2/review",
    });
  });
});
