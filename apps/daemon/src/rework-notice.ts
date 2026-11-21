import { REWORK_NOTICE_MARKER_PREFIX } from "./github.js";
import { askQuote } from "./human-ask-notice.js";
import { taskLinkNote } from "./task-link.js";

/*
 * 実装の PR の指摘を設計の工程に戻したことを、その PR に知らせるコメント（PBI-446）。設計に戻すと、設計のやり直し・設計の PR・
 * 人の承認を経てから実装をやり直すので、実装の PR は直らないまま開く。PR を見ている人は sacty の画面を開かないので、戻したこと・
 * 理由・次にすることを、1 回の差し戻しにつき 1 通書く。
 */

/** 同じ差し戻しに何度も書かないための目印。`<!-- sacty-rework-notice:<タスク ID>:<差し戻しの回> -->`。 */
export function reworkNoticeMarker(taskId: string, round: number): string {
  return `${REWORK_NOTICE_MARKER_PREFIX}${taskId}:${round} -->`;
}

export type ReworkNoticeInput = {
  taskId: string;
  /** 差し戻しの回（設計への差し戻しの何回目か）。 */
  round: number;
  /** 戻し先の判断の理由（どの決定を変えるか）。 */
  reason: string;
  /** 戻した工程（設計）。 */
  stepName: string;
  /** タスクの画面の URL。 */
  taskUrl: string;
  /** 画面の URL が依頼した人のマシンでだけ開けるか（注釈を添える）。 */
  localOnly?: boolean;
  secrets: readonly string[];
};

/**
 * 設計に戻したことを知らせるコメントの本文。理由は、秘密情報を伏せてから 600 文字で切り、内部のパスを置き換え、@ の
 * 通知を無効にして、引用にする（人に確かめてほしいことの投稿と同じ）。
 */
export function buildReworkNotice(input: ReworkNoticeInput): string {
  return [
    reworkNoticeMarker(input.taskId, input.round),
    `## Sacty：指摘を${input.stepName}に戻しました`,
    "",
    `この PR への指摘が、承認済みの設計の方針の変更にあたると判断し、設計の工程に戻しました。設計のやり直しは、すでに始まっています。この PR は、設計の PR が承認されるまで、直らないまま開いています。`,
    "",
    "**どの決定を変えるか（判断の理由）：**",
    "",
    askQuote(input.reason, input.secrets),
    "",
    "**次に人がすること：**",
    "",
    `- Sacty が作る設計の PR を確かめ、承認（マージ）してください。承認されると、この PR の実装をやり直します。`,
    "- 局所の変更で足りる（設計の工程までは要らない）と考えるときは、次の回から、指摘に「実装の工程で直す」と書いてください。その回は、実装の工程で直し、設計書の直しも同じ PR に入ります（設計のやり直しは、すでに始まっています）。",
    "",
    `意図と違うときは、[タスクの画面](${input.taskUrl})で差し戻してください。${taskLinkNote(input.localOnly).join("")}`,
  ].join("\n");
}
