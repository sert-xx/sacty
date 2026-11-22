/**
 * 実装の工程の、完了の申告（PBI-347）。実装の実行が終わると、sacty は作業領域の内容をそのまま提出する（PR を作る・更新する）。
 * 範囲の一部だけを実装して終わった実行を提出にしないために、実装し終えたかを申告させて、sacty が読む。
 *
 * - 申告は、言語の名前が sacty-completion のコードブロックの中にだけ書かせる。sacty は、このコードブロックだけを申告として読む
 *   （どこからどこまでが申告かを、フェンスで区切る。本文のほかの所にある JSON や文は、申告として扱わない）。
 * - 完了（complete）と申告した実行だけを、提出に進める。申告のコードブロックのすべてを、決まった形どおりに読めたときだけ、完了にする。
 * - 未完了（incomplete）と申告した・申告が無い・読めない実行は、提出に進めず、残っていることを渡して実装をやり直す。
 */
import {
  COMPLETION_REMAINING_ITEM_MAX,
  COMPLETION_REMAINING_MAX,
  type ImplementationCompletion,
} from "@sacty/core";
import { cut, hasDuplicateKeys, takeFences } from "./agent-json.js";

/** 完了の申告のコードブロックの、言語の名前。 */
export const COMPLETION_FENCE = "sacty-completion";

/** 申告のコードブロック（指示の例。申告を足すスタブ・テストも使う）。 */
export function completionBlock(completion: ImplementationCompletion): string {
  return [`\`\`\`${COMPLETION_FENCE}`, JSON.stringify(completion), "```"].join("\n");
}

/**
 * 実装・修正の工程の、完了の申告の指示（PBI-347）。実行の終わりが提出になることと、申告の場所と形を伝える。未完了で終えて
 * よいのは進められないときだけで、途中で実行を終えても、sacty が同じセッションを再開するだけであることも伝える（PBI-350）。
 */
export function implementCompletionLines(): string[] {
  return [
    "",
    "--- 完了の申告 ---",
    "- この実行が終わると、sacty は作業領域の内容をそのまま提出する（PR を作る・更新する）。範囲（この指示が求める、実装すること・観点・指摘への対応のすべて）を実装し終えてから、実行を終える",
    `- 範囲を実装し終えたかを、必ず申告する。申告は、言語の名前を ${COMPLETION_FENCE} にしたコードブロックの中にだけ、下の形の JSON で書く。出力の最後に、1つだけ書く`,
    `- sacty はこのコードブロックだけを申告として読み、本文からは取り除く。このコードブロックの外に書いたものは申告として扱わない。説明の中で書き方を例に挙げるときは、言語の名前を ${COMPLETION_FENCE} にしない`,
    `- 範囲のすべてを実装し終えたら complete にする（変更が要らないと確かめたときも complete）。残っていることが1つでもあれば incomplete にし、remaining に、残っていることを1件ずつ書く（${COMPLETION_REMAINING_MAX} 件まで）`,
    "- 申告を含む報告を書いた後に、背景の処理の通知などで作業を続けて、変更や結果が変わったら、報告と申告を、最後の出力で出し直す（sacty は、申告を含む最後の出力を答えとして読む。出し直さないと、前の報告と申告で提出される）",
    // 途中で実行を終えても得が無いことを伝える（未完了と申告して数分で実行を終える実行が続いた。PBI-350）
    "- この実行の中で、範囲のすべてを実装し終える。区切りのよい所で実行を終えて、続きを次の実行に回さない（incomplete で終えると、sacty は提出せずに、同じセッションを再開して続けさせるだけで、途中で終えても進まない）",
    "- ベースブランチや PR の取り込みで入った変更は、今回の変更ではなく、提出に含まれてよい。競合は両方の振る舞いを保って合わせ、それ以外に手を入れない",
    "- incomplete で終えてよいのは、これ以上進められないとき（人の判断や、外部の状態の変化が要るとき）だけ。remaining に、残っていることと、進められない理由を書く。実装し終えていないのに complete と申告しない",
    "- remaining に書くのは、この工程で実装・確認することだけ。あなたには確かめられないこと（CI の結果・実機での動作など）は、remaining ではなく、人が確かめることとして実装の説明に書く",
    "- 承認された要求要件・設計で人がする、またはこの工程の外ですると決まった作業は、remaining に数えない。作業履歴に人がすることとして書いて提出する",
    "- 人の判断が必要で未完了と申告するときは、remaining に何を決めてほしいかを1つの問いで書く。工程が自分で決められる候補があれば推奨を添える（止まった画面で読めるようにする）",
    "- 申告が無い実行は、未完了として扱い、提出しない。申告を下の形どおりに読めない実行も同じ（JSON として読めない・status と remaining のほかのキーがある・同じキーが重複している・コードブロックが閉じていない・申告のコードブロックが複数あって食い違う、など）",
    "範囲のすべてを実装し終えたとき：",
    completionBlock({ status: "complete" }),
    "残っていることがあるとき：",
    completionBlock({
      status: "incomplete",
      remaining: ["残っていること（何を・どこに。1件ずつ）"],
    }),
  ];
}

/**
 * 残っていることの一覧を読む。空の項目は除き、件数と1件の長さの上限で切る（文字の途中では切らない）。一覧として読めない形
 * （配列でない・文でない項目がある）なら undefined（残っていることがあるかを、決められない）。
 */
function readRemaining(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return (value as string[])
    .map((item) => cut(item.trim(), COMPLETION_REMAINING_ITEM_MAX))
    .filter((item) => item.length > 0)
    .slice(0, COMPLETION_REMAINING_MAX);
}

/**
 * 申告のコードブロックの中身を、決まった形どおりに読む。形は、キーが status（complete か incomplete）と remaining（文の一覧。
 * 省いてよい）だけの JSON のオブジェクト。次のときは undefined（読めない申告。どちらを意図したかを、推し量って決めない）。
 * - JSON として読めない・オブジェクトでない
 * - status と remaining のほかのキーがある
 * - 同じキーが重複している（JSON は後の値で上書きして読まれるので、前の値が消える）。重複を調べられないほど入れ子が深いものも同じ
 * - status が complete でも incomplete でもない
 * - remaining が、文の一覧でない（文字列・文でない項目など）
 * status が complete でも、remaining に残っていることがあれば未完了にする（食い違う申告は、提出に進めない側に倒す）。
 */
function readDeclaration(body: string): ImplementationCompletion | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
    if (hasDuplicateKeys(body)) return undefined;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const declared = value as Record<string, unknown>;
  if (Object.keys(declared).some((key) => key !== "status" && key !== "remaining")) {
    return undefined;
  }
  // remaining を書いていなければ、残っていることは無い
  const remaining = declared.remaining === undefined ? [] : readRemaining(declared.remaining);
  if (remaining === undefined) return undefined;
  if (declared.status === "incomplete") return { status: "incomplete", remaining };
  if (declared.status !== "complete") return undefined;
  return remaining.length > 0 ? { status: "incomplete", remaining } : { status: "complete" };
}

/**
 * 実装の工程の出力から、完了の申告（言語の名前が sacty-completion のコードブロック）を読み、本文から取り除く。申告のコード
 * ブロックは、読めても読めなくても、本文から取り除く。completion が無ければ、申告なし（未完了として扱い、提出しない）。
 * - 申告のコードブロックが無ければ、申告なし。
 * - 読めないコードブロック（readDeclaration。閉じていないものも）が1つでもあれば、申告なし。
 * - すべて読めて、最後の申告が未完了なら、未完了（残っていることは、最後の申告のもの）。
 * - すべて読めて、すべてが完了のときだけ、完了。最後の申告が完了でも、ほかに未完了の申告があれば、申告なし（どちらを意図
 *   したかを決められない）。
 */
export function extractCompletion(output: string): {
  output: string;
  completion?: ImplementationCompletion;
} {
  const taken = takeFences(output, COMPLETION_FENCE);
  const declarations = taken.fences.map((fence) =>
    fence.closed ? readDeclaration(fence.body) : undefined,
  );
  const last = declarations.at(-1);
  if (last === undefined || declarations.includes(undefined)) return { output: taken.output };
  if (last.status === "incomplete") return { output: taken.output, completion: last };
  return declarations.every((d) => d?.status === "complete")
    ? { output: taken.output, completion: last }
    : { output: taken.output };
}
