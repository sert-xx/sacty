import { readSync } from "node:fs";
import { REDACTED } from "./agents/redact.js";

/**
 * バイトの範囲の読み取り（PBI-395）。成果物の本文・セッションログを、UTF-8 のバイトの位置と量で区切って返す。
 * 全体は読まず、返す範囲と、伏せる値を見つけるための前後の余分だけを読む。
 */

/** 1回に返す量の上限（バイト）。 */
export const RANGE_MAX_BYTES = 32_000;

/** 位置（バイト）で読める元。 */
export type ByteSource = {
  /** 全体の大きさ（バイト）。 */
  total: number;
  /** [from, to) を読む。元がそれより短ければ、読めた分だけ。 */
  read(from: number, to: number): Buffer;
  /**
   * 記録が途切れている継ぎ目（バイトの位置）。値の続きが記録に無いので、値の一部が残りうる。
   * end：その位置の前で、値の先頭の一部が終わりうる（先頭の終わり）。start：その位置の後で、値の後ろの一部が始まりうる（末尾の始まり）。
   */
  cuts?: { end: number[]; start: number[] };
};

export type ByteRange = {
  text: string;
  /** 返した先頭の位置（バイト）。 */
  offset: number;
  /** 続きの位置（バイト。返した末尾）。 */
  next: number;
  totalBytes: number;
  /** 全体を返せず、続き（末尾から読んだときは、手前）がある。 */
  clipped: boolean;
};

export function memorySource(buf: Buffer): ByteSource {
  return { total: buf.length, read: (from, to) => buf.subarray(from, Math.min(to, buf.length)) };
}

/** 開いたファイルの、先頭から size バイトの元。 */
export function fileSource(fd: number, size: number): ByteSource {
  return {
    total: size,
    read(from, to) {
      const end = Math.min(to, size);
      const buf = Buffer.alloc(Math.max(0, end - from));
      let done = 0;
      while (done < buf.length) {
        const n = readSync(fd, buf, done, buf.length - done, from + done);
        if (n === 0) break;
        done += n;
      }
      return done === buf.length ? buf : buf.subarray(0, done);
    },
  };
}

/** a のあとに b を続けた元。 */
export function concatSource(a: ByteSource, b: ByteSource): ByteSource {
  return {
    total: a.total + b.total,
    cuts: {
      end: [...(a.cuts?.end ?? []), ...(b.cuts?.end ?? []).map((p) => p + a.total)],
      start: [...(a.cuts?.start ?? []), ...(b.cuts?.start ?? []).map((p) => p + a.total)],
    },
    read(from, to) {
      const parts: Buffer[] = [];
      if (from < a.total) parts.push(a.read(from, Math.min(to, a.total)));
      if (to > a.total) parts.push(b.read(Math.max(0, from - a.total), to - a.total));
      return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
    },
  };
}

type Spans = [number, number][];

/** 伏せる値の形を、空でない重複のないバイト列にする。 */
export function toNeedles(forms: readonly string[]): Buffer[] {
  return [...new Set(forms.filter((f) => f.length > 0))].map((f) => Buffer.from(f, "utf8"));
}

const maxLength = (needles: readonly Buffer[]) =>
  needles.reduce((m, n) => Math.max(m, n.length), 0);

/** 重なる区間・接する区間を1つにまとめる。 */
function mergeSpans(spans: Spans): Spans {
  const sorted = [...spans].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Spans = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** 値の全体の出現（重なる出現も含む）の区間。 */
function fullSpans(buf: Buffer, needles: readonly Buffer[]): Spans {
  const spans: Spans = [];
  for (const needle of needles) {
    for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) {
      spans.push([i, i + needle.length]);
    }
  }
  return spans;
}

const within = (a: number, b: number, fulls: Spans) => fulls.some(([x, y]) => x <= a && b <= y);

/**
 * [0, at) の末尾が、いずれかの値の先頭の一部（値の全体より短い）になっている長さ。
 * 値の全体の出現に収まるバイトだけの一致は、一部とみなさない。
 */
function partialBefore(buf: Buffer, at: number, needles: readonly Buffer[], fulls: Spans): number {
  let keep = 0;
  for (const needle of needles) {
    for (let k = Math.min(needle.length - 1, at); k > keep; k--) {
      if (buf.subarray(at - k, at).equals(needle.subarray(0, k)) && !within(at - k, at, fulls)) {
        keep = k;
        break;
      }
    }
  }
  return keep;
}

/** [at, 終わり) の先頭が、いずれかの値の後ろの一部（値の全体より短い）になっている長さ。 */
function partialAfter(buf: Buffer, at: number, needles: readonly Buffer[], fulls: Spans): number {
  let keep = 0;
  for (const needle of needles) {
    for (let k = Math.min(needle.length - 1, buf.length - at); k > keep; k--) {
      if (
        buf.subarray(at, at + k).equals(needle.subarray(needle.length - k)) &&
        !within(at, at + k, fulls)
      ) {
        keep = k;
        break;
      }
    }
  }
  return keep;
}

const REDACTED_BYTES = Buffer.from(REDACTED, "utf8");

/**
 * 前の回に伏せた印（[REDACTED]）の前後。印の前（starts）で値の先頭の一部が終わりうる／印の後（ends）で値の後ろの一部が始まりうる
 * （印は、その時点で知っていた別の値で置き換えた跡で、その値と重なる値の一部が印の外側に残る）。窓の端で切れた印も数える。
 */
function markerBounds(buf: Buffer): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  const size = REDACTED_BYTES.length;
  for (let i = buf.indexOf(REDACTED_BYTES); i >= 0; i = buf.indexOf(REDACTED_BYTES, i + 1)) {
    starts.push(i);
    ends.push(i + size);
  }
  for (let k = Math.min(size - 1, buf.length); k > 0; k--) {
    if (buf.subarray(0, k).equals(REDACTED_BYTES.subarray(size - k))) {
      ends.push(k);
      break;
    }
  }
  for (let k = Math.min(size - 1, buf.length); k > 0; k--) {
    if (buf.subarray(buf.length - k).equals(REDACTED_BYTES.subarray(0, k))) {
      starts.push(buf.length - k);
      break;
    }
  }
  return { starts, ends };
}

/**
 * 伏せる範囲を、バイトの区間として1か所で決める（読み取り・閉じるときの伏せ直し・実行中の終わりの3か所が使う）。
 * 値の全体の出現と、値の続きが記録に無い所（継ぎ目・前の回に伏せた印の前後）で見つけた値の一部を区間にし、
 * 重なる・接する区間は1つにまとめる。伏せる時点（書くとき・閉じるとき・読むとき）で知っている値の集まりが違っても、
 * 前の回の印は、その外側に値の一部が残る手がかりとして働く。
 * 継ぎ目：cuts.end の位置の前で値の先頭の一部が終わりうる／cuts.start の位置の後で値の後ろの一部が始まりうる。
 * 印と印・継ぎ目に挟まれた短い区間が、値の途中の一部になっているときも伏せる。
 */
/** 値の一部が始まりうる所（afters）と、値の一部が終わりうる所（befores）。継ぎ目と、前の回に伏せた印（切れたものを含む）の前後。 */
function boundaries(
  buf: Buffer,
  cuts: { end?: readonly number[]; start?: readonly number[] },
): { befores: number[]; afters: number[] } {
  const marks = markerBounds(buf);
  const cutEnds = (cuts.end ?? []).filter((p) => p > 0 && p <= buf.length);
  const cutStarts = (cuts.start ?? []).filter((p) => p >= 0 && p < buf.length);
  // 継ぎ目で切られた印（先頭の終わりが「[REDA」で終わる・末尾の始まりが「CTED]」から始まる）も、印の前後として数える
  const size = REDACTED_BYTES.length;
  for (const p of cutEnds) {
    for (let k = Math.min(size - 1, p); k > 0; k--) {
      if (buf.subarray(p - k, p).equals(REDACTED_BYTES.subarray(0, k))) {
        marks.starts.push(p - k);
        break;
      }
    }
  }
  for (const p of cutStarts) {
    for (let k = Math.min(size - 1, buf.length - p); k > 0; k--) {
      if (buf.subarray(p, p + k).equals(REDACTED_BYTES.subarray(size - k))) {
        marks.ends.push(p + k);
        break;
      }
    }
  }
  return {
    befores: [...cutEnds, ...marks.starts].sort((a, b) => a - b),
    afters: [...cutStarts, ...marks.ends.filter((p) => p < buf.length)],
  };
}

/** 値の一部が始まりうる所 p から次の終わりうる所 q までの短い区間が、値の途中の一部になっているか。 */
function middlePiece(
  buf: Buffer,
  p: number,
  befores: readonly number[],
  needles: readonly Buffer[],
  fulls: Spans,
): number | undefined {
  const q = befores.find((b) => b > p);
  if (q === undefined || q - p >= maxLength(needles)) return undefined;
  const piece = buf.subarray(p, q);
  return needles.some((n) => n.indexOf(piece) >= 0) && !within(p, q, fulls) ? q : undefined;
}

function secretSpans(
  buf: Buffer,
  needles: readonly Buffer[],
  cuts: { end?: readonly number[]; start?: readonly number[] } = {},
): Spans {
  if (needles.length === 0) return [];
  const fulls = fullSpans(buf, needles);
  const spans = [...fulls];
  const { befores, afters } = boundaries(buf, cuts);
  for (const p of befores) {
    const k = partialBefore(buf, p, needles, fulls);
    if (k > 0) spans.push([p - k, p]);
  }
  for (const p of afters) {
    const k = partialAfter(buf, p, needles, fulls);
    if (k > 0) spans.push([p, p + k]);
    // 次の「値の先頭の一部が終わりうる所」までの短い区間が、値の途中の一部になっているとき
    const q = middlePiece(buf, p, befores, needles, fulls);
    if (q !== undefined) spans.push([p, q]);
  }
  return mergeSpans(spans);
}

/**
 * 終わり（まだ続きが届くかもしれない所）の直前が、継ぎ目・前の回の印の後から続く、値の途中の一部になっているか。
 * 値の全体の出現に収まる分は数えない。
 */
function openPieceAtEnd(
  buf: Buffer,
  needles: readonly Buffer[],
  cuts: { end?: readonly number[]; start?: readonly number[] },
): boolean {
  const fulls = fullSpans(buf, needles);
  const { afters } = boundaries(buf, cuts);
  return afters.some((p) => middlePiece(buf, p, [buf.length], needles, fulls) !== undefined);
}

/** buf の [from, to) を、区間を [REDACTED] に置き換えて返す。区間は from..to の中に収まっているものとする。 */
function replaceSpans(buf: Buffer, from: number, to: number, spans: Spans): Buffer {
  const parts: Buffer[] = [];
  let cursor = from;
  for (const [a, b] of spans) {
    if (b <= from || a >= to) continue;
    parts.push(buf.subarray(cursor, Math.max(cursor, a)), REDACTED_BYTES);
    cursor = Math.min(to, b);
  }
  parts.push(buf.subarray(cursor, to));
  return Buffer.concat(parts);
}

/**
 * ファイルの一部（継ぎ目の前の分・後の分・全体）を伏せる。edge.end：buf の終わりが継ぎ目（値の先頭の一部が終わりうる）、
 * edge.start：buf の始まりが継ぎ目（値の後ろの一部が始まりうる）。
 */
export function redactBytes(
  buf: Buffer,
  forms: readonly string[],
  edge: { start?: boolean; end?: boolean } = {},
): Buffer {
  const needles = toNeedles(forms);
  const spans = secretSpans(buf, needles, {
    end: edge.end ? [buf.length] : [],
    start: edge.start ? [0] : [],
  });
  return spans.length === 0 ? buf : replaceSpans(buf, 0, buf.length, spans);
}

/**
 * 実行中のログの、読める終わりの決め方。終わりが、伏せる値の形のどれかの先頭の一部（値の全体より短い）で終わるときは、
 * その一部（と、つながる値の出現）を終わりから外した元を返す（値の続きは、まだ届いていないかもしれないので、伏せられない）。
 * totalBytes・next も、この終わりで数える。
 */
export function withoutPartialSecretTail(source: ByteSource, forms: readonly string[]): ByteSource {
  const needles = toNeedles(forms);
  const pad = maxLength(needles);
  if (pad < 2 || source.total === 0) return source;
  // 外す所は、終わりにつながる区間の始まり。窓の始まりに近いと、窓の外から続く値を見落とすので、窓を広げて探し直す
  let size = Math.min(source.total, 2 * pad);
  let total: number | undefined;
  for (;;) {
    const from = source.total - size;
    const tail = source.read(from, source.total);
    const fulls = fullSpans(tail, needles);
    // 末尾の始まり・先頭の終わりの継ぎ目も渡す（継ぎ目にある値の後ろの一部が、終わりの一部とつながるため）
    const cuts = {
      end: [...(source.cuts?.end ?? []).map((p) => p - from), tail.length],
      start: (source.cuts?.start ?? []).map((p) => p - from),
    };
    // 終わりが、値の先頭の一部で終わっているか、前の回の印・継ぎ目の後から続く値の途中の一部で終わっているとき
    if (
      partialBefore(tail, tail.length, needles, fulls) === 0 &&
      !openPieceAtEnd(tail, needles, cuts)
    ) {
      return source;
    }
    const spans = secretSpans(tail, needles, cuts);
    const last = spans[spans.length - 1];
    if (!last || last[1] !== tail.length) return source;
    if (last[0] >= pad || from === 0) {
      total = from + last[0];
      break;
    }
    if (size >= TAIL_SEARCH_MAX) {
      total = 0; // 値が途切れなくつながる異常な並び。返せる所が決められないので、返さない
      break;
    }
    size = Math.min(source.total, size * 2);
  }
  const readable = total;
  return {
    total: readable,
    ...(source.cuts ? { cuts: source.cuts } : {}),
    read: (a, b) => source.read(a, Math.min(b, readable)),
  };
}

/** 読める終わりを探すときに、終わりから遡って読む量の上限（バイト）。 */
const TAIL_SEARCH_MAX = 1 << 20;

const isContinuation = (byte: number | undefined) => ((byte ?? 0) & 0xc0) === 0x80;

function charLength(lead: number): number {
  return lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
}

/** buf の、UTF-8 の文字として最後まで書き終えた所までの長さ。 */
function completeLength(buf: Buffer): number {
  for (let j = buf.length - 1, back = 0; j >= 0 && back < 4; j--, back++) {
    const b = buf[j] as number;
    if (isContinuation(b)) continue;
    return buf.length - j >= charLength(b) ? buf.length : j;
  }
  return buf.length;
}

/**
 * 元の範囲を返す。fromEnd なら末尾の max バイト、そうでなければ offset から max バイト。
 * 境目は、UTF-8 の文字の頭にそろえる（始めは次の文字の頭へ進め、終わりは文字を書き終えた所まで戻す。1文字も入らないときは
 * 1文字だけ返して、続きが進むようにする）。
 * forms（伏せる値の形）があれば、範囲の前後に、いちばん長い形のバイト数だけ余分に読んで、値を見つけ、境目が値の途中なら
 * 値の外側へ広げてから、値を伏せて返す（値の一部を残さない。返す量は、最大で max＋余分の2倍＋4）。
 */
export function readByteRange(
  source: ByteSource,
  request: { offset?: number; fromEnd?: boolean; max: number },
  forms: readonly string[] = [],
): ByteRange {
  const total = source.total;
  const needles = toNeedles(forms);
  const pad = maxLength(needles);
  let max = request.max;
  if (request.fromEnd && total > 0) {
    // 末尾の文字より max が小さいときは、その1文字は返す（0バイトにしない）
    const last = source.read(Math.max(0, total - 4), total);
    for (let j = last.length - 1; j >= 0; j--) {
      if (isContinuation(last[j])) continue;
      max = Math.max(max, last.length - j);
      break;
    }
  }
  let start = request.fromEnd ? Math.max(0, total - max) : (request.offset ?? 0);
  if (start >= total)
    return { text: "", offset: total, next: total, totalBytes: total, clipped: false };
  let end = Math.min(total, start + max);
  const lo = Math.max(0, start - pad);
  let win: Buffer = Buffer.alloc(0);
  let spans: [number, number][] = [];
  // 値の全体の出現と、継ぎ目の前後に残る値の一部を、区間として1か所で決める（外側へ広げて伏せる）
  const load = (to: number) => {
    win = source.read(lo, Math.min(total, to));
    spans = secretSpans(win, needles, {
      end: (source.cuts?.end ?? []).map((p) => p - lo),
      start: (source.cuts?.start ?? []).map((p) => p - lo),
    }).map(([a, b]): [number, number] => [lo + a, lo + b]);
  };
  const at = (position: number) => win[position - lo];
  load(end + pad + 4);
  const widen = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const [a, b] of spans) {
        if (a < start && start < b) {
          start = a;
          changed = true;
        }
        if (a < end && end < b) {
          end = b;
          changed = true;
        }
      }
    }
  };
  widen();
  while (start < total && isContinuation(at(start))) start++;
  end = start + completeLength(win.subarray(start - lo, end - lo));
  if (end <= start) end = Math.min(total, start + charLength(at(start) ?? 0));
  widen();
  // 文字の頭へ進めた結果、窓の外に出た分（max が小さいとき）は、読み足して伏せる値を探し直す
  if (lo + win.length < Math.min(total, end + pad)) {
    load(end + pad + 4);
    widen();
  }
  const text = replaceSpans(
    win,
    start - lo,
    end - lo,
    spans.map(([a, b]): [number, number] => [a - lo, b - lo]),
  ).toString("utf8");
  return {
    text,
    offset: start,
    next: end,
    totalBytes: total,
    clipped: request.fromEnd ? start > 0 : end < total,
  };
}
