import { readSync } from "node:fs";
import { REDACTED, redact } from "./agents/redact.js";

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

/**
 * 実行中のログの、読める終わりの決め方。終わりが、伏せる値の形のどれかの先頭の一部（値の全体より短い）で終わるときは、
 * その一部を終わりから外した元を返す（値の続きは、まだ届いていないかもしれないので、伏せられない）。
 * totalBytes・next も、この終わりで数える。
 */
export function withoutPartialSecretTail(source: ByteSource, forms: readonly string[]): ByteSource {
  const needles = forms.filter((f) => f.length > 0).map((f) => Buffer.from(f, "utf8"));
  const pad = needles.reduce((m, n) => Math.max(m, n.length), 0);
  if (pad < 2 || source.total === 0) return source;
  const from = Math.max(0, source.total - (pad - 1));
  const tail = source.read(from, source.total);
  let drop = 0;
  for (const needle of needles) {
    const most = Math.min(needle.length - 1, tail.length);
    for (let k = most; k > drop; k--) {
      if (tail.subarray(tail.length - k).equals(needle.subarray(0, k))) {
        drop = k;
        break;
      }
    }
  }
  if (drop === 0) return source;
  const total = source.total - drop;
  return {
    total,
    ...(source.cuts ? { cuts: source.cuts } : {}),
    read: (a, b) => source.read(a, Math.min(b, total)),
  };
}

/** buf の末尾の、いずれかの値の先頭の一部（値の全体より短い）になっている部分の長さ。 */
export function partialAtEnd(buf: Buffer, needles: readonly Buffer[]): number {
  let keep = 0;
  for (const needle of needles) {
    for (let k = Math.min(needle.length - 1, buf.length); k > keep; k--) {
      if (buf.subarray(buf.length - k).equals(needle.subarray(0, k))) {
        keep = k;
        break;
      }
    }
  }
  return keep;
}

/** buf の先頭の、いずれかの値の後ろの一部（値の全体より短い）になっている部分の長さ。 */
export function partialAtStart(buf: Buffer, needles: readonly Buffer[]): number {
  let keep = 0;
  for (const needle of needles) {
    for (let k = Math.min(needle.length - 1, buf.length); k > keep; k--) {
      if (buf.subarray(0, k).equals(needle.subarray(needle.length - k))) {
        keep = k;
        break;
      }
    }
  }
  return keep;
}

/**
 * 継ぎ目（値の続きが記録に無い所）をはさむ3つのうち、先頭の分・末尾の分を、値の一部を伏せて返す
 * （先頭の分は終わりの一部、末尾の分は始まりの一部を [REDACTED] にする。値の全体も伏せる）。
 */
export function redactSeamEnd(buf: Buffer, forms: readonly string[]): Buffer {
  const needles = forms.filter((f) => f.length > 0).map((f) => Buffer.from(f, "utf8"));
  const pad = needles.reduce((m, n) => Math.max(m, n.length), 0);
  const k = partialAtEnd(buf.subarray(Math.max(0, buf.length - pad)), needles);
  const body = redact(buf.subarray(0, buf.length - k).toString("utf8"), forms);
  return Buffer.from(k > 0 ? `${body}${REDACTED}` : body);
}

export function redactSeamStart(buf: Buffer, forms: readonly string[]): Buffer {
  const needles = forms.filter((f) => f.length > 0).map((f) => Buffer.from(f, "utf8"));
  const pad = needles.reduce((m, n) => Math.max(m, n.length), 0);
  const k = partialAtStart(buf.subarray(0, pad), needles);
  const body = redact(buf.subarray(k).toString("utf8"), forms);
  return Buffer.from(k > 0 ? `${REDACTED}${body}` : body);
}

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
  const needles = forms.filter((f) => f.length > 0).map((f) => Buffer.from(f, "utf8"));
  const pad = needles.reduce((m, n) => Math.max(m, n.length), 0);
  let start = request.fromEnd ? Math.max(0, total - request.max) : (request.offset ?? 0);
  if (start >= total)
    return { text: "", offset: total, next: total, totalBytes: total, clipped: false };
  let end = Math.min(total, start + request.max);
  const lo = Math.max(0, start - pad);
  const win = source.read(lo, Math.min(total, end + pad + 4));
  const at = (position: number) => win[position - lo];
  const spans: [number, number][] = [];
  for (const needle of needles) {
    for (let i = win.indexOf(needle); i >= 0; i = win.indexOf(needle, i + 1)) {
      spans.push([lo + i, lo + i + needle.length]);
    }
  }
  // 継ぎ目の前後に残る、値の一部（値の続きが記録に無いので、全体の一致では見つからない）も、値と同じように外側へ広げて伏せる
  const partial: [number, number][] = [];
  for (const p of source.cuts?.end ?? []) {
    if (p <= lo || p > lo + win.length) continue;
    const before = win.subarray(Math.max(0, p - lo - (pad - 1)), p - lo);
    const keep = partialAtEnd(before, needles);
    if (keep > 0) partial.push([p - keep, p]);
  }
  for (const p of source.cuts?.start ?? []) {
    if (p < lo || p >= lo + win.length) continue;
    const after = win.subarray(p - lo, Math.min(win.length, p - lo + (pad - 1)));
    const keep = partialAtStart(after, needles);
    if (keep > 0) partial.push([p, p + keep]);
  }
  spans.push(...partial);
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
  const pieces: string[] = [];
  let cursor = start;
  for (const [a, b] of partial.sort((x, y) => x[0] - y[0])) {
    if (a < cursor || b > end) continue;
    pieces.push(redact(win.subarray(cursor - lo, a - lo).toString("utf8"), forms), REDACTED);
    cursor = b;
  }
  pieces.push(redact(win.subarray(cursor - lo, end - lo).toString("utf8"), forms));
  const text = pieces.join("");
  return {
    text,
    offset: start,
    next: end,
    totalBytes: total,
    clipped: request.fromEnd ? start > 0 : end < total,
  };
}
