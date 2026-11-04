import type { Task } from "@sacty/core";
import { splitLineContext } from "./prompts.js";

/*
 * 監査が登録するメモリーに、そのタスクの依頼者が決めた答え（範囲・数値・有無・画面の要否など、そのタスクの要求そのもの）が、
 * ほかのタスクにも当てはまる事実として書かれていないかを、登録の前に検査する（PBI-302 B6。S14 r5 では、監査が SactyTest 全体の
 * メモリーに、S14 の答え（画面は要らない・15 分にそろえる・上限なしなど）を事実として登録した）。
 *
 * 指示（監査の指示のメモリーの決まり）だけに頼らず、sacty が機械的に検査する。見つけられるのは、依頼者を主語に書いた文と、
 * 依頼者が書いた文（依頼の本文・人の指摘・再開の補足）を、そのまま写した部分だけ。言い換えられた答えは見つけられない。
 */

/** 依頼者が書いた文として、重なりを調べる文字列（依頼の題と本文・人の指摘・再開の補足）。AI のレビューの指摘は含めない。 */
export function requesterTexts(task: Task): string[] {
  return [
    task.title,
    task.body,
    // 行へのコメントの指摘は、sacty が添えた行の内容（リポジトリの引用）を除いた、人が書いた本文だけ（PR #304 のレビュー）
    ...task.remarks
      .filter((r) => !r.voided && r.source !== "sacty_review")
      .map((r) => splitLineContext(r.text).body),
    ...(task.resumeNotes ?? []),
  ].filter((text) => typeof text === "string" && text.trim() !== "");
}

/**
 * 写したと見なす、連続した一致の文字数（空白・記号を除いた後）。これより短い一致は偶然の一致として見逃す。一致は、1つの依頼者の文の
 * 中の連続した位置で数え、位置や文をまたいで合算しない（PR #304 のレビュー：12 文字の句が別々の文に 3 つあるだけで弾いていた）。
 */
const COPIED_RUN = 14;

/** 比べるために、全角半角・大文字小文字をそろえ、空白・記号を除く。 */
function squeeze(text: string): string[] {
  return Array.from(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, ""),
  );
}

/**
 * 一致のうち、文章（日本語など、英数字以外の文字）が少ないものは、写しと見なさない。パス・識別子・コマンドのような英数字が
 * 主の一致は、リポジトリの事実で、依頼の文と偶然重なる。
 */
const TEXT_CHARS_MIN = 6;

function isProse(gram: string): boolean {
  return Array.from(gram).filter((c) => !/[a-z0-9]/.test(c)).length >= TEXT_CHARS_MIN;
}

function grams(chars: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i + COPIED_RUN <= chars.length; i++) {
    const gram = chars.slice(i, i + COPIED_RUN).join("");
    if (isProse(gram)) result.add(gram);
  }
  return result;
}

/**
 * 依頼者を主語に、その答え・求めたことを書く言い方。「答えた」だけでは数えない（レビューの担当などエージェントが答えた、という
 * sacty の工程の知見も書かれるため。DA の見直し：既存のメモリーの「担当の 14 件が…と答えた」を誤って弾いた）。人を主語に
 * したときだけ数える。
 */
const REQUESTER_SUBJECT =
  /依頼者|依頼人|依頼した人|依頼主|発注者|ステークホルダー|stakeholder|requester|(?:人|ユーザー|利用者|お客様|顧客)(?:は|が)[^。\n]{0,40}(?:と|を)(?:答え(?:た|ました)|回答(?:した|しました))/i;

export type MemoryRequesterIssue =
  /** 依頼者を主語にした文がある（依頼者がこう答えた・求めた、など）。 */
  | "requester_mentioned"
  /** 依頼者が書いた文（依頼の本文・人の指摘・再開の補足）を、そのまま写した部分がある。 */
  | "requester_text_copied";

/**
 * 登録しようとするメモリー（題・概要・中身）が、依頼者の答えを書いたものに当たるか。当たれば、その種類。登録しない。
 */
export function memoryRequesterIssue(
  memory: { title: string; summary: string; body: string },
  requester: readonly string[],
): MemoryRequesterIssue | undefined {
  const all = `${memory.title}\n${memory.summary}\n${memory.body}`;
  if (REQUESTER_SUBJECT.test(all)) return "requester_mentioned";
  if (requester.length === 0) return undefined;
  const written = grams(squeeze(all));
  if (written.size === 0) return undefined;
  // 14 文字の並び（連続した位置）が、1つの依頼者の文とそのまま重なれば、14 文字以上の連続した一致がある
  for (const text of requester) {
    for (const gram of grams(squeeze(text))) if (written.has(gram)) return "requester_text_copied";
  }
  return undefined;
}
