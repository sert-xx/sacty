import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";
import type { RepositoryCandidates } from "@/lib/repository-candidates";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({ createTaskAction: async () => ({}) }));

const { CandidatesProblems, CandidatesStatus } = await import("./new-task-dialog");

const render = (candidates: RepositoryCandidates) =>
  renderToStaticMarkup(
    createElement("div", null, [
      createElement(CandidatesProblems, { candidates, key: "p" }),
      createElement(CandidatesStatus, { candidates, key: "s" }),
    ]),
  );

describe("タスクの作成のダイアログの、リポジトリの候補（PBI-109）", () => {
  it("取得の途中・失敗・空を、ダイアログの中でわかるように出す（どれも URL を入力して作成できると添える）", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).forms.task;
      expect(render({ status: "loading" }), lang).toContain(t.repositoriesLoading);
      expect(render({ status: "loading" }), lang).toContain('role="status"');
      const failed = render({ status: "failed", message: "boom" });
      expect(failed, lang).toContain(t.repositoriesFailed("boom"));
      expect(failed, lang).toContain('role="alert"');
      expect(render({ status: "loaded", repositories: [], problems: [] }), lang).toContain(
        t.repositoriesEmpty,
      );
    }
    locale = "ja";
  });

  it("候補を読めなかった Org の理由は、今と同じく出す（空の文言は重ねない）", () => {
    const t = messagesFor("ja").forms.task;
    const problem = t.listFailed("acme", "gh に認証されていません");
    const html = render({ status: "loaded", repositories: [], problems: [problem] });
    expect(html).toContain(problem);
    expect(html).not.toContain(t.repositoriesEmpty);
    expect(html).not.toContain(t.repositoriesLoading);
  });

  it("候補が読めたら、状態の文言は出さない", () => {
    const t = messagesFor("ja").forms.task;
    const html = render({ status: "loaded", repositories: ["acme/api"], problems: [] });
    expect(html).not.toContain(t.repositoriesLoading);
    expect(html).not.toContain(t.repositoriesEmpty);
  });
});
