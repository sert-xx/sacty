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

/**
 * 「{」「[」の位置から、対応する「}」「]」の次の位置を求める。文字列の中の括弧・``` は数えない。閉じない・文字列の
 * 中に改行がある（JSON の文字列は改行を含めない）ときは null。1回の走査で、途中で開いたすべての括弧の結果も覚える
 * （同じ位置から走査し直すと、閉じない括弧の多い出力で、出力の長さの2乗の時間がかかるため）。開いた位置は文字列の
 * 外なので、そこから走査し直しても同じ結果になる。
 */
function bracketEnds(output: string): (start: number) => number | null {
  const ends = new Map<number, number | null>();
  const scan = (start: number) => {
    const open: number[] = [];
    let inString = false;
    for (let i = start; i < output.length; i++) {
      const c = output[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        else if (c === "\n") break;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") open.push(i);
      else if (c === "}" || c === "]") {
        const at = open.pop();
        if (at !== undefined) ends.set(at, i + 1);
        if (open.length === 0) return;
      }
    }
    for (const at of open) ends.set(at, null);
  };
  return (start) => {
    if (!ends.has(start)) scan(start);
    return ends.get(start) ?? null;
  };
}

/** 囲みの開始の行（```、```json、```JSON、```jsonc など）。 */
const FENCE_OPEN = /^[ \t]*```[\w.+-]*[ \t]*$/;

/** 行の頭の ```（囲みの開始・終わりの行）。 */
const FENCE_LINE = /^[ \t]*```/gm;

/**
 * JSON が囲みの中にあれば、囲みの行も含めた範囲にする。前の行の ``` が、前のコードの囲みの終わりの行（それまでの囲みの
 * 行の数が奇数）なら、囲みではない。
 */
function withFence(output: string, start: number, end: number): { start: number; end: number } {
  let before = start;
  while (before > 0 && /\s/.test(output[before - 1] ?? "")) before--;
  const lineStart = output.lastIndexOf("\n", before - 1) + 1;
  if (!FENCE_OPEN.test(output.slice(lineStart, before))) return { start, end };
  if ((output.slice(0, lineStart).match(FENCE_LINE)?.length ?? 0) % 2 === 1) return { start, end };
  let after = end;
  while (after < output.length && /\s/.test(output[after] ?? "")) after++;
  if (!output.startsWith("```", after)) return { start, end };
  const newline = output.indexOf("\n", after);
  const lineEnd = newline === -1 ? output.length : newline;
  if (output.slice(after + 3, lineEnd).trim() !== "") return { start, end };
  return { start: lineStart, end: lineEnd };
}

/**
 * 出力の中の JSON のオブジェクトを、出てきた順にすべて返す。囲み方（```json・```・ほかの言語名・囲みなし・説明の
 * 文の中）は問わない。説明の文の中の波括弧など、JSON として読めないものは候補にしない。オブジェクトの中の
 * オブジェクトは、別の候補にしない。
 */
export function jsonCandidates(output: string): JsonCandidate[] {
  const found: JsonCandidate[] = [];
  const endOf = bracketEnds(output);
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
      found.push({ value: value as Record<string, unknown>, ...withFence(output, i, end) });
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

/** 候補の範囲を、表示用の本文から取り除く（範囲は重ならない）。 */
export function withoutCandidates(output: string, candidates: readonly JsonCandidate[]): string {
  let cleaned = output;
  for (const c of [...candidates].sort((a, b) => b.start - a.start)) {
    cleaned = cleaned.slice(0, c.start) + cleaned.slice(c.end);
  }
  return cleaned;
}
