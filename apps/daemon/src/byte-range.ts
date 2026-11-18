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

/**
 * 伏せる範囲を、バイトの区間として1か所で決める（読み取り・閉じるときの伏せ直し・実行中の終わりの3か所が使う）。
 * 値の全体の出現と、継ぎ目で見つけた値の一部を区間にし、重なる・接する区間は1つにまとめる。
 * 継ぎ目：cuts.end の位置の前で値の先頭の一部が終わりうる／cuts.start の位置の後で値の後ろの一部が始まりうる（値の続きが記録に無い）。
 */
function secretSpans(
  buf: Buffer,
  needles: readonly Buffer[],
  cuts: { end?: readonly number[]; start?: readonly number[] } = {},
): Spans {
  if (needles.length === 0) return [];
  const fulls = fullSpans(buf, needles);
  const spans = [...fulls];
  for (const p of cuts.end ?? []) {
    if (p <= 0 || p > buf.length) continue;
    const k = partialBefore(buf, p, needles, fulls);
    if (k > 0) spans.push([p - k, p]);
  }
  for (const p of cuts.start ?? []) {
    if (p < 0 || p >= buf.length) continue;
    const k = partialAfter(buf, p, needles, fulls);
    if (k > 0) spans.push([p, p + k]);
  }
  return mergeSpans(spans);
}

const REDACTED_BYTES = Buffer.from(REDACTED, "utf8");

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
    if (partialBefore(tail, tail.length, needles, fulls) === 0) return source;
    const spans = secretSpans(tail, needles, { end: [tail.length] });
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
  let start = request.fromEnd ? Math.max(0, total - request.max) : (request.offset ?? 0);
  if (start >= total)
    return { text: "", offset: total, next: total, totalBytes: total, clipped: false };
  let end = Math.min(total, start + request.max);
  const lo = Math.max(0, start - pad);
  const win = source.read(lo, Math.min(total, end + pad + 4));
  const at = (position: number) => win[position - lo];
  // 値の全体の出現と、継ぎ目の前後に残る値の一部を、区間として1か所で決める（外側へ広げて伏せる）
  const spans = secretSpans(win, needles, {
    end: (source.cuts?.end ?? []).map((p) => p - lo),
    start: (source.cuts?.start ?? []).map((p) => p - lo),
  }).map(([a, b]): [number, number] => [lo + a, lo + b]);
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
