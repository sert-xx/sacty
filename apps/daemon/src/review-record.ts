import {
  REVIEW_RECORD_LIST_MAX,
  REVIEW_RECORD_SHORT_LIST_MAX,
  REVIEW_RECORD_TEXT_MAX,
  type ReviewRecord,
  ReviewVerificationKind,
  ReviewViewpointStatus,
} from "@sacty/core";
import { z } from "zod";

/**
 * PR のレビューの実行が、過程の記録を返すブロックの見出し（PBI-460）。コードブロックの情報文字列に書かせる
 * （セルフレビューの報告 sacty-self-review と同じく、依頼した側が決めた形で返す）。
 */
export const REVIEW_RECORD_HEADING = "sacty-review-record";

/** 記録に固有の欄名。見出しの無いコードブロックでも、これをキーに持てば記録とみなして投稿から除く。 */
const RECORD_FIELD_NAMES = ["viewpoints", "notReviewed", "dismissed", "dropped", "verification"];

/**
 * 記録の欄名が、キーとして書かれているか。大小文字・欄名の前後の引用符（二重・一重・無し）・`:` の前の空白を問わない。
 * 欄名の直前・直後が英数字・`_` のもの（`myverification:` など）は当てない。mode・scope は一般の設定の語なので使わない。
 */
const FIELD_KEY = new RegExp(
  `(?<![A-Za-z0-9_])["']?(?:${RECORD_FIELD_NAMES.join("|")})["']?\\s*:`,
  "i",
);
const HEADING_ANYWHERE = new RegExp(REVIEW_RECORD_HEADING, "i");

/** 行頭の字下げ・引用（`>`）・リストの印。 */
const LINE_PREFIX = /^(?:[ \t]+|>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]))*/;

/** 改行は \r\n・\r・\n のどれでも分ける。 */
const LINE_BREAK = /\r\n|\r|\n/;

interface Fence {
  start: number;
  end: number;
  closed: boolean;
  info: string;
  /** 開きと閉じを除いた中身の行。 */
  content: string[];
}

/** 行の飾り（字下げ・引用・リストの印）を除いた中身。 */
function bare(line: string): string {
  return line.slice((LINE_PREFIX.exec(line) ?? [""])[0].length);
}

/**
 * コードブロック（フェンス）を見つける。行頭の空白（数を問わない）・引用・リストの印を除いた後に、バッククォートかチルダの
 * 3 文字以上で始まる行を開きとし、同じ文字で開きと同じ長さ以上のフェンスで閉じる。閉じていないものは、文字列の終わりまで。
 */
function findFences(lines: readonly string[]): Fence[] {
  const fences: Fence[] = [];
  let open: { start: number; char: string; length: number; info: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const rest = bare(lines[i] ?? "");
    if (open) {
      const close = rest.match(/^(`{3,}|~{3,})[ \t]*$/);
      if (close?.[1]?.[0] === open.char && (close[1]?.length ?? 0) >= open.length) {
        fences.push({
          start: open.start,
          end: i,
          closed: true,
          info: open.info,
          content: lines.slice(open.start + 1, i),
        });
        open = undefined;
      }
      continue;
    }
    const opening = rest.match(/^(`{3,}|~{3,})(.*)$/);
    // バッククォートのフェンスは、情報文字列にバッククォートを含まないものだけが開き（「```foo``` を使うと」は開きではない）
    if (opening && !(opening[1]?.startsWith("`") && (opening[2] ?? "").includes("`"))) {
      open = {
        start: i,
        char: opening[1]?.[0] ?? "`",
        length: opening[1]?.length ?? 3,
        info: opening[2] ?? "",
      };
    }
  }
  if (open) {
    fences.push({
      start: open.start,
      end: lines.length - 1,
      closed: false,
      info: open.info,
      content: lines.slice(open.start + 1),
    });
  }
  return fences;
}

/** 行の括弧（{ [ と } ]）の増減。二重引用符の文字列の中は数えない。 */
function bracketDelta(line: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth;
}

/** 1 回分の除去。除くものが無ければ、入力をそのまま返す。 */
function stripOnce(text: string): string {
  const lines = text.split(LINE_BREAK);
  const remove = new Array<boolean>(lines.length).fill(false);
  const fenced = new Array<boolean>(lines.length).fill(false);
  for (const fence of findFences(lines)) {
    for (let i = fence.start; i <= fence.end; i++) fenced[i] = true;
    // 見出しを情報文字列に含むもの、または中身に記録に固有の欄名をキーとして含むもの（JSON として読めるかは問わない）
    // 中身に、見出し付きのフェンスが入れ子になっているもの（外側を除くと内側が現れる）も、外側ごと除く
    const nestedHeading = fence.content.some((l) => {
      const m = bare(l).match(/^(?:`{3,}|~{3,})(.*)$/);
      return m !== null && HEADING_ANYWHERE.test(m[1] ?? "");
    });
    if (
      HEADING_ANYWHERE.test(fence.info) ||
      nestedHeading ||
      FIELD_KEY.test(fence.content.join("\n"))
    ) {
      for (let i = fence.start; i <= fence.end; i++) remove[i] = true;
    }
  }
  // フェンスの外：{ か [ で始まる行から、括弧の釣り合う行まで（釣り合わなければ文字列の終わりまで）を 1 つの範囲とする。
  // 範囲の中に欄名のキーがあれば、範囲ごと除く。範囲の外の地の文の行は除かない
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || !/^[{[]/.test(bare(lines[i] ?? ""))) continue;
    let depth = 0;
    let end = i;
    for (let k = i; k < lines.length; k++) {
      if (fenced[k]) break;
      depth += bracketDelta(k === i ? bare(lines[k] ?? "") : (lines[k] ?? ""));
      end = k;
      if (depth <= 0) break;
    }
    if (FIELD_KEY.test(lines.slice(i, end + 1).join("\n"))) {
      for (let k = i; k <= end; k++) remove[k] = true;
    }
    i = end;
  }
  // 除いた後に見出しの文字列が残る行も除く
  for (let i = 0; i < lines.length; i++) {
    if (!remove[i] && HEADING_ANYWHERE.test(lines[i] ?? "")) remove[i] = true;
  }
  return remove.some(Boolean) ? lines.filter((_, i) => !remove[i]).join("\n") : text;
}

/**
 * 投稿する文字列から、記録のブロックを取り除く（PBI-460）。読めたかどうかに関わらず、見出しの付いたブロック・記録に固有の
 * 欄名をキーに持つブロック・フェンスの外の記録の JSON・見出しの文字列が残る行を、閉じていないものと 2 つ目以降も含めて除く。
 * 除いた後に新しく現れるもの（入れ子）がなくなるまで、繰り返す。
 */
export function stripReviewRecord(text: string): string {
  let current = text;
  for (let i = 0; i < 20; i++) {
    const next = stripOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * 答えから、記録のブロックを読む。情報文字列に見出しを含む、最初の閉じたブロックだけを読む（2 つ目以降・見出しの無いものは
 * 読まない）。ブロックが無ければ undefined（記録を返さなかった）。あるのに JSON として読めなければ null。
 */
export function readReviewRecordBlock(output: string): unknown | null | undefined {
  const lines = output.split(LINE_BREAK);
  const block = findFences(lines).find((f) => HEADING_ANYWHERE.test(f.info));
  if (!block) return undefined;
  if (!block.closed) return null;
  try {
    const value: unknown = JSON.parse(block.content.join("\n"));
    // 見出しをキーにした入れ物（{"sacty-review-record": {...}}）でもよい
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      REVIEW_RECORD_HEADING in value
    ) {
      return (value as Record<string, unknown>)[REVIEW_RECORD_HEADING];
    }
    return value;
  } catch {
    return null;
  }
}

/** 形の検査。表の型だけを認め、表に無い欄は認めない（どれか 1 つでも通らなければ、全体が通らない）。 */
const text = z.string();
const StrictRecord = z.strictObject({
  mode: z.enum(["subagents", "sequential"]).optional(),
  viewpoints: z
    .array(z.strictObject({ id: text, status: ReviewViewpointStatus, reason: text.optional() }))
    .max(REVIEW_RECORD_LIST_MAX)
    .optional(),
  notReviewed: z
    .array(z.strictObject({ id: text, reason: text }))
    .max(REVIEW_RECORD_LIST_MAX)
    .optional(),
  dismissed: z
    .array(z.strictObject({ title: text, viewpoint: text.optional(), reason: text }))
    .max(REVIEW_RECORD_LIST_MAX)
    .optional(),
  dropped: z
    .strictObject({
      overlapping: z.number().int().nonnegative().optional(),
      outOfScope: z.number().int().nonnegative().optional(),
      handled: z.number().int().nonnegative().optional(),
      must: z.number().int().nonnegative().optional(),
    })
    .optional(),
  scope: z.array(text).max(REVIEW_RECORD_SHORT_LIST_MAX).optional(),
  verification: z
    .array(z.strictObject({ kind: ReviewVerificationKind, text }))
    .max(REVIEW_RECORD_SHORT_LIST_MAX)
    .optional(),
});

/**
 * 読んだ記録を、検査して、記録に残す形にする（PBI-460）。形の検査に通らなければ null（一部だけ残さない）。文字列はすべて、
 * 秘密の値を伏せてから 1 件 500 文字に切る（切る前に伏せるので、境界をまたぐ値も残らない）。伏せる処理が失敗したら null。
 */
export function checkReviewRecord(
  raw: unknown,
  redact: (text: string) => string,
): ReviewRecord | null {
  const parsed = StrictRecord.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  try {
    const cut = (s: string): string => redact(s).slice(0, REVIEW_RECORD_TEXT_MAX);
    return {
      ...(v.mode ? { mode: v.mode } : {}),
      viewpoints: (v.viewpoints ?? []).map((p) => ({
        id: cut(p.id),
        status: p.status,
        ...(p.reason !== undefined ? { reason: cut(p.reason) } : {}),
      })),
      notReviewed: (v.notReviewed ?? []).map((p) => ({ id: cut(p.id), reason: cut(p.reason) })),
      dismissed: (v.dismissed ?? []).map((p) => ({
        title: cut(p.title),
        ...(p.viewpoint !== undefined ? { viewpoint: cut(p.viewpoint) } : {}),
        reason: cut(p.reason),
      })),
      ...(v.dropped
        ? {
            dropped: {
              overlapping: v.dropped.overlapping ?? 0,
              outOfScope: v.dropped.outOfScope ?? 0,
              handled: v.dropped.handled ?? 0,
              must: v.dropped.must ?? 0,
            },
          }
        : {}),
      scope: (v.scope ?? []).map(cut),
      verification: (v.verification ?? []).map((p) => ({ kind: p.kind, text: cut(p.text) })),
    };
  } catch {
    return null;
  }
}

/**
 * 前回の記録のせいで、再レビューを絞らないか（PBI-460）。記録が無い（これより前の版の回・読めなかった回）、見られなかった所
 * （notReviewed）がある、止まった検証がある、のどれかなら絞らない。判断は構造の欄だけで決め、文の中身は読まない。
 */
export function reviewRecordBlocksNarrowing(record: ReviewRecord | null | undefined): boolean {
  if (!record) return true;
  return record.notReviewed.length > 0 || record.verification.some((v) => v.kind === "stopped");
}

/**
 * レビューの答えから作って投稿する文字列（本文・行へのコメントの各本文・リスク評価の各文）から、記録のブロックを取り除く
 * （PBI-460）。行へのコメントの本文が空になったものは捨てる。リスク評価の文が空になったときは、評価を使わない。
 */
export function withoutReviewRecord<
  T extends {
    output: string;
    comments: { body: string }[];
    risk?: {
      change: string;
      scope: string;
      reversibility: string;
      verification: string;
      focus: { where: string; why: string }[];
    };
  },
>(review: T): T {
  const result: T = {
    ...review,
    output: stripReviewRecord(review.output).trim(),
    comments: review.comments
      .map((c) => ({ ...c, body: stripReviewRecord(c.body) }))
      .filter((c) => c.body.trim() !== ""),
  };
  const risk = review.risk;
  if (risk) {
    const strings = [
      risk.change,
      risk.scope,
      risk.reversibility,
      risk.verification,
      ...risk.focus.flatMap((f) => [f.where, f.why]),
    ];
    const stripped = strings.map(stripReviewRecord);
    if (stripped.some((t) => t.trim() === "")) {
      delete result.risk;
    } else if (stripped.some((t, i) => t !== strings[i])) {
      result.risk = {
        ...risk,
        change: stripReviewRecord(risk.change),
        scope: stripReviewRecord(risk.scope),
        reversibility: stripReviewRecord(risk.reversibility),
        verification: stripReviewRecord(risk.verification),
        focus: risk.focus.map((f) => ({
          where: stripReviewRecord(f.where),
          why: stripReviewRecord(f.why),
        })),
      };
    }
  }
  return result;
}
