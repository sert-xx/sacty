import type { StepKey } from "@sacty/core";
import { redact } from "./agents/redact.js";
import { HUMAN_ASK_MARKER_PREFIX } from "./github.js";
import { withoutInternalPaths } from "./prompts.js";
import { withoutRemarkIds } from "./remark-ids.js";
import { markdownText } from "./remark-line.js";

/*
 * 人に確かめてほしいことを、sacty が作った PR に知らせるコメント（PBI-301）。
 * 差し戻しや PR の指摘の作り直しで、戻し先の判断が指摘の意図を読み取れなかったときの理由と、実行が指摘への対応と
 * 一緒に挙げた「人に確かめたいこと」（聞き返し・推測で決めたこと）を載せる。PR を見ている人は sacty の画面を開かないので、
 * 承認の画面にしか出ないと気づかれない。作り直した成果物が承認待ちになったときに、1 回の提出につき 1 件書く。
 */

/** 1 件の文の長さの上限（文字数）。外から来た文（エージェントの出力）を PR に載せるので切り詰める。 */
export const ASK_TEXT_MAX = 600;

/** 同じ提出に何度も書かないための目印。`<!-- sacty-human-ask:<タスク ID>:<工程>:<提出回> -->`。 */
export function humanAskMarker(taskId: string, step: StepKey, submission: number): string {
  return `${HUMAN_ASK_MARKER_PREFIX}${taskId}:${step}:${submission} -->`;
}

/**
 * PR に載せる文。秘密情報を伏せてから切り詰める（逆だと、切り口にかかった秘密情報の前半が残る）。@名前で知らない人に
 * 通知が飛ばないよう、@ の直後に見えない文字を挟み、引用にして、本文の記法（見出し・リンクなど）として解釈させない。
 */
export function askQuote(text: string, secrets: readonly string[], max = ASK_TEXT_MAX): string {
  return publicText(text, secrets, max)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * PR・Issue に載せる、外から来た文（引用にする前の形）。秘密情報を伏せ、作業領域の内部のパスを、人が辿れる呼び方に
 * 置き換えてから、切り詰める（文字の途中では切らない）。@名前で通知が飛ばないよう、@ の直後に見えない文字を挟む。
 */
export function publicText(text: string, secrets: readonly string[], max: number): string {
  // 作業領域の内部のパスは、人が辿れないので、人が辿れる呼び方に置き換える（PBI-301 A7）
  // エージェントが文の中に書いた指摘の ID も除く（PBI-471。人は辿れない）
  const hidden = withoutRemarkIds(withoutInternalPaths(redact(text, secrets))).trim();
  return withoutMentions(cutAtMax(hidden, max));
}

/** 上限で切る（切ったら末尾に … を付ける）。文字の途中（サロゲートペアの間）では切らない。 */
export function cutAtMax(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uDC00-\uDFFF]/.test(text[max] ?? "") ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/** @ の直後に見えない文字を挟み、@名前で知らない人に通知が飛ばないようにする。 */
export function withoutMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b");
}

/**
 * 指摘を示す手がかり（PBI-471）。PR のコメントから取り込んだ指摘は、元のコメントへのリンク（url）。リンクが作れない指摘
 * （画面から書かれた指摘など）は、指摘の要点の1行（line。`remarkLine` で整えたもの）。指摘の ID・画面の URL は出さない。
 */
export type RemarkRef = { url?: string; line?: string };

/** 指摘を示す文（リンクがあればリンク、無ければ要点の1行。どちらも無ければ「指摘」）。 */
export function remarkRefText(ref: RemarkRef): string {
  if (ref.url) return `[この指摘](${ref.url})`;
  return ref.line ? `「${markdownText(ref.line)}」` : "指摘";
}

/** 複数の指摘を示す文。 */
export function remarkRefsText(refs: readonly RemarkRef[]): string {
  return refs.length > 0 ? refs.map(remarkRefText).join("・") : "指摘";
}

export type HumanAskNoticeInput = {
  taskId: string;
  step: StepKey;
  stepName: string;
  submission: number;
  /** 指摘の意図を読み取れなかったときの、指摘の手がかりと理由。 */
  undecided?: { remarks: readonly RemarkRef[]; reason: string };
  /** 実行が挙げた、人に確かめたいこと。同じ文の確認は 1 件にまとまっていて、付いていた指摘を `remarks` に並べる（PBI-354）。 */
  confirms: { remarks: readonly RemarkRef[]; text: string }[];
  secrets: readonly string[];
};

/** 人に確かめてほしいことを知らせるコメントの本文。確かめることが無ければ undefined。 */
export function buildHumanAskNotice(input: HumanAskNoticeInput): string | undefined {
  if (!input.undecided && input.confirms.length === 0) return undefined;
  const lines = [
    humanAskMarker(input.taskId, input.step, input.submission),
    "## Sacty：人に確かめてほしいことがあります",
    "",
    `${input.stepName}を作り直しました。承認・マージの前に、次を確かめてください。`,
  ];
  if (input.undecided) {
    lines.push(
      "",
      `**${remarkRefsText(input.undecided.remarks)}の意図を読み取れませんでした。** 理由：`,
      "",
      askQuote(input.undecided.reason, input.secrets),
      "",
      "読み取れた範囲の最小限で直しています。直した結果が指摘の意図と合うかを、指摘した方が確かめてください。",
    );
  }
  for (const c of input.confirms) {
    lines.push(
      "",
      `**確かめたいこと（${remarkRefsText(c.remarks)}）：**`,
      "",
      askQuote(c.text, input.secrets),
    );
  }
  lines.push("", "意図と違うときは、この PR にコメントするか、Sacty の画面で差し戻してください。");
  return lines.join("\n");
}
