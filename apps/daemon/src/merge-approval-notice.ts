import { MERGE_APPROVAL_MARKER_PREFIX, MERGE_NOT_APPROVED_MARKER_PREFIX } from "./github.js";
import { taskLinkNote } from "./task-link.js";

/*
 * 工程（要求要件・設計）の PR の自動の直しの間に、人がその PR をマージしたときの知らせ（PBI-462）。
 * 承認として扱った知らせは、マージを承認にしたこと・直しを取り込まなかったこと・捨てた提案の件数を、1 つの PR に 1 通書く。
 * 承認として扱わなかった知らせは、要求要件へ戻している間の設計の PR のマージで、なぜもう一度マージが要るかを書く。
 * 実装の PR の作り直しをマージで止めたとき（PBI-276）も、承認にした知らせを書く。
 */

/** 承認にした知らせの目印。`<!-- sacty-merge-approval:<タスク ID>:<PR 番号> -->`。 */
export function mergeApprovalMarker(taskId: string, number: number): string {
  return `${MERGE_APPROVAL_MARKER_PREFIX}${taskId}:${number} -->`;
}

/** 承認にしなかった知らせの目印。`<!-- sacty-merge-not-approved:<タスク ID>:<PR 番号> -->`。 */
export function mergeNotApprovedMarker(taskId: string, number: number): string {
  return `${MERGE_NOT_APPROVED_MARKER_PREFIX}${taskId}:${number} -->`;
}

export type MergeApprovalNoticeInput = {
  taskId: string;
  number: number;
  /** 捨てた提案（指摘）の件数。 */
  discarded: number;
  taskUrl: string;
  localOnly?: boolean;
};

/** マージを承認として扱ったことの知らせの本文。 */
export function buildMergeApprovalNotice(input: MergeApprovalNoticeInput): string {
  return [
    mergeApprovalMarker(input.taskId, input.number),
    "## Sacty：このマージを承認として扱いました",
    "",
    "自動の直しの実行中にこの PR がマージされたため、マージを承認として扱い、次の工程へ進みます。",
    "自動の直しは止めて、結果を取り込んでいません。",
    input.discarded > 0
      ? `直しに反映していなかった提案が${input.discarded}件ありました。これも取り込んでいません。`
      : "直しに反映していなかった提案はありません。",
    "",
    `経過は[タスクの画面](${input.taskUrl})で確かめられます。${taskLinkNote(input.localOnly).join("")}`,
  ].join("\n");
}

export type MergeNotApprovedNoticeInput = {
  taskId: string;
  number: number;
  /** 承認にしなかった PR の工程の名前（設計）。 */
  stepName: string;
  /** 戻した先の工程の名前（要求要件）。 */
  backName: string;
  taskUrl: string;
  localOnly?: boolean;
};

/** マージを承認として扱わなかったことの知らせの本文。 */
export function buildMergeNotApprovedNotice(input: MergeNotApprovedNoticeInput): string {
  return [
    mergeNotApprovedMarker(input.taskId, input.number),
    `## Sacty：このマージを${input.stepName}の承認として扱っていません`,
    "",
    `${input.backName}の直しの最中だったため、このマージは${input.stepName}の承認として扱っていません。`,
    `${input.backName}の承認の後に、${input.stepName}の PR を作り直します。`,
    "",
    `経過は[タスクの画面](${input.taskUrl})で確かめられます。${taskLinkNote(input.localOnly).join("")}`,
  ].join("\n");
}
