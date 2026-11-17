import { readFileSync } from "node:fs";
import { message, renderMessage, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { SactyConfig } from "./config.js";
import {
  allowedPlans,
  buildOrchestratorPrompt,
  buildPrompt,
  buildReviewImagePrompt,
  extractStepPlan,
} from "./prompts.js";
import { createApp } from "./server.js";
import { InvalidOperationError, selfReviewDepthOf } from "./service.js";
import { agent, configOf, dbPath, makeService, useTempDir } from "./testing/daemon.js";

useTempDir();

/** 軽い依頼のセルフレビューの指示の目印（スキルの「明示している場合に限り」と対応する文）。 */
const MARK =
  "- このタスクの依頼は、工程の選択で「軽い」と判定されている。このセルフレビューを、スキルの「軽い依頼の自己レビュー」の規則で行う";
const VIEWPOINTS =
  "最初のレビューで起動する観点は、要件への適合の観点（主対象の種類が design-doc なら D-1、code なら C-1、user-doc なら U-1）と、横断の X-1 だけにする";

const skill = (path: string) =>
  readFileSync(
    new URL(`../default-context/skills/review/review-dispatch/${path}`, import.meta.url),
    "utf8",
  );

const plan = (extra: Record<string, unknown>) =>
  `\`\`\`json\n${JSON.stringify({
    "sacty-steps": { plan: "skip-design", reason: "小さい", testCommand: "npm test", ...extra },
  })}\n\`\`\``;

describe("依頼の大きさを、工程を選ぶ時点でオーケストレーターに判定させる（PBI-369）", () => {
  const task = (extra: Partial<Task> = {}) =>
    ({
      id: "t-1",
      title: "README に節を足す",
      body: "使い方の節を足す",
      steps: [],
      remarks: [],
      outputs: {},
      approved: {},
      repository: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "abcdef1" },
      ...extra,
    }) as unknown as Task;

  it("工程の選択の指示に、軽いとする条件と、軽いと判定しない変更と、答えの形を書く", () => {
    const repoless = { title: "x", body: "", steps: [] } as unknown as Task;
    const prompts = [
      buildOrchestratorPrompt(task()),
      buildOrchestratorPrompt(repoless, { repoless: { repositories: [] } }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("- selfReviewDepth：依頼の大きさ。");
      expect(prompt).toContain("light（軽い）か normal（通常）のどちらかを書き");
      expect(prompt).toContain("理由は、画面で人が読む");
      // 軽いとするのは、すべての条件に当たるときだけ
      expect(prompt).toContain("light にするのは、次のすべてに当たるときだけ");
      // セキュリティにかかわる変更・取り消しにくい変更は、軽いと判定させない。迷うときも通常
      expect(prompt).toContain("セキュリティにかかわる変更は、認証・認可、秘密情報の扱い");
      expect(prompt).toContain("取り消しにくい変更は、データの削除・移行・形式の変更");
      expect(prompt).toContain("これらを含む・含むか分からない・迷うときは normal にする");
      expect(prompt).toContain(
        "security-check・security-fix・operation・split を選ぶときも normal にする",
      );
      // PR のレビューには関係しない
      expect(prompt).toContain("絞るのはセルフレビューだけで、PR のレビューには関係しない");
      expect(prompt).toContain(
        '"selfReviewDepth": "light または normal", "selfReviewDepthReason": "そう判定した理由"',
      );
    }
    // テストのコマンドの答えの形と、noTests の答えの形の両方に示す
    expect(prompts[0]?.match(/"selfReviewDepth": "light または normal"/g)).toHaveLength(2);
  });

  it("PR のレビューだけのタスクの指示（イメージの選択）には、依頼の大きさを判定させない", () => {
    const prompt = buildReviewImagePrompt(task(), [{ name: "node", description: "Node.js" }]);
    expect(prompt).not.toContain("selfReviewDepth");
  });

  it("答えからは、light・normal と理由を読む。理由の無い light と、決めた値でない答えは、判定として使わない", () => {
    expect(
      extractStepPlan(plan({ selfReviewDepth: "light", selfReviewDepthReason: "節を足すだけ" })),
    ).toMatchObject({ selfReviewDepth: "light", selfReviewDepthReason: "節を足すだけ" });
    expect(
      extractStepPlan(
        plan({ selfReviewDepth: "normal", selfReviewDepthReason: "振る舞いを変える" }),
      ),
    ).toMatchObject({ selfReviewDepth: "normal", selfReviewDepthReason: "振る舞いを変える" });
    // 理由の無い通常は、通常として読む（理由は持たない）
    const bare = extractStepPlan(plan({ selfReviewDepth: "normal" }));
    expect(bare).toMatchObject({ selfReviewDepth: "normal" });
    expect(bare).not.toHaveProperty("selfReviewDepthReason");
    // 理由の無い軽い判定（空・空白だけ・文字列でない）は使わない
    for (const reason of [undefined, "", "   ", 1, null]) {
      const got = extractStepPlan(
        plan({ selfReviewDepth: "light", selfReviewDepthReason: reason }),
      );
      expect(got, String(reason)).toBeDefined();
      expect(got, String(reason)).not.toHaveProperty("selfReviewDepth");
      expect(got, String(reason)).not.toHaveProperty("selfReviewDepthReason");
    }
    // 決めた値でない答え・書かない答えは、判定なし（通常として扱う）。理由だけも持たない
    for (const depth of ["Light", "small", true, 1, null, undefined]) {
      const got = extractStepPlan(plan({ selfReviewDepth: depth, selfReviewDepthReason: "理由" }));
      expect(got, String(depth)).toBeDefined();
      expect(got, String(depth)).not.toHaveProperty("selfReviewDepth");
      expect(got, String(depth)).not.toHaveProperty("selfReviewDepthReason");
    }
  });

  it("長い理由は、上限（1000 文字）で切る", () => {
    const got = extractStepPlan(
      plan({ selfReviewDepth: "light", selfReviewDepthReason: "あ".repeat(1500) }),
    );
    expect(got?.selfReviewDepthReason?.length).toBeLessThanOrEqual(1000);
    expect(got?.selfReviewDepth).toBe("light");
  });

  it("セキュリティ対応の組み合わせは、軽いと答えても通常として記録する。セルフレビューをする工程が無い組み合わせには記録しない", () => {
    const forced = selfReviewDepthOf({
      plan: "security-fix",
      selfReviewDepth: "light",
      selfReviewDepthReason: "数行の変更",
    });
    expect(forced.selfReviewDepth).toBe("normal");
    // 理由には、sacty が通常にしたことと、オーケストレーターの理由を残す（日英）
    const ja = renderMessage(forced.selfReviewDepthReason ?? "", "ja");
    expect(ja).toContain("セキュリティ対応のタスクは、依頼が軽いと判定しません");
    expect(ja).toContain("（理由：数行の変更）");
    expect(renderMessage(forced.selfReviewDepthReason ?? "", "en")).toContain(
      "is never judged light",
    );
    // 通常と答えたものは、そのまま
    expect(
      selfReviewDepthOf({
        plan: "security-fix",
        selfReviewDepth: "normal",
        selfReviewDepthReason: "理由",
      }),
    ).toEqual({ selfReviewDepth: "normal", selfReviewDepthReason: "理由" });
    // セルフレビューをする工程（要求要件・設計・実装・文書作成）がある、ほかの組み合わせは、答えのまま
    for (const p of [
      "standard",
      "skip-design",
      "direct",
      "bugfix",
      "document",
      "design-only",
    ] as const) {
      expect(
        selfReviewDepthOf({ plan: p, selfReviewDepth: "light", selfReviewDepthReason: "節を足す" }),
        p,
      ).toEqual({ selfReviewDepth: "light", selfReviewDepthReason: "節を足す" });
    }
    // セルフレビューをする工程が無い組み合わせ（PR のレビューだけ・調査だけ・セキュリティチェック・作業のみ）には、
    // 判定を使う所が無いので、軽いとも通常とも記録しない
    for (const p of ["review", "investigate", "security-check", "operation"] as const) {
      for (const depth of ["light", "normal"] as const) {
        expect(
          selfReviewDepthOf({ plan: p, selfReviewDepth: depth, selfReviewDepthReason: "小" }),
          `${p}/${depth}`,
        ).toEqual({});
      }
    }
    // 答えが無いときも記録しない
    expect(selfReviewDepthOf({ plan: "standard" })).toEqual({});
  });
});

describe("子タスクに分ける組み合わせ（分割の親）は、軽いと答えても通常として記録する（PBI-387）", () => {
  it("split は、軽いと答えても通常にし、理由に、sacty が通常にしたことと、オーケストレーターの理由を残す", () => {
    const forced = selfReviewDepthOf({
      plan: "split",
      selfReviewDepth: "light",
      selfReviewDepthReason: "文書の節を足すだけ",
    });
    expect(forced.selfReviewDepth).toBe("normal");
    expect(forced.selfReviewDepthReason).toEqual(
      message("selfReview.depthForcedNormalSplit", { reason: "文書の節を足すだけ" }),
    );
    const ja = renderMessage(forced.selfReviewDepthReason ?? "", "ja");
    expect(ja).toContain("子タスクに分けて進めるタスクは、依頼が軽いと判定しません");
    expect(ja).toContain("オーケストレーターは軽いと答えていました（理由：文書の節を足すだけ）");
    const en = renderMessage(forced.selfReviewDepthReason ?? "", "en");
    expect(en).toContain("A task that is split into child tasks is never judged light");
    expect(en).toContain("(reason: 文書の節を足すだけ)");
    // セキュリティ対応の文言とは別（どの決まりで通常にしたかが分かる）
    expect(ja).not.toContain("セキュリティ対応");
  });

  it("split で、理由の無い軽い答えも通常にし、理由には、括弧を付けずに、sacty が通常にしたことだけを残す", () => {
    const forced = selfReviewDepthOf({ plan: "split", selfReviewDepth: "light" });
    expect(forced.selfReviewDepth).toBe("normal");
    expect(renderMessage(forced.selfReviewDepthReason ?? "", "ja")).toBe(
      "子タスクに分けて進めるタスクは、依頼が軽いと判定しません。オーケストレーターは軽いと答えていました。",
    );
    expect(renderMessage(forced.selfReviewDepthReason ?? "", "en")).toBe(
      "A task that is split into child tasks is never judged light. The Orchestrator answered light.",
    );
  });

  it("split で通常と答えたもの・答えが無いものは、そのまま", () => {
    expect(
      selfReviewDepthOf({
        plan: "split",
        selfReviewDepth: "normal",
        selfReviewDepthReason: "理由",
      }),
    ).toEqual({ selfReviewDepth: "normal", selfReviewDepthReason: "理由" });
    expect(selfReviewDepthOf({ plan: "split" })).toEqual({});
  });

  it("子タスクが選べる組み合わせには split が無く、子の判定は、子ごとの答えのまま", () => {
    const child = { parent: { taskId: "p-1", dependsOn: [] } } as unknown as Task;
    expect(allowedPlans(child)).not.toContain("split");
    expect(allowedPlans({} as unknown as Task)).toContain("split");
    expect(
      selfReviewDepthOf({ plan: "direct", selfReviewDepth: "light", selfReviewDepthReason: "小" }),
    ).toEqual({ selfReviewDepth: "light", selfReviewDepthReason: "小" });
  });
});

describe("軽いと判定されたタスクでは、セルフレビューの観点を絞らせる（PBI-369）", () => {
  const LIGHT = { judged: "light", reason: "README に節を足すだけ" } as const;
  const PASSED = { rounds: 1, passed: true, remaining: [], notReviewed: [], summary: "" };
  const task = (extra: Partial<Task> = {}): Task =>
    ({
      id: "t-1",
      title: "README に節を足す",
      body: "使い方の節を足す",
      steps: ["requirements", "design", "implement"].map((key) => ({ key, state: "todo" })),
      remarks: [],
      outputs: {},
      approved: {
        requirements: { output: "# 承認済みの要求要件", submission: 1 },
        design: {
          output: "# 承認済みの設計",
          submission: 1,
          testViewpoints: [{ id: "TV-1", title: "節", input: "README", expected: "節がある" }],
        },
      },
      testViewpoints: [],
      reproductionTests: [],
      testCommand: "npm test",
      proposals: [],
      repository: {
        url: "https://github.com/acme/app",
        baseBranch: "main",
        baseCommit: "abcdef1234",
      },
      ...extra,
    }) as unknown as Task;
  const STEPS = ["requirements", "design", "implement"] as const;

  it("要求要件・設計・実装・文書作成のどの工程でも、観点を 2 つに絞り、段階を下げ、横断の 2 回目を省き、起動しなかった観点を残させる", () => {
    const prompts: [string, string][] = [
      ...STEPS.map(
        (step) => [step, buildPrompt(task({ selfReviewDepth: LIGHT }), step)] as [string, string],
      ),
      [
        "document",
        buildPrompt(
          task({
            selfReviewDepth: LIGHT,
            steps: [{ key: "document", state: "todo" }],
          } as Partial<Task>),
          "document",
        ),
      ],
    ];
    for (const [step, prompt] of prompts) {
      expect(prompt, step).toContain(MARK);
      expect(prompt, step).toContain(VIEWPOINTS);
      // リポジトリの決まり・スキルの観点は残す。X-2 は、検証が悪いときだけ
      expect(prompt, step).toContain(
        "対象のリポジトリに、今回の変更に当てはまる開発向けの決まり・レビュー用のスキルがあれば、X-3・R も起動する",
      );
      expect(prompt, step).toContain("X-2 は、実行した検証が失敗・警告を出したときだけ起動する");
      // 上位の段階の担当は 1 段下げる
      expect(prompt, step).toContain(
        "standard より上の段階の観点の担当は、1 段下の段階で起動する（既定の観点カタログでは、advanced の X-1・C-1・R を standard で起動する）",
      );
      // 横断の 2 回目を省く
      expect(prompt, step).toContain("X-1 も、前回の回で must を出したときだけ起動する");
      expect(prompt, step).toContain("起動する観点が無ければ、再レビューをせずに提出へ進む");
      // 起動しなかった観点と理由を、今までどおり残す
      expect(prompt, step).toContain(
        "起動しなかった観点は、起動表に「起動しない」と理由（軽い依頼）を残し、報告の summary でも、起動した観点と起動しなかった観点が分かるように書く",
      );
      // 意図して起動しなかった観点を、見られなかった観点（画面で確かめるよう出すもの）に混ぜさせない
      expect(prompt, step).toContain(
        "報告の notReviewed には書かない（notReviewed は、起動したのに結果を得られなかった観点だけ）",
      );
      // セキュリティにかかわる・取り消しにくいと分かったら、軽い依頼として扱わない
      expect(prompt, step).toContain("軽い依頼として扱わず、通常の規則で観点を決め");
      // 報告の形と回数の上限は変えない
      expect(prompt, step).toContain("回数の上限はスキルの規則（初回を含めて最大 5 回）");
      expect(prompt, step).toContain('{"sacty-self-review": {"rounds": 2, "passed": true');
    }
  });

  it("判定が無い・通常のタスクと、人が通常の深さに上書きしたタスクには、絞る指示を出さない（今までどおりの観点）", () => {
    const tasks: [string, Task][] = [
      ["判定なし", task()],
      ["通常", task({ selfReviewDepth: { judged: "normal", reason: "振る舞いを変える" } })],
      [
        "上書き",
        task({
          selfReviewDepth: LIGHT,
          selfReviewDepthOverride: { depth: "normal", at: "2026-11-17T00:00:00.000Z" },
        }),
      ],
    ];
    for (const [name, t] of tasks) {
      for (const step of STEPS) {
        const prompt = buildPrompt(t, step);
        expect(prompt, `${name}/${step}`).toContain("--- 提出の前のセルフレビュー ---");
        expect(prompt, `${name}/${step}`).not.toContain("軽い依頼");
        expect(prompt, `${name}/${step}`).not.toContain("「軽い」と判定されている");
      }
    }
    // 判定なしの指示は、軽いタスクの指示から、絞る指示の行だけを除いたものと同じ（ほかは変えていない）
    for (const step of STEPS) {
      const light = buildPrompt(task({ selfReviewDepth: LIGHT }), step).split("\n");
      const normal = buildPrompt(task(), step).split("\n");
      expect(light.length - normal.length, step).toBe(6);
      expect(
        light.filter((line) => !normal.includes(line)),
        step,
      ).toHaveLength(6);
    }
  });

  it("指摘を受けた直しの実行では、起動する観点は直しの実行の規則のままにし、段階と再レビューの規則だけを当てる", () => {
    const prompt = buildPrompt(
      task({
        selfReviewDepth: LIGHT,
        outputs: { requirements: "# 前回\n\n- 内容" },
        selfReviews: { requirements: PASSED },
        remarks: [
          { id: "requirements-1-1", step: "requirements", round: 1, text: "指摘", voided: false },
        ],
      } as Partial<Task>),
      "requirements",
    );
    expect(prompt).toContain("この実行は、人の差し戻し（requirements-1-1）を受けた直しである");
    expect(prompt).toContain(MARK);
    expect(prompt).toContain(
      "最初のレビューで起動する観点は、上の直しの実行の規則のまま（今回の指摘に関わる観点と X-1 だけ）にする",
    );
    // 観点を 2 つに絞る指示（初回の規則）は、直しの実行の規則と食い違うので出さない
    expect(prompt).not.toContain(VIEWPOINTS);
    expect(prompt).toContain("standard より上の段階の観点の担当は、1 段下の段階で起動する");
  });

  it("PR のレビューの工程と、セルフレビューを省く工程（提出を PR のレビューの子タスクがレビューする）には、絞る指示を出さない", () => {
    const review = buildPrompt(
      task({
        selfReviewDepth: LIGHT,
        steps: [{ key: "review", state: "todo" }],
        reviewComments: [],
        reviewTarget: {
          repo: "https://github.com/acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          title: "README",
          body: "",
          headCommit: "h".repeat(40),
          baseCommit: "b".repeat(40),
          author: "alice",
        },
      } as unknown as Partial<Task>),
      "review",
      { diff: "diff --git a/README.md b/README.md" },
    );
    expect(review).toContain("review-dispatch（流れは pr-review）");
    expect(review).not.toContain("軽い依頼");
    expect(review).not.toContain("「軽い」と判定されている");
    for (const step of STEPS) {
      const prompt = buildPrompt(task({ selfReviewDepth: LIGHT }), step, {
        pullRequestReview: true,
      });
      expect(prompt, step).toContain("--- 提出の前のセルフレビュー（行わない） ---");
      expect(prompt, step).not.toContain("軽い依頼");
    }
  });
});

describe("既定のスキル review-dispatch の、軽い依頼の自己レビューの規則（PBI-369）", () => {
  it("SKILL.md に、指示が明示したときだけ観点を絞る規則と、起動表の例がある", () => {
    const text = skill("SKILL.md");
    // 必須観点を全部起動する規則の例外として書く
    expect(text).toContain("作業の指示が軽い依頼と明示した `self-review` も除く。規則 8");
    expect(text).toContain("8. **軽い依頼の自己レビューは、観点を絞る**");
    // sacty の指示の文と、スキルが待つ明示の文が合っている
    expect(text).toContain(
      "作業の指示が「このタスクの依頼は軽いと判定されている。軽い依頼の自己レビューの規則で行う」と**明示している場合に限り**",
    );
    expect(MARK).toContain("軽い依頼の自己レビュー」の規則で行う");
    expect(text).toContain(
      "要件への適合の観点（主対象が `code` なら C-1、`design-doc` なら D-1、`user-doc` なら U-1）と X-1 だけ",
    );
    expect(text).toContain("`standard` より上の段階の担当は、1 段下の段階で起動する");
    expect(text).toContain("X-1 も、前回の回で `must` を出したときだけ起動する");
    expect(text).toContain("起動しなかった観点は、起動表に「起動しない」と理由（軽い依頼）を残す");
    // PR のレビューと、明示の無い実行には当てはめない
    expect(text).toContain("明示が無い実行と `pr-review` には、この規則を当てはめない");
    // セキュリティにかかわる・取り消しにくい変更なら使わない
    expect(text).toContain("この規則を使わず、規則 1〜7 で決める");
    // 起動表の例に、起動しなかった観点と理由の行がある
    expect(text).toContain(
      "| D-2 実現可能性・整合性 | 起動しない | | 軽い依頼：要件への適合と横断に絞る | |",
    );
    // 実測と合わない「費用は小さい」は書かない
    expect(text).not.toContain("費用は小さい");
  });

  it("流れの資料（self-review）に、観点・段階・再レビュー・記録・扱わないときの決め方がある", () => {
    const text = skill("references/self-review.md");
    expect(text).toContain("## 軽い依頼の自己レビュー");
    expect(text).toContain("| `user-doc` | U-1 正確性・コードとの同期 |");
    expect(text).toContain("明示が無いときは、対象が小さく見えても絞らない");
    // リポジトリの決まり・スキルの観点は残す
    expect(text).toContain("リポジトリが自分で決めた確認は、軽い依頼でも省かない");
    // 横断の 2 回目を省く
    expect(text).toContain("起動する観点が無いので、再レビューをせずに提出へ進む");
    // 起動しなかった観点と理由を残す
    expect(text).toContain("理由に「軽い依頼：要件への適合と横断に絞る」");
    expect(text).toContain("**軽い依頼として扱わないとき**");
    expect(text).toContain("`pr-review` には当てはめない");
  });

  it("観点カタログに段階を 1 段下げる規則があり、PR のレビューの資料は、対象が小さくても絞らないと書く", () => {
    const viewpoints = skill("references/viewpoints.md");
    expect(viewpoints).toContain(
      "`standard` より上の段階の担当を、この表の 1 段下の段階で起動する（`advanced` は `standard`、`expert` は `advanced`、`ultimate` は `expert`）",
    );
    expect(skill("references/pr-review.md")).toContain(
      "対象が小さくても、観点は絞らない（`self-review` の「軽い依頼の自己レビュー」は、`pr-review` には当てはめない）",
    );
  });

  it("既定のコンテキストの規則に、特定のリポジトリ・言語に寄せた語を書かない", () => {
    const section = skill("references/self-review.md").split("## 軽い依頼の自己レビュー")[1] ?? "";
    const added = section.split("## ループの上限")[0] ?? "";
    expect(added.length).toBeGreaterThan(500);
    expect(added).not.toMatch(/sacty|npm|vitest|TypeScript|Node\.js/i);
  });
});

describe("人が、タスクごとにセルフレビューを通常の深さに上書きする（PBI-369）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const config = () => {
    const base = (configOf(agent({ id: "luna" }))() as { ok: true; config: SactyConfig }).config;
    return { ok: true as const, config: base };
  };
  const chosen = (extra: Record<string, unknown>) =>
    out(
      `\`\`\`json\n${JSON.stringify({
        "sacty-steps": { plan: "design-only", reason: "設計だけ", ...extra },
      })}\n\`\`\``,
    );
  const depthEvents = (service: ReturnType<typeof makeService>["service"], id: string) =>
    service
      .get(id)
      ?.activity.filter((e) => e.type === "SelfReviewDepthChanged")
      .map((e) => ({ actor: e.actor, ...(e.type === "SelfReviewDepthChanged" ? e.payload : {}) }));

  it("軽いと判定されたタスクは、判定と理由を記録し、工程の指示で観点を絞る。上書きすると次の実行から通常になり、戻すとまた絞る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        chosen({ selfReviewDepth: "light", selfReviewDepthReason: "README に節を足すだけ" }),
        out("# 要求要件 v1"),
        out("# 要求要件 v2"),
        out("# 要求要件 v3"),
      ],
      { realPlanner: true, config },
    );
    const { id } = service.createTask({ projectId: "default", title: "README に節を足す" });
    await service.runNext(id);
    const first = service.get(id);
    expect(first?.task.selfReviewDepth).toEqual({
      judged: "light",
      reason: "README に節を足すだけ",
    });
    const event = first?.activity.find((e) => e.type === "StepsChosen");
    expect(event?.type === "StepsChosen" && event.payload.selfReviewDepth).toBe("light");
    // 最初の工程（要求要件）の指示に、絞る指示がある
    expect(executor.stdins[1]).toContain(MARK);
    // 人が「通常の深さで」と上書きする（承認待ちでも変えられる）。次の実行（差し戻しの直し）から通常の観点
    const changed = service.changeSelfReviewDepth(id, { depth: "normal" });
    expect(changed.selfReviewDepthOverride?.depth).toBe("normal");
    expect(changed.selfReviewDepth?.judged).toBe("light");
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["足りない"] });
    await service.runNext(id);
    expect(executor.stdins[2]).toContain("--- 提出の前のセルフレビュー ---");
    expect(executor.stdins[2]).not.toContain("軽い依頼");
    // 同じ深さへの変更は、理由を示して断る
    expect(() => service.changeSelfReviewDepth(id, { depth: "normal" })).toThrow(
      InvalidOperationError,
    );
    // 判定に戻すと、次の実行からまた絞る
    const back = service.changeSelfReviewDepth(id, { depth: "light" });
    expect(back.selfReviewDepthOverride).toBeUndefined();
    service.requestChanges(id, { step: "requirements", submission: 2, comments: ["まだ足りない"] });
    await service.runNext(id);
    expect(executor.stdins[3]).toContain(MARK);
    expect(() => service.changeSelfReviewDepth(id, { depth: "light" })).toThrow(
      InvalidOperationError,
    );
    // 台帳に、人が・何から何に変えたかを残す
    expect(depthEvents(service, id)).toEqual([
      { actor: "person", from: "light", to: "normal" },
      { actor: "person", from: "normal", to: "light" },
    ]);
    activity.close();
  });

  it("通常と判定されたタスク・判定の無いタスクは、今までどおりの観点で動き、人が軽くすることはできない", async () => {
    for (const extra of [
      { selfReviewDepth: "normal", selfReviewDepthReason: "振る舞いを変える" },
      {},
      // 理由の無い軽い判定は、使わない
      { selfReviewDepth: "light" },
    ]) {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [chosen(extra), out("# 要求要件")], {
        realPlanner: true,
        config,
      });
      const { id } = service.createTask({ projectId: "default", title: "機能を足す" });
      await service.runNext(id);
      const name = JSON.stringify(extra);
      expect(service.get(id)?.task.selfReviewDepth?.judged, name).toBe(
        extra.selfReviewDepthReason ? "normal" : undefined,
      );
      expect(executor.stdins[1], name).toContain("--- 提出の前のセルフレビュー ---");
      expect(executor.stdins[1], name).not.toContain("軽い依頼");
      for (const depth of ["light", "normal"] as const) {
        expect(() => service.changeSelfReviewDepth(id, { depth }), name).toThrow(
          /軽いと判定されていない/,
        );
      }
      expect(depthEvents(service, id), name).toEqual([]);
      activity.close();
    }
  });

  it("子タスクに分ける組み合わせを選んだタスクは、軽いと答えても通常として記録し、観点を絞らず、人が軽くすることもできない（PBI-387）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const split = chosen({
      plan: "split",
      reason: "大きいので分ける",
      selfReviewDepth: "light",
      selfReviewDepthReason: "文書の節を足すだけ",
    });
    const { service, executor } = makeService(activity, [split, out("# 要求要件")], {
      realPlanner: true,
      config,
    });
    const { id } = service.createTask({ projectId: "default", title: "機能を足す" });
    await service.runNext(id);
    const forced = {
      judged: "normal",
      reason: message("selfReview.depthForcedNormalSplit", { reason: "文書の節を足すだけ" }),
    };
    expect(service.get(id)?.task.stepsChoice?.plan).toBe("split");
    expect(service.get(id)?.task.selfReviewDepth).toEqual(forced);
    // 親の工程（要求要件）の指示は、観点を絞らない
    expect(executor.stdins[1]).toContain("--- 提出の前のセルフレビュー ---");
    expect(executor.stdins[1]).not.toContain("軽い依頼");
    // 通常として記録したので、人の上書き（軽いと判定されたタスクだけ）は断る
    for (const depth of ["light", "normal"] as const) {
      expect(() => service.changeSelfReviewDepth(id, { depth })).toThrow(/軽いと判定されていない/);
    }
    expect(depthEvents(service, id)).toEqual([]);
    activity.close();
  });

  it("API でも変えられる。決めた値でない深さ・無いタスクは断る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [chosen({ selfReviewDepth: "light", selfReviewDepthReason: "節を足すだけ" }), out("# 要求")],
      { realPlanner: true, config },
    );
    const app = createApp(service, "tok");
    const { id } = service.createTask({ projectId: "default", title: "README に節を足す" });
    await service.runNext(id);
    const post = (taskId: string, body: unknown) =>
      app.request(`/api/tasks/${taskId}/self-review-depth`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify(body),
      });
    const ok = await post(id, { depth: "normal" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { task: Task };
    expect(body.task.selfReviewDepthOverride?.depth).toBe("normal");
    expect((await post(id, { depth: "deep" })).status).toBe(400);
    expect((await post(id, {})).status).toBe(400);
    expect((await post("none", { depth: "normal" })).status).not.toBe(200);
    expect(depthEvents(service, id)).toHaveLength(1);
    activity.close();
  });
});
