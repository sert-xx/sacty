// @vitest-environment jsdom
import { type ActivityEvent, project, type Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
let tasks: Task[] = [];
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor(locale) }));
vi.mock("@/lib/daemon", () => ({
  listTasks: async () => tasks,
  listProjects: async () => [{ id: "default" }],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { loadTaskList } = await import("@/lib/task-list-data");
const { LiveTaskList } = await import("./task-list");

function task(repos: boolean, chosen: boolean, urls = false): Task {
  const base = { taskId: "t1", projectId: "default", at: "2026-10-20T00:00:00.000Z" };
  const events = [
    {
      ...base,
      id: "e1",
      seq: 1,
      actor: "person",
      type: "TaskCreated",
      payload: {
        title: "Work",
        body: "Work",
        start: "sacty",
        budgetCapUsd: 10,
        noRepo: true,
        ...(repos
          ? {
              repos: urls
                ? ["https://github.com/acme/a", "https://github.com/acme/b"]
                : ["acme/a", "acme/b"],
            }
          : {}),
      },
    },
  ] as ActivityEvent[];
  if (chosen)
    events.push({
      ...base,
      id: "e2",
      seq: 2,
      actor: "orchestrator",
      type: "RepositoryChosen",
      payload: { repo: "https://github.com/acme/a", reason: "選択理由", costUsd: 0 },
    } as ActivityEvent);
  const result = project(events).get("t1");
  if (!result) throw new Error("task missing");
  return result;
}

async function render(repos: boolean, chosen: boolean, urls = false) {
  tasks = [task(repos, chosen, urls)];
  const initial = await loadTaskList("default");
  if (!initial) throw new Error("project missing");
  return renderToStaticMarkup(createElement(LiveTaskList, { projectId: "default", initial }));
}

describe("複数リポジトリの一覧（R-8）", () => {
  for (const lang of ["ja", "en"] as const) {
    for (const chosen of [false, true]) {
      for (const urls of [false, true]) {
        it(`${lang} で${urls ? "URL" : "名前"}の指定を作業先の選択${chosen ? "後" : "前"}に表示する`, async () => {
          locale = lang;
          const html = await render(true, chosen, urls);
          expect(html).toContain(
            `${messagesFor(lang).tasks.specifiedRepositories}: ${urls ? "https://github.com/acme/a, https://github.com/acme/b" : "acme/a, acme/b"}`,
          );
          expect(html).not.toContain('data-testid="no-repository"');
          if (chosen) {
            const document = new DOMParser().parseFromString(html, "text/html");
            expect(document.querySelector('[data-testid="task-repo-t1"]')?.textContent).toBe(
              `${messagesFor(lang).tasks.workingRepository}: a`,
            );
          }
        });
      }
    }
    it(`${lang} でリポジトリ無しの印を表示する`, async () => {
      locale = lang;
      expect(await render(false, false)).toContain('data-testid="no-repository"');
    });
  }
});
