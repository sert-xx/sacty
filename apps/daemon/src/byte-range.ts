/**
 * バイトの範囲の読み取り（PBI-395）。成果物の本文を、UTF-8 のバイトの位置と量で区切って返す。
 * 本文は、画面で読めるものと同じ記録（書くときに伏せてある作業履歴・タスクの状態）から取るので、ここでは伏せない。
 */

/** 1回に返す量の上限（バイト）。 */
export const RANGE_MAX_BYTES = 32_000;

export type ByteRange = {
  text: string;
  /** 返した先頭の位置（バイト）。 */
  offset: number;
  /** 続きの位置（バイト。返した末尾）。 */
  next: number;
  totalBytes: number;
  /** 全体を返せず、続きがある。 */
  clipped: boolean;
};

const isContinuation = (byte: number | undefined) => ((byte ?? 0) & 0xc0) === 0x80;

function charLength(lead: number): number {
  return lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
}

/**
 * buf の、offset から max バイトまでの範囲を返す。境目は、UTF-8 の文字の頭にそろえる（始めは次の文字の頭へ進め、
 * 終わりは文字を書き終えた所まで戻す。1文字も入らないときは、1文字だけ返して続きが進むようにする）。
 * offset が全体以上なら、空の text と全体の大きさを返す。
 */
export function readByteRange(buf: Buffer, request: { offset?: number; max: number }): ByteRange {
  const total = buf.length;
  let start = request.offset ?? 0;
  if (start >= total) {
    return { text: "", offset: total, next: total, totalBytes: total, clipped: false };
  }
  while (start < total && isContinuation(buf[start])) start++;
  let end = Math.min(total, start + request.max);
  // 終わりが文字の途中なら、その文字の頭まで戻す
  if (end < total) {
    let head = end;
    while (head > start && isContinuation(buf[head])) head--;
    if (head > start || !isContinuation(buf[head])) end = head;
  }
  if (end <= start) end = Math.min(total, start + charLength(buf[start] as number));
  return {
    text: buf.subarray(start, end).toString("utf8"),
    offset: start,
    next: end,
    totalBytes: total,
    clipped: end < total,
  };
}
