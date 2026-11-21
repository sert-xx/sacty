// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";
import { ACTIVE, EMPTY_FILTER, matchesFilter } from "@/lib/task-filter";

let locale: Locale = "ja";
let tasks: Task[] = [];
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor(locale) }));
vi.mock("@/lib/daemon", () => ({
  listTasks: async () => tasks,
  listProjects: async () => [{ id: "default" }],
  getDashboardSummary: async () => ({ waitingSince: {} }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {} }),
  useSearchParams: () => new URLSearchParams(),
}));
const { loadTaskList } = await import("@/lib/task-list-data");
const { LiveTaskList } = await import("./task-list");

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

/** 人の承認（マージ）を待つ、実装の PR が開いているタスク。 */
const awaiting = (patch: Partial<Task> = {}): Task =>
  task({
    status: "awaiting_approval",
    gate: { step: "implement", submission: 1 } as Task["gate"],
    steps: [{ key: "implement", state: "active" }],
    pullRequest: {
      branch: "b",
      commit: "c1",
      url: "https://github.com/acme/web/pull/7",
      number: 7,
    },
    pullRequestState: "open",
    ...patch,
  });

/** PBI-364 が記録した CI の失敗（提出のコミット c1 の PR #7 のもの）。 */
const failure: NonNullable<Task["pullRequestCiFailure"]> = {
  number: 7,
  commit: "c1",
  head: "9f8e7d6c5b4a",
  checks: [{ name: "CI", url: "https://github.com/acme/web/actions/runs/1" }],
  at: "2026-11-17T00:00:00.000Z",
};

async function load(list: Task[]) {
  tasks = list;
  const data = await loadTaskList("default");
  if (!data) throw new Error("project missing");
  return data;
}

async function page(list: Task[]) {
  const html = renderToStaticMarkup(
    createElement(LiveTaskList, { projectId: "default", initial: await load(list) }),
  );
  return new DOMParser().parseFromString(html, "text/html");
}

describe("タスクの一覧：承認待ちの実装の PR の CI が失敗していた印（PBI-371）", () => {
  for (const lang of ["ja", "en"] as const) {
    it(`${lang}：記録があるタスクの行にだけ、アイコンと文字で印を出す（状態の文言は変えない）`, async () => {
      locale = lang;
      const m = messagesFor(lang);
      const document = await page([
        awaiting({ id: "t1", pullRequestCiFailure: failure }),
        awaiting({ id: "t2" }),
      ]);
      const mark = document.querySelector('[data-testid="task-ci-failed-t1"]');
      // 色だけに頼らない：飾りのアイコン（読み上げない）と、文字
      expect(mark?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      // 補足（読んだ時点の結果であること）は、印の中に隠して置かれ、開かなくても読める
      const hint = mark?.querySelector('[data-slot="hint"]');
      expect(hint?.textContent).toBe(m.tasks.ciFailedHint);
      hint?.remove();
      expect(mark?.textContent).toBe(lang === "ja" ? "CI 失敗" : "CI failed");
      // 状態の表示は、印の無いタスクと同じ
      const status = (id: string) => {
        const cell = document.querySelector(`[data-testid="task-row-${id}"] td:last-child`);
        cell?.querySelector(`[data-testid="task-ci-failed-${id}"]`)?.remove();
        return cell?.textContent;
      };
      if (lang === "ja") expect(status("t1")).toBe("実装の PR のマージ待ち");
      expect(status("t1")).toBeTruthy();
      expect(status("t1")).toBe(status("t2"));
      expect(document.querySelector('[data-testid="task-ci-failed-t2"]')).toBeNull();
    });
  }

  it("状態・絞り込み・並び・「あなたの出番」は、記録があっても無くても同じ", async () => {
    locale = "ja";
    const before = task({ id: "a", title: "前", createdAt: "2026-10-09T00:00:00.000Z" });
    const after = task({
      id: "z",
      title: "後",
      steps: [{ key: "implement", state: "done" }],
      createdAt: "2026-10-11T00:00:00.000Z",
    });
    const without = await load([before, awaiting(), after]);
    const withFailure = await load([before, awaiting({ pullRequestCiFailure: failure }), after]);
    // 行の違いは、印だけ（状態の文言と種類・並びは同じ）
    expect(withFailure.rows.map(({ ciFailed: _, ...row }) => row)).toEqual(without.rows);
    expect(withFailure.rows.filter((r) => r.ciFailed).map((r) => r.id)).toEqual(["t1"]);
    expect(without.rows.filter((r) => r.ciFailed)).toEqual([]);
    expect(withFailure.needsYou).toEqual(without.needsYou);
    // 絞り込みの結果も同じ（状態の種類は「あなたの出番」のまま。印では絞り込まない）
    for (const status of ["", ACTIVE, "person", "working", "waiting", "completed"] as const) {
      const shown = (data: typeof without) =>
        data.rows.filter((r) => matchesFilter(r, { ...EMPTY_FILTER, status })).map((r) => r.id);
      expect(shown(withFailure)).toEqual(shown(without));
    }
  });

  it("印は、PBI-364 の表示が消える条件で消える（新しい判定は持たない）", async () => {
    locale = "ja";
    const shown = async (t: Task) => (await load([t])).rows[0]?.ciFailed;
    expect(await shown(awaiting({ pullRequestCiFailure: failure }))).toBe(true);
    // 記録が無い（PR の更新・マージ・クローズ・開き直しで、記録は消える）
    expect(await shown(awaiting())).toBeUndefined();
    // 記録が今の提出のものでない（PR を更新した・別の PR）
    expect(
      await shown(
        awaiting({
          pullRequest: { branch: "b", commit: "c2", url: "u", number: 7 },
          pullRequestCiFailure: failure,
        }),
      ),
    ).toBeUndefined();
    expect(
      await shown(awaiting({ pullRequestCiFailure: { ...failure, number: 8 } })),
    ).toBeUndefined();
    // PR がマージされた・閉じられた
    for (const state of ["merged", "closed"] as const) {
      expect(
        await shown(awaiting({ pullRequestState: state, pullRequestCiFailure: failure })),
      ).toBeUndefined();
    }
    // 承認待ちでない（差し戻して実行待ち・実行中、エスカレーション、中止）
    for (const status of ["queued", "running", "idle", "escalated", "cancelled"] as const) {
      expect(await shown(awaiting({ status, pullRequestCiFailure: failure }))).toBeUndefined();
    }
    // PR のレビューの子タスクの指摘なしを待っている
    expect(
      await shown(
        awaiting({
          pullRequest: { branch: "b", commit: "c1", url: "u", number: 7, awaitingReview: true },
          pullRequestCiFailure: failure,
        }),
      ),
    ).toBeUndefined();
  });
});
