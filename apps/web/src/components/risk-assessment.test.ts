// @vitest-environment jsdom
import type { ActivityEvent } from "@sacty/core";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import { describeEvent } from "@/lib/labels";

/*
 * PR のリスク評価の欄と、作業履歴の行（PBI-362）。段階・勧めるレビューの深さ・根拠・とくに見る箇所を、日本語と英語で出す。
 */
let locale: "ja" | "en" = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));

const { RiskAssessmentCard } = await import("./risk-assessment");

type CardTask = Parameters<typeof RiskAssessmentCard>[0]["task"];

const assessment = {
  level: "high",
  signals: ["security", "unverified"],
  change: "認証の確認を変える",
  scope: "すべての API",
  reversibility: "元に戻せば戻る",
  verification: "テストは足していない",
  focus: [{ where: "src/auth.ts:10-30", why: "トークンの検証" }],
};

const render = (riskAssessment: unknown) =>
  renderToStaticMarkup(h(RiskAssessmentCard, { task: { riskAssessment } as CardTask }));

beforeEach(() => {
  locale = "ja";
});

describe("PR のリスク評価の欄（PBI-362）", () => {
  it("段階・勧める深さ・合図・根拠・とくに見る箇所を出す", () => {
    const html = render({ via: "publish", commit: "0123456789abcdef", assessment, at: "x" });
    expect(html).toContain("PR のリスク評価");
    expect(html).toContain('data-testid="risk-level"');
    expect(html).toContain(">高<");
    expect(html).toContain("設計と影響から確かめる");
    expect(html).toContain("セキュリティ（重い） · 確かめていない振る舞い（軽い）");
    expect(html).not.toContain("依存の版の更新");
    expect(html).toContain("認証の確認を変える");
    expect(html).toContain("すべての API");
    expect(html).toContain("元に戻せば戻る");
    expect(html).toContain("テストは足していない");
    expect(html).toContain("src/auth.ts:10-30");
    expect(html).toContain("トークンの検証");
    expect(html).toContain("PR を出す前に評価 · 評価したコミット 0123456");
  });

  it("英語でも、同じ中身を英語の見出しで出す", () => {
    locale = "en";
    const html = render({ via: "review", commit: "0123456789abcdef", assessment, at: "x" });
    expect(html).toContain("PR risk assessment");
    expect(html).toContain(">High<");
    expect(html).toContain("Check from the design and impact");
    expect(html).toContain("Security (heavy) · Unverified behavior (light)");
    expect(html).toContain("Assessed in the review step · Assessed commit 0123456");
  });

  it("段階ごとに、勧める深さが変わる。合図・とくに見る箇所が無ければ、その行を出さない", () => {
    const low = render({
      via: "publish",
      assessment: { ...assessment, level: "low", signals: [], focus: [] },
      at: "x",
    });
    expect(low).toContain(">低<");
    expect(low).toContain("流し読みでよい");
    expect(low).not.toContain("リスクの合図");
    expect(low).not.toContain("とくに見る箇所</dt>");
    expect(
      render({ via: "publish", assessment: { ...assessment, level: "medium" }, at: "x" }),
    ).toContain("変えた振る舞いの箇所を読む");
  });

  it("依存の版の更新があれば、上げ幅を出す。外した合図（以前の記録）には、重さを添えない（PBI-377）", () => {
    const patch = render({
      via: "review",
      assessment: { ...assessment, level: "low", signals: [], dependencyUpdate: "patch" },
      at: "x",
    });
    expect(patch).toContain('data-testid="risk-dependency-update"');
    expect(patch).toContain("依存の版の更新");
    expect(patch).toContain("パッチ");
    const old = render({
      via: "review",
      assessment: { ...assessment, signals: ["defect", "large"], dependencyUpdate: "unknown" },
      at: "x",
    });
    expect(old).toContain("不具合の疑い · 大きな差分（軽い）");
    expect(old).toContain("上げ幅を読み取れない");
    locale = "en";
    const en = render({
      via: "review",
      assessment: { ...assessment, signals: ["defect", "large"], dependencyUpdate: "major" },
      at: "x",
    });
    expect(en).toContain("Suspected defect · Large diff (light)");
    expect(en).toContain("Dependency version update");
    expect(en).toContain("Major");
  });

  it("評価できなかったときは、そのことと理由を出す", () => {
    const html = render({ via: "publish", reason: { code: "pr.riskUnreadable" }, at: "x" });
    expect(html).toContain('data-testid="risk-failed"');
    expect(html).toContain("評価できませんでした。");
    expect(html).toContain("エージェントの出力から、リスク評価を読み取れませんでした。");
    expect(html).not.toContain('data-testid="risk-level"');
  });

  it("評価が無ければ、欄を出さない", () => {
    expect(render(undefined)).toBe("");
  });
});

describe("作業履歴のリスク評価の行（PBI-362）", () => {
  const event = (payload: Record<string, unknown>) =>
    ({ type: "PullRequestRiskAssessed", payload, actor: "sacty" }) as unknown as ActivityEvent;

  it("評価した場面と段階を、日本語と英語で書く", () => {
    const assessed = event({ via: "publish", assessment });
    expect(describeEvent(assessed, messagesFor("ja").labels)).toContain(
      "PR を出す前に、PR のリスクを評価した：高",
    );
    expect(describeEvent(assessed, messagesFor("en").labels)).toContain(
      "Assessed the PR's risk before opening the PR: high",
    );
    expect(describeEvent(event({ via: "review", assessment }), messagesFor("ja").labels)).toContain(
      "レビューの工程で、PR のリスクを評価した：高",
    );
  });

  it("評価できなかったときは、理由を添える", () => {
    const failed = event({ via: "review", reason: { code: "pr.riskUnreadable" } });
    expect(describeEvent(failed, messagesFor("ja").labels)).toContain(
      "レビューの工程で、PR のリスクを評価できなかった：エージェントの出力から、リスク評価を読み取れませんでした。",
    );
    expect(describeEvent(failed, messagesFor("en").labels)).toContain(
      "Could not assess the PR's risk in the review step: Could not read the risk assessment from the agent's output.",
    );
  });
});
