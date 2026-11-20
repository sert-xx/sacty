/*
 * 直しに入る前に、AI が「この PR では対応しない」と選り分けた提案（PBI-436）を、指摘への返信に載せる文。
 * 返信の書き出し・目印・署名・長さの上限（全体）は、今までの返信（remark-reply.ts）のまま。ここは、載せる文だけを作る。
 */

import { redact } from "./agents/redact.js";
import { cutAtMax } from "./human-ask-notice.js";
import { withoutInternalPaths } from "./prompts.js";
import { withoutHtmlComments } from "./suggestion-triage.js";

/** 返信に添える、AI の判断であることと、人が直させる方法。 */
export const TRIAGE_REPLY_NOTE =
  "直しに入る前に AI が判断し、この PR では対応しません。直させたいときは、PR に要対応とコメントしてください。";

/** 返信の 1 項目に載せる、提案の文・理由の長さの上限（文字数）。返信の全体の上限（4,000 文字）に収める。 */
const ITEM_TEXT_MAX = 200;
const ITEM_REASON_MAX = 400;

type Part = { text: string; reason: string };

/**
 * 1 項目の文を、1 行にする。HTML のコメント（sacty の投稿の目印に見える文字列）を除き、秘密情報を伏せ、内部のパスを置き換えて
 * から切る（伏せる前に切ると、切り口にかかった秘密情報の前半が残る。文字の途中でも切らない）。
 */
const oneLine = (v: string, max: number, secrets: readonly string[]) =>
  cutAtMax(
    withoutInternalPaths(redact(withoutHtmlComments(v), secrets))
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );

/** 対応しない提案と理由の一覧（1 件 1 行）。 */
function declinedList(parts: readonly Part[], secrets: readonly string[]): string {
  return parts
    .map(
      (d) =>
        `- ${oneLine(d.text, ITEM_TEXT_MAX, secrets)}\n  理由：${oneLine(d.reason, ITEM_REASON_MAX, secrets)}`,
    )
    .join("\n");
}

/**
 * 指摘への返信に載せる対応の文。
 * - 提案のすべてを対応しないとした指摘（triaged）：AI の判断であることと、対応しない提案と理由。
 * - 一部の提案だけを対応しないとした指摘：実装の対応の後ろに、対応しない提案と理由を足す（1 つの投稿への返信は 1 通のまま）。
 * - それ以外：実装の対応の文のまま。
 */
export function triageReplyTextOf(
  remark: { response: string; triaged?: true; declinedParts?: readonly Part[] },
  secrets: readonly string[],
): string {
  const parts = remark.declinedParts ?? [];
  if (remark.triaged) return `${TRIAGE_REPLY_NOTE}\n\n${declinedList(parts, secrets)}`;
  if (parts.length === 0) return remark.response;
  return `${remark.response}\n\nこのレビューの次の提案は、${TRIAGE_REPLY_NOTE}\n\n${declinedList(parts, secrets)}`;
}
