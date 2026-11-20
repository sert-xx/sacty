import { type CodeFence, closesFence, openingFence } from "@sacty/core";

/**
 * 要求要件・設計の成果物の冒頭の「確認したいこと」の節を読み取り、PR の本文に出す節を組み立てる（PBI-439）。
 * 読み取りの結果はタスクの値には記録しない（本文を作るたびに、そのときの成果物から作り直す）。
 * 依存の向き：`human-ask-notice.ts` が `prompts.ts` を import しているので、ここからは import しない。
 */

/** 写す中身の上限（文字）。 */
export const STEP_QUESTIONS_MAX = 6_000;

export type StepQuestions =
  | { kind: "empty" }
  | { kind: "missing" }
  | { kind: "none" }
  | { kind: "counted"; must: number; should: number; content: string }
  | { kind: "uncounted"; content: string };

const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const BOLD_LABEL_LINE = /^ {0,3}\*\*(.+?)\*\*[ \t]*[：:]?[ \t]*$/;
const LIST_HEAD = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/;
const QUESTIONS_NAME = /^確認したいこと/;
const DECIDED_NAME = /^確認しないと決めたこと/;
const MUST_SHOULD = /^(must|should)(?:[ \t]*[（(][^）)]*[）)])?[ \t]*(?:[：:][ \t]*(.*))?$/i;

type Entry = { line: string; fenced: boolean };

/** 行ごとに、コードブロックの中（開く行・閉じる行を含む）かを付ける。 */
function scan(text: string): Entry[] {
  let fence: CodeFence | undefined;
  return text.split("\n").map((line) => {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      return { line, fenced: true };
    }
    const opened = openingFence(line);
    if (opened) {
      fence = opened;
      return { line, fenced: true };
    }
    return { line, fenced: false };
  });
}

const plain = (text: string) =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/^\d+[.)][ \t]*/, "")
    .trim();

/** 見出し・太字の札の行の、深さ（太字の札は 7）と名前。 */
function headingOf(line: string): { level: number; name: string } | undefined {
  const heading = HEADING_LINE.exec(line);
  if (heading) return { level: (heading[1] as string).length, name: plain(heading[2] as string) };
  const label = BOLD_LABEL_LINE.exec(line);
  if (label) return { level: 7, name: plain(label[1] as string) };
  return undefined;
}

/** 行の頭の記号・太字を除いた文が「なし」だけか。 */
function isNone(text: string): boolean {
  return /^なし[。.]?$/.test(
    text
      .replace(/\*\*|__/g, "")
      .replace(/^(?:[-*+]|\d+[.)])[ \t]+/, "")
      .trim(),
  );
}

function sectionBody(output: string): string[] | undefined {
  const entries = scan(output);
  let start = -1;
  let level = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as Entry;
    if (entry.fenced) continue;
    const head = headingOf(entry.line);
    if (head && QUESTIONS_NAME.test(head.name)) {
      start = i;
      level = head.level;
      break;
    }
  }
  if (start < 0) return undefined;
  const body: Entry[] = [];
  for (let i = start + 1; i < entries.length; i += 1) {
    const entry = entries[i] as Entry;
    if (!entry.fenced) {
      const head = headingOf(entry.line);
      if (head && head.level <= level && !(level === 7 && MUST_SHOULD.test(head.name))) break;
      // 「確認しないと決めたこと」から後ろは写さない（見出し・札・見出しでない行）
      if (head && DECIDED_NAME.test(head.name)) break;
      if (
        !head &&
        /^確認しないと決めたこと[：:]?$/.test(plain(entry.line.replace(LIST_HEAD, "$2")))
      )
        break;
    }
    body.push(entry);
  }
  return body.map((e) => e.line);
}

type Label = { kind: "must" | "should"; at: number; rest: string };

function labelOf(line: string): { kind: "must" | "should"; rest: string } | undefined {
  const head = headingOf(line);
  const list = head ? undefined : LIST_HEAD.exec(line);
  const text = head ? head.name : list ? plain(list[2] as string) : undefined;
  if (text === undefined) return undefined;
  const hit = MUST_SHOULD.exec(text);
  if (!hit) return undefined;
  return {
    kind: (hit[1] as string).toLowerCase() as "must" | "should",
    rest: (hit[2] ?? "").trim(),
  };
}

/** must・should の件数。数えられなければ undefined。 */
function countQuestions(body: string[]): { must: number; should: number } | undefined {
  const entries = scan(body.join("\n"));
  const labels: Label[] = [];
  entries.forEach((entry, at) => {
    if (entry.fenced) return;
    const label = labelOf(entry.line);
    if (label) labels.push({ ...label, at });
  });
  const counts: Partial<Record<"must" | "should", number>> = {};
  for (let n = 0; n < labels.length; n += 1) {
    const label = labels[n] as Label;
    if (counts[label.kind] !== undefined) return undefined;
    const end = labels[n + 1]?.at ?? entries.length;
    const range = entries.slice(label.at + 1, end).filter((e) => !e.fenced && e.line.trim());
    const items = range.flatMap((e) => {
      const item = LIST_HEAD.exec(e.line);
      return item ? [(item[1] as string).replace(/\t/g, "    ").length] : [];
    });
    if (label.rest && isNone(label.rest)) counts[label.kind] = 0;
    else if (!label.rest && range.length > 0 && isNone(range.map((e) => e.line).join(" ")))
      counts[label.kind] = 0;
    else if (items.length > 0) {
      const top = Math.min(...items);
      counts[label.kind] = items.filter((i) => i === top).length;
    } else if (label.rest) counts[label.kind] = 1;
    else return undefined;
  }
  if (counts.must === undefined || counts.should === undefined) return undefined;
  return { must: counts.must, should: counts.should };
}

/** 成果物（内部のパスの置き換えと秘密の伏せを済ませたもの）から、「確認したいこと」の節を読み取る。 */
export function readStepQuestions(output: string | undefined): StepQuestions {
  if (!output?.trim()) return { kind: "empty" };
  const body = sectionBody(output);
  if (!body) return { kind: "missing" };
  const text = body.join("\n").trim();
  if (!text) return { kind: "missing" };
  if (isNone(text)) return { kind: "none" };
  const counts = countQuestions(body);
  if (!counts) return { kind: "uncounted", content: text };
  if (counts.must === 0 && counts.should === 0) return { kind: "none" };
  return { kind: "counted", ...counts, content: text };
}

/** @ の直後に見えない文字を挟み、@名前で知らない人に通知が飛ばないようにする（`human-ask-notice.ts` の withoutMentions と同じ）。 */
function withoutMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b");
}

/** 閉じるキーワード（closes #1 など）と # の間に見えない文字を挟み、Issue の自動クローズを防ぐ。 */
function withoutClosing(text: string): string {
  const keyword = "\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b";
  return text
    .replace(new RegExp(`(${keyword}:?[ \\t]*(?:[\\w.-]+/[\\w.-]+)?)#(?=\\d)`, "gi"), "$1\u200b#")
    .replace(new RegExp(`(${keyword}:?[ \\t]+)(?=https?://)`, "gi"), "$1\u200b");
}

/** 上限で切る（サロゲートペアの間では切らない）。閉じていないコードブロック・コメント・折りたたみは閉じる。 */
function limitContent(content: string, path: string, max: number): string {
  const safe = withoutClosing(withoutMentions(content));
  let text = safe;
  let cut = false;
  if (text.length > max) {
    const end = /[\uDC00-\uDFFF]/.test(text[max] ?? "") ? max - 1 : max;
    text = text.slice(0, end);
    cut = true;
  }
  const open = openFence(text);
  if (open) text += `\n${open}`;
  if (/<!--(?![\s\S]*?-->)/.test(text)) text += " -->";
  const opened = (text.match(/<details>/g) ?? []).length;
  const closed = (text.match(/<\/details>/g) ?? []).length;
  text += "\n</details>".repeat(Math.max(0, opened - closed));
  if (cut)
    text += `\n\n…（長いので省きました。続きは成果のファイル \`${path}\` の「確認したいこと」の節で確かめてください）`;
  return text;
}

/** text の最後がコードブロックの中なら、それを閉じる行。 */
function openFence(text: string): string | undefined {
  let fence: CodeFence | undefined;
  for (const line of text.split("\n")) {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
    } else fence = openingFence(line);
  }
  return fence ? fence.char.repeat(Math.max(3, fence.size)) : undefined;
}

export const QUESTIONS_NONE_LINE = "確認したいこと：なし（must・should とも問いはありません）";
const answerLines = [
  "- 答えるには、この PR にコメントしてください。sacty が取り込み、答えを成果物に反映します。",
  "- 答えずにマージすると、推奨の答えで次の工程に進みます（must も同じです）。",
];

export type StepQuestionsSection = {
  /** 本文に置く行（無ければ空）。 */
  lines: string[];
  /** 長さの上限でも省かない、行のまとまり（無ければ undefined）。 */
  keep?: string;
};

/**
 * 本文に置く「確認したいこと」の節。form は、見出しの形（text：`## 確認したいこと`、template：`**確認したいこと**`）。
 * 成果のファイルの path は、読み取れないとき・切ったときの案内に使う。
 */
export function stepQuestionsLines(
  read: StepQuestions,
  path: string,
  form: "text" | "template",
  max = STEP_QUESTIONS_MAX,
): StepQuestionsSection {
  if (read.kind === "empty") return { lines: [] };
  if (read.kind === "none") return { lines: [QUESTIONS_NONE_LINE], keep: QUESTIONS_NONE_LINE };
  if (read.kind === "missing") {
    const line = `確認したいこと：成果物から読み取れませんでした。成果のファイル \`${path}\` の冒頭で確かめてください。`;
    return { lines: [line], keep: line };
  }
  const first =
    read.kind === "uncounted"
      ? "人に決めてほしい問いがあります（件数は成果物の形から数えられませんでした）。"
      : read.must > 0
        ? `must ${read.must}件・should ${read.should}件。must は、後で答えが違うと分かると、それまでの作業が無駄になる問いです。`
        : `should ${read.should}件（must はありません）。`;
  const block = [first, ...answerLines].join("\n");
  return {
    lines: [
      form === "text" ? "## 確認したいこと" : "**確認したいこと**",
      "",
      block,
      "",
      limitContent(read.content, path, max),
    ],
    keep: block,
  };
}
