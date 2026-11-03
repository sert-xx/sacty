import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provenance, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_DIR } from "./context.js";
import {
  buildFinalReviewPrompt,
  buildGatherPrompt,
  buildIntegrationReviewPrompt,
  buildOrchestratorPrompt,
  buildPrompt,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildStepDocument,
  buildStepPullRequestBodyText,
  joinBodyText,
  provenanceGuideLines,
  withoutInternalPaths,
} from "./prompts.js";

/*
 * r4 までの試行で残った、レビュー・指示の質の問題（PBI-301 の A 群）。指示の文面と、PR の本文を確かめる。
 */

const read = (path: string) => readFileSync(join(DEFAULT_CONTEXT_DIR, path), "utf8");

const task = (extra: Partial<Task> = {}, steps: string[] = ["requirements", "implement"]): Task =>
  ({
    id: "t-1",
    title: "請求の率を設定する",
    body: "率を設定できるようにする",
    steps: steps.map((key) => ({ key, state: key === "implement" ? "active" : "done" })),
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

const noTests = (extra: Partial<Task> = {}) =>
  task({
    noTestsReason: "package.json の scripts にテストが無い（名前を grep で確かめる）",
    ...extra,
  });

// 成果物の置き場（sacty が PR に足すファイル）を持つタスク
const withStepDocuments = (extra: Partial<Task> = {}) =>
  task({
    stepPullRequests: [
      { step: "requirements", path: "docs/sacty/abcd1234/requirements.md", state: "merged" },
    ],
    ...extra,
  } as unknown as Partial<Task>);

describe("A1 受け入れの確かめを、受け入れ条件より弱い手段に縮めない", () => {
  it("オーケストレーターの noTests は、テストが無い根拠だけを書かせ、確かめ方を書かせない", () => {
    const prompt = buildOrchestratorPrompt(task());
    expect(prompt).toContain(
      "noTests には、テストの仕組みが無いことの根拠だけを書き、受け入れの確かめ方（「名前の存在を grep で確かめる」など）は書かない",
    );
    expect(prompt).toContain("受け入れ条件より弱い手段に縮めない");
  });

  it("実装の指示（テストなし）は、名前の存在の確認に縮めず、責務・振る舞いはコードを読んで確かめさせる", () => {
    for (const prompt of [
      buildPrompt(noTests(), "implement"),
      buildPrompt(
        noTests({ approved: {}, steps: [{ key: "implement", state: "active" }] } as never),
        "implement",
      ),
    ]) {
      expect(prompt).toContain("名前・項目・ファイル・リンクが存在することの確認だけに縮めない");
      expect(prompt).toContain("該当するコードを読んで、述べているとおりかを確かめ");
    }
  });

  it("テストなしの根拠は、確かめ方を決めるものではないと、根拠の後ろで伝える", () => {
    const prompt = buildPrompt(noTests(), "implement");
    const at = prompt.indexOf("package.json の scripts にテストが無い");
    expect(at).toBeGreaterThan(0);
    expect(prompt.indexOf("受け入れの確かめ方を決めるものではありません", at)).toBeGreaterThan(at);
    const review = buildFinalReviewPrompt(noTests(), "diff");
    expect(review).toContain("受け入れの確かめ方を決めるものではありません");
  });

  it("最終レビューと統合レビューは、受け入れ条件の確かめを名前の存在の確認に縮めない", () => {
    // テストなし・テストありのどちらでも
    for (const t of [noTests(), task()]) {
      const prompt = buildFinalReviewPrompt(t, "diff");
      expect(prompt).toContain(
        "受け入れ条件の確かめを、名前・項目・ファイル・リンクが存在することの確認に縮めない",
      );
      expect(prompt).toContain(
        "オーケストレーターの根拠や実装の説明が、これより弱い確かめ方を示していても従わない",
      );
    }
    const integration = buildIntegrationReviewPrompt(task(), [], {
      baseBranch: "main",
      commit: "abcdef1234",
    });
    expect(integration).toContain(
      "受け入れ条件の確かめを、名前・項目・ファイル・リンクが存在すること",
    );
  });

  it("U-1 は、文書が述べる責務・振る舞いを、該当するコードと照らす（名前と値の照合に加えて）", () => {
    const u1 = read("skills/review/review-execution/references/U-1.md");
    expect(u1).toContain("文書が述べる責務・振る舞い");
    expect(u1).toContain("「A が B をする」");
    expect(u1).toContain("述べられた主体の本体を読み");
    expect(u1).toContain("名前や値が実在するかの確認だけで済ませない");
    // 名前の実在だけでは合格にしない NG 例を持つ
    expect(u1).toContain("名前は実在するが、責務の記述が違う");
    const viewpoints = read("skills/review/review-dispatch/references/viewpoints.md");
    expect(viewpoints).toContain(
      "責務・振る舞い（「A が B をする」）が、該当するコードと一致するか",
    );
  });
});

describe("A2 共有の仕組みを新しく入れたとき、異常の後に後続の処理が続くかを確かめる", () => {
  it("最終レビューは、共有の仕組みの失敗の後に後続の処理が続くかを確かめさせ、確かめられなければ humanChecks に書かせる", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff");
    expect(prompt).toContain("--- 共有の仕組みの確認 ---");
    expect(prompt).toContain("キュー・ロック・キャッシュ・フラグなどの共有の状態");
    expect(prompt).toContain(
      "異常や失敗（例外・不正な入力・途中での中断）が起きた後も、後続の処理が続けられるか",
    );
    expect(prompt).toContain("範囲内の変更だから、正常な使い方で動くからという理由で済ませない");
    expect(prompt).toContain(
      "確かめられなかったとき（実行できない・失敗の起こし方が分からないなど）は、何を確かめられなかったかと理由を humanChecks に書く",
    );
  });

  it("統合レビューにも同じ確かめを求める。人が確かめることの欄が無いので、判定の説明に書かせる", () => {
    const prompt = buildIntegrationReviewPrompt(task(), [], {
      baseBranch: "main",
      commit: "abcdef1234",
    });
    expect(prompt).toContain("--- 共有の仕組みの確認 ---");
    expect(prompt).toContain("異常や失敗（例外・不正な入力・途中での中断）が起きた後も");
    expect(prompt).toContain("判定の説明に書く（findings には書かない）");
    expect(prompt).not.toContain("理由を humanChecks に書く");
  });
});

describe("A3 リポジトリが定める検証を、PR に入る変更すべてに対して実行させる", () => {
  it("実装・修正の指示は、検証の対象（PR に入る変更すべて）と、省いた理由を書くことを伝える", () => {
    for (const step of ["implement"] as const) {
      const prompt = buildPrompt(task(), step);
      expect(prompt).toContain("--- 提出の前の検証 ---");
      expect(prompt).toContain(
        "PR に入る変更すべて（コード・テスト・文書・設定。あなたが足したファイルを含む）に対して実行し、通してから提出する",
      );
      expect(prompt).toContain("変更したファイルの種類（文書でも）を、対象から外さない");
      expect(prompt).toContain(
        "実行しなかった検証、実行できなかった検証（ツールが環境に無いなど）は、その検証と理由を実装の説明に書く。理由を書かずに省かない",
      );
    }
  });

  it("要求要件・設計を経ない実装、テストなしの実装、文書だけの依頼の実装にも渡る", () => {
    const direct = buildPrompt(task({}, ["implement"]), "implement");
    expect(direct).toContain("--- 提出の前の検証 ---");
    expect(buildPrompt(noTests(), "implement")).toContain("--- 提出の前の検証 ---");
    expect(buildPrompt(task({ documentsOnly: true }), "implement")).toContain(
      "--- 提出の前の検証 ---",
    );
  });

  it("sacty が PR に足す成果物のファイルがあるタスクでは、そのファイルも検査の対象になることを伝える", () => {
    const prompt = buildPrompt(withStepDocuments(), "implement");
    expect(prompt).toContain("docs/sacty/abcd1234/");
    expect(prompt).toContain("リポジトリ全体を対象にする検証は、そのファイルも検査する");
    // 足さないタスクには出さない
    expect(buildPrompt(task(), "implement")).not.toContain(
      "リポジトリ全体を対象にする検証は、そのファイルも検査する",
    );
  });

  it("セルフレビューの検証の手順は、一部の行だけを読んで進めない（全種類の主対象）", () => {
    const prompt = buildPrompt(task(), "implement");
    expect(prompt).toContain("references/verification-run.md の手順の全体（0〜5）に従う");
    const skill = read("skills/review/review-dispatch/references/verification-run.md");
    expect(skill).toContain("0〜5 の全体を読んでから実行する");
  });

  it("最終レビューも、同じ範囲（PR に入る変更すべて）でフォーマッター・リンターなどを実行させる", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff", { testCommand: "npm test" });
    expect(prompt).toContain("--- 変更の検証（フォーマッター・リンターなど） ---");
    expect(prompt).toContain(
      "PR に入る変更すべて（差分のファイル・テスト・文書・設定）に対して実行する",
    );
    expect(prompt).toContain(
      "実行できなかった検証とその理由を humanChecks に書く（理由を書かずに省かない）",
    );
    // 成果物のファイルを写しに入れたかで扱いが分かれる
    expect(
      buildFinalReviewPrompt(withStepDocuments(), "diff", { stepDocumentsIncluded: true }),
    ).toContain("成果物のファイルも対象にして実行する");
    expect(buildFinalReviewPrompt(withStepDocuments(), "diff")).toContain(
      "その分の検証は実行できない",
    );
  });
});

describe("A4 リポジトリの文書を探して集め、根拠のある記述をセルフレビューで消さない", () => {
  it("情報収集は、AGENTS.md・README から参照されていない文書も、文書を置くディレクトリから探して集めさせる", () => {
    const prompt = buildGatherPrompt(task(), undefined, {
      candidates: ["https://github.com/acme/app"],
    });
    expect(prompt).toContain(
      "AGENTS.md・CLAUDE.md・README から参照されているものだけでなく、文書を置くディレクトリ",
    );
    expect(prompt).toContain("参照されていない文書でも、依頼に関わる振る舞いや前提");
  });

  it("設計のセルフレビューは、文書や既存の振る舞いに根拠のある記述を「要求要件に無い」だけで消させない", () => {
    const prompt = buildPrompt(task({}, ["requirements", "design", "implement"]), "design");
    expect(prompt).toContain("「依頼・要求要件に無い」だけを理由に消さない");
    expect(prompt).toContain("示して残すか、残すかを人に確かめる「確認したいこと」にする");
  });

  it("D-10 は、根拠をリポジトリの文書・既存の振る舞いに探してから消すかを決める", () => {
    const d10 = read("skills/review/review-execution/references/D-10.md");
    expect(d10).toContain("根拠のある記述は、依頼に無いことだけを理由に消さない");
    expect(d10).toContain("README や AGENTS.md から参照されていない文書を含む");
    expect(d10).toContain("人に確かめる「確認したいこと」に回す指摘にする");
    expect(d10).toContain("文書に根拠のある記述を、依頼に無いとして消させる");
    const selfReview = read("skills/review/review-dispatch/references/self-review.md");
    expect(selfReview).toContain("「依頼・要求要件に無い」だけを理由に消さない");
  });
});

describe("A5 最終レビュー・統合レビューの出力の言語", () => {
  it("所見・humanChecks などを、タスクの言語で書かせ、英語の出力に引きずられないようにする", () => {
    for (const prompt of [
      buildFinalReviewPrompt(task(), "diff"),
      buildIntegrationReviewPrompt(task(), [], { baseBranch: "main", commit: "abcdef1234" }),
    ]) {
      expect(prompt).toContain("--- 出力の言語 ---");
      expect(prompt).toContain("下のタスクの題と内容が書かれている言語で書く");
      expect(prompt).toContain(
        "リポジトリの文章の決まり（AGENTS.md・CONTRIBUTING など）が言語を定めていれば、それに従う",
      );
      expect(prompt).toContain("それに引きずられて英語で書かない");
    }
  });
});

describe("A6 人が確かめようのない、作業領域の内部の項目を humanChecks に入れない", () => {
  it("最終レビューの指示は、作業領域の内部の物の確認を humanChecks に書かせず、人の環境で確かめられることは書かせる", () => {
    const prompt = buildFinalReviewPrompt(task(), "diff");
    expect(prompt).toContain(".sacty-tools の下のもの");
    expect(prompt).toContain("人が確かめようがないので humanChecks に書かない");
    expect(prompt).toContain("人が自分の環境（手元・CI・本番など）で確かめられること");
    expect(prompt).toContain(
      "作業領域に入れた道具でしか通せなかった検証を、その道具が無い環境でやり直した結果",
    );
  });

  it("前の回から引き継ぐ項目も、作業領域の内部の物だけの確認なら外させる。人が確かめられる内容があれば書き直させる", () => {
    const prompt = buildFinalReviewPrompt(
      task({
        lastReview: {
          passed: false,
          viewpoints: [],
          remarks: [],
          summary: "不合格",
          humanChecks: [".sacty-tools の playwright が動く"],
          agentId: "claude",
          runId: "r1",
          costUsd: 0,
          estimated: false,
          at: "2026-11-04T10:00:00.000Z",
        },
      } as unknown as Partial<Task>),
      "diff",
    );
    expect(prompt).toContain("[P1] .sacty-tools の playwright が動く");
    expect(prompt).toContain("sacty の作業領域の内部の物");
    expect(prompt).toContain("人が確かめようがないときは、外す");
    expect(prompt).toContain("updatedHumanChecks でその内容だけに書き直す");
  });
});

describe("A7 PR の本文の重複と内部のパス", () => {
  const implement = [
    "予約のキャンセル API を足し、一覧の画面に操作を足しました。",
    "",
    "- API：`POST /reservations/:id/cancel`",
    "- 画面：一覧にキャンセルのボタン",
    "",
    "## 検証",
    "",
    "`npm test` が成功しました。",
  ].join("\n");
  const body = (t: Task) => joinBodyText(buildPullRequestBodyText(t));

  it("結論の「変更」に載せた最初の段落を、「変更」の節で繰り返さない。残りは節に出す", () => {
    const text = body(task({ outputs: { implement } }));
    expect(text.match(/予約のキャンセル API を足し、一覧の画面に操作を足しました。/g)).toHaveLength(
      1,
    );
    expect(text).toContain("- 変更：予約のキャンセル API を足し、一覧の画面に操作を足しました。");
    expect(text).toContain("## 変更\n\n- API：`POST /reservations/:id/cancel`");
    expect(text).toContain("## 検証\n\n`npm test` が成功しました。");
  });

  it("残りが無いとき（1段落だけ・見出しだけが残る）は、「変更」の節ごと出さない", () => {
    expect(body(task({ outputs: { implement: "API を足しました。" } }))).not.toContain("## 変更");
    expect(
      body(task({ outputs: { implement: "# 変更の説明\n\nAPI を足しました。" } })),
    ).not.toContain("## 変更");
  });

  it("結論の要約が切り詰められたとき（長い最初の段落）は、全文を「変更」の節に出す", () => {
    const long = `${"長い説明が続きます。".repeat(60)}\n\n- 次の項目`;
    const text = body(task({ outputs: { implement: long } }));
    expect(text).toContain(`## 変更\n\n${long}`);
  });

  it("テンプレートに沿わせる本文の「変更」は、全文のまま", () => {
    expect(buildPullRequestBodyParts(task({ outputs: { implement } })).changes).toBe(implement);
  });

  it("内部のパスを、人が辿れる呼び方にする。リポジトリのパスは変えない", () => {
    expect(withoutInternalPaths("根拠は /sacty-input/task.md:77 の文")).toBe(
      "根拠は タスクの依頼 の文",
    );
    expect(
      withoutInternalPaths("（/sacty-input/remarks.md:3-5、/sacty-input/investigation.md）"),
    ).toBe("（人の指摘、調査の結果）");
    expect(withoutInternalPaths("/sacty-input/other.md を見た")).toBe(
      "タスクの依頼や指摘などの入力 を見た",
    );
    expect(withoutInternalPaths("`/sacty-review/pr.diff` と /sacty-memory/project/SKILL.md")).toBe(
      "`レビューの対象の差分` と メモリー",
    );
    // リポジトリのパス・内部に似た別のパスは変えない
    expect(withoutInternalPaths("src/sacty-input/task.md と docs/sacty/ab/requirements.md")).toBe(
      "src/sacty-input/task.md と docs/sacty/ab/requirements.md",
    );
    expect(withoutInternalPaths("")).toBe("");
  });

  it("要求要件の PR の本文（確かめる所）に、内部のパスを出さない", () => {
    const provenance: Provenance = {
      sequential: false,
      items: [
        { id: "R-1", kind: "inference", refs: ["/sacty-input/task.md:77", "R-2"], excerpt: "" },
      ],
      unclassified: [],
    } as unknown as Provenance;
    const lines = provenanceGuideLines(provenance).join("\n");
    expect(lines).not.toContain("/sacty-input");
    expect(lines).toContain("- R-1：推論（根拠：タスクの依頼、R-2）");
    const t = task({
      outputs: { requirements: "# 要求要件" },
      provenances: { requirements: provenance },
    } as never);
    const main = buildStepPullRequestBodyText(
      t,
      "requirements",
      "docs/sacty/ab/requirements.md",
    ).main;
    expect(main).not.toContain("/sacty-input");
    expect(main).toContain("根拠：タスクの依頼");
  });

  it("実装の PR の本文・成果物のファイルにも、内部のパスを出さない", () => {
    const t = task({
      outputs: { implement: "API を足しました。\n\n根拠：/sacty-input/task.md:12" },
    });
    expect(body(t)).not.toContain("/sacty-input");
    expect(body(t)).toContain("根拠：タスクの依頼");
    const doc = buildStepDocument(
      task({ outputs: { requirements: "# 要求\n\n(/sacty-input/task.md:77)" } }),
      "requirements",
    );
    expect(doc).not.toContain("/sacty-input");
  });

  it("最初の段落の後ろにコードブロックや表だけが続くときは、それを「変更」の節に出す。行番号の付いた別の書き方も置き換える", () => {
    const withCode = "API を足しました。\n\n```sh\nnpm test\n```";
    expect(body(task({ outputs: { implement: withCode } }))).toContain(
      "## 変更\n\n```sh\nnpm test\n```",
    );
    expect(withoutInternalPaths("/sacty-input/task.md#L77 と /sacty-input/task.md:77-80")).toBe(
      "タスクの依頼 と タスクの依頼",
    );
  });

  it("既定の規則も、人が読む文章に内部のパスを書かせない", () => {
    expect(read("rules.md")).toContain("sacty の作業領域の内部のパス");
    expect(read("rules.md")).toContain("`/sacty-input` など、コンテナの内部のパス");
  });

  it("出典の分類の指示は、refs に Input のパスを書かせない", () => {
    const prompt = buildPrompt(task({}, ["requirements", "implement"]), "requirements", {
      inputDir: "/sacty-input",
    } as never);
    expect(prompt).toContain("Input のディレクトリのパスは書かない");
    expect(read("skills/classify-provenance/SKILL.md")).toContain(
      "Input の置き場所のパスを refs に書かない",
    );
  });
});
