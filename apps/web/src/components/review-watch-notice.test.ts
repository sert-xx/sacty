// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { type FC, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/client";
import { ReviewWatchNotice } from "./review-watch-notice";

/*
 * タスクの詳細に、レビューを投稿した後の PR の見守り（今の回の判定・何を待っているか）と、見守りを終えた理由を出す（PBI-411）。
 */

const render = (patch: Partial<Task>, locale: "ja" | "en" = "ja") =>
  renderToStaticMarkup(
    h(
      I18nProvider as unknown as FC<{ locale: "ja" | "en" }>,
      { locale },
      h(ReviewWatchNotice, {
        task: {
          id: "t1",
          status: "idle",
          steps: [{ key: "review", state: "done" }],
          reviewPost: { url: "https://github.com/acme/app/pull/9#r1", at: "2026-11-20T00:00:00Z" },
          ...patch,
        } as unknown as Task,
      }),
    ),
  );

const watch = { since: "2026-11-19T23:50:00Z" };

describe("ReviewWatchNotice", () => {
  it("見守り中は、今の回の判定と、PR の作者の対応を待っていること（人の出番ではないこと）を出す", () => {
    const html = render({
      reviewWatch: watch,
      reviewRound: 2,
      reviewVerdicts: [
        { round: 1, verdict: "changes_required" },
        { round: 2, verdict: "suggestions" },
      ],
    });
    expect(html).toContain('data-state="watching"');
    expect(html).toContain("PR の変化を見守っています");
    expect(html).toMatch(/<p role="status"[^>]*>2回目のレビューの判定：提案あり/);
    expect(html).toContain("PR の作者の対応を待っています。あなたの対応は要りません。");
    // 仕組み（何が起きると再レビュー・完了になるか）は、補足に置く
    expect(html).toContain("自動で再レビューします");
    expect(html).toContain('href="https://github.com/acme/app/pull/9#r1"');
    const en = render(
      { reviewWatch: watch, reviewVerdicts: [{ round: 1, verdict: "changes_required" }] },
      "en",
    );
    expect(en).toContain("Verdict of review round 1: changes required");
    expect(en).toContain("Waiting for the PR author to respond. Nothing is needed from you.");
  });

  it("フォークからの PR で自動の再レビューを見送っているときは、人が再レビューを押すまでレビューしないことと、新しい先頭を出す（PBI-461）", () => {
    const patch = {
      reviewWatch: watch,
      reviewVerdicts: [{ round: 1, verdict: "changes_required" as const }],
      reviewHold: { commit: "d".repeat(40), at: "2026-11-20T01:00:00Z" },
    };
    const html = render(patch);
    expect(html).toContain('data-testid="review-watch-held"');
    expect(html).toContain(
      "フォークからの PR なので、新しいコミット（ddddddd）は、人が再レビューを押すまでレビューしません。",
    );
    expect(render(patch, "en")).toContain("so the new commit (ddddddd) is not reviewed until");
    // 待っていなければ出さない
    expect(render({ ...patch, reviewHold: undefined })).not.toContain("review-watch-held");
  });

  it("判定が無い回も、判定が無いことを出して見守る。sacty が作った PR の子タスクは、PR を作ったタスクを待っていると出す", () => {
    expect(
      render({ reviewWatch: watch, reviewVerdicts: [{ round: 1, missing: "absent" }] }),
    ).toContain("1回目のレビューの判定：判定が付いていない");
    expect(
      render({ reviewWatch: watch, reviewVerdicts: [{ round: 1, missing: "invalid" }] }),
    ).toContain("1回目のレビューの判定：判定を読めない");
    const child = render({
      reviewWatch: watch,
      reviewVerdicts: [{ round: 1, verdict: "suggestions" }],
      reviewOf: { taskId: "p1", step: "implement" },
    });
    expect(child).toContain("PR を作ったタスクの対応を待っています。あなたの対応は要りません。");
    expect(child).toContain("PR を作ったタスクが PR を更新して承認待ちに戻ると");
  });

  it("見守りを終えて完了したタスクには、終えた理由（マージ・クローズ）を出す", () => {
    const ended = (reason: "merged" | "closed" | "parent_completed") =>
      render({
        reviewVerdicts: [{ round: 1, verdict: "suggestions" }],
        reviewWatchEnded: { reason },
      });
    expect(ended("merged")).toContain('data-state="merged"');
    expect(ended("merged")).toContain("PR がマージされたので、完了にしました。");
    expect(ended("closed")).toContain("PR がマージされずに閉じられたので、完了にしました。");
    expect(ended("parent_completed")).toContain(
      "PR を作ったタスクが完了したので、完了にしました。",
    );
  });

  it("指摘なしで完了したタスク・更新の前の版が投稿して完了したタスク・一時停止中・中止したタスクには、何も出さない", () => {
    expect(render({ reviewVerdicts: [{ round: 1, verdict: "no_findings" }] })).toBe("");
    // 更新の前の版の投稿（見守りの印が無い）
    expect(render({ reviewVerdicts: [{ round: 1, verdict: "changes_required" }] })).toBe("");
    expect(
      render({
        status: "paused",
        reviewWatch: watch,
        reviewVerdicts: [{ round: 1, verdict: "suggestions" }],
      }),
    ).toBe("");
    expect(
      render({
        status: "cancelled",
        reviewVerdicts: [{ round: 1, verdict: "suggestions" }],
        reviewWatchEnded: { reason: "merged" },
      }),
    ).toBe("");
  });
});
