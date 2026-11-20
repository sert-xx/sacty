import type { RemarkResponseStatus } from "@sacty/core";
import { redact } from "./agents/redact.js";
import { REMARK_REPLY_MARKER_PREFIX } from "./github.js";
import { withoutInternalPaths } from "./prompts.js";

/*
 * PR のレビュー・コメントから取り込んだ指摘への対応を、PR に返信する投稿（PBI-352）。
 * 行へのコメントから取り込んだ指摘には、そのコメントへの返信として、レビューの本文・通常のコメントから取り込んだ指摘には、
 * 元へのリンクを付けた PR のコメントとして投稿する。指摘した人・AI が、指摘の場所で、対応されたか・断られたかを読めるように。
 */

/** 返信に載せる対応の文の長さの上限（文字数）。外から来た文（エージェントの出力）を PR に載せるので切り詰める。 */
export const REPLY_TEXT_MAX = 4_000;

/** 指摘の元のコメントの種類と、GitHub の ID（指摘の origin の key から読む）。 */
export type RemarkOriginRef = {
  kind: "review" | "review_comment" | "comment";
  id: number;
};

/** origin の key（`review:<ID>`・`review_comment:<ID>`・`comment:<ID>`）を読む。読めなければ undefined。 */
export function remarkOriginRef(key: string): RemarkOriginRef | undefined {
  const match = key.match(/^(review|review_comment|comment):(\d+)$/);
  const id = Number(match?.[2]);
  return match && Number.isSafeInteger(id) && id > 0
    ? { kind: match[1] as RemarkOriginRef["kind"], id }
    : undefined;
}

/** 元のコメントの URL（PR の URL と、種類ごとの位置）。 */
export function remarkOriginUrl(pullRequestUrl: string, ref: RemarkOriginRef): string {
  const anchor =
    ref.kind === "review"
      ? `pullrequestreview-${ref.id}`
      : ref.kind === "review_comment"
        ? `discussion_r${ref.id}`
        : `issuecomment-${ref.id}`;
  return `${pullRequestUrl.replace(/\/+$/, "")}#${anchor}`;
}

/**
 * 同じ指摘への返信を探すための、目印の前半（提出回を除く）。1件の指摘には1回だけ返信するので、どの提出回の返信でも見つける。
 */
export function remarkReplyMarkerOf(taskId: string, remarkId: string): string {
  return `${REMARK_REPLY_MARKER_PREFIX}${taskId}:${remarkId}:`;
}

/** 同じ返信を二度投稿しないための目印（デーモンが投稿の後・記録の前に止まったとき、見つけて使う）。 */
export function remarkReplyMarker(taskId: string, remarkId: string, submission: number): string {
  return `${remarkReplyMarkerOf(taskId, remarkId)}${submission} -->`;
}

const ORIGIN_NAME: Record<RemarkOriginRef["kind"], string> = {
  review: "このレビュー",
  review_comment: "この行へのコメント",
  comment: "このコメント",
};

/** 書き出しの文で言う、元の投稿の種類。 */
const ORIGIN_KIND: Record<RemarkOriginRef["kind"], string> = {
  review: "レビューの本文",
  review_comment: "行へのコメント",
  comment: "通常のコメント",
};

/** 通常のコメントへの返信に添える、元のコメントの引用の長さの上限（文字数）。 */
export const REPLY_QUOTE_MAX = 100;

/** 上限で切る。文字の途中（サロゲートペアの間）で切らない。返信の文章と引用に共通の処理。 */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uDC00-\uDFFF]/.test(text[max] ?? "") ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/** @ の直後に見えない文字を挟み、@名前で知らない人に通知が飛ばないようにする。 */
function noMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b");
}

/**
 * 元のコメントの冒頭を、1行の引用にする。秘密情報を伏せてから、HTML のコメント（目印）を除き、空白を1つにまとめて、
 * 切る（切り口にかかった秘密情報の前半が残らない）。HTML・Markdown が返信の形を壊さないよう、`<` と「`」を無害にし、
 * 「 」で囲んで、行頭が見出し・リストなどにならないようにする。本文が空なら undefined。
 */
export function remarkQuote(text: string, secrets: readonly string[]): string | undefined {
  const flat = withoutInternalPaths(redact(text, secrets))
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return undefined;
  const cut = noMentions(cutAt(flat, REPLY_QUOTE_MAX)).replace(/</g, "&lt;").replace(/`/g, "'");
  return `> 「${cut}」`;
}

/** 書き出しの文。元の投稿の種類と、出どころ（sacty の AI のレビューか、人の投稿か。分からなければ言わない）を読めるようにする。 */
function replyOpening(origin: NonNullable<RemarkReplyInput["origin"]>): string {
  const from =
    origin.author === "sacty_review"
      ? "sacty の AI が書いた"
      : origin.author === "human"
        ? "人が書いた"
        : "";
  return `${from}${ORIGIN_KIND[origin.ref.kind]}（[${ORIGIN_NAME[origin.ref.kind]}](${origin.url})）への返信です。`;
}

/**
 * 後続に回したい案（PBI-370）の返信の頭と、末尾の注記。指摘した人がすぐに読んで議論が起きうるので、決まったことのように
 * 書かない。案であり、人に確認中で、まだ決まっていないことを明記する。
 */
export const DEFERRAL_PROPOSAL_HEAD =
  "**この PR では直さず、後続に回したいという案です（人に確認中で、まだ決まっていません）。** 理由：";
export const DEFERRAL_PROPOSAL_NOTE =
  "後続に回すか、この PR で直すかは、このタスクを承認する人が、マージの前に決めます。決定は、この PR にコメントで残します。";

export type RemarkReplyInput = {
  taskId: string;
  stepName: string;
  /** 指摘の ID。引き継いだ PR の指摘では、元のコメントのキー（目印にだけ使う）。 */
  remarkId: string;
  /** 引き継いだ PR の指摘への対応（指摘の ID は sacty の中のものでないので、末尾に書かない）。 */
  continued?: true;
  submission: number;
  /** 対応の文（エージェントの出力）。 */
  text: string;
  /** 対応したか、理由があって対応しなかったか、後続に回したい案か。申告が無ければ、対応の文だけを載せる。 */
  status?: RemarkResponseStatus;
  /**
   * PR のコメントとして投稿するときの、元のレビュー・コメント（どれへの返信かが分かるように、リンクを付ける）。
   * 行へのコメントへの返信として投稿するときは渡さない（スレッドで分かる）。
   */
  origin?: {
    ref: RemarkOriginRef;
    url: string;
    /** 元の投稿の出どころ。引き継いだ PR の指摘は、記録が無いので渡さない。 */
    author?: "sacty_review" | "human";
    /** 元のコメントの本文。通常のコメントへの返信にだけ、冒頭を引用する。 */
    quote?: string;
  };
  secrets: readonly string[];
};

/**
 * 返信の本文。先頭で、対応したのか、理由があって対応していないのかが分かるようにする。対応の文は、秘密情報を伏せてから
 * 切り詰める（逆だと、切り口にかかった秘密情報の前半が残る）。@名前で知らない人に通知が飛ばないよう、@ の直後に見えない
 * 文字を挟む。作業領域の内部のパスは、人が辿れる呼び方に置き換える。
 */
export function buildRemarkReply(input: RemarkReplyInput): string {
  const hidden = withoutInternalPaths(redact(input.text, input.secrets)).trim();
  // 文字の途中（サロゲートペアの間）で切らない
  const text = noMentions(cutAt(hidden, REPLY_TEXT_MAX));
  const quote =
    input.origin?.ref.kind === "comment" && input.origin.quote !== undefined
      ? remarkQuote(input.origin.quote, input.secrets)
      : undefined;
  const head =
    input.status === "addressed"
      ? "**対応しました。**"
      : input.status === "declined"
        ? "**対応していません。** 理由："
        : input.status === "deferred"
          ? DEFERRAL_PROPOSAL_HEAD
          : undefined;
  return [
    remarkReplyMarker(input.taskId, input.remarkId, input.submission),
    ...(input.origin ? [replyOpening(input.origin), ...(quote ? [quote] : []), ""] : []),
    ...(head ? [head, ""] : []),
    text,
    ...(input.status === "deferred" ? ["", DEFERRAL_PROPOSAL_NOTE] : []),
    "",
    "---",
    `sacty のタスク ${input.taskId} の${input.stepName}の工程で、AI が書きました${input.continued ? "" : `（指摘 ${input.remarkId} への対応）`}。`,
  ].join("\n");
}
