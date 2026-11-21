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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { loadTaskList } = await import("@/lib/task-list-data");
const { LiveTaskList } = await import("./task-list");

const task = (patch: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "default",
  title: "A",
  body: "",
  start: "sacty",
  status: "queued",
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

async function load(list: Task[]) {
  tasks = list;
  const data = await loadTaskList("default");
  if (!data) throw new Error("一覧のデータが無い");
  return data;
}

async function page(list: Task[]) {
  const html = renderToStaticMarkup(
    createElement(LiveTaskList, { projectId: "default", initial: await load(list) }),
  );
  return new DOMParser().parseFromString(html, "text/html");
}

/** 最初の工程の前に sacty が処理している実行待ち（processing）と、枠を待っているだけの実行待ち（waiting）。 */
const list = () => [
  task({ id: "processing", preparing: "gathering", createdAt: "2026-10-11T00:00:00.000Z" }),
  task({ id: "waiting", createdAt: "2026-10-10T00:00:00.000Z" }),
];

describe("タスクの一覧：最初の工程の前の処理中（PBI-410）", () => {
  it("処理している実行待ちは進行中、枠を待つ実行待ちは待ちとして出し、状態の絞り込みも同じ区分になる", async () => {
    locale = "ja";
    const data = await load(list());
    const status = (id: string) => data.rows.find((r) => r.id === id)?.status;
    expect(status("processing")).toEqual({ text: "情報を収集中", tone: "working" });
    expect(status("waiting")).toEqual({ text: "実行待ち", tone: "waiting" });
    const shown = (filter: (typeof EMPTY_FILTER)["status"]) =>
      data.rows
        .filter((r) => matchesFilter(r, { ...EMPTY_FILTER, status: filter }))
        .map((r) => r.id);
    expect(shown("working")).toEqual(["processing"]);
    expect(shown("waiting")).toEqual(["waiting"]);
    expect(shown("person")).toEqual([]);
    expect(shown(ACTIVE)).toEqual(["processing", "waiting"]);
    // どちらも、人の出番ではない
    expect(data.needsYou).toEqual([]);
  });

  for (const lang of ["ja", "en"] as const) {
    it(`${lang}：行に段階の文を出し、工程が決まる前の文は、処理中であることと矛盾しない`, async () => {
      locale = lang;
      const document = await page(list());
      const row = (id: string) => document.querySelector(`[data-testid="task-row-${id}"]`);
      expect(row("processing")?.querySelector("td:last-child")?.textContent).toBe(
        lang === "ja" ? "情報を収集中" : "Gathering information",
      );
      expect(row("waiting")?.querySelector("td:last-child")?.textContent).toBe(
        lang === "ja" ? "実行待ち" : "Queued",
      );
      // 工程が決まる前の文は、これから選ぶ（未来形）ではなく、決まっていないという状態だけを言う
      const chips = lang === "ja" ? "工程は未定" : "Steps not chosen yet";
      expect(row("processing")?.textContent).toContain(chips);
      expect(row("waiting")?.textContent).toContain(chips);
      expect(row("processing")?.textContent).not.toMatch(/選びます|will choose/);
    });
  }
});
