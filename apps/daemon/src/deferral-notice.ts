import type { DeferralDecision } from "@sacty/core";
import { DEFERRAL_NOTICE_MARKER_PREFIX } from "./github.js";
import { askQuote } from "./human-ask-notice.js";

/*
 * 後続に回したい案（実装が、この PR では直さず後続に回したいと申告した指摘）への、人の決定を、PR に残すコメント（PBI-370）。
 * 実装の返信は「案であり、人に確認中」と書くので、決まったこと（後続に回す／この PR で直す）と、その指摘の一覧を、PR を
 * 見ている人が読めるように、決定のたびに 1 件書く。
 */

/** 同じ決定を二度書かないための目印。`<!-- sacty-deferral:<タスク ID>:<何回目の決定か> -->`。 */
export function deferralNoticeMarker(taskId: string, decision: number): string {
  return `${DEFERRAL_NOTICE_MARKER_PREFIX}${taskId}:${decision} -->`;
}

export type DeferralNoticeItem = {
  remarkId: string;
  decision: DeferralDecision;
  /**
   * その PR のコメントから取り込んだ指摘の、指摘の文・実装が書いた後続に回したい理由・元のコメントの URL。sacty の画面から
   * 書いた指摘には無い（画面で書いた文と、それへの対応は、PR に載せない。指摘への対応の返信と同じ）。
   */
  quoted?: { text: string; reason: string; url: string };
};

export type DeferralNoticeInput = {
  taskId: string;
  decision: number;
  items: readonly DeferralNoticeItem[];
  /** タスクの画面の URL。 */
  taskUrl: string;
  /**
   * 「この PR で直す」の差し戻しが、上限でエスカレーションになった（まだ差し戻していない。人が、上限を超えて差し戻すかを
   * 決める）。
   */
  escalated?: boolean;
  secrets: readonly string[];
};

/**
 * 決定のコメントの本文。指摘の文と理由は外から来た文なので、秘密情報を伏せてから切り詰め、引用にして載せる（askQuote）。
 * 決定が無ければ undefined。
 */
export function buildDeferralNotice(input: DeferralNoticeInput): string | undefined {
  if (input.items.length === 0) return undefined;
  const section = (decision: DeferralDecision, title: string): string[] => {
    const items = input.items.filter((item) => item.decision === decision);
    if (items.length === 0) return [];
    return [
      "",
      `### ${title}（${items.length} 件）`,
      ...items.flatMap((item) =>
        item.quoted
          ? [
              "",
              `**指摘 ${item.remarkId}**（[元のコメント](${item.quoted.url})）`,
              "",
              askQuote(item.quoted.text, input.secrets),
              "",
              "実装が、後続に回したいとした理由：",
              "",
              askQuote(item.quoted.reason, input.secrets),
            ]
          : [
              "",
              `**指摘 ${item.remarkId}**（Sacty の画面から書かれた指摘。内容は、タスクの画面で読めます）`,
            ],
      ),
    ];
  };
  const fixes = input.items.some((item) => item.decision === "fix");
  const fixNote = !fixes
    ? ""
    : input.escalated
      ? "この PR で直すと決めた指摘は、差し戻しが上限に達しているため、まだ差し戻していません（タスクの画面で、上限を超えて差し戻すかを決めます）。"
      : "この PR で直すと決めた指摘は、実装をやり直して直します。";
  return [
    deferralNoticeMarker(input.taskId, input.decision),
    "## Sacty：後続に回したい案を、人が決めました",
    "",
    "実装が「この PR では直さず、後続に回したい」とした指摘について、このタスクを承認する人が、次のとおり決めました。",
    ...section("defer", "後続に回す"),
    ...section("fix", "この PR で直す"),
    "",
    "---",
    `${fixNote}後続に回すと決めた指摘は、この PR では直しません。決定は、[タスクの画面](${input.taskUrl})で行われました。`,
  ].join("\n");
}
