import { readSync } from "node:fs";
import { redact } from "./agents/redact.js";

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
    read(from, to) {
      const parts: Buffer[] = [];
      if (from < a.total) parts.push(a.read(from, Math.min(to, a.total)));
      if (to > a.total) parts.push(b.read(Math.max(0, from - a.total), to - a.total));
      return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
    },
  };
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
  const text = redact(win.subarray(start - lo, end - lo).toString("utf8"), forms);
  return {
    text,
    offset: start,
    next: end,
    totalBytes: total,
    clipped: request.fromEnd ? start > 0 : end < total,
  };
}
