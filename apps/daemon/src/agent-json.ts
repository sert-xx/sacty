/**
 * エージェントの答えの中の JSON を読む（PBI-72）。エージェントには「```json」で囲んで出すよう指示しているが、AI は
 * 「```」だけで囲む・ほかの言語名で囲む・囲まずに JSON だけを出す・説明の文の中に書くことがある。囲み方に頼らず、
 * 出力の中の JSON のオブジェクトをすべて候補にし、形（スキーマ）に合うものを呼び出し側が選ぶ。
 */

/** 出力の中の JSON のオブジェクトの候補。 */
export type JsonCandidate = {
  value: Record<string, unknown>;
  /** 表示用の本文から取り除く範囲（囲みがあれば、囲みの行も含む）。 */
  start: number;
  end: number;
};

/** JSON の数（JSON.parse と同じ形）。 */
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * 「{」の位置から始まる JSON のオブジェクトを確かめ、その終わりの次の位置を返す（JSON でなければ null）。JSON.parse と
 * 同じ文法を、入れ子を再帰せずに読む。途中で開いた「{」「[」の結果（閉じた位置、または壊れている）もすべて覚え、
 * 後でその位置から確かめるときは読み直さない（PBI-72 レビュー指摘）。入れ子の値は、外側と同じ文字から同じように
 * 読むので、外側が値の途中で壊れていれば、その値も同じ所で壊れている。これで、深い入れ子の末尾が壊れている・閉じない
 * 括弧が多い出力でも、時間は出力の長さにほぼ比例する。
 */
function objectValidator(output: string): (start: number) => number | null {
  const ends = new Map<number, number | null>();
  const length = output.length;
  const skipSpace = (p: number) => {
    let i = p;
    while (i < length) {
      const c = output.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
    return i;
  };
  /** p の「"」から始まる文字列の終わりの次の位置。JSON の文字列でなければ -1。 */
  const stringEnd = (p: number) => {
    for (let i = p + 1; i < length; i++) {
      const c = output.charCodeAt(i);
      if (c === 0x22) return i + 1;
      if (c < 0x20) return -1;
      if (c === 0x5c) {
        const next = output[i + 1];
        if (next === "u") {
          if (!HEX4.test(output.slice(i + 2, i + 6))) return -1;
          i += 5;
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) {
          i++;
        } else {
          return -1;
        }
      }
    }
    return -1;
  };
  /** 文字列・数・true・false・null の終わりの次の位置。どれでもなければ -1。 */
  const scalarEnd = (p: number) => {
    const c = output[p];
    if (c === '"') return stringEnd(p);
    for (const word of ["true", "false", "null"]) {
      if (output.startsWith(word, p)) return p + word.length;
    }
    NUMBER.lastIndex = p;
    return NUMBER.test(output) ? NUMBER.lastIndex : -1;
  };
  const validate = (start: number): number | null => {
    const open: { start: number; array: boolean }[] = [];
    const fail = () => {
      for (const frame of open) ends.set(frame.start, null);
      return null;
    };
    let state: "value" | "valueOrClose" | "key" | "keyOrClose" | "colon" | "after" = "value";
    let p = start;
    for (;;) {
      p = skipSpace(p);
      const c = output[p];
      const top = open.at(-1);
      if ((state === "keyOrClose" && c === "}") || (state === "valueOrClose" && c === "]")) {
        state = "after";
      } else if (state === "value" || state === "valueOrClose") {
        if (c === "{" || c === "[") {
          const known = ends.get(p);
          if (known === null) return fail();
          if (known !== undefined && open.length > 0) {
            p = known;
            state = "after";
            continue;
          }
          open.push({ start: p, array: c === "[" });
          p++;
          state = c === "{" ? "keyOrClose" : "valueOrClose";
          continue;
        }
        const end = scalarEnd(p);
        if (end < 0) return fail();
        p = end;
        state = "after";
        continue;
      } else if (state === "key" || state === "keyOrClose") {
        const end = c === '"' ? stringEnd(p) : -1;
        if (end < 0) return fail();
        p = end;
        state = "colon";
        continue;
      } else if (state === "colon") {
        if (c !== ":") return fail();
        p++;
        state = "value";
        continue;
      } else {
        if (!top) return fail();
        if (c === ",") {
          p++;
          state = top.array ? "value" : "key";
          continue;
        }
        if (c !== (top.array ? "]" : "}")) return fail();
      }
      // 閉じる
      const frame = open.pop();
      if (!frame) return fail();
      p++;
      ends.set(frame.start, p);
      if (open.length === 0) return p;
      state = "after";
    }
  };
  return (start) => {
    const known = ends.get(start);
    return known !== undefined ? known : validate(start);
  };
}

/** 囲みの開始の行（```、```json、```JSON、```jsonc など）。 */
const FENCE_OPEN = /^[ \t]*```[\w.+-]*$/;

/**
 * 囲みの行を、出力の頭から1回で調べる。開始の行は、行の終わり（後ろの空白を除く）の位置から行の頭へ、終わりの行
 * （``` だけの行）は、``` の位置から行の終わりへ引けるようにする。それまでの囲みの行の数が奇数の行は、前のコードの
 * 囲みの終わりの行なので、開始の行にしない。
 */
function fenceLines(output: string) {
  const opens = new Map<number, number>();
  const closes = new Map<number, number>();
  let count = 0;
  for (const m of output.matchAll(/^[ \t]*```[^\n]*/gm)) {
    const line = m[0];
    const trimmed = line.trimEnd();
    if (count % 2 === 0 && FENCE_OPEN.test(trimmed)) opens.set(m.index + trimmed.length, m.index);
    if (trimmed.trim() === "```") {
      closes.set(m.index + line.length - line.trimStart().length, m.index + line.length);
    }
    count++;
  }
  return { opens, closes };
}

/** JSON が囲みの中にあれば、囲みの行も含めた範囲にする。 */
function withFence(
  output: string,
  fences: ReturnType<typeof fenceLines>,
  start: number,
  end: number,
): { start: number; end: number } {
  let before = start;
  while (before > 0 && /\s/.test(output[before - 1] ?? "")) before--;
  const lineStart = fences.opens.get(before);
  if (lineStart === undefined) return { start, end };
  let after = end;
  while (after < output.length && /\s/.test(output[after] ?? "")) after++;
  const lineEnd = fences.closes.get(after);
  if (lineEnd === undefined) return { start, end };
  return { start: lineStart, end: lineEnd };
}

/**
 * 出力の中の JSON のオブジェクトを、出てきた順にすべて返す。囲み方（```json・```・ほかの言語名・囲みなし・説明の
 * 文の中）は問わない。説明の文の中の波括弧など、JSON として読めないものは候補にしない。オブジェクトの中の
 * オブジェクトは、別の候補にしない。
 */
export function jsonCandidates(output: string): JsonCandidate[] {
  const found: JsonCandidate[] = [];
  const endOf = objectValidator(output);
  let fences: ReturnType<typeof fenceLines> | undefined;
  let i = output.indexOf("{");
  while (i !== -1) {
    const end = endOf(i);
    let value: unknown;
    if (end !== null) {
      try {
        value = JSON.parse(output.slice(i, end));
      } catch {
        value = undefined;
      }
    }
    if (end !== null && value && typeof value === "object" && !Array.isArray(value)) {
      fences ??= fenceLines(output);
      found.push({ value: value as Record<string, unknown>, ...withFence(output, fences, i, end) });
      i = output.indexOf("{", end);
    } else {
      i = output.indexOf("{", i + 1);
    }
  }
  return found;
}

/**
 * 後ろの候補から順に read で読み、読めた最初のもの（形の合う、最後に出たもの）を返す。合うものが無ければ undefined
 * （呼び出し側が、何を読み取れなかったかのわかるエラーにする）。
 */
export function lastJsonAnswer<T>(
  output: string,
  read: (value: Record<string, unknown>) => T | undefined,
): { value: T; candidate: JsonCandidate } | undefined {
  for (const candidate of jsonCandidates(output).reverse()) {
    let value: T | undefined;
    try {
      value = read(candidate.value);
    } catch {
      // 形の合わない候補。次の候補を試す
      continue;
    }
    if (value !== undefined) return { value, candidate };
  }
  return undefined;
}

/** 見出しの値がオブジェクトなら、そのオブジェクト。 */
export function headedObject(
  value: Record<string, unknown>,
  heading: string,
): Record<string, unknown> | undefined {
  const v = value[heading];
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * 候補の範囲を、表示用の本文から取り除く。範囲は重なってもよい（同じ報告を、JSON の候補と見出しの両方で見つけた
 * とき。PR #130 レビュー指摘）。
 */
export function withoutCandidates(
  output: string,
  candidates: readonly Pick<JsonCandidate, "start" | "end">[],
): string {
  const parts: string[] = [];
  let at = 0;
  for (const c of [...candidates].sort((a, b) => a.start - b.start)) {
    if (c.start > at) parts.push(output.slice(at, c.start));
    at = Math.max(at, c.end);
  }
  parts.push(output.slice(at));
  return parts.join("");
}

/** 見出しで見つけた JSON のオブジェクト（読めるかを問わない）。 */
export type HeadingSpan = {
  /** 表示用の本文から取り除く範囲（囲みがあれば、囲みの行も含む）。 */
  start: number;
  end: number;
  /** JSON として読めれば見出しの値。読めなければ undefined。 */
  value: unknown;
};

/**
 * 見出し heading を最初のキーに持つ JSON のオブジェクト（{"見出し": …}）を、JSON として読めるかを問わずに、出てきた順に
 * すべて返す（PR #130 レビュー指摘）。末尾のカンマなどで読めない報告も見つけ、本文から取り除けるようにする。
 *
 * 範囲は、見出しの直前の「{」から、文字列の中を除いて括弧が閉じるところまで。囲みの中なら、囲みの行も含める。
 * - 囲みの中：括弧が閉じなければ、囲みの終わりの行まで（囲みの中はすべて報告）
 * - 囲みの外：JSON として読めなければ、括弧の数は当てにならない（後ろの本文の「}」で閉じたように見える・文字列が途切れて
 *   本文を巻き込む）。報告が始まった行の終わりまでにし、後ろの本文は消さない（PR #130 再々レビュー指摘）。複数行の壊れた
 *   報告では、2行目からが本文に残るが、成果物の本文を消すよりよい
 */
export function headingSpans(output: string, heading: string): HeadingSpan[] {
  const found: HeadingSpan[] = [];
  const key = new RegExp(`"${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`, "g");
  let fences: ReturnType<typeof fenceLines> | undefined;
  let after = 0;
  for (const m of output.matchAll(key)) {
    if (m.index < after) continue;
    let open = m.index;
    while (open > 0 && /\s/.test(output[open - 1] ?? "")) open--;
    if (output[open - 1] !== "{") continue;
    open--;
    fences ??= fenceLines(output);
    let before = open;
    while (before > 0 && /\s/.test(output[before - 1] ?? "")) before--;
    const fenced = fences.opens.has(before);
    let close = objectClose(output, open, fenced);
    let value: unknown;
    try {
      const parsed: unknown = JSON.parse(output.slice(open, close));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        value = (parsed as Record<string, unknown>)[heading];
      }
    } catch {
      value = undefined;
      if (!fenced) {
        const lineEnd = output.indexOf("\n", open);
        close = Math.min(close, lineEnd === -1 ? output.length : lineEnd + 1);
      }
    }
    let end = close;
    while (end > open && /\s/.test(output[end - 1] ?? "")) end--;
    found.push({ ...withFence(output, fences, open, end), value });
    after = close;
  }
  return found;
}

/**
 * open の「{」が閉じる位置の次。文字列の中の括弧は数えない。JSON の文字列は改行を含めないので、文字列の中で改行に来たら、
 * 閉じない文字列としてそこで終える（PR #130 再レビュー指摘）。括弧が閉じなければ、囲みの中（fenced）なら囲みの終わりの行
 * （行の頭が ```）の頭、囲みの外なら最初の空行か ``` の行の頭（どれも無ければ出力の終わり）。空行で区切るのは閉じない
 * 報告だけで、閉じる報告（空行を含む正しい JSON も）は途中で切らない（PR #130 再レビュー指摘）。空行は CRLF の行も含む。
 */
function objectClose(output: string, open: number, fenced: boolean): number {
  let depth = 0;
  let inString = false;
  let firstBlank: number | undefined;
  for (let i = open; i < output.length; i++) {
    const c = output[i];
    if (c === "\n") {
      inString = false;
      const next = output.slice(i + 1, i + 8);
      if (/^[ \t\r]*```/.test(next)) return fenced ? i + 1 : Math.min(firstBlank ?? i + 1, i + 1);
      if (firstBlank === undefined && /^[ \t\r]*\n/.test(next)) firstBlank = i + 1;
      continue;
    }
    if (inString) {
      if (c === "\\" && output[i + 1] !== "\n" && output[i + 1] !== "\r") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return fenced ? output.length : (firstBlank ?? output.length);
}
