import { describe, expect, it } from "vitest";
import {
  concatSource,
  memorySource,
  RANGE_MAX_BYTES,
  readByteRange,
  redactBytes,
  withoutPartialSecretTail,
} from "./byte-range.js";

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

  it("max が 1〜3 バイトでも、文字の途中の位置・末尾の文字より小さい量で、壊れた文字を返さず、読みが進み、末尾読みは空にならない", () => {
    const text = "日😀😀";
    const bytes = Buffer.byteLength(text);
    for (const max of [1, 2, 3]) {
      for (let offset = 0; offset < bytes; offset++) {
        const r = readByteRange(memorySource(Buffer.from(text, "utf8")), { offset, max });
        expect(r.text).not.toContain("�");
        // 最後の文字の途中から読むと、残りは文字にならないので、終わりまで進む
        if (r.offset === bytes) continue;
        expect(r.text.length).toBeGreaterThan(0);
        expect(r.next).toBeGreaterThan(r.offset);
      }
      const tail = readByteRange(memorySource(Buffer.from(text, "utf8")), { fromEnd: true, max });
      expect(tail.text).toBe("😀");
      expect(tail.next).toBe(bytes);
    }
    // 伏せる値を持つときも、読み足した窓で値を伏せる
    const r = readByteRange(
      memorySource(Buffer.from("日😀ghp_SECRETVAL", "utf8")),
      { offset: 1, max: 1 },
      ["ghp_SECRETVAL"],
    );
    expect(r.text).not.toContain("�");
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

  describe("伏せる範囲の決め方（バイトの区間として1か所で決める）", () => {
    const red = (text: string, forms: string[], edge?: { start?: boolean; end?: boolean }) =>
      redactBytes(Buffer.from(text, "utf8"), forms, edge).toString("utf8");

    it("最初と最後の文字が同じ値が、終わりや始まりに接しても、値の全体を伏せる（一部を切り出して残りを残さない）", () => {
      const secret = "ghp_Q1w2E3r4T5y6U7i8g";
      // 末尾の g が値の先頭（g）と同じ
      expect(red(`x ${secret}`, [secret], { end: true })).toBe("x [REDACTED]");
      expect(red(`${secret} x`, [secret], { start: true })).toBe("[REDACTED] x");
      expect(red(`x ${secret}`, [secret])).toBe("x [REDACTED]");
      const same = "aXa";
      expect(red("--aXa", [same], { end: true })).toBe("--[REDACTED]");
      expect(red("aXa--", [same], { start: true })).toBe("[REDACTED]--");
    });

    it("別の値の先頭と末尾が重なる2つの値は、1つの区間にまとめて伏せる", () => {
      const forms = ["abcdef", "defxyz"];
      expect(red("-abcdefxyz-", forms)).toBe("-[REDACTED]-");
      // 継ぎ目に接する側も、値のどの一部も残らない
      expect(red("-abcdefxy", forms, { end: true })).toBe("-[REDACTED]");
      expect(red("efxyz-", forms, { start: true })).toBe("[REDACTED]-");
    });

    it("継ぎ目で見つけた値の一部（先頭の一部・後ろの一部）を伏せ、継ぎ目でなければ伏せない", () => {
      const forms = ["ghp_SECRETVAL"];
      expect(red("x ghp_SEC", forms, { end: true })).toBe("x [REDACTED]");
      expect(red("x ghp_SEC", forms)).toBe("x ghp_SEC");
      expect(red("RETVAL y", forms, { start: true })).toBe("[REDACTED] y");
      expect(red("RETVAL y", forms)).toBe("RETVAL y");
      expect(red("日本秘密", ["秘密値ABC"], { end: true })).toBe("日本[REDACTED]");
    });

    it("継ぎ目（cuts）を持つ元は、値の一部を外側へ広げて伏せ、返す境目も値の外側に来る", () => {
      const head = Buffer.from("start ghp_SEC", "utf8");
      const mark = Buffer.from("\n[cut]\n", "utf8");
      const tail = Buffer.from("RETVAL end", "utf8");
      const source = concatSource(
        { ...memorySource(head), cuts: { end: [head.length], start: [] } },
        {
          ...memorySource(Buffer.concat([mark, tail])),
          cuts: { end: [], start: [mark.length] },
        },
      );
      const forms = ["ghp_SECRETVAL"];
      const all = readByteRange(source, { offset: 0, max: 1000 }, forms);
      expect(all.text).toBe("start [REDACTED]\n[cut]\n[REDACTED] end");
      const mid = readByteRange(source, { offset: head.length - 2, max: 4 }, forms);
      expect(mid.offset).toBe(Buffer.byteLength("start "));
      expect(mid.text).not.toMatch(/SEC|RETVAL/);
      const tailRead = readByteRange(source, { fromEnd: true, max: 8 }, forms);
      expect(tailRead.text).not.toMatch(/RETVAL|ETVAL/);
      // cuts が無ければ、同じ元でも一部は残る（回帰の前提）
      const plain = concatSource(memorySource(head), memorySource(Buffer.concat([mark, tail])));
      expect(readByteRange(plain, { offset: 0, max: 1000 }, forms).text).toContain("RETVAL");
    });

    it("読める終わりが値の全体で終わるときは、値の最後の1文字が先頭と同じでも、値を欠かさず伏せる", () => {
      const secret = "ghp_Q1w2E3r4T5y6U7i8g";
      const source = memorySource(Buffer.from(`x ${secret}`, "utf8"));
      const readable = withoutPartialSecretTail(source, [secret]);
      expect(readByteRange(readable, { fromEnd: true, max: 100 }, [secret]).text).toBe(
        "x [REDACTED]",
      );
      // 値の先頭の一部で終わるときは、その一部を外す
      const part = withoutPartialSecretTail(memorySource(Buffer.from("x ghp_Q1w", "utf8")), [
        secret,
      ]);
      expect(part.total).toBe(2);
    });

    it("末尾の始まりに値の後ろの一部があり、終わりが同じ値の先頭の1文字で終わるときも、値の一部を返さない", () => {
      const secret = "aSECRETTOKEN0123456789a";
      const mark = Buffer.from("\n[cut]\n", "utf8");
      const tail = Buffer.from("ETTOKEN0123456789a", "utf8");
      const mem = {
        ...memorySource(Buffer.concat([mark, tail])),
        cuts: { end: [], start: [mark.length] },
      };
      const source = concatSource(
        { ...memorySource(Buffer.from("head ", "utf8")), cuts: { end: [], start: [] } },
        mem,
      );
      const readable = withoutPartialSecretTail(source, [secret]);
      const r = readByteRange(readable, { fromEnd: true, max: 100 }, [secret]);
      expect(r.text).not.toMatch(/ETTOKEN|0123/);
      expect(readByteRange(readable, { offset: 0, max: 100 }, [secret]).text).not.toMatch(
        /ETTOKEN|0123/,
      );
    });
  });

  it("乱数の入力（複数の値・重なる値・1文字が一致する値・複数バイトの文字・継ぎ目の位置と範囲）で、結果に値のどの一部も出ない", () => {
    let seed = 20261119;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const alphabet = ["g", "h", "秘", "密"];
    const filler = ["x", "-", " ", "\n", "あ".length ? "z" : "z"];
    const pick = <T>(list: readonly T[]) => list[rand(list.length)] as T;
    const word = (min: number, max: number, chars: readonly string[]) =>
      Array.from({ length: min + rand(max - min + 1) }, () => pick(chars)).join("");
    const MARK = "\n~~\n";
    const strip = (text: string) => text.replaceAll("[REDACTED]", "");
    const leaks = (text: string) => alphabet.some((c) => strip(text).includes(c));

    for (let round = 0; round < 3000; round++) {
      const needles = [...new Set(Array.from({ length: 1 + rand(3) }, () => word(2, 6, alphabet)))];
      // 値を、地の文（値の文字を含まない）の間に置く。ときどき、前の値の末尾と重ねて続ける
      let text = "";
      const count = 1 + rand(5);
      for (let i = 0; i < count; i++) {
        text += word(0, 6, filler);
        let value = pick(needles);
        const other = pick(needles);
        for (let k = Math.min(value.length, other.length) - 1; k > 0 && rand(2) === 0; k--) {
          if (value.endsWith(other.slice(0, k))) {
            value += other.slice(k);
            break;
          }
        }
        text += value;
        if (rand(3) === 0) text += pick(needles);
      }
      text += word(0, 6, filler);
      const chars = [...text];
      // 閉じた実行：先頭と末尾の間を省いた記録（継ぎ目が2つ）
      const p = rand(chars.length + 1);
      const q = Math.min(chars.length, p + rand(chars.length - p + 1));
      const head = Buffer.from(chars.slice(0, p).join(""), "utf8");
      const mark = Buffer.from(MARK, "utf8");
      const tail = Buffer.from(chars.slice(q).join(""), "utf8");
      const cut = concatSource(
        { ...memorySource(head), cuts: { end: [head.length], start: [] } },
        {
          ...memorySource(Buffer.concat([mark, tail])),
          cuts: { end: [], start: [mark.length] },
        },
      );
      // 実行中：読める終わりが、値の途中で終わる
      const live = Buffer.from(chars.slice(0, p).join(""), "utf8");
      for (const source of [
        cut,
        withoutPartialSecretTail(memorySource(live), needles),
        withoutPartialSecretTail(cut, needles),
      ]) {
        for (let i = 0; i < 6; i++) {
          const total = source.total;
          const request = rand(2)
            ? { fromEnd: true, max: 1 + rand(30) }
            : { offset: rand(total + 2), max: 1 + rand(30) };
          const r = readByteRange(source, request, needles);
          const label = JSON.stringify({ needles, text, p, q, request });
          expect(leaks(r.text), label).toBe(false);
          expect(r.text, label).not.toContain("�");
          if (!("fromEnd" in request) && request.offset < total) {
            expect(r.next, label).toBeGreaterThan(r.offset);
          }
        }
      }
    }
  });
});
