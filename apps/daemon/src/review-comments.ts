import type { StepKey } from "@sacty/core";
import type { PullRequestFeedback } from "./github.js";
import { isSactyRemarkReply } from "./github.js";
import { readRemarkReply, remarkOriginRef, remarkOriginUrl } from "./remark-reply.js";

/*
 * PR のレビューの子タスクに渡す、PR のコメントの 1 件ずつに、出どころ（人・sacty・確かめられない）と、sacty の返信の状態を付ける
 * （PBI-445）。人と sacty が同じ GitHub アカウントでも見分けるため、アカウントではなく、返信の目印のタスク ID の一致
 * （feedback が付ける bySacty）と、投稿した人の PR の作者・リポジトリとの関係で決める。本文に書かれた「人が書いた」などには従わない。
 */

/** 人の投稿として扱う、リポジトリとの関係（書き込み権限のある人）。 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * 出どころを付ける。sacty：bySacty の付いた返信。person：PR の作者、または書き込み権限のある人（OWNER・MEMBER・COLLABORATOR）。
 * unverified：それ以外（権限の無いアカウント、目印がこの PR を扱うタスクと一致しない投稿）。人の却下として扱うのは person だけ。
 */
export function annotateReviewComments(
  items: readonly PullRequestFeedback[],
  prAuthor: string,
): PullRequestFeedback[] {
  const author = prAuthor.toLowerCase();
  return items.map((item) => {
    if (item.bySacty) {
      const reply = readRemarkReply(item.body);
      return {
        ...item,
        by: "sacty" as const,
        reply: {
          ...(reply.status ? { status: reply.status } : {}),
          ...(reply.declinedProposals ? { declinedProposals: true as const } : {}),
        },
      };
    }
    // 目印があるのに、この PR を扱うタスクと一致しない投稿は、人の投稿に数えない
    const person =
      !isSactyRemarkReply(item.body) &&
      ((author !== "" && item.author.toLowerCase() === author) ||
        TRUSTED_ASSOCIATIONS.has(item.association ?? ""));
    return { ...item, by: person ? ("person" as const) : ("unverified" as const) };
  });
}

/**
 * PR を作ったタスクの人が、画面で無効にした指摘（RemarkVoided）を、その PR の工程の分だけ選ぶ（PBI-445）。マージで捨てた指摘
 * （自動で無効にしたもの）と、別の工程の指摘は含めない。元のコメントがこの PR のものなら、URL を添える。
 */
export function voidedByPersonOf(
  remarks: readonly {
    step: StepKey;
    text: string;
    voided: boolean;
    voidedBy?: "person";
    origin?: { key: string; number: number };
  }[],
  step: StepKey,
  number: number,
  prUrl: string,
): { text: string; url?: string }[] {
  return remarks
    .filter((r) => r.step === step && r.voided && r.voidedBy === "person")
    .map((r) => {
      const ref = r.origin?.number === number ? remarkOriginRef(r.origin.key) : undefined;
      return { text: r.text, ...(ref ? { url: remarkOriginUrl(prUrl, ref) } : {}) };
    });
}
