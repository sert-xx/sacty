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
  getDashboardSummary: async () => ({ waitingSince: {} }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { loadTaskList } = await import("@/lib/task-list-data");
const { LiveTaskList } = await import("./task-list");

function task(
  repos: boolean,
  chosen: boolean,
  urls = false,
  specified = ["https://github.com/acme/a", "https://github.com/acme/b"],
): Task {
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
              repos: urls ? specified : ["acme/a", "acme/b"],
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

async function render(repos: boolean, chosen: boolean, urls = false, specified?: string[]) {
  tasks = [task(repos, chosen, urls, specified)];
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
          const document = new DOMParser().parseFromString(html, "text/html");
          document.querySelector('[data-testid="task-repos-t1"] [data-slot="hint"]')?.remove();
          // URL の指定は、単数と同じリポジトリ名で出す（URL として読めない古い値は、そのまま。PBI-360）
          expect(document.querySelector('[data-testid="task-repos-t1"]')?.textContent?.trim()).toBe(
            `${messagesFor(lang).tasks.specifiedRepositories}: ${urls ? "a, b" : "acme/a, acme/b"}`,
          );
          expect(html).not.toContain('data-testid="no-repository"');
          if (chosen) {
            expect(document.querySelector('[data-testid="task-repo-t1"]')?.textContent).toBe(
              `${messagesFor(lang).tasks.workingRepository}: a`,
            );
          }
        });
      }
    }
    it(`${lang} で短い名前に URL の全体のツールチップを付け、同じ名前は owner/name（それも同じなら URL）で区別する（PBI-360）`, async () => {
      locale = lang;
      const specified = [
        "https://github.com/acme/web",
        "https://github.com/other/web",
        "https://github.com/acme/api",
        "https://ghe.example.com/acme/tools",
        "https://github.com/acme/tools",
      ];
      const html = await render(true, false, true, specified);
      const document = new DOMParser().parseFromString(html, "text/html");
      const shown = [...document.querySelectorAll('[data-testid="task-repos-t1"] [title]')].map(
        (e) => [e.textContent, e.getAttribute("title")],
      );
      expect(shown).toEqual([
        ["acme/web", specified[0]],
        ["other/web", specified[1]],
        ["api", specified[2]],
        [specified[3], specified[3]],
        [specified[4], specified[4]],
      ]);
      // キーボード・タップでも URL の全体を確かめられるよう、補足（フォーカスできる印）にも並べる。リンクは増やさない
      const hint = document.querySelector('[data-testid="task-repos-t1"] [data-slot="hint"]');
      expect(hint?.tagName).toBe("BUTTON");
      expect(hint?.getAttribute("aria-label")).toBe(messagesFor(lang).common.hint);
      expect(hint?.textContent).toBe(specified.join("\n"));
      expect(document.querySelectorAll('[data-testid="task-repos-t1"] a')).toHaveLength(0);
      hint?.remove();
      expect(document.querySelector('[data-testid="task-repos-t1"]')?.textContent?.trim()).toBe(
        `${messagesFor(lang).tasks.specifiedRepositories}: acme/web, other/web, api, ${specified[3]}, ${specified[4]}`,
      );
    });
    it(`${lang} でリポジトリ無しの印を表示する`, async () => {
      locale = lang;
      expect(await render(false, false)).toContain('data-testid="no-repository"');
    });
  }
});
