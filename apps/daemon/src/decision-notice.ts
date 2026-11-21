import { DECISION_NOTICE_MARKER_PREFIX } from "./github.js";
import { askQuote } from "./human-ask-notice.js";

/*
 * AI のレビューが「直しでは解消できず、人の判断が要る」と印を付けた要修正が残ったので、直しに入らずに止めたことを、その PR に
 * 知らせるコメント（PBI-452）。PR を見ている人は sacty の画面を開かないので、止めたこと・理由（どの指摘が、なぜ直しでは
 * 解消できないとされたか）・人がすることを、止めた 1 回につき 1 通書く。
 */

/** 同じ止めた回に何度も書かないための目印。`<!-- sacty-decision-notice:<タスク ID>:<止めた回> -->`。 */
export function decisionNoticeMarker(taskId: string, round: number): string {
  return `${DECISION_NOTICE_MARKER_PREFIX}${taskId}:${round} -->`;
}

export type DecisionNoticeInput = {
  taskId: string;
  /** 止めた回（このタスクで、印で止めた何回目か）。 */
  round: number;
  /** 印の付いた指摘と、直しでは解消できないとされた根拠。 */
  findings: readonly { finding: string; reason: string }[];
  secrets: readonly string[];
};

/**
 * 止めたことを知らせるコメントの本文。指摘と根拠は、秘密情報を伏せてから切り、内部のパスを置き換え、@ の通知を無効にして、
 * 引用にする（人に確かめてほしいことの投稿と同じ）。
 */
export function buildDecisionNotice(input: DecisionNoticeInput): string {
  return [
    decisionNoticeMarker(input.taskId, input.round),
    "## Sacty：人の判断を待って止めています",
    "",
    "AI のレビューが、次の指摘を「直し（実装の手直し）では解消できず、人の判断が要る」と判断しました。往復を続けても解消しないので、直しに入らずに止めています。",
    "",
    "**直しでは解消できないとされた指摘と、その根拠：**",
    "",
    ...input.findings.flatMap((f) => [
      askQuote(`${f.finding}\n根拠：${f.reason}`, input.secrets),
      "",
    ]),
    "**次に人がすること：**",
    "",
    "- 了承するか、進め方の方針があるときは、この PR にコメントで書いてください。書いた内容を直しの指示に渡して、再開します。",
    "- 指摘をそのまま受け入れるなら、この PR をマージしてください（止めた理由の指摘は反映せずに、マージを承認として進めます）。",
    "",
    "補足を付けて再開するときは、Sacty の画面で再開してください。",
  ].join("\n");
}
