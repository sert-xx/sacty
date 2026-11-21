import { describe, expect, it, vi } from "vitest";
import { ByteRedactor } from "../agent-sessions.js";
import { StreamRedactor } from "../session-logs.js";
import { compileSecrets, MAX_AUTH_FILE_BYTES, REDACTED, redact } from "./redact.js";

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

/** 節 1 つあたりの、配列の大きさ（バイト）。GC や時間に左右されず、節の持ち方で決まる（確保した余りではなく、使った節で割る）。 */
function bytesPerNode(m: ReturnType<typeof compileSecrets>): number {
  const total =
    m.firstCode.byteLength + m.firstChild.byteLength + m.fail.byteLength + m.best.byteLength;
  return total / m.nodes;
}

describe("とても長い値でも、伏せる処理のメモリと時間が長さに比例する（PBI-444）", () => {
  it("2MB の値の木は、使った節が文字数と同じ程度で、1 文字あたり 30 バイト以下。子が 2 つ以上ある節の Map は値の数以下", () => {
    const value = longValue(2 * MB, 1);
    const m = compileSecrets([value, "other-secret-value"]);
    expect(m.nodes).toBeLessThanOrEqual(value.length + "other-secret-value".length + 1);
    expect(bytesPerNode(m) * (m.nodes / value.length)).toBeLessThanOrEqual(30);
    expect(m.more.size).toBeLessThanOrEqual(2);
  });

  it("長さを 2 倍にすると、使う節の数が 2 倍に近い（二乗にならない）", () => {
    const small = compileSecrets([longValue(256 * 1024, 2)]).nodes;
    const large = compileSecrets([longValue(512 * 1024, 2)]).nodes;
    expect(large / small).toBeGreaterThan(1.9);
    expect(large / small).toBeLessThan(2.1);
  });

  it("2MB の値を含む入力から、値の全体を伏せる", () => {
    const value = longValue(2 * MB, 3);
    expect(redact(`head ${value} tail ${value}`, [value])).toBe(
      `head ${REDACTED} tail ${REDACTED}`,
    );
  });

  it("同じ文字だけの長い値と入力でも、全体が 1 つの目印になる", () => {
    const value = "a".repeat(MB);
    expect(redact(`x${"a".repeat(2 * MB)}y`, [value])).toBe(`x${REDACTED}y`);
  });

  it("認証ファイルの大きさの上限は 1MiB で、その大きさの値でも木は 1 文字あたり 30 バイト以下で作れる", () => {
    expect(MAX_AUTH_FILE_BYTES).toBe(MB);
    const value = longValue(MAX_AUTH_FILE_BYTES, 4);
    const m = compileSecrets([value]);
    expect(m.best[m.best.length - 1]).toBe(value.length);
    expect(bytesPerNode(m) * (m.nodes / value.length)).toBeLessThanOrEqual(30);
  });

  it("StreamRedactor：値の集合が変わらなければ、push のたびに値の形を作り直さない（長い値でも 1 回の時間が長さに比例しない）", () => {
    const value = `${longValue(200_000, 5)}\n"`;
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const stream = new StreamRedactor(() => [value]);
      for (let i = 0; i < 200; i++) stream.push("small output line\n");
      expect(stringify.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      stringify.mockRestore();
    }
  });

  it("StreamRedactor：途中で値が増えたら、増えた値も伏せる", () => {
    const first = longValue(20_000, 6);
    const second = longValue(20_000, 7);
    const secrets = [first];
    const stream = new StreamRedactor(() => secrets);
    let out = stream.push(`a ${first} b `);
    secrets.push(second);
    out += stream.push(`${second} c`) + stream.flush();
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c`);
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

  it("ByteRedactor：届く分の境目をまたいでも、残らない（UTF-8 の多バイトの文字の途中で切れる値）", () => {
    const wide = `${value.slice(0, 100_000)}あいう${value.slice(0, 50_000)}`;
    const text = `before ${wide} after ${wide}`;
    for (const step of [999, 65_536, 150_001, 100_009]) {
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

describe("ステージした認証ファイルの上限（readStagedFile）", () => {
  it("上限ちょうどは読め、上限 + 1 バイトは例外になる", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readStagedFile, StagedFileTooLargeError } = await import("./docker.js");
    const dir = mkdtempSync(join(tmpdir(), "sacty-staged-"));
    try {
      writeFileSync(join(dir, "exact"), "a".repeat(100));
      writeFileSync(join(dir, "over"), "a".repeat(101));
      expect(readStagedFile({ dir, name: "exact" }, 100).length).toBe(100);
      expect(() => readStagedFile({ dir, name: "over" }, 100)).toThrow(StagedFileTooLargeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
