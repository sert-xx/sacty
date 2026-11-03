/**
 * コードブロックのフェンス（CommonMark の規則）。元の行で読む：字下げは0〜3空白まで（4空白以上はコードの中の字下げで、
 * フェンスではない）。開始は ``` か ~~~ を3つ以上（``` の行の後ろに ` は置けない）。終了は開始と同じ文字だけで
 * 開始以上の長さ、後ろは空白だけ（4文字で開いたコードの中の3文字は、終わりではない）。
 */
export type CodeFence = { char: string; size: number };

export function openingFence(line: string): CodeFence | undefined {
  const opened = line.match(/^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/);
  return opened?.[1] ? { char: opened[1].charAt(0), size: opened[1].length } : undefined;
}

export function closesFence(line: string, fence: CodeFence): boolean {
  const closed = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
  const marks = closed?.[1] ?? "";
  return marks.length >= fence.size && marks.charAt(0) === fence.char;
}

const trimBlankLines = (value: string) => value.replace(/^(?:[ \t]*\n)+/, "").trimEnd();

/**
 * 直しの実行（前の実装の説明がある）で、実装のエージェントが説明の中に分けて書く節の見出し（PBI-299）。説明の残りは PR 全体の説明にし、
 * この節には、今回の直しで何を指摘され何を変えたかだけを書かせる。sacty は PR の本文で、全体の説明と分けて載せる。
 */
export const LAST_FIX_HEADING = "最後の直し";

/**
 * 実装の説明から、「## 最後の直し」の節（見出しの行は含めない。次の同じかより上の階層の見出しまで）を分ける。コードブロックの中の
 * 行は見出しとして読まない。節が無ければ fix は undefined で、whole は text のまま。節だけが空のときは fix が空文字。
 */
export function splitLastFix(text: string): { whole: string; fix?: string } {
  const rest: string[] = [];
  const body: string[] = [];
  let state: "before" | "in" | "after" = "before";
  let level = 0;
  let fence: CodeFence | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const target = state === "in" ? body : rest;
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      target.push(line);
      continue;
    }
    const opened = openingFence(line);
    if (opened) {
      fence = opened;
      target.push(line);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading?.[1]) {
      if (state === "in" && heading[1].length <= level) state = "after";
      else if (state === "before" && (heading[2] ?? "").startsWith(LAST_FIX_HEADING)) {
        state = "in";
        level = heading[1].length;
        continue;
      }
    }
    (state === "in" ? body : rest).push(line);
  }
  if (state === "before") return { whole: text };
  return { whole: trimBlankLines(rest.join("\n")), fix: body.join("\n").trim() };
}

/**
 * 実装の提出までの、PR 全体の説明の土台（PBI-299）を進める。base は、前の提出までの土台（最初の提出の前は undefined）、
 * previous は、土台に数える提出の出力。最初の提出は、その説明を土台にする（「最後の直し」の節があれば、節を除く）。
 * 以後は、「最後の直し」の節のある提出（全体の説明を書き直した提出）の、節以外の部分を土台にする。節の無い提出（直しだけを書いた）
 * は土台を変えない。履歴の上限を超えても土台が消えないよう、`Task.implementBase` に持つ。
 */
export function advanceImplementBase(base: string | undefined, previous: string): string {
  const split = splitLastFix(previous);
  if (base === undefined) return split.whole;
  return split.fix !== undefined && split.whole.trim() !== "" ? split.whole : base;
}
