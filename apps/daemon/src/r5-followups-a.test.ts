import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { aiReviewFor, aiReviewOfHead } from "./ai-review-head.js";
import { DEFAULT_CONTEXT_DIR } from "./context.js";
import {
  aiReviewBodyLine,
  buildPrompt,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildStepPullRequestBodyParts,
  buildStepPullRequestBodyText,
  joinBodyText,
  withoutInternalPaths,
} from "./prompts.js";
import { WORKSPACE_SCRATCH_DIR, WORKSPACE_TOOLS_DIR } from "./repository.js";

/*
 * r5 の試行で見つかった問題のうち、作業領域・検証・画面・記録（PBI-302 の A・D 群）。
 */

const read = (path: string) => readFileSync(join(DEFAULT_CONTEXT_DIR, path), "utf8");

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: "t-1",
    title: "請求の率を設定する",
    body: "率を設定できるようにする",
    status: "queued",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: { implement: "# 実装の説明\n\n- 率を足した" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["rate.test.ts › 率"] }],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

describe("A1 作業用のファイルを作業領域の外に置き、リポジトリの検査に影響させない", () => {
  it("検証の記録の置き場所を、作業領域の外の具体的な場所にする（<一時ディレクトリ> のままにしない）", () => {
    const dir = "skills/review/review-dispatch/references";
    for (const file of ["verification-run", "aggregation", "linked-docs", "screen-capture"]) {
      const text = read(`${dir}/${file}.md`);
      expect(text, file).not.toContain("<一時ディレクトリ>");
      expect(text, file).toContain(WORKSPACE_SCRATCH_DIR);
    }
    const run = read(`${dir}/verification-run.md`);
    expect(run).toContain("ツール用のディレクトリなど）を示していても");
    expect(run).toContain("ログ・要約・起点の写しなどの記録を置く場所ではない");
    expect(run).toContain("検証のスクリプトやコマンドにも");
    // 既定のスキルはどのリポジトリにも渡るので、sacty の名前を書かない
    for (const file of ["verification-run", "aggregation", "linked-docs", "screen-capture"]) {
      expect(read(`${dir}/${file}.md`), file).not.toContain("sacty");
    }
  });

  it("既定の規則は、.sacty-tools を道具の置き場だけにし、作業用のファイルを外に置かせる", () => {
    const rules = read("rules.md");
    expect(rules).toContain("`.sacty-tools/` は道具を入れる場所だけです");
    expect(rules).toContain(`\`${WORKSPACE_SCRATCH_DIR}/\` に置いてください`);
    expect(rules).toContain("リポジトリのファイル（スクリプト・テスト・設定）に、");
  });

  it("実装の指示は、.sacty-tools に作業用のファイルを置かせず、内部の名前をリポジトリに書かせない", () => {
    for (const prompt of [
      buildPrompt(task(), "implement"),
      buildPrompt(task({ steps: [{ key: "implement", state: "active" }] } as never), "implement"),
    ]) {
      expect(prompt).toContain(`${WORKSPACE_TOOLS_DIR}/ は入れたツールの置き場だけ`);
      expect(prompt).toContain(`作業領域の外の ${WORKSPACE_SCRATCH_DIR}/ に置く`);
      expect(prompt).toContain("sacty の作業領域の内部の名前を書かない");
    }
  });

  it("人が読む文章から、作業用の一時ファイルのパスも除く", () => {
    expect(withoutInternalPaths(`ログは ${WORKSPACE_SCRATCH_DIR}/review-verify/a.log にある`)).toBe(
      "ログは 作業用の一時ファイル にある",
    );
    expect(withoutInternalPaths("下書き /tmp/sacty-self-review/draft.md を直す")).toContain(
      "作業用の一時ファイル",
    );
    expect(withoutInternalPaths("/tmp/agent-scratch を見る")).toBe("作業用の一時ファイル を見る");
    expect(withoutInternalPaths("/tmp/other/x と src/tmp/sacty-x.ts")).toBe(
      "/tmp/other/x と src/tmp/sacty-x.ts",
    );
  });
});

describe("A2 終了コードが 0 でないのに合格にした理由を、「合格」とだけ出さない", () => {
  const withTests = (tests: Record<string, unknown>) =>
    task({
      lastReview: {
        passed: true,
        viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
        remarks: [],
        summary: "所見",
        tests: { command: "npm test", output: "", ...tests },
        agentId: "g",
        runId: "r",
        costUsd: 0,
        estimated: false,
        at: "2026-11-04T00:00:00.000Z",
      },
    } as unknown as Partial<Task>);

  it("環境による失敗だけと判断して合格にしたときは、そう書く。終了コード 0 の合格は、これまでどおり", () => {
    const body = joinBodyText(
      buildPullRequestBodyText(
        withTests({ exitCode: 1, environmentFailures: ["a.test.ts：起点でも失敗する"] }),
      ),
    );
    expect(body).toContain(
      "→ 合格（ゴールガーディアンが実行。終了コード 1。終了コードは 0 でないが、失敗は環境によるものだけと判断して合格にした。下の「人が確かめること」）",
    );
    expect(body).toContain("- [ ] 環境によると判断したテストの失敗：a.test.ts：起点でも失敗する");
    const ok = joinBodyText(buildPullRequestBodyText(withTests({ exitCode: 0 })));
    expect(ok).toContain("→ 合格（ゴールガーディアンが実行。終了コード 0）");
    expect(ok).not.toContain("合格にした");
    const failed = joinBodyText(buildPullRequestBodyText(withTests({ exitCode: 1 })));
    expect(failed).toContain("→ 不合格（ゴールガーディアンが実行。終了コード 1）");
  });
});

describe("D1 今の head に sacty の AI のレビューが付いているか", () => {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const gate = (extra: Partial<Task> = {}) =>
    task({
      id: "impl",
      status: "awaiting_approval",
      gate: { step: "implement", submission: 1 },
      pullRequest: {
        branch: "b",
        commit: "7ed51c5aaaa",
        url: "https://github.com/acme/app/pull/2",
        number: 2,
        repo: "https://github.com/acme/app",
      },
      pullRequestState: "open",
      ...extra,
    } as unknown as Partial<Task>);
  const reviewer = (extra: Record<string, unknown> = {}) =>
    ({
      id: "rev",
      title: "PR のレビュー",
      body: "https://github.com/acme/app/pull/2 をレビューする",
      status: "running",
      steps: [{ key: "review", state: "active" }],
      repository: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "abc" },
      ...extra,
    }) as unknown as Task;

  it("レビューのタスクが無ければ none、動いていれば reviewing、今の head に投稿していれば attached", () => {
    const g = gate();
    expect(aiReviewOfHead(g, [g], same, "7ed51c5aaaa")).toEqual({
      head: "7ed51c5aaaa",
      status: "none",
    });
    expect(aiReviewOfHead(g, [g, reviewer()], same, "7ed51c5aaaa")).toEqual({
      head: "7ed51c5aaaa",
      status: "reviewing",
    });
    const posted = reviewer({
      status: "idle",
      reviewTarget: { headCommit: "7ed51c5" },
      reviewPost: { url: "https://github.com/acme/app/pull/2#r1", at: "x" },
    });
    expect(aiReviewOfHead(g, [g, posted], same, "7ed51c5aaaa")).toEqual({
      head: "7ed51c5aaaa",
      status: "attached",
      url: "https://github.com/acme/app/pull/2#r1",
    });
  });

  it("別の head へのレビュー・別の PR・中止・一時停止は、今の head のレビューに数えない", () => {
    const g = gate();
    const old = reviewer({
      status: "idle",
      reviewTarget: { headCommit: "0000000" },
      reviewPost: { url: "https://github.com/acme/app/pull/2#r0", at: "x" },
    });
    expect(aiReviewOfHead(g, [g, old], same, "7ed51c5aaaa")?.status).toBe("none");
    const runningOld = reviewer({ reviewTarget: { headCommit: "0000000" } });
    expect(aiReviewOfHead(g, [g, runningOld], same, "7ed51c5aaaa")?.status).toBe("none");
    const other = reviewer({ body: "https://github.com/acme/app/pull/9 をレビューする" });
    expect(aiReviewOfHead(g, [g, other], same, "7ed51c5aaaa")?.status).toBe("none");
    expect(
      aiReviewOfHead(g, [g, reviewer({ status: "cancelled" })], same, "7ed51c5aaaa")?.status,
    ).toBe("none");
    expect(
      aiReviewOfHead(g, [g, reviewer({ status: "paused" })], same, "7ed51c5aaaa")?.status,
    ).toBe("none");
    // 再レビューの前の回が今の head に付いていたなら、付いている
    const rerun = reviewer({
      reviewRound: 2,
      previousReview: {
        round: 1,
        url: "https://github.com/acme/app/pull/2#r1",
        at: "x",
        headCommit: "7ed51c5",
      },
    });
    expect(aiReviewOfHead(g, [g, rerun], same, "7ed51c5aaaa")?.status).toBe("attached");
  });

  it("状況は、提出したコミットではなく、PR が開いている間に読んだ最新の head で計算する。読めていなければ unknown", () => {
    const g = gate();
    // 提出したコミット A（7ed51c5）にレビューが付いている
    const posted = reviewer({
      status: "idle",
      reviewTarget: { headCommit: "7ed51c5" },
      reviewPost: { url: "https://github.com/acme/app/pull/2#r1", at: "x" },
    });
    expect(aiReviewOfHead(g, [g, posted], same, "7ed51c5aaaa")?.status).toBe("attached");
    // 人が未レビューのコミット B を足した：A のレビューを「今の head に付いている」としない
    expect(aiReviewOfHead(g, [g, posted], same, "bbbbbbb1111")).toEqual({
      head: "bbbbbbb1111",
      status: "none",
    });
    // 最新の head を読めていない：付いたと誤らない
    expect(aiReviewOfHead(g, [g, posted], same, undefined)).toEqual({
      head: "7ed51c5aaaa",
      status: "unknown",
    });
    expect(aiReviewBodyLine({ head: "7ed51c5aaaa", status: "unknown" })).toContain(
      "状況は分かりません",
    );
  });

  it("承認待ちでない・PR が開いていないタスクは、状況を持たない。作成前の PR（番号なし）は none", () => {
    expect(
      aiReviewOfHead(gate({ status: "running" } as Partial<Task>), [], same, "abc"),
    ).toBeUndefined();
    expect(
      aiReviewOfHead(gate({ pullRequestState: "merged" } as Partial<Task>), [], same, "abc"),
    ).toBeUndefined();
    expect(
      aiReviewFor(
        { repo: "https://github.com/acme/app", number: undefined, head: "abc" },
        "x",
        [reviewer()],
        same,
      ),
    ).toEqual({ head: "abc", status: "none" });
  });

  it("PR の本文に、今の head の AI のレビューの状況を書く（無ければ書かない）", () => {
    const t = task();
    for (const [status, text] of [
      ["none", "この head（7ed51c5）には、sacty の AI のレビューがまだ付いていません"],
      ["reviewing", "この head（7ed51c5）を、sacty の AI のレビューがレビュー中です"],
      ["attached", "この head（7ed51c5）には、sacty の AI のレビューが付いています"],
    ] as const) {
      const aiReview = { head: "7ed51c5aaaa", status };
      expect(aiReviewBodyLine(aiReview)).toContain(text);
      expect(joinBodyText(buildPullRequestBodyText(t, { aiReview }))).toContain(
        `- AI のレビュー：${text}`,
      );
      expect(buildPullRequestBodyParts(t, { aiReview }).summary).toContain(
        `AI のレビュー：${text}`,
      );
    }
    // 要求要件・設計の PR の本文にも書く（承認の案内の前。テンプレートに沿わせる本文は要約）
    const step = task({ stepPullRequests: [] } as Partial<Task>);
    const aiReview = { head: "7ed51c5aaaa", status: "reviewing" as const };
    const stepText = buildStepPullRequestBodyText(
      step,
      "requirements",
      "docs/sacty/t-1/requirements.md",
      aiReview,
    );
    expect(stepText.footer).toContain(
      "この head（7ed51c5）を、sacty の AI のレビューがレビュー中です",
    );
    expect(stepText.footer.indexOf("AI のレビュー：")).toBeLessThan(stepText.footer.indexOf("---"));
    expect(
      buildStepPullRequestBodyParts(
        step,
        "requirements",
        "docs/sacty/t-1/requirements.md",
        aiReview,
      ).summary,
    ).toContain("AI のレビュー：");
    expect(
      buildStepPullRequestBodyText(step, "requirements", "docs/sacty/t-1/requirements.md").footer,
    ).not.toContain("AI のレビュー：");
    expect(aiReviewBodyLine(undefined)).toBeUndefined();
    expect(joinBodyText(buildPullRequestBodyText(t))).not.toContain("AI のレビュー：");
    expect(
      aiReviewBodyLine({
        head: "abcdef1234",
        status: "attached",
        url: "https://github.com/a/b/pull/1#r",
      }),
    ).toContain("（https://github.com/a/b/pull/1#r）");
  });
});
