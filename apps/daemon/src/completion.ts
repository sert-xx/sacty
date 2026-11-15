/**
 * 実装の工程の、完了の申告（PBI-347）。実装の実行が終わると、sacty は作業領域の内容をそのまま提出する（PR を作る・更新する）。
 * 範囲の一部だけを実装して終わった実行を提出にしないために、実装し終えたかを申告させて（見出し sacty-completion）、sacty が読む。
 *
 * - 完了（complete）と申告した実行だけを、提出に進める。
 * - 未完了（incomplete）と申告した・申告が無い・読めない実行は、提出に進めず、残っていることを渡して実装をやり直す。
 */
import {
  COMPLETION_REMAINING_ITEM_MAX,
  COMPLETION_REMAINING_MAX,
  type ImplementationCompletion,
} from "@sacty/core";
import { type HeadingSpan, headingMentions, headingSpans, jsonCandidates } from "./agent-json.js";

/** 完了の申告の見出し。 */
export const COMPLETION_HEADING = "sacty-completion";

/** 申告の形の例（指示に載せる）。 */
function exampleLines(): string[] {
  return [
    "```json",
    JSON.stringify({ [COMPLETION_HEADING]: { status: "complete" } }),
    "```",
    "```json",
    JSON.stringify({
      [COMPLETION_HEADING]: {
        status: "incomplete",
        remaining: ["残っていること（何を・どこに。1件ずつ）"],
      },
    }),
    "```",
  ];
}

/**
 * 実装・修正の工程の、完了の申告の指示（PBI-347）。実行の終わりが提出になることと、申告の形を伝える。
 */
export function implementCompletionLines(): string[] {
  return [
    "",
    "--- 完了の申告 ---",
    "- この実行が終わると、sacty は作業領域の内容をそのまま提出する（PR を作る・更新する）。範囲（この指示が求める、実装すること・観点・指摘への対応のすべて）を実装し終えてから、実行を終える",
    "- 範囲を実装し終えたかを、次の形式で必ず申告する（sacty が読み、本文からは取り除く）。申告が無い実行は、未完了として扱い、提出しない",
    `- 範囲のすべてを実装し終えたら complete にする（変更が要らないと確かめたときも complete）。残っていることが1つでもあれば incomplete にし、remaining に、残っていることを1件ずつ書く（${COMPLETION_REMAINING_MAX} 件まで）`,
    "- incomplete の実行は提出されず、sacty が remaining を渡して実装をやり直させる。実装し終えていないのに complete と申告しない",
    ...exampleLines(),
  ];
}

/** 残っていることの一覧を読む。文でない項目・空の項目は除き、件数と長さの上限で切る。 */
function readRemaining(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, COMPLETION_REMAINING_ITEM_MAX))
    .filter((item) => item.length > 0)
    .slice(0, COMPLETION_REMAINING_MAX);
}

/**
 * 実装の工程の出力から、完了の申告（見出し sacty-completion の最後のもの）を読む。読んだ JSON の範囲（本文から取り除く）も返す。
 * 申告が無い・形が合わなければ completion は無い。最後の申告が JSON として読めないときも、前の申告には戻らず、申告なしにする
 * （前の申告は、作業の途中のものでありうるため）。
 * - status が incomplete なら、remaining が無い・読めなくても未完了にする（未完了の申告を、形の崩れで落とさない）。
 * - status が complete でも、remaining に残っていることがあれば未完了にする（食い違う申告は、提出に進めない側に倒す）。
 */
export function extractCompletion(output: string): {
  completion?: ImplementationCompletion;
  spans: HeadingSpan[];
} {
  // 見出しを先頭のキーに持つもの（読めないものも）、先頭以外のキーに持つ読めるもの、それ以外の読めない申告の順に集める
  const headed = headingSpans(output, COMPLETION_HEADING);
  const inner = jsonCandidates(output)
    .filter(
      (c) =>
        c.value[COMPLETION_HEADING] !== undefined &&
        !headed.some((h) => h.start <= c.start && c.end <= h.end),
    )
    .map((c): HeadingSpan => ({ start: c.start, end: c.end, value: c.value[COMPLETION_HEADING] }));
  const read = [...headed, ...inner];
  const spans = [...read, ...headingMentions(output, COMPLETION_HEADING, read)];
  // 最後の申告は、取り除く範囲ではなく、申告が出てきた位置で選ぶ
  const position = (r: HeadingSpan) => r.at ?? r.start;
  const last = spans.reduce<HeadingSpan | undefined>(
    (latest, r) => (latest === undefined || position(r) >= position(latest) ? r : latest),
    undefined,
  )?.value;
  if (!last || typeof last !== "object" || Array.isArray(last)) return { spans };
  const declared = last as Record<string, unknown>;
  const remaining = readRemaining(declared.remaining);
  if (
    declared.status === "incomplete" ||
    (declared.status === "complete" && remaining.length > 0)
  ) {
    return { completion: { status: "incomplete", remaining }, spans };
  }
  if (declared.status === "complete") return { completion: { status: "complete" }, spans };
  return { spans };
}
