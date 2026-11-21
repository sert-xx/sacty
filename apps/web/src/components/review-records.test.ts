// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * レビューの記録（PBI-460）：PR には出さない過程の情報を、すべての回について、画面の言語の文言で出す。記録の文は
 * PR を読んだエージェントが書いたものなので、Markdown・HTML として解釈しない。
 */
let locale: "ja" | "en" = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));

const { ReviewRecords } = await import("./review-records");

type Records = NonNullable<Task["reviewRecords"]>;

const round = (n: number, extra: Record<string, unknown> = {}): Records[number] => ({
  round: n,
  record: {
    mode: n === 2 ? "sequential" : "subagents",
    viewpoints: [
      { id: `C-${n}`, status: "launched", reason: `起動理由${n}` },
      { id: `C-${n}x`, status: "substituted", reason: `代わりに見た理由${n}` },
    ],
    notReviewed: [{ id: `D-${n}`, reason: `見られなかった理由${n}` }],
    dismissed: [
      {
        title: n === 1 ? "<b>x</b> と **y**" : `採用しなかった指摘${n}`,
        viewpoint: "C-3",
        reason: `不採用の理由${n}`,
      },
    ],
    dropped: { overlapping: n, outOfScope: n + 1, handled: n + 2, must: 0 },
    scope: [`絞った理由${n}`],
    verification: [
      { kind: "reused", text: `使い回した検証${n}` },
      { kind: "stopped", text: `止まった検証${n}` },
    ],
  },
  reviewDispatch: {
    agentId: `agent-${n}`,
    model: `model-${n}`,
    subagents: n * 3,
    ...(n === 3 ? { configuredAgentId: "primary-agent" } : {}),
  },
  ...extra,
});

const render = (records: Records, lang: "ja" | "en") => {
  locale = lang;
  return renderToStaticMarkup(h(ReviewRecords, { records }));
};

describe("レビューの記録の欄（PBI-460）", () => {
  const records = [round(1), round(2), round(3)];

  it("すべての回（3 回）の、観点ごとの扱いと理由・見られなかった観点と理由・採用しなかった指摘と理由・落とした件数・検証の経過・エージェントを、日本語で出す", () => {
    const html = render(records, "ja");
    for (const n of [1, 2, 3]) {
      expect(html).toContain(`${n}回目のレビュー`);
      expect(html).toContain(`起動理由${n}`);
      expect(html).toContain("親が代わりに見た");
      expect(html).toContain(`代わりに見た理由${n}`);
      expect(html).toContain(`D-${n}：見られなかった理由${n}`);
      expect(html).toContain(`不採用の理由${n}`);
      expect(html).toContain(`既存の指摘と重なる ${n}件・目的の範囲の外 ${n + 1}件`);
      expect(html).toContain(`絞った理由${n}`);
      expect(html).toContain(`使い回した：使い回した検証${n}`);
      expect(html).toContain(`止まった：止まった検証${n}`);
      expect(html).toContain(`レビューしたエージェント：agent-${n}（model-${n}）`);
      expect(html).toContain(`観点ごとの担当：${n * 3}件を起動`);
    }
    expect(html).toContain("観点ごとの担当に分けて見た");
    expect(html).toContain("逐次モードで見た");
    expect(html).toContain(
      "設定のエージェント primary-agent が使えなかったため、切り替え先で実行しました。",
    );
  });

  it("英語でも、同じ内容を英語の文言で出す", () => {
    const html = render(records, "en");
    for (const n of [1, 2, 3]) {
      expect(html).toContain(`Review round ${n}`);
      expect(html).toContain(`見られなかった理由${n}`);
      expect(html).toContain(`reused: 使い回した検証${n}`);
      expect(html).toContain(`stopped: 止まった検証${n}`);
      expect(html).toContain(`Reviewed by agent: agent-${n} (model-${n})`);
      expect(html).toContain(`Per-viewpoint reviewers: ${n * 3} started`);
    }
    expect(html).toContain("reviewed by the parent instead");
    expect(html).toContain("The configured agent primary-agent was unavailable");
    expect(html).toContain("Reviewed sequentially");
    expect(html).not.toContain("起動した");
  });

  it("記録の文は、Markdown・HTML として解釈せず、文字列のまま出す", () => {
    const html = render(records, "ja");
    // <b> はタグにならず、エスケープされた文字として出る。** も強調にならない
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; と **y**");
    expect(html).not.toContain("<strong>");
  });

  it("読めなかった回（null）はそのことだけを出し、記録の無い回の欄は出さない。以前の作業履歴（記録の無いタスク）では何も出さない", () => {
    const html = render([round(1), { round: 2, record: null }], "ja");
    expect(html).toContain("2回目のレビュー");
    expect(html).toContain("この回の記録は、読めなかったため残っていません。");
    expect(html).toContain("起動理由1");
    // 記録の無いタスク：欄が出ない
    expect(render([], "ja")).toBe("");
    expect(render([], "en")).toBe("");
  });
});
