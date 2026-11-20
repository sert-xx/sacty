/*
 * 直しに入る前に、AI が「この PR では対応しない」と選り分けた提案（PBI-436）を、指摘への返信に載せる文。
 * 返信の書き出し・目印・署名・伏せ・長さの上限は、今までの返信（remark-reply.ts）のまま。ここは、載せる文だけを作る。
 */

/** 返信に添える、AI の判断であることと、人が直させる方法。 */
export const TRIAGE_REPLY_NOTE =
  "直しに入る前に AI が判断し、この PR では対応しません。直させたいときは、PR に要対応とコメントしてください。";

/** 返信の 1 項目に載せる、提案の文・理由の長さの上限（文字数）。返信の全体の上限（4,000 文字）に収める。 */
const ITEM_TEXT_MAX = 200;
const ITEM_REASON_MAX = 400;

const oneLine = (v: string, max: number) => {
  const flat = v.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 対応しない提案と理由の一覧（1 件 1 行）。 */
function declinedList(parts: readonly { text: string; reason: string }[]): string {
  return parts
    .map(
      (d) => `- ${oneLine(d.text, ITEM_TEXT_MAX)}\n  理由：${oneLine(d.reason, ITEM_REASON_MAX)}`,
    )
    .join("\n");
}

/** 提案のすべてを対応しないとした指摘（直しに入らない）への返信の文。 */
export function triagedReplyText(parts: readonly { text: string; reason: string }[]): string {
  return `${TRIAGE_REPLY_NOTE}\n\n${declinedList(parts)}`;
}

/**
 * 一部の提案だけを対応しない指摘への返信の文：実装の対応の後ろに、対応しない提案と理由を足す（1 つの投稿への返信は 1 通のまま）。
 */
export function withDeclinedParts(
  response: string,
  parts: readonly { text: string; reason: string }[] | undefined,
): string {
  if (!parts || parts.length === 0) return response;
  return `${response}\n\nこのレビューの次の提案は、${TRIAGE_REPLY_NOTE}\n\n${declinedList(parts)}`;
}
