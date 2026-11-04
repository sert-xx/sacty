import {
  displayTestNames,
  type FinalReview,
  type Task,
  withoutFormatPlaceholders,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildGatherPrompt,
  buildPrompt,
  buildPullRequestBody,
  buildPullRequestBodyParts,
  gatheredLines,
  provenanceGuideLines,
  provenanceIds,
  withoutWorkReport,
} from "./prompts.js";

/*
 * r5 の C 群（PBI-302）：成果物と PR の本文。
 * C1 成果物に混ざる作業の報告・削除した行、C2 PR の本文の重複・空の見出し、C3 観点 → テストの表の重複と書式の文字、
 * C4 対象のリポジトリの外の情報の書き方。
 */

describe("C1：要求要件・設計の本文の外にある作業の報告を取り除く", () => {
  const BODY = [
    "# 要求要件：会議室の空き時間を調べる",
    "",
    "API を足す。",
    "",
    "## 要求",
    "",
    "| R-1 | 返す |",
  ].join("\n");

  it("S14：最初の見出しの前にある報告の段落を取り除く。本文は一字も変えない", () => {
    const report =
      "要求要件を直しました。画面を外して API だけにしています。セルフレビューは 1 回目で must の指摘がなく、通りました。";
    expect(withoutWorkReport(`${report}\n\n${BODY}`)).toBe(BODY);
  });

  it("S16：指摘の ID を挙げた報告も取り除く（複数の段落でも、本文の段落は残す）", () => {
    const report =
      "指摘 requirements-2-1 に合わせて端数の確かめ方を足しました。\n\nセルフレビュー（D-4・X-1）では must の指摘はありませんでした。";
    expect(withoutWorkReport(`${report}\n\n${BODY}`)).toBe(BODY);
  });

  it("見出しの前の、報告ではない段落（本文の要約など）は残す", () => {
    const text = `会議室の空き時間を返す API を足す。\n\n要求要件を直しました。\n\n${BODY}`;
    expect(withoutWorkReport(text)).toBe(`会議室の空き時間を返す API を足す。\n\n${BODY}`);
  });

  it("見出しの前・区切り線の後ろの、背景を述べる「〜ました」は報告とみなさず残す", () => {
    const background =
      "旧 API は 2024 年に廃止されました。r5 で予約の重なりが起きました。この要求要件は、その代わりを定める。";
    expect(withoutWorkReport(`${background}\n\n${BODY}`)).toBe(`${background}\n\n${BODY}`);
    const note = `${BODY}\n\n---\n\n注：税率は 2019 年に改定されました。`;
    expect(withoutWorkReport(note)).toBe(note);
    // 同じ段落に作業の報告の語があれば取り除く（背景の文と混ざっていても）
    expect(withoutWorkReport(`障害が起きました。そこで本文を書き直しました。\n\n${BODY}`)).toBe(
      BODY,
    );
  });

  it("最後の区切り線の後ろが報告だけなら、区切り線ごと取り除く。区切り線の後ろに本文の節があれば残す", () => {
    expect(withoutWorkReport(`${BODY}\n\n---\n\nコミット・プッシュはしていません。`)).toBe(BODY);
    const kept = `${BODY}\n\n---\n\n## 付録\n\nセルフレビューという語を説明する節。`;
    expect(withoutWorkReport(kept)).toBe(kept);
    // 区切り線の後ろに報告ではない段落があれば、触らない
    const prose = `${BODY}\n\n---\n\n注：数値は例。`;
    expect(withoutWorkReport(prose)).toBe(prose);
  });

  it("本文の中の文・コードブロックの中・見出しの下線は読まない。見出しが無い出力は変えない", () => {
    const inBody = `${BODY}\n\nレビューを直しました、と利用者に表示する。`;
    expect(withoutWorkReport(inBody)).toBe(inBody);
    const fenced = `\`\`\`\n# コマンド\n\`\`\`\n\n直しました。\n\n${BODY}`;
    // コードブロックの中の「# コマンド」は見出しではない。最初の見出しは本文の「# 要求要件」
    expect(withoutWorkReport(fenced)).toBe(`\`\`\`\n# コマンド\n\`\`\`\n\n${BODY}`);
    const noHeading = "直しました。\n\n本文だけ";
    expect(withoutWorkReport(noHeading)).toBe(noHeading);
    // 文の直後の `---` は見出しの下線で、区切り線ではない
    const setext = `${BODY}\n\n付録のタイトル\n---\n直しました。`;
    expect(withoutWorkReport(setext)).toBe(setext);
  });

  it("報告が無い出力は、そのまま返す。空の出力も", () => {
    expect(withoutWorkReport(BODY)).toBe(BODY);
    expect(withoutWorkReport("")).toBe("");
  });

  it("要求要件・設計の指示に、最初の見出しの前に報告を置かないことと、sacty が取り除くことを書く", () => {
    const t = { id: "t", title: "A", body: "b", steps: [], remarks: [], approved: {}, outputs: {} };
    for (const [step, name] of [
      ["requirements", "要求要件"],
      ["design", "設計"],
    ] as const) {
      const prompt = buildPrompt(t as unknown as Task, step);
      expect(prompt, step).toContain(
        `出力の最初は、${name}の最初の見出しにする。見出しの前に、前置きや作業の報告を置かない`,
      );
    }
  });
});

describe("C1：削除した行（R-n（削除：…））は確かめる項目に数えない", () => {
  const output = [
    "# 要求要件",
    "",
    "| R-1（削除：区間のまとめ方は R-2 で決める） | | |",
    "| R-2 | 返す |",
    "| R-3（削除：画面は作らない） | | | |",
    "| R-4 | 400 を返す |",
  ].join("\n");

  it("削除の行の ID は項目から除く。残る ID は出てくる順", () => {
    expect(provenanceIds("requirements", output, [])).toEqual(["R-2", "R-4"]);
    // 半角の括弧・空白でも
    expect(provenanceIds("requirements", "| R-1 (削除：x) |\n| R-2 | y |", [])).toEqual(["R-2"]);
  });

  it("削除の行が無い成果物・削除の語を含むだけの行は、今までどおり", () => {
    expect(provenanceIds("requirements", "| R-1 | 項目を削除する |\n| R-2 | b |", [])).toEqual([
      "R-1",
      "R-2",
    ]);
    expect(provenanceIds("requirements", "", [])).toEqual([]);
  });

  it("確かめる所の案内に、削除の行を並べない", () => {
    const ids = provenanceIds("requirements", output, []);
    const guide = provenanceGuideLines({
      sequential: false,
      items: [{ id: "R-2", kind: "inference", refs: [], excerpt: "" }],
      unclassified: ids.filter((id) => id !== "R-2"),
    }).join("\n");
    expect(guide).toContain("R-2：推論");
    expect(guide).toContain("R-4：分類なし");
    expect(guide).not.toContain("R-1");
    expect(guide).not.toContain("R-3");
  });
});

const review = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: true,
  viewpoints: [{ viewpointId: "REQ", verified: true, reason: "REQ の所見。" }],
  remarks: [],
  summary: "合格。変更は最小限。",
  tests: { command: "npm test", exitCode: 0, output: "" },
  agentId: "claude",
  runId: "r1",
  costUsd: 0,
  estimated: false,
  at: "2026-11-04T10:00:00.000Z",
  ...extra,
});

const taskOf = (extra: Record<string, unknown> = {}) =>
  ({
    id: "t-1",
    title: "出版社を持たせる",
    body: "出版社を持たせる",
    steps: [{ key: "implement", state: "active" }],
    remarks: [],
    outputs: { implement: "出版社を足しました。" },
    approved: { requirements: { output: "# 要求要件\n\n出版社を持たせる。", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["src/a.test.ts › 出版社"] }],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    lastReview: review(),
    repository: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "abcdef1" },
    ...extra,
  }) as unknown as Task;

const count = (text: string, part: string) => text.split(part).length - 1;

describe("C2：PR の本文で、同じ文を複数の節に繰り返さない・空の見出しを出さない", () => {
  const SUMMARY = Array.from(
    { length: 40 },
    (_, i) => `${i + 1}件目の受け入れ条件を、テストで確かめている。`,
  ).join("");

  it("S2・S18：最終レビューの総評は、結論に頭、折りたたみに続きだけを出す。再発の確認があっても重ならない", () => {
    const remarks = [{ remarkId: "implement-1-1", notRecurred: true, reason: "直した" }];
    const body = buildPullRequestBody(
      taskOf({ lastReview: review({ summary: SUMMARY, remarks }) }),
    );
    // どの文も1回しか出ない
    for (let i = 1; i <= 40; i++) {
      expect(
        body.match(new RegExp(`(?<!\\d)${i}件目の受け入れ条件を`, "g")),
        String(i),
      ).toHaveLength(1);
    }
    expect(body).toContain(
      "<summary>ゴールガーディアンの最終レビュー（続きと再発の確認）</summary>",
    );
    expect(body).toContain("- implement-1-1：再発なし（直した）");
  });

  it("テンプレートに沿わせる本文の「sacty の記録」も、続きだけを出す", () => {
    const parts = buildPullRequestBodyParts(taskOf({ lastReview: review({ summary: SUMMARY }) }));
    const summary = parts.summary ?? "";
    const record = parts.record ?? "";
    expect(record).toContain("**ゴールガーディアンの最終レビュー（続き）**");
    const lead = /最終レビュー：合格。(.*)/.exec(summary)?.[1] ?? "";
    expect(lead.length).toBeGreaterThan(0);
    expect(record).not.toContain(lead);
    expect(`${lead}${record.split("\n\n").at(-1)}`).toBe(SUMMARY);
  });

  it("観点ごとの所見は、総評にある文を繰り返さない。全部が総評の文なら、総評と同じと書く", () => {
    const summary =
      "受け入れ条件はすべて、コードとテストで満たしていることを確かめた。範囲外の変更や、既存の振る舞いの変化は無い。";
    const own = "R-1 は src/a.ts の create で確かめた。";
    const mixed = buildPullRequestBody(
      taskOf({
        lastReview: review({
          summary,
          viewpoints: [{ viewpointId: "REQ", verified: true, reason: `${summary}${own}` }],
        }),
      }),
    );
    expect(count(mixed, "受け入れ条件はすべて、コードとテストで満たしていることを確かめた。")).toBe(
      1,
    );
    expect(mixed).toContain(`最終レビューの所見：${own}`);
    const same = buildPullRequestBody(
      taskOf({
        lastReview: review({
          summary,
          viewpoints: [{ viewpointId: "REQ", verified: true, reason: summary }],
        }),
      }),
    );
    expect(count(same, "受け入れ条件はすべて、コードとテストで満たしていることを確かめた。")).toBe(
      1,
    );
    expect(same).toContain("最終レビューの所見：総評と同じです");
  });

  it("短い所見（偶然の一致がありうる短い文）は除かない", () => {
    const body = buildPullRequestBody(
      taskOf({
        lastReview: review({
          summary: "問題なし。",
          viewpoints: [{ viewpointId: "REQ", verified: true, reason: "問題なし。" }],
        }),
      }),
    );
    expect(body).toContain("最終レビューの所見：問題なし。");
  });

  it("S14：最後の直しが結論に収まるときは、「最後の直し」の節を出さない。収まらないときは、結論以外の残りだけを節に出す", () => {
    const fix =
      "implement-1-1 を受け、fake API の追加を削除しました。\napps/ui の差分をなくしました。";
    const whole = "予約の空きを返す API を足しました。";
    const t = (f: string) =>
      taskOf({
        outputs: { implement: `${whole}\n\n## 最後の直し\n\n${f}` },
        implementHistory: [whole, `${whole}\n\n## 最後の直し\n\n${f}`],
      });
    const short = buildPullRequestBody(t(fix));
    expect(count(short, "fake API の追加を削除しました")).toBe(1);
    expect(short).toContain("- 最後の直し：implement-1-1 を受け");
    expect(short).not.toContain("## 最後の直し");
    const longFix = `${fix}\n\n詳しい経緯：テストの名前を直し、観点との対応を取り直した。`;
    const long = buildPullRequestBody(t(longFix));
    expect(count(long, "fake API の追加を削除しました")).toBe(1);
    expect(long).toContain(
      "## 最後の直し\n\n詳しい経緯：テストの名前を直し、観点との対応を取り直した。",
    );
  });

  it("S2：説明が自分の見出しから始まるときは、中身の無い「## 変更」を重ねない。見出しより前に文があれば「## 変更」を出す", () => {
    const own = "## 変更内容\n\n- 概要を書いた\n- 例を書いた";
    const withOwn = buildPullRequestBody(
      taskOf({ outputs: { implement: `要約の段落。\n\n${own}` } }),
    );
    expect(withOwn).not.toContain("## 変更\n");
    expect(withOwn).toContain("## 変更内容\n\n- 概要を書いた");
    // 見出しの前に結論に載せなかった文が残るときは、その文のための「## 変更」を出す
    const lead = "要約の段落。".repeat(60);
    const second = buildPullRequestBody(taskOf({ outputs: { implement: `${lead}\n\n${own}` } }));
    expect(second).toContain("## 変更\n\n");
    // 3階層以下の見出しから始まるなら、「## 変更」の下の小見出しなので出す
    const small = buildPullRequestBody(
      taskOf({ outputs: { implement: "要約。\n\n### 詳細\n\n中身。" } }),
    );
    expect(small).toContain("## 変更\n\n### 詳細\n\n中身。");
  });
});

describe("C3：観点 → テストの表で、同じテストを1回だけ出し、書式の文字をそのまま見せない", () => {
  const S18 = [
    "src/app.test.ts › books API › returns publisher %j in creation, list and detail",
    "src/app.test.ts › books API › rejects invalid publisher %j without registering a book",
    "src/client.test.ts › library client › registers a book and reads it back",
    "src/app.test.ts › returns publisher %j in creation, list and detail",
    "src/app.test.ts › rejects invalid publisher %j without registering a book",
    "src/client.test.ts › registers a book and reads it back",
  ];

  it("S18：describe の接頭辞あり・なしの同じテストは、あるほう（長い名前）に1回だけ。順序は最初の位置", () => {
    expect(displayTestNames(S18)).toEqual([
      "src/app.test.ts › books API › returns publisher ‹…› in creation, list and detail",
      "src/app.test.ts › books API › rejects invalid publisher ‹…› without registering a book",
      "src/client.test.ts › library client › registers a book and reads it back",
    ]);
    // 接頭辞のない名前が先に出ても、長い名前が残る
    expect(displayTestNames([S18[3] ?? "", S18[0] ?? ""])).toEqual([
      "src/app.test.ts › books API › returns publisher ‹…› in creation, list and detail",
    ]);
  });

  it("境界：空・1件・同じ名前の重複・describe が違う同名のテスト・ファイルが違う同名のテストは別のまま", () => {
    expect(displayTestNames([])).toEqual([]);
    expect(displayTestNames(["a.test.ts › x"])).toEqual(["a.test.ts › x"]);
    expect(displayTestNames(["a.test.ts › x", "a.test.ts › x"])).toEqual(["a.test.ts › x"]);
    expect(displayTestNames(["a.test.ts › A › works", "a.test.ts › B › works"])).toEqual([
      "a.test.ts › A › works",
      "a.test.ts › B › works",
    ]);
    expect(displayTestNames(["a.test.ts › works", "b.test.ts › works"])).toEqual([
      "a.test.ts › works",
      "b.test.ts › works",
    ]);
    // 入れ子の describe の一部を省いた名前も、末尾が合えば同じテスト
    expect(displayTestNames(["f.ts › A › B › t", "f.ts › B › t", "f.ts › t"])).toEqual([
      "f.ts › A › B › t",
    ]);
    // 空白だけ違う名前
    expect(displayTestNames(["f.ts › t", "f.ts  ›  t"])).toEqual(["f.ts › t"]);
    // vitest の区切り（ > ）でも
    expect(displayTestNames(["f.ts > A > t", "f.ts > t"])).toEqual(["f.ts > A > t"]);
  });

  it("書式の文字（%s %d %i %f %j %o %O %p %# %$）を値の印にする。%% は % にし、数字の直後の % は触らない", () => {
    expect(withoutFormatPlaceholders("rejects %j and %s, %d %i %f %o %O %p %# %$")).toBe(
      "rejects ‹…› and ‹…›, ‹…› ‹…› ‹…› ‹…› ‹…› ‹…› ‹…› ‹…›",
    );
    expect(withoutFormatPlaceholders("100%% done")).toBe("100% done");
    expect(withoutFormatPlaceholders("rate 5%d")).toBe("rate 5%d");
    expect(withoutFormatPlaceholders("plain name")).toBe("plain name");
  });

  it("PR の本文の表・折りたたみに、重複と書式の文字が出ない（10 件のうち 5 件が重複していた S18）", () => {
    const body = buildPullRequestBody(
      taskOf({
        testMap: [
          {
            viewpointId: "REQ",
            tests: [
              ...S18,
              "src/client.test.ts › library client › registers and filters publishers",
              "src/client.test.ts › registers and filters publishers",
            ],
          },
        ],
      }),
    );
    expect(body).not.toContain("%j");
    // 表のセル：4 件の別のテストの、1件目と残りの件数
    expect(body).toMatch(
      /\| REQ [^|]*\| src\/app\.test\.ts › books API › returns publisher ‹…› in creation[^|]* ほか 3 件 \|/,
    );
    // 折りたたみには、同じテストが2回出ない
    const folded = body.slice(body.indexOf("<details>"));
    expect(count(folded, "returns publisher ‹…› in creation")).toBe(1);
    expect(count(folded, "registers and filters publishers")).toBe(1);
    expect(count(folded, "registers a book and reads it back")).toBe(1);
  });
});

describe("C4：対象のリポジトリの外から集めた情報の書き方", () => {
  const task = {
    id: "t-1",
    title: "アーキテクチャの概要を書く",
    body: "概要を書く",
    steps: [],
    remarks: [],
    approved: {},
    outputs: {},
    repository: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "abcdef1" },
  } as unknown as Task;

  it("情報収集の指示に、出どころの明記・対象のリポジトリの文書ではないこと・文書の無さを外で補わないことを書く", () => {
    const prompt = buildGatherPrompt(task);
    expect(prompt).toContain("対象のリポジトリの外から集めた情報");
    expect(prompt).toContain(
      "出どころ（リポジトリ名か URL）を添え、「対象のリポジトリの外」と明記して",
    );
    expect(prompt).toContain("対象のリポジトリの文書・コードとは別の項目に書く");
    expect(prompt).toContain(
      "sources の title にも「（対象のリポジトリの外：<リポジトリ名か URL>）」を添える",
    );
    expect(prompt).toContain(
      "対象のリポジトリに文書が無い・少ないことは、外の文書で補ったように書かず",
    );
  });

  it("特定のリポジトリ・言語・ツールの名前に寄せない", () => {
    const line = buildGatherPrompt(task)
      .split("\n")
      .find((l) => l.includes("対象のリポジトリの外から集めた情報"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/gogs|upstream|Go\b|npm|GitHub Actions/i);
  });

  it("集めた情報を読む工程・ゴールガーディアンの指示にも、外の情報を対象のリポジトリの規約・決定にしないことを添える", () => {
    const gathered = {
      ...task,
      gathered: { brief: "（対象のリポジトリの外：example/lib）API の説明", sources: [] },
    } as unknown as Task;
    for (const reader of ["agent", "guardian", "orchestrator"] as const) {
      expect(gatheredLines(gathered, reader).join("\n"), reader).toContain(
        "対象のリポジトリの規約や決定として扱わないでください",
      );
    }
    expect(gatheredLines(task)).toEqual([]);
  });
});
