import { type ActivityEvent, project } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({
  pauseTaskAction: async () => ({}),
  cancelTaskAction: async () => ({}),
  resumeTaskAction: async () => ({}),
  rerunTaskAction: async () => ({}),
  deriveTaskAction: async () => ({}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const { TaskDetailView } = await import("./task-detail");

function task(repos: boolean, chosen: boolean, urls = false) {
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

describe("複数リポジトリの詳細（R-8）", () => {
  for (const lang of ["ja", "en"] as const) {
    for (const chosen of [false, true]) {
      for (const urls of [false, true]) {
        it(`${lang} で${urls ? "URL" : "名前"}の指定を作業先の選択${chosen ? "後" : "前"}に表示する`, () => {
          locale = lang;
          const html = renderToStaticMarkup(
            createElement(TaskDetailView, {
              data: {
                task: task(true, chosen, urls),
                activity: [],
                projectName: "Project",
                children: [],
              },
            }),
          );
          expect(html).toContain(
            `${messagesFor(lang).task.specifiedRepositories}: ${urls ? "https://github.com/acme/a, https://github.com/acme/b" : "acme/a, acme/b"}`,
          );
          expect(html).not.toContain('data-testid="no-repository"');
          if (chosen) {
            expect(html).toContain(`${messagesFor(lang).task.workingRepository}: acme/a`);
            expect(html).toContain("選択理由");
          }
        });
      }
    }
    it(`${lang} でリポジトリ無しの印を表示する`, () => {
      locale = lang;
      const html = renderToStaticMarkup(
        createElement(TaskDetailView, {
          data: { task: task(false, false), activity: [], projectName: "Project", children: [] },
        }),
      );
      expect(html).toContain('data-testid="no-repository"');
    });
  }
});
