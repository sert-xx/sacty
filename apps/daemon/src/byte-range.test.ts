import { describe, expect, it } from "vitest";
import { RANGE_MAX_BYTES, readByteRange } from "./byte-range.js";

const src = (text: string) => Buffer.from(text, "utf8");

/** next から読み直して続けると、元の文になる。 */
function readAll(text: string, max: number): string[] {
  const parts: string[] = [];
  let offset = 0;
  for (let i = 0; i < 10_000; i++) {
    const r = readByteRange(src(text), { offset, max });
    parts.push(r.text);
    if (r.next >= r.totalBytes) break;
    expect(r.next).toBeGreaterThan(offset);
    offset = r.next;
  }
  return parts;
}

describe("バイトの範囲の読み取り（PBI-395）", () => {
  it("上限ちょうどは全文で clipped なし、1バイト超えると切り取って続きの位置を返す", () => {
    const exact = readByteRange(src("a".repeat(RANGE_MAX_BYTES)), { max: RANGE_MAX_BYTES });
    expect(exact).toMatchObject({
      clipped: false,
      next: RANGE_MAX_BYTES,
      totalBytes: RANGE_MAX_BYTES,
    });
    expect(exact.text).toHaveLength(RANGE_MAX_BYTES);
    const over = readByteRange(src("a".repeat(RANGE_MAX_BYTES + 1)), { max: RANGE_MAX_BYTES });
    expect(over).toMatchObject({
      clipped: true,
      next: RANGE_MAX_BYTES,
      totalBytes: RANGE_MAX_BYTES + 1,
    });
    expect(over.text).toHaveLength(RANGE_MAX_BYTES);
  });

  it("max が 1〜3 バイトでも、文字の途中の位置で、壊れた文字を返さず、読みが進む", () => {
    const text = "日😀😀";
    const bytes = Buffer.byteLength(text);
    for (const max of [1, 2, 3]) {
      for (let offset = 0; offset < bytes; offset++) {
        const r = readByteRange(src(text), { offset, max });
        expect(r.text).not.toContain("�");
        // 最後の文字の途中から読むと、残りは文字にならないので、終わりまで進む
        if (r.offset === bytes) continue;
        expect(r.text.length).toBeGreaterThan(0);
        expect(r.next).toBeGreaterThan(r.offset);
      }
    }
  });

  it("文字の途中の offset は、次の文字の頭へ進め、その位置を offset に返す", () => {
    expect(readByteRange(src("日本語"), { offset: 1, max: 6 })).toEqual({
      text: "本語",
      offset: 3,
      next: 9,
      totalBytes: 9,
      clipped: false,
    });
  });

  it("全体以上の位置は、0バイトと全体の大きさを返す", () => {
    for (const offset of [5, 15]) {
      expect(readByteRange(src("abcde"), { offset, max: 10 })).toEqual({
        text: "",
        offset: 5,
        next: 5,
        totalBytes: 5,
        clipped: false,
      });
    }
  });

  it("日本語・絵文字の途中で切らず、置換文字を含まない。next から読み直して続けると元の文に一致する", () => {
    const text = "あいう😀えお🎉かき日本語😀".repeat(7);
    for (const max of [1, 2, 3, 4, 5, 7, 10, 13]) {
      const parts = readAll(text, max);
      for (const part of parts) {
        expect(part).not.toContain("�");
        expect(part).not.toMatch(
          /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
        );
      }
      expect(parts.join("")).toBe(text);
    }
  });
});
