// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * 後続に回したい案（PBI-370）：実装が「この PR では直さず、後続に回したい」と申告した指摘の一覧を、承認の画面に出し、
 * 人が 1 件ずつ「後続に回す／この PR で直す」を決める。タスクの詳細には、決めていない案があることと、承認の画面への
 * リンクを出す。
 */
const locale = vi.hoisted(() => ({ value: "ja" as "ja" | "en" }));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale.value) }));
vi.mock("@/app/actions", () => ({ deferralAction: async () => ({}) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    h("a", { href, ...rest }, children as never),
}));

const { DeferralNotice, deferralOriginUrl } = await import("./deferral");
const { DeferralPendingNotice } = await import("./deferral-pending");

const remark = (id: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  step: "implement",
  round: 1,
  text: `指摘 ${id} の文`,
  voided: false,
  submittedIn: 2,
  ...patch,
});

const task = (patch: Record<string, unknown> = {}): Task =>
  ({
    id: "t1",
    status: "awaiting_approval",
    gate: { step: "implement", submission: 2 },
    submissions: { implement: 2 },
    pullRequest: {
      branch: "b",
      commit: "c1",
      url: "https://github.com/acme/web/pull/7",
      number: 7,
      repo: "https://github.com/acme/web",
    },
    pullRequestState: "open",
    remarks: [],
    ...patch,
  }) as unknown as Task;

const proposals = [
  remark("implement-1-1", {
    source: "sacty_review",
    origin: { key: "review:601", number: 7 },
    deferral: { proposedIn: 2, reason: "直すには、新しい保存の仕組みが要ります" },
  }),
  remark("implement-1-2", { deferral: { proposedIn: 2, reason: "このタスクの範囲の外です" } }),
];

const render = (node: Parameters<typeof renderToStaticMarkup>[0], lang: "ja" | "en" = "ja") => {
  locale.value = lang;
  document.body.innerHTML = renderToStaticMarkup(node);
  return document.body;
};

describe("承認の画面：後続に回したい指摘の一覧と、指摘ごとの決定（PBI-370）", () => {
  it("日英で、案ごとに、指摘・理由・出どころ・元のコメントへのリンクと、決定の選択肢（まだ決めない・後続に回す・この PR で直す）を出す", () => {
    const ja = render(h(DeferralNotice, { task: task({ remarks: proposals }) }));
    expect(ja.querySelector("h2")?.textContent).toContain("後続に回したい指摘が2件あります");
    expect(ja.textContent).toContain(
      "マージの前に、後続に回すか、この PR で直すかを、1 件ずつ決めてください。",
    );
    const items = [...ja.querySelectorAll('[data-testid="deferral-item"]')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("指摘 implement-1-1");
    expect(items[0]?.textContent).toContain("AI のレビュー");
    expect(items[0]?.textContent).toContain("指摘 implement-1-1 の文");
    expect(items[0]?.textContent).toContain("後続に回したい理由");
    expect(items[0]?.textContent).toContain("直すには、新しい保存の仕組みが要ります");
    expect(items[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/web/pull/7#pullrequestreview-601",
    );
    // 画面から書いた指摘（元のコメントが無い・人の指摘）には、リンクと AI のレビューの印を出さない
    expect(items[1]?.querySelector("a")).toBeNull();
    expect(items[1]?.textContent).not.toContain("AI のレビュー");
    // 指摘ごとに、3 つから選ぶ。初めは「まだ決めない」
    const radios = [
      ...(items[0]?.querySelectorAll("input[type=radio]") ?? []),
    ] as HTMLInputElement[];
    expect(radios.map((r) => [r.name, r.value, r.hasAttribute("checked")])).toEqual([
      ["decision:implement-1-1", "", true],
      ["decision:implement-1-1", "defer", false],
      ["decision:implement-1-1", "fix", false],
    ]);
    expect(items[0]?.textContent).toContain("まだ決めない");
    expect(items[0]?.textContent).toContain("後続に回す");
    expect(items[0]?.textContent).toContain("この PR で直す");
    // 提出回と工程を、決定と一緒に送る（古い画面からの決定を、デーモンが断れるように）
    const hidden = (name: string) =>
      (ja.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value;
    expect([hidden("taskId"), hidden("step"), hidden("submission")]).toEqual([
      "t1",
      "implement",
      "2",
    ]);
    expect(ja.querySelector("button[type=submit]")?.textContent).toBe("決定する");
    expect(ja.textContent).toContain("「この PR で直す」を選ぶと、実装に差し戻します。");

    const en = render(h(DeferralNotice, { task: task({ remarks: proposals }) }), "en");
    expect(en.querySelector("h2")?.textContent).toContain(
      "2 findings the implementation proposes to defer",
    );
    expect(en.textContent).toContain("Why it proposes to defer");
    expect(en.textContent).toContain("Decide later");
    expect(en.textContent).toContain("Fix in this PR");
    expect(en.querySelector("button[type=submit]")?.textContent).toBe("Decide");
    const one = render(h(DeferralNotice, { task: task({ remarks: [proposals[0]] }) }), "en");
    expect(one.querySelector("h2")?.textContent).toContain(
      "1 finding the implementation proposes to defer",
    );
  });

  it("決定済みの指摘は、記録として出す。決めていない案が無ければ、決定のフォームは出さない", () => {
    const decided = [
      remark("implement-1-1", {
        deferral: { proposedIn: 2, reason: "仕組みが要る", decision: "defer" },
      }),
      remark("implement-1-2", {
        deferral: { proposedIn: 2, reason: "範囲の外", decision: "fix" },
      }),
    ];
    const body = render(h(DeferralNotice, { task: task({ remarks: decided }) }));
    expect(body.querySelector("form")).toBeNull();
    const record = body.querySelector('[data-testid="deferral-decided"]');
    expect(record?.textContent).toContain("決定済みの指摘（2件）");
    expect(record?.textContent).toContain("指摘 implement-1-1 ・ 後続に回すと決定");
    expect(record?.textContent).toContain("指摘 implement-1-2 ・ この PR で直すと決定");
    // 決めていない案と決定済みが混ざれば、両方を出す
    const mixed = render(
      h(DeferralNotice, { task: task({ remarks: [proposals[0], decided[1]] }) }),
    );
    expect(mixed.querySelectorAll('[data-testid="deferral-item"]')).toHaveLength(1);
    expect(mixed.querySelector('[data-testid="deferral-decided"]')?.textContent).toContain(
      "決定済みの指摘（1件）",
    );
  });

  it("指摘ごとに、後続に回すときの扱いを選べる。初めの値は、プロジェクトの既定（無ければ、何もしない）。決定済みの指摘には、扱いと結果を出す", () => {
    const select = (t: Task, lang: "ja" | "en" = "ja") =>
      render(h(DeferralNotice, { task: t }), lang).querySelector(
        '[data-testid="deferral-handling"]',
      ) as HTMLSelectElement;
    const options = (el: HTMLSelectElement) =>
      [...el.querySelectorAll("option")].map((o) => [o.value, o.textContent, o.selected]);
    const plain = select(task({ remarks: [proposals[0]] }));
    expect(plain.name).toBe("handling:implement-1-1");
    expect(options(plain)).toEqual([
      ["none", "何もしない", true],
      ["task", "Sacty の後続のタスクを作る", false],
      ["issue", "GitHub の Issue を作る", false],
    ]);
    const preset = select(
      task({ remarks: [proposals[0]], deferralHandlingDefault: "issue" }),
      "en",
    );
    expect(options(preset)).toEqual([
      ["none", "Do nothing", false],
      ["task", "Create a Sacty follow-up task", false],
      ["issue", "Create a GitHub issue", true],
    ]);
    const decided = (deferral: Record<string, unknown>) =>
      render(
        h(DeferralNotice, {
          task: task({
            remarks: [
              remark("implement-1-1", {
                deferral: { proposedIn: 2, reason: "理由", decision: "defer", ...deferral },
              }),
            ],
          }),
        }),
      ).querySelector('[data-testid="deferral-handled"]');
    expect(decided({})).toBeNull();
    expect(decided({ handling: "task" })?.textContent).toBe(
      "Sacty の後続のタスクを作る ・ このタスクの完了後に、後続のタスクを作成",
    );
    const made = decided({ handling: "task", handled: { taskId: "t2" } });
    expect(made?.querySelector("a")?.getAttribute("href")).toBe("/tasks/t2");
    expect(made?.querySelector("a")?.textContent).toBe("後続のタスクを開く");
    const issue = decided({
      handling: "issue",
      handled: { url: "https://github.com/acme/web/issues/901" },
    });
    expect(issue?.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/web/issues/901",
    );
    expect(decided({ handling: "issue" })?.textContent).toContain("Issue を作成中");
    expect(
      decided({ handling: "issue", handled: { failure: "403 forbidden" } })?.textContent,
    ).toContain("扱いを実行できませんでした：403 forbidden");
  });

  it("案が無い・無効にした指摘だけ・実装の承認待ちでないときは、何も出さない", () => {
    const none = (t: Task) =>
      render(h(DeferralNotice, { task: t })).querySelector('[data-testid="deferral"]');
    expect(none(task())).toBeNull();
    expect(none(task({ remarks: [{ ...proposals[0], voided: true }] }))).toBeNull();
    expect(none(task({ status: "queued", gate: undefined, remarks: proposals }))).toBeNull();
    expect(none(task({ status: "paused", gate: undefined, remarks: proposals }))).toBeNull();
    expect(none(task({ gate: { step: "design", submission: 2 }, remarks: proposals }))).toBeNull();
  });

  it("元のコメントの URL は、その PR のコメントから取り込んだ指摘だけに作る", () => {
    const pr = { number: 7, url: "https://github.com/acme/web/pull/7/" };
    expect(deferralOriginUrl(pr, { key: "review_comment:501", number: 7 })).toBe(
      "https://github.com/acme/web/pull/7#discussion_r501",
    );
    expect(deferralOriginUrl(pr, { key: "comment:401", number: 7 })).toBe(
      "https://github.com/acme/web/pull/7#issuecomment-401",
    );
    expect(deferralOriginUrl(pr, { key: "comment:401", number: 8 })).toBeUndefined();
    expect(deferralOriginUrl(pr, { key: "javascript:alert(1)", number: 7 })).toBeUndefined();
    expect(deferralOriginUrl(pr, undefined)).toBeUndefined();
    expect(deferralOriginUrl({ number: 7 }, { key: "comment:401", number: 7 })).toBeUndefined();
  });
});

describe("タスクの詳細：決めていない案があることを出す（PBI-370）", () => {
  it("日英で、件数と、承認の画面へのリンクを出す。決めていない案が無ければ出さない", () => {
    const ja = render(h(DeferralPendingNotice, { task: task({ remarks: proposals }) }));
    const notice = ja.querySelector('[data-testid="deferral-pending"]');
    expect(notice?.textContent).toContain("後続に回したい指摘が2件あります");
    expect(notice?.querySelector("a")?.getAttribute("href")).toBe("/tasks/t1/review");
    expect(notice?.querySelector("a")?.textContent).toBe("承認の画面で決める");
    const en = render(h(DeferralPendingNotice, { task: task({ remarks: proposals }) }), "en");
    expect(en.querySelector("a")?.textContent).toBe("Decide on the approval screen");
    const decided = proposals.map((p) => ({
      ...p,
      deferral: { ...(p.deferral as object), decision: "defer" },
    }));
    expect(
      render(h(DeferralPendingNotice, { task: task({ remarks: decided }) })).querySelector(
        '[data-testid="deferral-pending"]',
      ),
    ).toBeNull();
  });
});
