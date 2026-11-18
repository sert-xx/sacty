import { describe, expect, it } from "vitest";
import { memorySource, RANGE_MAX_BYTES, readByteRange } from "./byte-range.js";

const src = (text: string) => memorySource(Buffer.from(text, "utf8"));

/** next から読み直して続けると、元の文になる。 */
function readAll(text: string, max: number, forms: string[] = []): string[] {
  const parts: string[] = [];
  let offset = 0;
  for (let i = 0; i < 10_000; i++) {
    const r = readByteRange(src(text), { offset, max }, forms);
    parts.push(r.text);
    if (r.next <= offset && r.next >= r.totalBytes) break;
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

  it("末尾から読む指定は、末尾の max バイトを文字の頭から返す", () => {
    const r = readByteRange(src("あいうえお"), { fromEnd: true, max: 7 });
    // 末尾 7 バイトは「う」の途中から。次の文字の頭（え）から
    expect(r.text).toBe("えお");
    expect(r).toMatchObject({ clipped: true, next: 15, totalBytes: 15 });
    expect(readByteRange(src("abc"), { fromEnd: true, max: 10 })).toMatchObject({
      text: "abc",
      clipped: false,
    });
  });

  it("伏せる値が境目をまたぐと、値の外側へ広げて値ごと伏せる（値の一部を残さない）", () => {
    const secret = "tok-SECRET-1234";
    const text = `head ${secret} tail`;
    const start = Buffer.byteLength("head tok-SEC");
    const r = readByteRange(src(text), { offset: start, max: 40 }, [secret]);
    expect(r.text).toBe("[REDACTED] tail");
    expect(r.offset).toBe(Buffer.byteLength("head "));
    // 終わりの境目が値の途中
    const e = readByteRange(src(text), { offset: 0, max: start + 2 }, [secret]);
    expect(e.text).toBe("head [REDACTED]");
    expect(e.next).toBe(Buffer.byteLength(`head ${secret}`));
    for (const piece of ["tok", "SECRET", "1234", "SEC"]) {
      expect(r.text).not.toContain(piece);
      expect(e.text).not.toContain(piece);
    }
  });

  it("日本語を含む値も、エスケープした形も、境目をまたいで残さない", () => {
    const secret = "合言葉🔑値";
    const escaped = JSON.stringify(secret).slice(1, -1);
    const text = `前 ${secret} 後 {"k":"${escaped}"} 終`;
    for (let max = 1; max < Buffer.byteLength(text); max += 3) {
      for (const offset of [0, 4, 9, 14, 20, 30]) {
        const r = readByteRange(src(text), { offset, max }, [secret, escaped]);
        expect(r.text).not.toContain("合言葉");
        expect(r.text).not.toContain("値");
        expect(r.text).not.toContain("🔑");
        expect(r.text).not.toContain("\\ud83d");
        expect(r.text).not.toContain("�");
      }
    }
  });
});
