import { FLAKY_KNOWN_MIN_TASKS, type FlakyTest, TASK_BODY_MAX, TASK_TITLE_MAX } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({ createTaskAction: async () => ({}) }));

const { FlakyTestsCard, flakyFixDraft } = await import("./flaky-tests");

const test1 = (patch: Partial<FlakyTest> = {}): FlakyTest => ({
  name: "ui > 保存",
  file: "tests/ui.spec.ts",
  repo: "https://github.com/acme/app",
  taskCount: 1,
  lastSeenAt: "2026-01-02T03:04:05.000Z",
  reason: "別の画面",
  tasks: [
    {
      taskId: "t1",
      taskTitle: "決済の修正",
      at: "2026-01-02T03:04:05.000Z",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
    },
  ],
  known: false,
  ...patch,
});
const project = { id: "p1", name: "決済", hasTargets: true };
const render = (tests: FlakyTest[]) =>
  renderToStaticMarkup(createElement(FlakyTestsCard, { tests, project }));
const count = (html: string, text: string) => html.split(text).length - 1;

describe("監査の画面の不安定なテスト（PBI-312）", () => {
  it("0 件なら、まだ無いと出し、提案を出さない", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const m = messagesFor(lang).audit.screen.flaky;
      const html = render([]);
      expect(html, lang).toContain(m.none);
      expect(html, lang).not.toContain(m.createFix);
    }
    locale = "ja";
  });

  it("1 件：名前・タスクの数・最後に見た日時・タスクと PR へのリンクを出す。既知でなければ提案しない", () => {
    const m = messagesFor("ja").audit.screen.flaky;
    const html = render([test1()]);
    expect(html).toContain("ui &gt; 保存");
    expect(html).toContain("tests/ui.spec.ts");
    expect(html).toContain(m.taskCount(1));
    expect(html).toContain('dateTime="2026-01-02T03:04:05.000Z"');
    expect(html).toContain('href="/tasks/t1"');
    expect(html).toContain('href="https://github.com/acme/app/pull/7"');
    expect(html).not.toContain(m.createFix);
    expect(html).not.toContain(m.known);
  });

  it("複数件：既知のものだけに提案を出す。提案はダイアログを開くボタンで、タスクは作らない", () => {
    const m = messagesFor("ja").audit.screen.flaky;
    const html = render([
      test1({ name: "a", taskCount: FLAKY_KNOWN_MIN_TASKS, known: true }),
      test1({ name: "b", taskCount: 2 }),
    ]);
    expect(count(html, 'data-testid="flaky-test"')).toBe(2);
    expect(count(html, 'data-testid="flaky-test-proposal"')).toBe(1);
    expect(count(html, m.createFix)).toBe(1);
    // ダイアログを開く前は、フォームを出さない（作成は人の操作だけ）
    expect(html).not.toContain("<form");
  });

  it("直しているタスクがあれば、提案を重ねず、そのタスクへのリンクを出す", () => {
    const m = messagesFor("ja").audit.screen.flaky;
    const html = render([
      test1({ known: true, taskCount: 3, fixTask: { taskId: "fix", title: "直す" } }),
    ]);
    expect(html).not.toContain(m.createFix);
    expect(html).toContain(m.fixTask);
    expect(html).toContain('href="/tasks/fix"');
  });

  it("英語の画面でも、日本語の文言を出さない", () => {
    locale = "en";
    const html = render([test1({ name: "ui", reason: "r", known: true, taskCount: 3 })]).replace(
      "決済の修正",
      "",
    );
    locale = "ja";
    expect(html).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});

describe("直すタスクの下書き（PBI-312）", () => {
  it("テスト・ファイル・根拠を書き、隔離・無効化で隠さないと添える。PR のリンクは書かない", () => {
    for (const lang of ["ja", "en"] as const) {
      const m = messagesFor(lang).audit.screen.flaky;
      const { title, body } = flakyFixDraft(test1({ taskCount: 3 }), m);
      expect(title, lang).toContain("ui > 保存");
      expect(body, lang).toContain("tests/ui.spec.ts");
      expect(body, lang).toContain("別の画面");
      // タスクの内容にある PR は、そのタスクが扱う PR と読まれる
      expect(body, lang).not.toContain("/pull/");
      expect(body, lang).toMatch(/隔離・無効化|quarantining or disabling/);
    }
  });

  it("長い名前・根拠は、タスクの題・内容の上限に収める", () => {
    const m = messagesFor("ja").audit.screen.flaky;
    const { title, body } = flakyFixDraft(
      test1({ name: "あ".repeat(TASK_TITLE_MAX * 2), reason: "い".repeat(TASK_BODY_MAX * 2) }),
      m,
    );
    expect(title).toHaveLength(TASK_TITLE_MAX);
    expect(body).toHaveLength(TASK_BODY_MAX);
  });
});
