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

const { RiskAssessmentCard, riskAssessmentToShow } = await import("./risk-assessment");

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
    expect(html).toContain("PR を出す前に評価（以前の版） · 評価したコミット 0123456");
  });

  it("英語でも、同じ中身を英語の見出しで出す", () => {
    locale = "en";
    const html = render({ via: "review", commit: "0123456789abcdef", assessment, at: "x" });
    expect(html).toContain("PR risk assessment");
    expect(html).toContain(">High<");
    expect(html).toContain("Check from the design and impact");
    expect(html).toContain("Security (heavy) · Unverified behavior (light)");
    expect(html).toContain(
      "Assessed in the review step, in a round with no findings · Assessed commit 0123456",
    );
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

describe("PR を作ったタスクの詳細に、レビューの子タスクの評価を出す（PBI-429）", () => {
  const HEAD = "1".repeat(40);
  const NEW_HEAD = "2".repeat(40);
  const risk = (commit: string, level = "high", via = "review") => ({
    via,
    commit,
    assessment: { ...assessment, level },
    at: "x",
  });
  const parent = (over: Record<string, unknown> = {}) =>
    ({ pullRequest: { number: 7, commit: HEAD }, ...over }) as unknown as CardTask;
  // 子タスクが最後にレビューした先頭（reviewTarget）は、既定では評価した先頭と同じ
  const child = (
    riskAssessment: unknown,
    step = "implement",
    number = 7,
    reviewed: string | undefined = (riskAssessment as { commit?: string }).commit,
  ) =>
    ({
      step,
      number,
      task: { riskAssessment, ...(reviewed ? { reviewTarget: { headCommit: reviewed } } : {}) },
    }) as never;
  const view = (task: CardTask, reviewTasks: unknown[]) =>
    renderToStaticMarkup(h(RiskAssessmentCard, { task, reviewTasks: reviewTasks as never }));

  it("子タスクを開かずに、段階・勧める深さ・合図・とくに見る箇所と、評価した先頭を読める。今の先頭の評価なら、古い評価の注意は出さない", () => {
    const html = view(parent(), [child(risk(HEAD))]);
    expect(html).toContain("PR のリスク評価");
    expect(html).toContain(">高<");
    expect(html).toContain("設計と影響から確かめる");
    expect(html).toContain("セキュリティ（重い）");
    expect(html).toContain("src/auth.ts:10-30");
    expect(html).toContain("評価したコミット 1111111");
    expect(html).not.toContain('data-testid="risk-stale"');
  });

  it("PR の先頭が評価の後に進んでいたら、今の先頭の評価として見せない（日本語・英語）", () => {
    const moved = parent({ pullRequest: { number: 7, commit: NEW_HEAD } });
    const advanced = child(risk(HEAD), "implement", 7, NEW_HEAD);
    expect(view(moved, [advanced])).toContain('data-testid="risk-stale"');
    expect(view(moved, [advanced])).toContain("今の先頭の評価ではありません");
    locale = "en";
    expect(view(moved, [advanced])).toContain("It is not for the current head");
  });

  it("子タスクの再レビューが記録される前に親の PR の先頭が進んでいたら、子タスクの評価を今の先頭のものとして見せない", () => {
    // 子の reviewTarget は A（評価した先頭）、親の pullRequest.commit は B
    const ahead = parent({ pullRequest: { number: 7, commit: NEW_HEAD } });
    const html = view(ahead, [child(risk(HEAD))]);
    expect(html).toContain('data-testid="risk-stale"');
    expect(riskAssessmentToShow(ahead, [child(risk(HEAD))])?.current).toBe(false);
  });

  it("先頭が進み、その回が指摘あり・判定なしで終わっても（評価は更新されない）、前の先頭の評価を今のものとして見せない", () => {
    // 再レビューを始めた直後（対象を解決する前）と、対象を解決した後
    const restarted = {
      step: "implement",
      number: 7,
      task: { riskAssessment: risk(HEAD), reviewRestartCommit: NEW_HEAD },
    } as never;
    expect(view(parent(), [restarted])).toContain('data-testid="risk-stale"');
    expect(view(parent(), [child(risk(HEAD), "implement", 7, NEW_HEAD)])).toContain(
      'data-testid="risk-stale"',
    );
    // 比べる先頭が無ければ、今のものとは見せない
    expect(riskAssessmentToShow(parent(), [child(risk(HEAD), "implement", 7, "")])?.current).toBe(
      false,
    );
  });

  it("人が足したコミットで進んだ先頭（指摘なしにした先頭 reviewedCommit）の評価は、今の先頭のものとして出す", () => {
    const task = parent({ pullRequest: { number: 7, commit: HEAD, reviewedCommit: NEW_HEAD } });
    expect(view(task, [child(risk(NEW_HEAD))])).not.toContain('data-testid="risk-stale"');
  });

  it("評価できなかったときは、そのことと理由を出す", () => {
    const html = view(parent(), [
      child({ via: "review", commit: HEAD, reason: { code: "pr.riskUnreadable" }, at: "x" }),
    ]);
    expect(html).toContain('data-testid="risk-failed"');
    expect(html).toContain("エージェントの出力から、リスク評価を読み取れませんでした。");
  });

  it("まだ評価が無い（指摘なしの回が無い）・要求要件の子タスク・別の PR の子タスクだけなら、何も出さない", () => {
    expect(view(parent(), [])).toBe("");
    expect(view(parent(), [{ step: "implement", number: 7, task: {} }])).toBe("");
    expect(view(parent(), [child(risk(HEAD), "requirements")])).toBe("");
    expect(view(parent(), [child(risk(HEAD), "implement", 8)])).toBe("");
  });

  it("子タスクの新しい評価があれば、版を上げる前の評価（via: publish）より先に出す。無ければ、どの先頭の評価かを添え、今の先頭と違えば注意する", () => {
    const legacy = risk("9".repeat(40), "low", "publish");
    const task = parent({ riskAssessment: legacy });
    const both = view(task, [child(risk(HEAD, "high"))]);
    expect(both).toContain(">高<");
    expect(both).not.toContain(">低<");
    const only = view(task, []);
    expect(only).toContain(">低<");
    expect(only).toContain("評価したコミット 9999999");
    expect(only).toContain('data-testid="risk-stale"');
    expect(riskAssessmentToShow(task, [])?.current).toBe(false);
  });

  it("版を上げる前の記録（base・inheritedFrom つき）も、表示が崩れず読める", () => {
    const legacy = {
      ...risk(HEAD, "medium", "publish"),
      base: "b".repeat(40),
      inheritedFrom: "a".repeat(40),
    };
    const html = view(parent({ riskAssessment: legacy }), []);
    expect(html).toContain(">中<");
    expect(html).not.toContain('data-testid="risk-stale"');
  });

  it("レビューのタスク自身の評価は出る。最後にレビューした先頭と同じなら今のもの、先頭が進んでいれば今のものとして見せない", () => {
    const own = (over: Record<string, unknown>) =>
      ({
        riskAssessment: risk(HEAD),
        reviewOf: { taskId: "p", step: "implement" },
        ...over,
      }) as unknown as CardTask;
    const same = view(own({ reviewTarget: { headCommit: HEAD } }), []);
    expect(same).toContain(">高<");
    expect(same).not.toContain('data-testid="risk-stale"');
    const advanced = view(own({ reviewTarget: { headCommit: NEW_HEAD } }), []);
    expect(advanced).toContain(">高<");
    expect(advanced).toContain('data-testid="risk-stale"');
    expect(view(own({ reviewRestartCommit: NEW_HEAD }), [])).toContain('data-testid="risk-stale"');
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

  it("引き継いだ評価は、どのコミットの評価をどのコミットに引き継いだかを書く（PBI-421）", () => {
    const inherited = event({
      via: "publish",
      assessment,
      commit: "def5678".padEnd(40, "0"),
      inheritedFrom: "abc1234".padEnd(40, "0"),
    });
    const ja = describeEvent(inherited, messagesFor("ja").labels);
    expect(ja).toContain("abc1234 の評価を def5678 に引き継いだ");
    expect(ja).toContain("高");
    expect(describeEvent(inherited, messagesFor("en").labels)).toContain(
      "carried the assessment of abc1234 over to def5678",
    );
  });
});
