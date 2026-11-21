import { describe, expect, it } from "vitest";
import { ByteRedactor } from "../agent-sessions.js";
import { StreamRedactor } from "../session-logs.js";
import { compileSecrets, REDACTED, redact } from "./redact.js";

const MB = 1024 * 1024;

/** 乱数（再現できるように種を固定する）で、衝突しにくい長い値を作る。 */
function longValue(length: number, seed: number): string {
  let x = seed;
  let out = "";
  const chunks: string[] = [];
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += String.fromCharCode(97 + ((x >>> 16) % 26));
    if (out.length === 8192) {
      chunks.push(out);
      out = "";
    }
  }
  return chunks.join("") + out;
}

/** 木が持つ配列の大きさ（バイト）。GC や時間に左右されず、節の持ち方で決まる。 */
function matcherBytes(m: ReturnType<typeof compileSecrets>): number {
  return m.firstCode.byteLength + m.firstChild.byteLength + m.fail.byteLength + m.best.byteLength;
}

describe("とても長い値でも、伏せる処理のメモリと時間が長さに比例する（PBI-444）", () => {
  it("2MB の値の木は、1 文字あたり 30 バイト以下で、子が 2 つ以上ある節の Map は値の数以下", () => {
    const value = longValue(2 * MB, 1);
    const m = compileSecrets([value, "other-secret-value"]);
    expect(matcherBytes(m) / value.length).toBeLessThanOrEqual(30);
    expect(m.more.size).toBeLessThanOrEqual(2);
  });

  it("長さを 2 倍にすると、木の大きさもちょうど 2 倍に近い（二乗にならない）", () => {
    const small = matcherBytes(compileSecrets([longValue(256 * 1024, 2)]));
    const large = matcherBytes(compileSecrets([longValue(512 * 1024, 2)]));
    expect(large / small).toBeGreaterThan(1.9);
    expect(large / small).toBeLessThan(2.1);
  });

  it("2MB の値の木を作るのも、2MB の入力から値を伏せるのも、1 秒以下で、全体が 1 つの目印になる", () => {
    const value = longValue(2 * MB, 3);
    const start = performance.now();
    const text = `head ${value} tail ${value}`;
    expect(redact(text, [value])).toBe(`head ${REDACTED} tail ${REDACTED}`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("同じ文字だけの長い値と入力でも、遅くならない（失敗の連鎖が二乗にならない）", () => {
    const value = "a".repeat(MB);
    const start = performance.now();
    expect(redact(`x${"a".repeat(2 * MB)}y`, [value])).toBe(`x${REDACTED}y`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("32MB の値でも木を作れる（落ちない）", () => {
    const value = "ab".repeat(16 * MB);
    const m = compileSecrets([value]);
    expect(m.best[m.best.length - 1]).toBe(value.length);
    expect(matcherBytes(m) / value.length).toBeLessThanOrEqual(30);
  });
});

describe("長い値でも、値の文字を 1 文字も残さない（PBI-438 を壊さない）", () => {
  const value = longValue(300_000, 4);

  it("全体が複数回・ほかの値と重なって現れても、残らない", () => {
    const other = `${value.slice(-1000)}tail-of-other`;
    const text = `a ${value} b ${value}${value} c ${value}${other.slice(1000)} d`;
    const out = redact(text, [value, other]);
    expect(out).not.toContain(value.slice(0, 50));
    expect(out).not.toContain("tail-of-other");
    expect(out).toBe(`a ${REDACTED} b ${REDACTED}${REDACTED} c ${REDACTED} d`);
  });

  it("StreamRedactor：届く分の境目をまたいでも、残らない", () => {
    const text = `before ${value} after`;
    for (const step of [1000, 77_777, 299_999]) {
      const stream = new StreamRedactor(() => [value]);
      let out = "";
      for (let i = 0; i < text.length; i += step) out += stream.push(text.slice(i, i + step));
      out += stream.flush();
      expect(out).toBe(`before ${REDACTED} after`);
    }
  });

  it("ByteRedactor：届く分の境目をまたいでも、残らない（UTF-8 の多バイトの値）", () => {
    const wide = `${value.slice(0, 100_000)}あいう${value.slice(0, 50_000)}`;
    const text = `before ${wide} after ${wide}`;
    for (const step of [999, 65_536, 150_001]) {
      const redactor = new ByteRedactor([wide]);
      const buf = Buffer.from(text, "utf8");
      const parts: Buffer[] = [];
      for (let i = 0; i < buf.length; i += step)
        parts.push(redactor.push(buf.subarray(i, i + step)));
      parts.push(redactor.flush());
      expect(Buffer.concat(parts).toString("utf8")).toBe(`before ${REDACTED} after ${REDACTED}`);
    }
  });
});
