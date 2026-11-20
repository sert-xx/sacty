import type { DaemonText } from "@sacty/core";
import { headedObject, lastJsonAnswer } from "./agent-json.js";

/*
 * AI のレビューの提案を、直しに入る前に、PR の範囲で 1 件ずつ選り分ける（PBI-436）ための、提案の単位の分け方と、選り分けの答えの
 * 読み方。レビューの指示・実行・記録は service.ts と prompts.ts が行う。
 */

/** 選り分けの答えの見出し（JSON のキー）。 */
export const TRIAGE_HEADING = "sacty-triage";

const MUST = "要修正";

/** 提案の 1 件。kind が must のものは、選り分けの対象にしない（必ず直す）。 */
export type SuggestionUnit = {
  /** 選り分けの指示と答えで使う ID（`S1` から、取り込んだ指摘をまたいで続ける）。 */
  id: string;
  /** 取り込んだ指摘の並びでの位置（0 始まり）。 */
  remark: number;
  text: string;
  kind: "suggestion" | "must";
};

/** 投稿の先頭の目印・本文の中の HTML のコメントを除く（指摘の頭を探す前に）。 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** 指摘の頭の行：行頭（箇条書き・見出し・太字の飾りを許す）の `[提案]`・`[要修正]`。 */
const UNIT_START = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:#{1,6}\s+)?(?:\*\*)?\s*\[(提案|要修正)\]/;

/** 行へのコメントの指摘の文：`<パス>:<行>：` の後（目印の後の改行を挟んでよい）に、頭が続く。 */
const INLINE = /^[^\s：]+(?::\d+)?：[ \t]*\n?[ \t]*(?:\*\*)?\[(提案|要修正)\]/;

/**
 * 提案を読む節の見出し：「指摘」だけ（許可リスト）。ほかの節（総評・前回の指摘・レビューの範囲など、見出しの名前を問わない）の
 * 文中の頭は、1 件として数えない。レビューの指示が、指摘の節の見出しを「指摘」と決めている。
 */
const FINDINGS_HEADING = /^\s*指摘\s*$/;

/**
 * 1 件の指摘（取り込んだ指摘の 1 件）の中の、提案・要修正の単位を求める。
 * - 行へのコメント：頭が付いていれば、指摘の全体が 1 件（頭が付いていなければ、単位なし）。
 * - レビューの本文：見出しが「指摘」の節（許可リスト）の、行頭の頭（`**[提案] 題**（場所）` など）ごとに 1 件。次の頭・見出し・区切りの線までが 1 件。
 *   総評・「前回の指摘」の節の文中に出る頭は数えない。
 */
export function suggestionUnitsOf(text: string): { kind: "suggestion" | "must"; text: string }[] {
  const plain = text.replace(HTML_COMMENT, "").trim();
  const inline = plain.match(INLINE);
  if (inline) return [{ kind: inline[1] === MUST ? "must" : "suggestion", text: plain }];
  const units: { kind: "suggestion" | "must"; lines: string[] }[] = [];
  let current: (typeof units)[number] | undefined;
  let reading = false;
  for (const line of plain.split("\n")) {
    const start = line.match(UNIT_START);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (!start && heading) {
      reading = FINDINGS_HEADING.test((heading[1] ?? "").replace(/\*+/g, ""));
      current = undefined;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      current = undefined;
      continue;
    }
    if (!reading) continue;
    if (start) {
      current = { kind: start[1] === MUST ? "must" : "suggestion", lines: [line] };
      units.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return units.map((u) => ({ kind: u.kind, text: u.lines.join("\n").trim() }));
}

/** 取り込んだ AI のレビューの指摘（aiReview の位置）から、提案・要修正の単位を、ID を付けて並べる。 */
export function splitSuggestions(
  remarks: readonly string[],
  aiReview: readonly number[],
): SuggestionUnit[] {
  const ai = new Set(aiReview);
  let n = 0;
  return remarks.flatMap((text, remark) =>
    ai.has(remark)
      ? suggestionUnitsOf(text).map((u) => ({
          id: `S${++n}`,
          remark,
          text: u.text,
          kind: u.kind,
        }))
      : [],
  );
}

/** 選り分けの答えの 1 件。 */
export type TriageDecision = {
  id: string;
  decision: "address" | "decline";
  reason: string;
  /** 同じ指摘（本文と行へのコメントの両方に出たもの）の、もう一方の ID。 */
  sameAs?: string;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * 選り分けの答えを読む。読めなければ undefined（呼び出し側が、すべて対応する側にする）。ID が知らないもの・重複・判断が
 * address か decline でないものは読み捨てる（その提案は判断が無いものとして、対応する側にする）。
 */
export function extractTriage(
  output: string,
  units: readonly Pick<SuggestionUnit, "id">[],
): TriageDecision[] | undefined {
  const known = new Set(units.map((u) => u.id));
  const found = lastJsonAnswer(output, (value) => {
    const v = headedObject(value, TRIAGE_HEADING);
    if (!v || !Array.isArray(v.items)) return undefined;
    const seen = new Set<string>();
    const list: TriageDecision[] = [];
    for (const raw of v.items as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const id = str(r.id);
      const decision = str(r.decision);
      if (!known.has(id) || seen.has(id)) continue;
      if (decision !== "address" && decision !== "decline") continue;
      seen.add(id);
      const sameAs = str(r.sameAs);
      list.push({
        id,
        decision,
        reason: str(r.reason),
        ...(sameAs && known.has(sameAs) && sameAs !== id ? { sameAs } : {}),
      });
    }
    return list;
  });
  return found?.value;
}

/** 選り分けの結果の 1 件（判断を補った後）。 */
export type TriagedItem = {
  id: string;
  remark: number;
  text: string;
  decision: "address" | "decline";
  reason: DaemonText;
  defaulted?: true;
};

/**
 * 答えを、提案ごとの判断にそろえる。
 * - 判断の無い提案は、対応する側（defaulted）。理由が空の decline も、理由を示せないので対応する側にする。
 * - 同じ指摘（sameAs）の判断が食い違ったら、対応する側にそろえる。
 */
export function settleTriage(
  suggestions: readonly SuggestionUnit[],
  answer: readonly TriageDecision[] | undefined,
  defaultReason: DaemonText,
): TriagedItem[] {
  const by = new Map((answer ?? []).map((d) => [d.id, d]));
  const items: TriagedItem[] = suggestions.map((u) => {
    const d = by.get(u.id);
    if (!d || (d.decision === "decline" && d.reason === "")) {
      return {
        id: u.id,
        remark: u.remark,
        text: u.text,
        decision: "address",
        reason: defaultReason,
        defaulted: true,
      };
    }
    return { id: u.id, remark: u.remark, text: u.text, decision: d.decision, reason: d.reason };
  });
  const index = new Map(items.map((i) => [i.id, i]));
  for (const d of answer ?? []) {
    const other = d.sameAs ? index.get(d.sameAs) : undefined;
    const self = index.get(d.id);
    if (!other || !self || other.decision === self.decision) continue;
    for (const item of [self, other]) {
      if (item.decision === "decline") {
        item.decision = "address";
        item.reason = defaultReason;
        item.defaulted = true;
      }
    }
  }
  return items;
}

type Verdict = "changes_required" | "suggestions" | "no_findings";

/** 提案だけの回が、今回（round）を含めて何回続いているか（今回の回から数える）。 */
export function countSuggestionRounds(
  round: number,
  verdictOf: (round: number) => Verdict | undefined,
): number {
  let n = 0;
  while (n < round && verdictOf(round - n) === "suggestions") n++;
  return n;
}

/**
 * 提案のすべてを対応しないとした指摘の位置（差し戻しから外す指摘）。要修正がなく、その指摘の提案のすべてが対応しないもの。
 * 本文は、判定が提案ありの回のものだけ外す（要修正を、書式の読み違いで落とさない。行へのコメントは、指摘ごとに頭が付いている）。
 * 提案の単位が 0 件の本文（総評だけで、提案は行へのコメントにある形）は、判定が提案ありの回のもので、同じ回の提案がすべて
 * 対応しないときに外す（残すと、直し・push・再レビューが起きる）。
 */
export function droppedRemarks(input: {
  remarks: readonly string[];
  units: readonly SuggestionUnit[];
  items: readonly Pick<TriagedItem, "remark" | "decision">[];
  aiReviewFrom: Readonly<Record<string, string>> | undefined;
  verdictOf: (round: number) => Verdict | undefined;
}): number[] {
  const { remarks, units, items, aiReviewFrom, verdictOf } = input;
  const noMust = units.every((u) => u.kind === "suggestion");
  const allDeclined = items.every((i) => i.decision === "decline");
  return remarks.flatMap((text, index) => {
    const mine = units.filter((u) => u.remark === index);
    const inline = mine.length === 1 && mine[0]?.text === text.replace(HTML_COMMENT, "").trim();
    const from = aiReviewFrom?.[String(index)];
    const fromRound = from ? Number(from.match(/:(\d+)$/)?.[1] ?? 1) : undefined;
    const suggestionsRound = fromRound !== undefined && verdictOf(fromRound) === "suggestions";
    if (mine.length === 0) {
      return suggestionsRound && noMust && allDeclined ? [index] : [];
    }
    return (inline || suggestionsRound) &&
      mine.every((u) => u.kind === "suggestion") &&
      items.filter((i) => i.remark === index).every((i) => i.decision === "decline")
      ? [index]
      : [];
  });
}
