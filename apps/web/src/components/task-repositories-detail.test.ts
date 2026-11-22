// @vitest-environment jsdom
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

function task(
  repos: boolean,
  chosen: boolean,
  urls = false,
  specified = ["https://github.com/acme/a", "https://github.com/acme/b"],
) {
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

describe("複数リポジトリの詳細（R-8）", () => {
  it("同じ実行のサービス起動を1行にまとめ、それぞれの記録に移動できる", () => {
    const base = {
      taskId: "t1",
      projectId: "default",
      at: "2026-10-20T00:00:00.000Z",
      actor: "sacty",
      type: "ServicesStarted",
    };
    const activity = [
      {
        ...base,
        id: "first",
        seq: 1,
        payload: {
          runId: "run1",
          step: "implement",
          file: "compose.yml",
          services: [{ name: "db", ports: [5432] }],
        },
      },
      {
        ...base,
        id: "second",
        seq: 2,
        payload: {
          runId: "run1",
          step: "implement",
          file: "shared.yml",
          compose: { name: "infra", commit: "abcdef123" },
          services: [{ name: "redis", ports: [6379] }],
        },
      },
    ] as ActivityEvent[];
    const html = renderToStaticMarkup(
      createElement(TaskDetailView, {
        data: { task: task(false, false), activity, projectName: "Project", children: [] },
      }),
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const first = document.getElementById("event-first");
    const second = document.getElementById("event-second");
    expect(first?.closest("li")).toBe(second?.closest("li"));
    expect(first?.closest("li")?.textContent).toContain("db");
    expect(first?.closest("li")?.textContent).toContain("redis");
  });
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
          const document = new DOMParser().parseFromString(html, "text/html");
          // URL の指定は、単数と同じ owner/name で出し、URL の全体はリンク先とツールチップ（PBI-360）
          expect(document.querySelector('[data-testid="task-repos"]')?.textContent).toBe(
            `${messagesFor(lang).task.specifiedRepositories}: acme/a, acme/b`,
          );
          expect(
            [...document.querySelectorAll('[data-testid="task-repos"] a')].map((a) => [
              a.textContent,
              a.getAttribute("href"),
              a.getAttribute("title"),
            ]),
          ).toEqual(
            urls
              ? [
                  ["acme/a", "https://github.com/acme/a", "https://github.com/acme/a"],
                  ["acme/b", "https://github.com/acme/b", "https://github.com/acme/b"],
                ]
              : [],
          );
          expect(html).not.toContain('data-testid="no-repository"');
          if (chosen) {
            expect(html).toContain(`${messagesFor(lang).task.workingRepository}: acme/a`);
            expect(html).toContain("選択理由");
          }
        });
      }
    }
    it(`${lang} で別のホストの同じ owner/name は URL の全体で区別する（PBI-360）`, () => {
      locale = lang;
      const specified = ["https://ghe.example.com/acme/tools", "https://github.com/acme/tools"];
      const html = renderToStaticMarkup(
        createElement(TaskDetailView, {
          data: {
            task: task(true, false, true, specified),
            activity: [],
            projectName: "Project",
            children: [],
          },
        }),
      );
      const document = new DOMParser().parseFromString(html, "text/html");
      expect(
        [...document.querySelectorAll('[data-testid="task-repos"] a')].map((a) => [
          a.textContent,
          a.getAttribute("href"),
        ]),
      ).toEqual(specified.map((url) => [url, url]));
    });
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
