// @vitest-environment jsdom
import { type FinalReview, type Task, WORKSPACE_FILE_FAILURE } from "@sacty/core";
import { type FC, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/client";
import { Implementation } from "./implementation";

/*
 * 最終レビューで、人が最終承認で確かめること（PBI-155）。作業領域では確かめられなかったことと、環境によると判断した
 * テストの失敗を出し、環境による失敗だけならテストは通ったものとして出す。
 */

const FAILURE = "processes.test.ts：起点のコミットでも同じく失敗する";

const review = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: true,
  viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
  remarks: [],
  summary: "所見",
  tests: { command: "npm test", exitCode: 1, output: "16 failed", environmentFailures: [FAILURE] },
  humanChecks: ["macOS の日本語入力で確かめる"],
  agentId: "g",
  runId: "r",
  costUsd: 0,
  estimated: false,
  at: "2026-10-24T10:00:00.000Z",
  ...extra,
});

const task = (lastReview: FinalReview) =>
  ({
    id: "t1",
    title: "ショートカット",
    status: "queued",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    outputs: { implement: "# 実装の説明" },
    approved: {},
    testMap: [{ viewpointId: "REQ", tests: ["form.test.ts"] }],
    remarks: [],
    lastReview,
  }) as unknown as Task;

const render = (t: Task, locale: "ja" | "en" = "ja") =>
  renderToStaticMarkup(
    h(
      I18nProvider as unknown as FC<{ locale: "ja" | "en" }>,
      { locale },
      h(Implementation, { task: t }),
    ),
  );

describe("Implementation の人が確かめること（PBI-155）", () => {
  it("人が確かめることと環境による失敗を出し、テストは合格として出す", () => {
    const html = render(task(review()));
    expect(html).toContain("人が確かめること");
    expect(html).toContain('<li class="break-words">macOS の日本語入力で確かめる</li>');
    expect(html).toContain(`環境によると判断したテストの失敗：${FAILURE}`);
    expect(html).toContain("環境による失敗だけ");
    expect(html).not.toContain("不合格");
    expect(render(task(review()), "en")).toContain("For a person to check");
  });

  it("どちらも無ければ出さない", () => {
    const html = render(
      task(
        review({
          humanChecks: undefined,
          tests: { command: "npm test", exitCode: 0, output: "" },
        }),
      ),
    );
    expect(html).not.toContain("人が確かめること");
    expect(html).not.toContain("環境による失敗だけ");
  });
});

describe("Implementation の、ツールが無くて実行できなかった検証（PBI-158）", () => {
  const skipped = review({
    tests: { command: "go test ./...", exitCode: 127, output: "", missingCommands: ["go"] },
    humanChecks: [
      "go のある環境で、テスト（検証）のコマンド `go test ./...` を実行して確かめてください",
    ],
  });

  it("実行できなかったことを示し、人が確かめることに出す。テストの不合格とは出さない", () => {
    const html = render(task(skipped));
    expect(html).toContain("go が無く実行できず");
    expect(html).toContain(
      "go のある環境で、テスト（検証）のコマンド `go test ./...` を実行して確かめてください",
    );
    expect(html).not.toContain("不合格");
    expect(render(task(skipped), "en")).toContain("Could not run: go missing");
  });

  it("記録が無ければ（コードを含む差分・それより前の版）、出さない", () => {
    const html = render(
      task(review({ tests: { command: "go test ./...", exitCode: 0, output: "" } })),
    );
    expect(html).not.toContain("無く実行できず");
  });
});

describe("Implementation のテストを書かずに差分で確かめる観点", () => {
  const designed = (lastReview?: FinalReview) =>
    ({
      ...task(lastReview ?? review()),
      verification: undefined,
      approved: {
        design: {
          output: "# 設計",
          testViewpoints: [
            {
              id: "TV-1",
              title: "手順の文言",
              input: "README",
              expected: "新しい手順が書かれている",
            },
          ],
        },
      },
      testMap: [{ viewpointId: "TV-1", tests: [], untested: "README の文言だけを直したため" }],
    }) as unknown as Task;

  it("テストが無いことを警告にせず、申告の理由と、ゴールガーディアンが差分で判定したことを出す", () => {
    const html = render(
      designed(
        review({
          viewpoints: [{ viewpointId: "TV-1", verified: true, reason: "差分で確かめた" }],
          tests: { command: "npm test", exitCode: 0, output: "" },
          humanChecks: undefined,
        }),
      ),
    );
    expect(html).toContain("テストなし・差分で確認（README の文言だけを直したため）");
    expect(html).toContain("差分で判定");
    expect(html).not.toContain("対応するテストがありません");
    expect(html).not.toContain("テスト合格");
    expect(render(designed(), "en")).toContain("No test; checked in the diff");
  });
});

describe("Implementation の設計の無いタスクの観点 REQ", () => {
  it("設計が無くても、実装が REQ を差分で確かめると申告したら、REQ と理由を出す", () => {
    const t = {
      ...task(
        review({
          viewpoints: [{ viewpointId: "REQ", verified: true, reason: "差分で確かめた" }],
          tests: { command: "npm test", exitCode: 0, output: "" },
          humanChecks: undefined,
        }),
      ),
      testMap: [{ viewpointId: "REQ", tests: [], untested: "README の文言だけを直したため" }],
    } as unknown as Task;
    const html = render(t);
    expect(html).toContain("受け入れ条件・タスクの目的");
    expect(html).toContain("テストなし・差分で確認（README の文言だけを直したため）");
    expect(html).toContain("差分で判定");
  });
});

describe("Implementation の、終了コードが 0 でないのに合格にした理由（PBI-302 A2）", () => {
  const designed = (lastReview: FinalReview) =>
    ({
      ...task(lastReview),
      verification: undefined,
      approved: {
        design: {
          output: "# 設計",
          testViewpoints: [
            { id: "TV-1", title: "文言", input: "README", expected: "書かれている" },
          ],
        },
      },
      testMap: [{ viewpointId: "TV-1", tests: ["a.test.ts › 文言"] }],
    }) as unknown as Task;
  const reviewed = (tests: FinalReview["tests"]) =>
    review({
      viewpoints: [{ viewpointId: "TV-1", verified: true, reason: "検証している" }],
      humanChecks: undefined,
      tests,
    });

  it("観点ごとの「テスト合格」に、環境による失敗だけで合格にしたことを添え、理由を日英で出す", () => {
    const html = render(
      designed(
        reviewed({ command: "npm test", exitCode: 1, output: "", environmentFailures: [FAILURE] }),
      ),
    );
    expect(html).toContain("テスト合格（環境による失敗のみ）");
    expect(html).toContain('data-testid="environment-pass-note"');
    expect(html).toContain(
      "終了コードは 1 ですが、失敗がすべて環境によるものとゴールガーディアンが判断したため",
    );
    const en = render(
      designed(
        reviewed({ command: "npm test", exitCode: 1, output: "", environmentFailures: [FAILURE] }),
      ),
      "en",
    );
    expect(en).toContain("Tests passed (environment failures only)");
    expect(en).toContain("The exit code is 1, but the run counts as passed");
  });

  it("終了コード 0 の合格には添えない", () => {
    const html = render(designed(reviewed({ command: "npm test", exitCode: 0, output: "" })));
    expect(html).toContain("テスト合格");
    expect(html).not.toContain("環境による失敗のみ");
    expect(html).not.toContain("environment-pass-note");
  });

  it("sacty の作業用のファイルによる失敗だけなら、人が確かめることには出さず、理由だけを出す", () => {
    const html = render(
      designed(
        reviewed({
          command: "npm test",
          exitCode: 1,
          output: "",
          environmentFailures: [WORKSPACE_FILE_FAILURE],
        }),
      ),
    );
    expect(html).toContain(
      "失敗が sacty の作業用のファイルによるものだけで、リポジトリの検査の対象ではないため",
    );
    expect(html).not.toContain("人が確かめること");
    expect(html).not.toContain(WORKSPACE_FILE_FAILURE);
  });
});

describe("Implementation の、前の段の結果を使い回したテスト（PBI-305）", () => {
  const reused = review({
    tests: { command: "npm test", exitCode: 0, output: "120 passed", reusedFrom: "ci" },
    humanChecks: undefined,
  });

  it("見出しと補足を、ゴールガーディアンが実行したものではなく、判定に使った結果の表現にする", () => {
    const html = render(task(reused));
    expect(html).toContain("最終レビューが判定に使ったテスト");
    expect(html).toContain("PR の CI の結果を使い回し");
    expect(html).not.toContain("ゴールガーディアンが実行したテスト");
    expect(html).not.toContain("ゴールガーディアンが最終レビューの中で実行し");
    const en = render(task(reused), "en");
    expect(en).toContain("Tests the final review judged with");
    expect(en).not.toContain("Tests run by the Goal Guardian");
  });

  it("使い回していなければ、これまでどおりゴールガーディアンが実行したテストとして出す", () => {
    const html = render(task(review({ tests: { command: "npm test", exitCode: 0, output: "" } })));
    expect(html).toContain("ゴールガーディアンが実行したテスト");
    expect(html).not.toContain("最終レビューが判定に使ったテスト");
  });
});
