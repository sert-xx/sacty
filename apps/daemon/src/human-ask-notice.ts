import type { StepKey } from "@sacty/core";
import { redact } from "./agents/redact.js";
import { HUMAN_ASK_MARKER_PREFIX } from "./github.js";

/*
 * 人に確かめてほしいことを、sacty が作った PR に知らせるコメント（PBI-301）。
 * 差し戻しや PR の指摘の作り直しで、ゴールガーディアンが指摘の意図を判断できなかったときの理由と、実行が指摘への対応と
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
export function askQuote(text: string, secrets: readonly string[]): string {
  const hidden = redact(text, secrets).trim();
  const cut = hidden.length > ASK_TEXT_MAX ? `${hidden.slice(0, ASK_TEXT_MAX)}…` : hidden;
  return cut
    .replace(/@(?=[A-Za-z0-9_-])/g, "@​")
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export type HumanAskNoticeInput = {
  taskId: string;
  step: StepKey;
  stepName: string;
  submission: number;
  /** ゴールガーディアンが指摘の意図を判断できなかったときの、指摘の ID と理由。 */
  undecided?: { remarkIds: string[]; reason: string };
  /** 実行が挙げた、人に確かめたいこと。 */
  confirms: { remarkId: string; text: string }[];
  /** タスクの画面の URL。 */
  taskUrl: string;
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
      `**指摘（${input.undecided.remarkIds.join("・")}）の意図を、ゴールガーディアンが判断できませんでした。** 理由：`,
      "",
      askQuote(input.undecided.reason, input.secrets),
      "",
      "読み取れた範囲の最小限で直しています。直した結果が指摘の意図と合うかを、指摘した方が確かめてください。",
    );
  }
  for (const c of input.confirms) {
    lines.push(
      "",
      `**作り直しの実行が確かめたいこと（指摘 ${c.remarkId}）：**`,
      "",
      askQuote(c.text, input.secrets),
    );
  }
  lines.push(
    "",
    `意図と違うときは、この PR にコメントするか、[タスクの画面](${input.taskUrl})で差し戻してください。`,
  );
  return lines.join("\n");
}
