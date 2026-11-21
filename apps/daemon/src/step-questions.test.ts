import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { fillTemplate, limitBody, PR_BODY_MAX, truncatedNote } from "./pr-template.js";
import { buildStepPullRequestBodyParts, buildStepPullRequestBodyText } from "./prompts.js";
import { readStepQuestions, STEP_QUESTIONS_MAX } from "./step-questions.js";

const PATH = "docs/sacty/t-1/design.md";
const task = (output: string | undefined, extra: Partial<Task> = {}): Task =>
  ({
    id: "t-1",
    title: "決済",
    body: "",
    steps: [],
    remarks: [],
    outputs: output === undefined ? {} : { design: output },
    approved: {},
    testViewpoints: [],
    reproductionTests: [],
    proposals: [],
    stepPullRequests: [],
    ...extra,
  }) as unknown as Task;
const text = (output: string | undefined, secrets?: string[], extra: Partial<Task> = {}) =>
  buildStepPullRequestBodyText(task(output, extra), "design", PATH, undefined, secrets);
const mainOf = (output: string | undefined) => text(output).main;

const FORM_A = [
  "# 設計",
  "",
  "## 確認したいこと",
  "",
  "### must",
  "",
  "1. 通貨は円だけか（推奨：円だけ）",
  "",
  "### should",
  "",
  "1. 領収書は要るか（推奨：要る）",
  "2. 分割払いは要るか（推奨：要らない）",
  "",
  "### 確認しないと決めたこと",
  "",
  "- 税率は固定とする",
  "",
  "## 構成",
  "",
  "本文",
].join("\n");
const FORM_B = [
  "# 設計",
  "",
  "## 確認したいこと",
  "",
  "- must：なし",
  "- should",
  "  1. 領収書は要るか（推奨：要る）",
  "  2. 分割払いは要るか（推奨：要らない）",
  "",
  "確認しないと決めたこと",
  "",
  "- 税率は固定とする",
  "",
  "## 構成",
].join("\n");
const NONE_LINE = "確認したいこと：なし（must・should とも問いはありません）";
const ANSWER_COMMENT =
  "- 答えるには、この PR にコメントしてください。Sacty が取り込み、答えを成果物に反映します。";
const ANSWER_MERGE = "- 答えずにマージすると、推奨の答えで次に進みます（must も同じです）。";

describe("要求要件・設計の PR の本文の「確認したいこと」（PBI-439）", () => {
  it("形 A：承認の案内の後・確かめる所の前に、件数・must の意味・答え方・中身が出て、確認しないと決めたことは写さない", () => {
    const body = mainOf(FORM_A);
    const at = (s: string) => body.indexOf(s);
    expect(at("この PR をマージすると")).toBeLessThan(at("## 確認したいこと"));
    expect(body).toContain(
      "must 1件・should 2件。must は、後で答えが違うと分かると、それまでの作業が無駄になる問いです。",
    );
    const section = body.slice(at("## 確認したいこと"));
    const lines = section.split("\n");
    expect(lines[2]).toContain("must 1件・should 2件");
    expect(lines[3]).toBe(ANSWER_COMMENT);
    expect(lines[4]).toBe(ANSWER_MERGE);
    expect(body).toContain("通貨は円だけか（推奨：円だけ）");
    expect(body).toContain("分割払いは要るか（推奨：要らない）");
    expect(body).not.toContain("税率は固定とする");
    expect(body).not.toContain("本文");
  });

  it("形 B：must なし・should 2件と数え、確認しないと決めたこと以降は写さない", () => {
    const body = mainOf(FORM_B);
    expect(body).toContain("should 2件（must はありません）。");
    expect(body).toContain("領収書は要るか（推奨：要る）");
    expect(body).not.toContain("税率は固定とする");
    expect(body).not.toContain("確認しないと決めたこと");
  });

  it("must だけ・should だけ", () => {
    const mustOnly = [
      "## 確認したいこと",
      "### must",
      "- A（推奨：a）",
      "- B（推奨：b）",
      "### should",
      "なし",
    ].join("\n");
    expect(mainOf(mustOnly)).toContain("must 2件・should 0件。must は、後で答えが違うと分かると");
    const shouldOnly = [
      "## 確認したいこと",
      "### must",
      "なし",
      "### should",
      "- A（推奨：a）",
    ].join("\n");
    const body = mainOf(shouldOnly);
    expect(body).toContain("should 1件（must はありません）。");
    expect(body).not.toContain("must 0件");
  });

  it("問いが無いとき（形 C・形 A・形 B の両方「なし」）は、1行だけ出し、答え方と中身は出さない", () => {
    const outputs = [
      "## 確認したいこと\n\nなし\n\n## 構成",
      "## 確認したいこと\n\n### must\n\nなし\n\n### should\n\nなし\n\n### 確認しないと決めたこと\n\n- X",
      "## 確認したいこと\n\n- must：なし\n- should：なし\n\n確認しないと決めたこと\n\n- X",
    ];
    for (const output of outputs) {
      const body = mainOf(output);
      expect(body).toContain(NONE_LINE);
      expect(body).not.toContain("答えるには");
      expect(body).not.toContain("## 確認したいこと");
      expect(text(output).keep).toContain(NONE_LINE);
    }
  });

  it("形 D は件数を書かず、0件・なしも書かずに、答え方と中身を出す", () => {
    const output = [
      "## 確認したいこと",
      "",
      "- **Q-1**：通貨は（推奨：円）",
      "  - 理由：国内のみ",
      "- **Q-2**：領収書は（推奨：要る）",
      "- **Q-3**：分割は（推奨：要らない）",
    ].join("\n");
    const body = mainOf(output);
    const section = body.slice(body.indexOf("## 確認したいこと"));
    expect(section).toContain(
      "人に決めてほしい問いがあります（件数は成果物の形から数えられませんでした）。",
    );
    expect(section).not.toMatch(/0件|なし/);
    expect(section).toContain(ANSWER_COMMENT);
    expect(section).toContain(ANSWER_MERGE);
    for (const q of ["Q-1", "Q-2", "Q-3", "理由：国内のみ"]) expect(section).toContain(q);
  });

  it("節が見つからないときは、0件・なしと書かずに成果のファイルで確かめるよう案内する。成果物が空なら何も足さない", () => {
    const body = mainOf("## Open questions\n\n- Should we?");
    expect(body).toContain(`成果のファイル \`${PATH}\` の冒頭で確かめてください`);
    const line = body.split("\n").find((l) => l.startsWith("確認したいこと："));
    expect(line).not.toMatch(/0件|なし（/);
    expect(line).toContain("読み取れませんでした");
    for (const empty of [undefined, "", "  \n"]) {
      expect(mainOf(empty)).not.toContain("確認したいこと");
    }
  });

  it("本文や、コードブロックの中の「確認したいこと」を節の始まりと取り違えない", () => {
    const output = [
      "# 設計",
      "",
      "確認したいことは次の節に書く。",
      "",
      "```md",
      "## 確認したいこと",
      "",
      "- must：なし",
      "```",
      "",
      "**確認したいこと**",
      "",
      "- must：なし",
      "- should：領収書は要るか（推奨：要る）",
      "",
      "**確認しないと決めたこと**",
      "",
      "- 無視",
    ].join("\n");
    const read = readStepQuestions(output);
    expect(read).toMatchObject({ kind: "counted", must: 0, should: 1 });
    const body = mainOf(output);
    expect(body).toContain("should 1件（must はありません）。");
    expect(body).toContain("領収書は要るか");
    expect(body).not.toContain("次の節に書く");
    expect(body).not.toContain("- 無視");
  });

  it("テンプレートに沿わせる本文：目的の見出しの中で、冒頭の1文の後・確かめる所の前に出て、件数と答え方が keep に入る", () => {
    const withProvenance = task(
      ["## 確認したいこと", "### must", "- A（推奨：a）", "### should", "- B（推奨：b）"].join(
        "\n",
      ),
      {
        provenances: {
          design: {
            items: [{ id: "R-9", kind: "inference", refs: [], excerpt: "" }],
            unclassified: [],
          },
        },
      } as Partial<Task>,
    );
    const parts = buildStepPullRequestBodyParts(withProvenance, "design", PATH);
    const filled = fillTemplate("## 目的\n\n## 変更\n", parts);
    const purpose = filled.main.slice(
      filled.main.indexOf("## 目的"),
      filled.main.indexOf("## 変更"),
    );
    expect(purpose.indexOf("設計の成果物です。")).toBeLessThan(
      purpose.indexOf("**確認したいこと**"),
    );
    expect(purpose.indexOf("**確認したいこと**")).toBeLessThan(purpose.indexOf("**確かめる所**"));
    expect(purpose).toContain(
      "must 1件・should 1件。must は、後で答えが違うと分かると、それまでの作業が無駄になる問いです。",
    );
    expect(purpose).toContain(ANSWER_COMMENT);
    expect(purpose).toContain(ANSWER_MERGE);
    expect(filled.keep).toHaveLength(1);
    expect(filled.keep[0]).toContain("must 1件・should 1件");
    expect(filled.keep[0]).toContain(ANSWER_MERGE);
  });

  it("確かめる所の直後に、出典の確かめで、問いは確認したいことに出る旨の1行を足し、確かめる項目の語は変えない（2つの本文の形）", () => {
    const prov = {
      provenances: {
        design: {
          items: [{ id: "R-9", kind: "inference", refs: [], excerpt: "" }],
          unclassified: [],
          sequential: false,
        },
      },
    } as unknown as Partial<Task>;
    const note = "出典の確かめです。人に決めてほしい問いは「確認したいこと」に出ます。";
    const body = text(FORM_A, undefined, prov).main;
    expect(body).toMatch(new RegExp(`## 確かめる所\\n\\n${note}\\n\\n- R-9：推論`));
    const parts = buildStepPullRequestBodyParts(task(FORM_A, prov), "design", PATH);
    expect(parts.summary).toMatch(
      new RegExp(`\\*\\*確かめる所\\*\\*\\n\\n${note}\\n\\n- R-9：推論`),
    );
  });

  it("長い節は 6,000 文字で切り、省いたことと成果のファイルで読む案内を足す。件数と答え方の行は残る", () => {
    const items = Array.from({ length: 200 }, (_, i) => `- Q${i}：${"あ".repeat(80)}（推奨：い）`);
    const output = ["## 確認したいこと", "### must", "- M（推奨：m）", "### should", ...items].join(
      "\n",
    );
    const body = mainOf(output);
    const section = body.slice(body.indexOf("## 確認したいこと"));
    expect(section).toContain("must 1件・should 200件");
    expect(section).toContain(
      `続きは成果のファイル \`${PATH}\` の「確認したいこと」の節で確かめてください`,
    );
    expect(section).not.toContain("Q199");
    expect(section.length).toBeLessThan(STEP_QUESTIONS_MAX + 600);
    expect(section).toContain(ANSWER_COMMENT);
  });

  it("本文の全体を省くときも、件数の行と答え方の2行が行として丸ごと残る（2つの本文の形）", () => {
    const long = Array.from({ length: 40 }, (_, i) => `指摘${i}`.padEnd(2000, "あ"));
    const remarks = long.map((t, i) => ({
      id: `r-${i}`,
      step: "design",
      text: t,
      response: t,
      voided: false,
    }));
    const t = task(FORM_A, { remarks } as unknown as Partial<Task>);
    const block = [
      "must 1件・should 2件。must は、後で答えが違うと分かると、それまでの作業が無駄になる問いです。",
      ANSWER_COMMENT,
      ANSWER_MERGE,
    ];
    const plain = buildStepPullRequestBodyText(t, "design", PATH);
    const limitedPlain = limitBody(plain.main, plain.footer, PR_BODY_MAX, plain.keep);
    expect(limitedPlain.truncated).toBe(true);
    const filled = fillTemplate(
      "## 目的\n\n## 変更\n",
      buildStepPullRequestBodyParts(t, "design", PATH),
    );
    const limitedFilled = limitBody(filled.main, filled.footer, PR_BODY_MAX, filled.keep);
    expect(limitedFilled.truncated).toBe(true);
    for (const body of [limitedPlain.body, limitedFilled.body]) {
      const lines = body.split("\n");
      for (const line of block) expect(lines).toContain(line);
    }
  });

  it("件数と答え方の行が省かれる位置に来るほど短い上限でも、keep があれば残り、keep が無ければ消える", () => {
    const remarks = [
      {
        id: "r-1",
        step: "design",
        text: "指摘".padEnd(3000, "あ"),
        response: "指摘".padEnd(3000, "あ"),
        voided: false,
      },
    ];
    const t = task(FORM_A, { remarks } as unknown as Partial<Task>);
    const plain = buildStepPullRequestBodyText(t, "design", PATH);
    const filled = fillTemplate(
      "## 目的\n\n## 変更\n",
      buildStepPullRequestBodyParts(t, "design", PATH),
    );
    for (const body of [plain, filled]) {
      // 切れ目が、本文の冒頭（件数の行より前）に来る上限
      const max = body.footer.length + truncatedNote(body.main.length).length + 64 + 100;
      const without = limitBody(body.main, body.footer, max, []);
      expect(without.truncated).toBe(true);
      expect(without.body, without.body).not.toContain(ANSWER_MERGE);
      const kept = limitBody(
        body.main,
        body.footer,
        max + body.keep.join("").length + 2,
        body.keep,
      ).body.split("\n");
      expect(kept).toContain(ANSWER_COMMENT);
      expect(kept).toContain(ANSWER_MERGE);
    }
  });

  it("@ メンション・閉じるキーワードを無効にし、使った秘密の値は切れ目にまたがっても先頭を残さない", () => {
    const secret = "sk-secret-value-1234567890";
    const head = [
      "### must",
      "なし",
      "### should",
      "- @sert-xx に聞く。closes #1 と Fixes #2（推奨：はい）",
      "- ",
    ].join("\n");
    // 写す中身（見出しの次の行から）の、切れ目（6,000 文字）の 10 文字手前から秘密が始まるようにする
    const filler = "あ".repeat(STEP_QUESTIONS_MAX - 10 - head.length - 3);
    const output = `## 確認したいこと\n${head}${filler}${secret}${"い".repeat(300)}`;
    expect(readStepQuestions(output)).toMatchObject({ kind: "counted", should: 2 });
    const body = text(output, [secret]).main;
    expect(body).toContain("@\u200bsert-xx");
    expect(body).toContain("closes \u200b#1");
    expect(body).toContain("Fixes \u200b#2");
    expect(body).not.toMatch(/@sert/);
    expect(body).not.toMatch(/closes #1|Fixes #2/);
    expect(body).not.toContain("sk-s");
    expect(body).toContain("長いので省きました");
  });

  it("文字参照・URL 形式の閉じるキーワードも無効にする", () => {
    const output = [
      "## 確認したいこと",
      "### must",
      "なし",
      "### should",
      "- &#64;user と closes &#35;1（推奨：a）",
      "- closes:https://example.com/x と closes <https://example.com/y>（推奨：b）",
    ].join("\n");
    const body = mainOf(output);
    expect(body).toContain("&amp;#64;user");
    expect(body).toContain("&amp;#35;1");
    expect(body).toContain("closes:\u200bhttps://example.com/x");
    expect(body).toContain("closes &lt;\u200bhttps://example.com/y>");
  });

  it("閉じていないコードブロックを閉じて空行を入れ、続く確かめる所が見出しのまま出る", () => {
    const output = [
      "## 確認したいこと",
      "### must",
      "なし",
      "### should",
      "- A（推奨：a）",
      "  ```sh",
      "  | a | b |",
      "  |---|---|",
      "  | 1 | 2 |",
    ].join("\n");
    const body = text(output, undefined, {
      provenances: {
        design: {
          items: [{ id: "R-9", kind: "inference", refs: [], excerpt: "" }],
          unclassified: [],
        },
      },
    } as Partial<Task>).main;
    expect(body).toMatch(/\| 1 \| 2 \|\n```\n\n## 確かめる所/);
  });

  it("書き方の小さな違い：確認しないと決めたこと：本文（1行）・字下げした「なし」・**must**：なし を読み取る", () => {
    const inline = [
      "## 確認したいこと",
      "- must：なし",
      "- should",
      "  1. A（推奨：a）",
      "  2. B（推奨：b）",
      "- 確認しないと決めたこと：税率は固定",
      "- 余り",
    ].join("\n");
    expect(readStepQuestions(inline)).toMatchObject({ kind: "counted", must: 0, should: 2 });
    expect(mainOf(inline)).not.toContain("税率は固定");
    const indentedNone = [
      "## 確認したいこと",
      "- must",
      "  - なし",
      "- should",
      "  1. A（推奨：a）",
    ].join("\n");
    expect(readStepQuestions(indentedNone)).toMatchObject({ kind: "counted", must: 0, should: 1 });
    const boldRest = ["## 確認したいこと", "**must**：なし", "**should**：A（推奨：a）"].join("\n");
    expect(readStepQuestions(boldRest)).toMatchObject({ kind: "counted", must: 0, should: 1 });
    const boldNone = ["## 確認したいこと", "**must**：なし", "**should**：なし"].join("\n");
    expect(readStepQuestions(boldNone)).toEqual({ kind: "none" });
  });

  it("改行が CRLF の成果物も読み取る", () => {
    const crlf = FORM_A.replace(/\n/g, "\r\n");
    expect(readStepQuestions(crlf)).toMatchObject({ kind: "counted", must: 1, should: 2 });
    expect(mainOf(crlf)).not.toContain("\r");
  });

  it("長い 1 行があっても、時間がかからない", () => {
    const start = Date.now();
    const output = [
      `# ${"\t#".repeat(40_000)}`,
      "## 確認したいこと",
      "### must",
      "なし",
      "### should",
      `- ${"close.".repeat(100_000)}`,
    ].join("\n");
    expect(readStepQuestions(output)).toMatchObject({ kind: "counted", should: 1 });
    mainOf(output);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("インラインコード・コードブロックの中の <!--・<details> を数えず、コードの外の生の HTML は無効にする。閉じ行で終わっても後ろが巻き込まれない", () => {
    const output = [
      "## 確認したいこと",
      "### must",
      "なし",
      "### should",
      "- `<!--` と `<details>` を書く（推奨：a）",
      "- <details open>と<DETAILS>と<!-- 閉じない（推奨：b）",
      "  ```html",
      "  <!-- x",
      "  ```",
    ].join("\n");
    const body = text(output, undefined, {
      provenances: {
        design: {
          items: [{ id: "R-9", kind: "inference", refs: [], excerpt: "" }],
          unclassified: [],
        },
      },
    } as Partial<Task>).main;
    expect(body).toContain("`<!--` と `<details>`");
    expect(body).not.toMatch(/<details open>|<DETAILS>/);
    expect(body).toContain("&lt;details open>");
    expect(body).toContain("&lt;!-- 閉じない");
    expect(body).toContain("  <!-- x\n  ```\n");
    expect(body).not.toMatch(/```\s*-->/);
    expect(body).toMatch(/```\n\n## 確かめる所/);
  });

  it("切れ目が絵文字の途中・コードブロックの中でも、壊れた文字を残さず、コードブロックを閉じる", () => {
    const emoji = [
      "## 確認したいこと",
      "### must",
      "なし",
      "### should",
      `- ${"あ".repeat(STEP_QUESTIONS_MAX - 12)}😀😀😀`,
    ].join("\n");
    expect(mainOf(emoji)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const inFence = [
      "## 確認したいこと",
      "### must",
      "なし",
      "### should",
      "- A（推奨：a）",
      "```",
      `<!-- ${"x".repeat(STEP_QUESTIONS_MAX)}`,
    ].join("\n");
    const body = text(inFence, undefined, {
      provenances: {
        design: {
          items: [{ id: "R-9", kind: "inference", refs: [], excerpt: "" }],
          unclassified: [],
        },
      },
    } as Partial<Task>).main;
    expect(body).toMatch(/\n```\n\n…（長いので省きました/);
    expect(body).toMatch(/## 確かめる所/);
  });
});
