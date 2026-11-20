import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildTriagePrompt, type ReviewDeferrals, rereviewLines } from "./prompts.js";
import {
  countSuggestionRounds,
  droppedRemarks,
  extractTriage,
  settleTriage,
  splitSuggestions,
  suggestionUnitsOf,
} from "./suggestion-triage.js";

const MARKER = "<!-- sacty-review:abc -->";
const finding = (tag: string, title: string) =>
  `**[${tag}] ${title}**（src/pay.ts）\n${title}の説明。`;

/** 既定のスキルが決める書式の、レビューの本文（総評・指摘の節・前回の指摘の節）。 */
const REVIEW_BODY = [
  MARKER,
  "## sacty のレビュー",
  "",
  "判定：修正が必要",
  "",
  "# 評価",
  "",
  "### 総評",
  "- [提案] が 3 件、[要修正] が 1 件あります。",
  "[提案] の件数は少なめです。",
  "",
  "### 前回の指摘",
  "- [提案] 前回の提案：対応を確認した",
  "",
  "### 指摘",
  "",
  finding("要修正", "必須の題"),
  "",
  finding("提案", "提案1"),
  "",
  finding("提案", "提案2"),
  "",
  finding("提案", "提案3"),
  "",
  "---",
  "sacty のタスク x で、AI がレビューしました。",
].join("\n");
const INLINE_SUGGESTION = `src/a.ts:12：${MARKER}\n[提案] 変数名を直す\n\`\`\`\nconst a = 1;\n\`\`\``;
const INLINE_PLAIN = `src/b.ts:3：${MARKER}\n頭の無いコメント`;

describe("AI のレビューの提案の単位の分け方（PBI-436）", () => {
  it("本文の [提案] 3 件と、[提案] の行へのコメント 1 件だけが選り分けの対象。[要修正]・頭の無いコメント・総評と前回の指摘の節の文中の [提案] は対象にならない", () => {
    const units = splitSuggestions(
      [REVIEW_BODY, INLINE_SUGGESTION, INLINE_PLAIN, "人のコメント [提案]"],
      [0, 1, 2],
    );
    expect(units.map((u) => [u.id, u.remark, u.kind])).toEqual([
      ["S1", 0, "must"],
      ["S2", 0, "suggestion"],
      ["S3", 0, "suggestion"],
      ["S4", 0, "suggestion"],
      ["S5", 1, "suggestion"],
    ]);
    const suggestions = units.filter((u) => u.kind === "suggestion");
    expect(suggestions).toHaveLength(4);
    expect(suggestions[0]?.text).toBe("**[提案] 提案1**（src/pay.ts）\n提案1の説明。");
    // 区切りの線の後（署名）は、提案の文に入らない
    expect(suggestions[2]?.text).not.toContain("AI がレビューしました");
    // 行へのコメントは、指摘の全体が 1 件（目印は除く）
    expect(suggestions[3]?.text).toContain("[提案] 変数名を直す");
    expect(suggestions[3]?.text).toContain("const a = 1;");
    expect(suggestions[3]?.text).not.toContain("sacty-review");
    // 頭の無いコメントと、人の指摘（aiReview に無い位置）は、単位にならない
    expect(units.some((u) => u.remark === 2 || u.remark === 3)).toBe(false);
  });

  it("行頭の素の [提案] も、箇条書き・見出しの形の頭も、1 件として数える", () => {
    expect(
      suggestionUnitsOf(
        "## 指摘\n[提案] 素の頭\n説明\n\n- [提案] 箇条書き\n\n### [提案] 見出し\n詳細",
      ).map((u) => u.kind),
    ).toEqual(["suggestion", "suggestion", "suggestion"]);
  });
});

describe("提案の単位の読み取りは「指摘」の節だけ（PBI-436）", () => {
  it("別の名前の節（前回までの指摘・太字の札・表）の頭は、新しい提案として数えない", () => {
    const body = [
      MARKER,
      "### 前回までの指摘",
      "- [提案] 前回の提案：対応を確認した",
      "**総評**",
      "[提案] 太字の札の下の文",
      "| 重さ | 内容 |",
      "| [提案] | 表の中 |",
      "### 指摘",
      finding("提案", "本物"),
    ].join("\n");
    expect(suggestionUnitsOf(body).map((u) => u.text)).toEqual([
      "**[提案] 本物**（src/pay.ts）\n本物の説明。",
    ]);
  });
  it("「指摘」の節が無い本文は、単位なし（選り分けない。今までどおり直す）", () => {
    expect(suggestionUnitsOf("[提案] 節の無い頭")).toEqual([]);
  });
});

describe("提案のすべてを対応しない指摘の位置（PBI-436）", () => {
  const sug = (remark: number, id: string) => ({
    id,
    remark,
    text: `[提案] ${id}`,
    kind: "suggestion" as const,
  });
  const verdictOf = () => "suggestions" as const;
  it("提案ありの回の、総評だけの本文（単位 0 件）は、行へのコメントの提案がすべて対応しないなら外す", () => {
    const remarks = ["## 総評\nだけ", "a.ts:1：\n[提案] x"];
    const units = [sug(1, "S1")];
    const aiReviewFrom = { "0": "k:1", "1": "k:1" };
    expect(
      droppedRemarks({
        remarks,
        units,
        items: [{ remark: 1, decision: "decline" }],
        aiReviewFrom,
        verdictOf,
      }),
    ).toEqual([0, 1]);
    expect(
      droppedRemarks({
        remarks,
        units,
        items: [{ remark: 1, decision: "address" }],
        aiReviewFrom,
        verdictOf,
      }),
    ).toEqual([]);
  });
  it("要修正の回の、単位 0 件の本文は外さない", () => {
    expect(
      droppedRemarks({
        remarks: ["本文", "a.ts:1：\n[提案] x"],
        units: [sug(1, "S1")],
        items: [{ remark: 1, decision: "decline" }],
        aiReviewFrom: { "0": "k:1", "1": "k:1" },
        verdictOf: () => "changes_required",
      }),
    ).toEqual([]);
  });
  it("提案だけの回の続いた数を、今回から数える", () => {
    const v = { 1: "changes_required", 2: "suggestions", 3: "suggestions" } as const;
    expect(countSuggestionRounds(3, (r) => v[r as 1 | 2 | 3])).toBe(2);
  });
});

describe("選り分けの答えの読み方（PBI-436）", () => {
  const units = [{ id: "S1" }, { id: "S2" }, { id: "S3" }];
  const answer = (items: unknown[]) =>
    `説明\n\`\`\`json\n${JSON.stringify({ "sacty-triage": { items } })}\n\`\`\``;

  it("答えを読み、知らない ID・重複・判断が address でも decline でもないものは読み捨てる", () => {
    expect(
      extractTriage(
        answer([
          { id: "S1", decision: "decline", reason: "範囲の外" },
          { id: "S1", decision: "address", reason: "重複" },
          { id: "S9", decision: "decline", reason: "知らない" },
          { id: "S2", decision: "maybe", reason: "読めない" },
          { id: "S3", decision: "address", reason: "直す" },
        ]),
        units,
      ),
    ).toEqual([
      { id: "S1", decision: "decline", reason: "範囲の外" },
      { id: "S3", decision: "address", reason: "直す" },
    ]);
  });

  it("読めない答えは undefined。判断の無い提案・理由の無い decline は、対応する側（defaulted）にする", () => {
    expect(extractTriage("読めない", units)).toBeUndefined();
    const suggestions = units.map((u, i) => ({ ...u, remark: i, text: `提案${u.id}` }));
    const items = settleTriage(
      suggestions,
      [
        { id: "S1", decision: "decline", reason: "範囲の外" },
        { id: "S2", decision: "decline", reason: "" },
      ],
      "判断が無い",
    );
    expect(items.map((i) => [i.id, i.decision, i.defaulted === true])).toEqual([
      ["S1", "decline", false],
      ["S2", "address", true],
      ["S3", "address", true],
    ]);
    expect(settleTriage(suggestions, undefined, "読めない").every((i) => i.defaulted)).toBe(true);
  });

  it("同じ指摘（sameAs）の判断が食い違ったら、対応する側にそろえる", () => {
    const suggestions = units.map((u, i) => ({ ...u, remark: i, text: `提案${u.id}` }));
    const items = settleTriage(
      suggestions,
      [
        { id: "S1", decision: "address", reason: "直す" },
        { id: "S2", decision: "decline", reason: "好み", sameAs: "S1" },
        { id: "S3", decision: "decline", reason: "好み" },
      ],
      "食い違い",
    );
    expect(items.map((i) => i.decision)).toEqual(["address", "address", "decline"]);
    expect(items[1]?.defaulted).toBe(true);
  });
});

/** 選り分けの指示・再レビューの指示を組み立てる最小のタスク。 */
const baseTask = (patch: Record<string, unknown> = {}): Task =>
  ({
    title: "決済 API の再送",
    body: "同じキーの再送で二重に決済しない。受け入れ条件：決済は 1 回",
    approved: {
      requirements: { output: "# 承認済みの要求要件 v1" },
      design: { output: "# 承認済みの設計 v1" },
    },
    remarks: [],
    ...patch,
  }) as unknown as Task;

describe("選り分けの指示（PBI-436）", () => {
  const suggestions = [
    { id: "S1", remark: 0, text: "**[提案] 提案1**（src/pay.ts）", kind: "suggestion" as const },
    { id: "S2", remark: 0, text: "**[提案] 提案2**（src/pay.ts）", kind: "suggestion" as const },
  ];
  const musts = [{ id: "S3", remark: 0, text: "**[要修正] 必須**", kind: "must" as const }];
  const task = baseTask({
    remarks: [
      {
        id: "implement-1-1",
        step: "implement",
        round: 1,
        text: "前の回の指摘 N",
        source: "sacty_review",
        status: "declined",
        response: "この環境では撮れない",
        voided: false,
      },
    ],
    declinedSuggestions: [{ text: "対応しないとした提案 D", reason: "好み", round: 1 }],
  });

  it("判断の材料（依頼・要求要件・設計・PR の説明・前の回の指摘と対応・対応しないとした提案・今回の提案・回数）と、基準・敷居・倒し方が入る", () => {
    const prompt = buildTriagePrompt(task, {
      suggestions,
      musts,
      round: 3,
      suggestionRounds: 2,
      pullRequestBody: "PR の説明：再送の防止",
    });
    for (const expected of [
      "決済 API の再送",
      "決済は 1 回",
      "# 承認済みの要求要件 v1",
      "# 承認済みの設計 v1",
      "PR の説明：再送の防止",
      "前の回の指摘 N",
      "この環境では撮れない",
      "対応しないとした提案 D",
      '"id":"S1"',
      '"id":"S2"',
      '"round":3,"suggestionOnlyRounds":2',
      // 基準
      "PR の目的の範囲の中にあり",
      "好み・書式・言い回し",
      "直しで足した文面の細部への新しい提案",
      "同じ原因の別の現れが提案として続いているもの",
      "直せない・この環境ではできないと答えたもの",
      "蒸し返し",
      // 回が進むほど敷居を上げる・提案だけの回が続くときは原則対応しない
      "提案だけの回が 2 回続いています。原則として、すべて「対応しない」",
      // 迷うときの倒し方
      "初回・1 回目）、対応する側に倒す",
      "2 回目以降）、対応しない側に倒す",
      "sacty-triage",
    ]) {
      expect(prompt).toContain(expected);
    }
    // 要修正は選り分けない
    expect(prompt).toContain("選り分けません。必ず直します");
  });

  it("初回は対応する側に倒し、2 回目以降は敷居を上げる", () => {
    const first = buildTriagePrompt(task, {
      suggestions,
      musts: [],
      round: 1,
      suggestionRounds: 1,
    });
    expect(first).toContain("初回のレビューです。迷うものは「対応する」にしてください");
    const second = buildTriagePrompt(task, {
      suggestions,
      musts: [],
      round: 2,
      suggestionRounds: 0,
    });
    expect(second).toContain("回が進むほど、対応する敷居を上げてください");
  });
});

describe("再レビューの指示への、対応しないとした提案の渡し方（PBI-436）", () => {
  const HEAD = "a".repeat(40);
  const reviewTask = (patch: Record<string, unknown> = {}): Task =>
    baseTask({
      reviewRound: 3,
      reviewTarget: { headCommit: HEAD },
      previousReview: {
        round: 2,
        url: "https://github.com/acme/app/pull/7#pullrequestreview-1",
        headCommit: "b".repeat(40),
        body: "# 前回",
        comments: [],
      },
      ...patch,
    });
  const declined = (n: number, longAt?: number): ReviewDeferrals["declinedByAuthor"] =>
    Array.from({ length: n }, (_, i) => ({
      text: i === longAt ? "あ".repeat(601) : `提案${i}`,
      reason: `理由${i}`,
      url: `https://github.com/acme/app/pull/7#pullrequestreview-${i}`,
    }));
  const dataOf = (lines: string[]) => {
    const text = lines.find((l) => l.startsWith('{"previousReview"')) ?? "{}";
    return JSON.parse(text) as {
      declinedByAuthor?: {
        finding: string;
        reason: string;
        url?: string;
        findingTruncated?: true;
      }[];
    };
  };

  it("対応しないとした提案は、50 件まで・1 件 600 文字までをデータに入れ、切ったものには印を付ける（新しい 50 件）", () => {
    const lines = rereviewLines(reviewTask(), [], {
      deferred: [],
      declinedByAuthor: declined(51, 50),
    });
    const data = dataOf(lines);
    // 古いものから落とし、新しい 50 件を渡す（最後の 1 件が、長い 601 文字の提案）
    expect(data.declinedByAuthor).toHaveLength(50);
    const last = data.declinedByAuthor?.at(-1);
    expect(last?.finding).toHaveLength(600);
    expect(last?.findingTruncated).toBe(true);
    expect(data.declinedByAuthor?.[0]?.finding).toBe("提案1");
    expect(lines.join("\n")).toContain("findingTruncated・reasonTruncated");
  });

  const declinedLine = (lines: string[]) => lines.filter((l) => l.includes("取り下げるのは"));

  it("通常の再レビュー：「前回の指摘」に、PR を作った側が対応しないと判断したと書かせ、未対応に数えず・同じ原因の別の現れとしても再指摘せず・判定の根拠にしない。要修正の重さと確かめたときだけ要修正にする", () => {
    const lines = rereviewLines(reviewTask(), [], { deferred: [], declinedByAuthor: declined(2) });
    const text = lines.join("\n");
    expect(text).toContain("未対応か、PR を作った側が対応しないと判断した");
    expect(text).toContain("declinedByAuthor の指摘を、対応を確かめた・未対応のどちらにも数えない");
    expect(text).toContain(
      "未対応に数えず、もう一度指摘せず（同じ原因の別の現れとしても出さない）、判定の根拠にしない",
    );
    expect(text).toContain(
      "[提案] の重みのままなら、理由が成り立たないとレビューが考えても、未対応として残さない",
    );
    expect(text).toContain("不具合・セキュリティ・データの破損・要件の不適合・互換性の破壊");
    expect(text).toContain("その後の変更で影響が大きくなったとき");
    // 対応しないとした提案が無いときは、今までどおりの二択
    const plain = rereviewLines(reviewTask(), [], { deferred: [] }).join("\n");
    expect(plain).toContain("対応を確かめた（直っている）か、未対応かを1行ずつ書く");
    expect(plain).not.toContain("declinedByAuthor");
  });

  it("同じ先頭の判定のし直しの回：取り下げの決まりは、実装が断った指摘だけに当たり、対応しないとした提案には当たらない", () => {
    const lines = rereviewLines(reviewTask({ reviewRejudgeCommit: HEAD }), [], {
      deferred: [],
      declinedByAuthor: declined(2),
    });
    const text = lines.join("\n");
    expect(text).toContain("今回は、前回と同じ先頭のコミットを判定し直す回");
    expect(text).toContain(
      "declinedByAuthor の提案は、作者の理由が成り立つかを確かめず、未対応に数えない",
    );
    expect(text).toContain("新しい要修正が無ければ、判定は指摘なしになる");
    // 「取り下げるのは…」の文は、必ず、declinedByAuthor に無い指摘に限られる
    expect(declinedLine(lines).length).toBeGreaterThan(0);
    for (const line of declinedLine(lines)) {
      expect(line).toContain("declinedByAuthor に無い指摘");
    }
    // 対応しないとした提案が無い判定し直しは、今までどおり（限定の語が付かない）
    const old = rereviewLines(reviewTask({ reviewRejudgeCommit: HEAD }), [], { deferred: [] });
    for (const line of declinedLine(old)) expect(line).not.toContain("declinedByAuthor");
  });
});
