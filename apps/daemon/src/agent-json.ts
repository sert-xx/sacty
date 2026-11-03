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
  /**
   * 報告が出てきた位置（どれが最後の報告かを決めるのに使う）。取り除く範囲が囲みの全体のとき、範囲の始まりとは違う。
   * 無ければ start。
   */
  at?: number;
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
 * 見出し heading のキー（"見出し":）のうち、covered の範囲（読めた JSON・headingSpans で見つけたもの）の外にあるものを、
 * 読めない報告として返す（value は undefined）。先頭以外のキーにある壊れた報告（末尾のカンマなど）は headingSpans では
 * 見つからないので、これで見つけ、最後の答えが読めないことに気づけるようにする。取り除く範囲は、囲みの中なら囲みの全体、
 * 囲みの外ならキーのある行（後ろの本文は消さない）。同じ囲みの中の複数のキーは1つにまとめる。
 */
export function headingMentions(
  output: string,
  heading: string,
  covered: readonly { start: number; end: number }[],
): HeadingSpan[] {
  const key = new RegExp(`"${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`, "g");
  // 囲み（``` の行から、閉じる ``` の行まで。閉じなければ出力の終わりまで）
  const blocks: { start: number; end: number }[] = [];
  let open: number | undefined;
  for (const m of output.matchAll(/^[ \t]*```[^\n]*(?:\n|$)/gm)) {
    if (open === undefined) open = m.index;
    else {
      blocks.push({ start: open, end: m.index + m[0].length });
      open = undefined;
    }
  }
  if (open !== undefined) blocks.push({ start: open, end: output.length });
  const found: HeadingSpan[] = [];
  for (const m of output.matchAll(key)) {
    const at = m.index;
    if (covered.some((c) => c.start <= at && at < c.end)) continue;
    // 同じ囲みの中の2つ目からは、出てきた位置だけを後ろに進める
    const same = found.find((f) => f.start <= at && at < f.end);
    if (same) {
      same.at = at;
      continue;
    }
    const block = blocks.find((b) => b.start <= at && at < b.end);
    if (block) {
      found.push({ ...block, value: undefined, at });
      continue;
    }
    const lineStart = output.lastIndexOf("\n", at - 1) + 1;
    const lineEnd = output.indexOf("\n", at);
    found.push({
      start: lineStart,
      end: lineEnd === -1 ? output.length : lineEnd + 1,
      value: undefined,
      at,
    });
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

/* ---- 崩れた JSON の寛容な読み取り（PBI-293） ---- */

/** 寛容な読み取りが JSON として読めなかった位置（出力の先頭からの文字数。走査量の上限で止めたときは、止めた位置）。 */
class LenientError extends Error {
  constructor(readonly at: number) {
    super(`unreadable at ${at}`);
  }
}

/** 直して読んだ箇所の種類。 */
export type RepairKind =
  /** 文字列の中の、エスケープしていない二重引用符。 */
  | "quote"
  /** 文字列の中の、エスケープしていない改行・タブなどの制御文字。 */
  | "control"
  /** 文字列の中の、JSON にない「\」のエスケープ。 */
  | "escape"
  /** 閉じる括弧の前の余分なカンマ。 */
  | "comma"
  /** 入れ子のオブジェクトの閉じ括弧「}」の欠け（PBI-298）。 */
  | "brace";

/** 直しながら読んだ箇所（at は、出力の先頭からの文字数）。brace は、「}」を補った次のキーも持つ。 */
type Repair = { kind: RepairKind; at: number; key?: string };

/**
 * 見出しのオブジェクトの形（PBI-298）。入れ子のオブジェクトの中に、見出しのオブジェクトのキーが現れたら、入れ子のオブジェクトの
 * 閉じ括弧「}」が欠けているとみなして補う。AI は、入れ子のオブジェクト（最終レビューの tests）を閉じ忘れることがある。
 * 括弧の数だけでは、どこで閉じるかが決まらない（humanChecks が tests の中に入って読めてしまう）ので、キーで決める。
 */
export type LenientShape = {
  /** 見出し。見出しのオブジェクトは、{"見出し": {…}} の値。 */
  heading: string;
  /** 見出しのオブジェクトのキー。 */
  keys: readonly string[];
  /** 見出しのオブジェクトのキーのうち、値がオブジェクトのもの → そのオブジェクトのキー。 */
  objects: Readonly<Record<string, readonly string[]>>;
};

/**
 * 寛容な読み取りの走査量の上限（文字・値の数）。閉じない文字列と見出しが繰り返される出力では、候補ごとに末尾まで読むので、
 * 上限が無いと出力の長さの2乗の時間がかかり、同期処理のデーモンが止まる。1回の呼び出しの全候補で共有し、出力の長さに比例させる。
 */
function lenientBudget(output: string): { left: number } {
  return { left: 4 * output.length + 100_000 };
}

/** 入れ子の深さの上限（再帰を使うので、深すぎる出力は読めないものとして止める）。 */
const LENIENT_MAX_DEPTH = 64;

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** 文字列を閉じる「"」の次に来てよいもの（文字列がオブジェクトのキー・値、配列の要素のどれか）。 */
const AFTER_KEY = /\s*:/y;
const AFTER_OBJECT_VALUE = /\s*(?:\}|,\s*\}|,\s*"[^"\\\r\n]{1,100}"\s*:)/y;
const AFTER_ARRAY_ITEM = /\s*(?:\]|,\s*\]|,\s*(?:["{[]|-?\d|true\b|false\b|null\b))/y;
const LENIENT_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * 「{」から始まる JSON のオブジェクトを、AI がよく崩す所を直しながら読む。直すのは次の3つだけ。
 * - 文字列の中の、エスケープしていない二重引用符（`"1,200"` など）。引用符の次に来る文字が、その場所に来る区切り
 *   （キーなら「:」、オブジェクトの値なら「}」か次のキー、配列の要素なら「]」か「,」と次の値）でなければ、文字列の
 *   一部とみなす
 * - 文字列の中の、エスケープしていない改行・タブなどの制御文字
 * - 文字列の中の、JSON にない「\」のエスケープ（`\d` など。「\」を文字として残す）と、閉じる括弧の前の余分なカンマ
 * これで読めなければ LenientError（読めなかった位置）を投げる。
 */
function parseLenient(
  output: string,
  open: number,
  budget: { left: number } = lenientBudget(output),
  shape?: LenientShape,
): { value: Record<string, unknown>; end: number; repairs: Repair[] } {
  let p = open;
  const repairs: Repair[] = [];
  /** 入れ子のオブジェクトの「}」を補って閉じた直後（次に読むキーは、囲んでいるオブジェクトのキー）。 */
  let resumed = false;
  /** 「}」を補ったか。補ったあとの見出しのオブジェクトに、入れ子のオブジェクトのキーが現れたら、直し方が決まらない。 */
  let braced = false;
  const length = output.length;
  const skipSpace = () => {
    while (p < length) {
      const c = output.charCodeAt(p);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      p++;
    }
  };
  const follows = (re: RegExp, at: number) => {
    re.lastIndex = at;
    return re.test(output) || at >= length;
  };
  const string = (after: RegExp): string => {
    const start = p;
    let result = "";
    let i = p + 1;
    for (; i < length; i++) {
      if (--budget.left < 0) throw new LenientError(start);
      const c = output[i] as string;
      if (c === '"') {
        if (follows(after, i + 1)) {
          p = i + 1;
          return result;
        }
        repairs.push({ kind: "quote", at: i });
        result += c;
      } else if (c === "\\") {
        const next = output[i + 1];
        if (next === "u" && HEX4.test(output.slice(i + 2, i + 6))) {
          result += String.fromCharCode(Number.parseInt(output.slice(i + 2, i + 6), 16));
          i += 5;
        } else if (next !== undefined && next in ESCAPES) {
          result += ESCAPES[next];
          i++;
        } else {
          repairs.push({ kind: "escape", at: i });
          result += c;
        }
      } else {
        if (c < " ") repairs.push({ kind: "control", at: i });
        result += c;
      }
    }
    throw new LenientError(start);
  };
  const value = (
    depth: number,
    after: RegExp,
    path: readonly string[],
    holder?: Record<string, unknown>,
  ): unknown => {
    if (--budget.left < 0) throw new LenientError(p);
    skipSpace();
    const c = output[p];
    if (c === "{" || c === "[") {
      if (depth >= LENIENT_MAX_DEPTH) throw new LenientError(p);
      return c === "{" ? object(depth + 1, path, holder) : array(depth + 1, path);
    }
    if (c === '"') return string(after);
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (output.startsWith(word, p)) {
        p += word.length;
        return v;
      }
    }
    LENIENT_NUMBER.lastIndex = p;
    if (!LENIENT_NUMBER.test(output)) throw new LenientError(p);
    const n = Number(output.slice(p, LENIENT_NUMBER.lastIndex));
    p = LENIENT_NUMBER.lastIndex;
    return n;
  };
  /**
   * 入れ子のオブジェクトの中に、見出しのオブジェクトのキーが現れたか。現れたら、入れ子のオブジェクトの「}」が欠けている。
   * 見出しのオブジェクトが同じキーを既に持つ・見出しのオブジェクトの外のキーなど、直し方が決まらないときは読まない。
   */
  const closesBefore = (path: readonly string[], key: string, at: number, holder?: object) => {
    if (!shape || path.length !== 2 || path[0] !== shape.heading) return false;
    const own = shape.objects[path[1] as string];
    if (!own || own.includes(key) || !shape.keys.includes(key)) return false;
    if (!holder || Object.hasOwn(holder, key)) throw new LenientError(at);
    return true;
  };
  const object = (
    depth: number,
    path: readonly string[],
    holder?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    p++;
    skipSpace();
    if (output[p] === "}") {
      p++;
      return result;
    }
    for (;;) {
      skipSpace();
      if (output[p] !== '"') throw new LenientError(p);
      const keyAt = p;
      const key = string(AFTER_KEY);
      if (closesBefore(path, key, keyAt, holder)) {
        repairs.push({ kind: "brace", at: keyAt, key });
        braced = true;
        resumed = true;
        p = keyAt;
        return result;
      }
      // 「}」を補ったあとの見出しのオブジェクトに、入れ子のオブジェクトのキーが現れたら、どこで閉じるか決まらない
      if (
        braced &&
        shape &&
        path.length === 1 &&
        path[0] === shape.heading &&
        !shape.keys.includes(key) &&
        Object.values(shape.objects).some((own) => own.includes(key))
      ) {
        throw new LenientError(keyAt);
      }
      skipSpace();
      if (output[p] !== ":") throw new LenientError(p);
      p++;
      Object.defineProperty(result, key, {
        value: value(depth, AFTER_OBJECT_VALUE, [...path, key], result),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (resumed) {
        // 入れ子のオブジェクトを補って閉じた。次は、このオブジェクトのキー（区切りのカンマは読み終えている）
        resumed = false;
        continue;
      }
      skipSpace();
      if (output[p] === ",") {
        const commaAt = p;
        p++;
        skipSpace();
        if (output[p] === "}") {
          repairs.push({ kind: "comma", at: commaAt });
          p++;
          return result;
        }
        continue;
      }
      if (output[p] !== "}") throw new LenientError(p);
      p++;
      return result;
    }
  };
  const array = (depth: number, path: readonly string[]): unknown[] => {
    const result: unknown[] = [];
    p++;
    skipSpace();
    if (output[p] === "]") {
      p++;
      return result;
    }
    for (;;) {
      result.push(value(depth, AFTER_ARRAY_ITEM, [...path, "[]"]));
      skipSpace();
      if (output[p] === ",") {
        const commaAt = p;
        p++;
        skipSpace();
        if (output[p] === "]") {
          repairs.push({ kind: "comma", at: commaAt });
          p++;
          return result;
        }
        continue;
      }
      if (output[p] !== "]") throw new LenientError(p);
      p++;
      return result;
    }
  };
  const parsed = object(1, []);
  return { value: parsed, end: p, repairs };
}

/** 見出し heading を最初のキーに持つ「{」の位置を、出てきた順にすべて返す（前の報告の中にあるものは除く）。 */
function headingOpens(
  output: string,
  heading: string,
  budget = lenientBudget(output),
  shape?: LenientShape,
): number[] {
  const key = new RegExp(`"${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`, "g");
  const opens: number[] = [];
  let skipUntil = 0;
  for (const m of output.matchAll(key)) {
    if (m.index < skipUntil) continue;
    let open = m.index;
    while (open > 0 && /\s/.test(output[open - 1] ?? "")) open--;
    if (output[open - 1] !== "{") continue;
    opens.push(open - 1);
    // 読めた報告の中のキーは数えない。読めなければ、次の候補を妨げない
    try {
      skipUntil = parseLenient(output, open - 1, budget, shape).end;
    } catch {
      // 読めなかった報告は、診断（explainUnreadableAnswer）が扱う
    }
  }
  return opens;
}

/** 直しながら読んだ箇所（line・column は JSON の先頭からの位置。1から）。 */
export type RepairNote = { kind: RepairKind; line: number; column: number; key?: string };

/** JSON（open の「{」から始まる）の中の、at の位置の行と桁（1から）。桁は、JSON の行の頭から数える。 */
function locate(output: string, open: number, at: number): { line: number; column: number } {
  const line = output.slice(open, at).split("\n").length;
  const column = at - Math.max(open, output.lastIndexOf("\n", at - 1) + 1) + 1;
  return { line, column };
}

/**
 * lastJsonAnswer と同じに読む。囲み方にかかわらず、JSON として読める答えのうち、形の合う最後のもの。それより後ろに、見出し
 * heading を最初のキーに持つ答えが（文字列の中の引用符・改行などの崩れで）JSON として読めずにあれば、崩れを直しながら
 * 読み直し、形の合う最後のものを返す（PBI-293。後ろの答えが最終の答えなので、前の読める答えより優先する）。
 *
 * shape を渡すと、入れ子のオブジェクトの閉じ括弧の欠けも直す（PBI-298）。read は、直して読んだ箇所（repairs。直さずに読めた
 * ときは空）も受け取る。直した結果が期待する形でなければ、undefined を返して読まない（推測で読まない）。
 *
 * 戻り値の candidate は、本文から取り除く範囲（囲みがあれば囲みの行も含む）。repairs は、直して読んだ箇所。
 */
export function lastLenientJsonAnswer<T>(
  output: string,
  heading: string,
  read: (value: Record<string, unknown>, repairs: readonly RepairNote[]) => T | undefined,
  shape?: LenientShape,
):
  | { value: T; candidate: Pick<JsonCandidate, "start" | "end">; repairs: RepairNote[] }
  | undefined {
  const strict = lastJsonAnswer(output, (value) => read(value, []));
  const budget = lenientBudget(output);
  let fences: ReturnType<typeof fenceLines> | undefined;
  for (const open of headingOpens(output, heading, lenientBudget(output), shape).reverse()) {
    if (strict && open < strict.candidate.end) break;
    let value: T | undefined;
    let parsed: ReturnType<typeof parseLenient>;
    let repairs: RepairNote[];
    try {
      parsed = parseLenient(output, open, budget, shape);
      repairs = parsed.repairs.map((r) => ({
        kind: r.kind,
        ...locate(output, open, r.at),
        ...(r.key === undefined ? {} : { key: r.key }),
      }));
      value = read(parsed.value, repairs);
    } catch {
      continue;
    }
    if (value !== undefined) {
      fences ??= fenceLines(output);
      return { value, candidate: withFence(output, fences, open, parsed.end), repairs };
    }
  }
  return strict && { value: strict.value, candidate: strict.candidate, repairs: [] };
}

/** 読めなかった答えの診断。 */
export type Unreadable =
  /** 見出しの JSON が、出力に無い。 */
  | { kind: "missing" }
  /**
   * 見出しの JSON が壊れていて、直しても読めない。line・column は JSON の先頭からの位置（1から）、near は壊れた所の前後
   * （生の出力のまま。呼び出し側が伏せる）。
   */
  | { kind: "broken"; line: number; column: number; near: string }
  /** JSON としては読めたが、必要な項目が無い・形が違う。 */
  | { kind: "shape" };

/**
 * 答えが読めなかったとき、最後の報告の何が読めなかったかを返す（PBI-293。作業履歴に残し、AI の出力のどこを直せば
 * よいかが分かるようにする）。
 */
export function explainUnreadableAnswer(
  output: string,
  heading: string,
  shape?: LenientShape,
): Unreadable {
  const open = headingOpens(output, heading, undefined, shape).at(-1);
  if (open === undefined) return { kind: "missing" };
  try {
    parseLenient(output, open, undefined, shape);
    return { kind: "shape" };
  } catch (error) {
    const at = error instanceof LenientError ? error.at : open;
    // 桁は、JSON の行の頭から数える（JSON の前に同じ行の前置きがあっても、その長さを足さない）
    const { line, column } = locate(output, open, at);
    const near = output
      .slice(Math.max(open, at - 30), at + 30)
      .replace(/\s+/g, " ")
      .trim();
    return { kind: "broken", line, column, near };
  }
}

/** JSON のエスケープ（`\\"`・`\\n`・`\\uXXXX` など）を文字に戻す。JSON にないエスケープと、壊れた `\\u` はそのまま残す。 */
export function unescapeJson(text: string): string {
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_m, hex?: string, ch?: string) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : (ESCAPES[ch as string] as string),
  );
}

/**
 * 上限（UTF-16 のコード単位）に収まるように切る。切る位置がサロゲートペアの間なら1つ戻し、文字を壊さない
 * （PR #135 レビュー指摘）。
 */
export function cut(v: string, max: number): string {
  if (v.length <= max) return v;
  let end = max - 1;
  const last = v.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${v.slice(0, end)}…`;
}

/**
 * 壊れた JSON の壊れた所の前後（near）を、失敗の理由に残してよい形にする（PBI-293・298）。
 *
 * near は出力から切り取る。呼び出し側は出力の秘密情報を伏せる関数（hide）を持つが、JSON の中の値は引用符・改行などが
 * エスケープされていて一致しないことがある。そこで、エスケープを戻した出力の全体を hide にかけ、伏せる所があれば（エスケープ
 * された秘密情報が出力にある）、前後の文字は残さず空にする（位置だけを残す）。全体で確かめてから切るので、切り取りの境界を
 * またぐ値も漏れない。hide が無ければ、前後の文字は残さない。
 */
export function safeNear(
  output: string,
  near: string,
  hide: ((text: string) => string) | undefined,
  max = 80,
): string {
  if (!hide) return "";
  const decoded = unescapeJson(output);
  if (hide(decoded) !== decoded || hide(output) !== output) return "";
  return cut(hide(near), max);
}
