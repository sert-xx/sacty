import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactEscaped } from "./redact.js";

const SECRET = "sk-live-12345";
const hide = (text: string) => redactEscaped(redact(text, [SECRET]), [SECRET]);

describe("デコードすると秘密情報に戻る JSON のエスケープを伏せる（PBI-131）", () => {
  it.each([
    ["Unicode エスケープ", '{"body": "sk-live-12\\u003345"}'],
    ["Unicode エスケープ（16 進の大文字）", '{"body": "sk\\u002Dlive-12345"}'],
    [
      "すべての文字を Unicode エスケープ",
      `{"body": "${[...SECRET].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`,
    ],
    ["キーの中", '{"sk-live-1234\\u0035": 1}'],
  ])("%s", (_, text) => {
    const out = hide(text);
    expect(JSON.stringify(JSON.parse(out))).not.toContain(SECRET);
    expect(out).toContain(REDACTED);
  });

  it("改行・引用符のエスケープを含む秘密情報も、デコードした後に残らない", () => {
    const secret = 'pa"ss\nword-xyz';
    const text = `{"body": ${JSON.stringify(`前 ${secret} 後`).replace("p", "\\u0070")}}`;
    const out = redactEscaped(redact(text, [secret]), [secret]);
    expect((JSON.parse(out) as { body: string }).body).toBe(`前 ${REDACTED} 後`);
  });

  it("デコードした結果は、伏せたまま正しい JSON のまま（ほかの値は変えない）", () => {
    const text = '{"a": "keep \\"quoted\\"", "b": "x sk-live-1234\\u0035 y", "c": 3}';
    expect(JSON.parse(hide(text))).toEqual({ a: 'keep "quoted"', b: `x ${REDACTED} y`, c: 3 });
  });

  it("前にある地の文の引用符で、組がずれても見落とさない", () => {
    const text = 'メモ "閉じない引用符 {"body":"sk-live-1234\\u0035"} と "もう一つ"';
    const out = hide(text);
    expect(out).not.toMatch(/u0035/);
    expect(out).toContain(`{"body":"${REDACTED}"}`);
    expect(out).toContain('"もう一つ"');
  });

  it("エスケープした JSON の中の JSON（入れ子）も伏せる", () => {
    // 外側の JSON をデコードすると、内側の JSON の文字列（まだエスケープされている）になる
    const text = JSON.stringify({ wrapped: '{"body":"sk-live-1234\\u0035"}' });
    const out = hide(text);
    const wrapped = (JSON.parse(out) as { wrapped: string }).wrapped;
    expect(JSON.stringify(JSON.parse(wrapped))).not.toContain(SECRET);
  });

  it("秘密情報を含まない文字列・JSON でない文・秘密情報が無いときは、そのまま返す", () => {
    for (const text of [
      '{"body": "\\u3042 ok"}',
      'C:\\path\\to "not json\\q"',
      "バックスラッシュの無い文",
      '"sk-live-1234\\u0035',
    ]) {
      expect(hide(text)).toBe(text);
    }
    const escaped = '{"body": "sk-live-1234\\u0035"}';
    expect(redactEscaped(escaped, [])).toBe(escaped);
    expect(redactEscaped(escaped, [""])).toBe(escaped);
  });

  it("同じ秘密情報が何か所にあっても、すべて伏せる", () => {
    const text = '["sk-live-1234\\u0035", "ok", "\\u0073k-live-12345", "sk-live-12345"]';
    expect(JSON.parse(hide(text))).toEqual([REDACTED, "ok", REDACTED, REDACTED]);
  });

  it("大きな出力でも、引用符の数に比例する時間で終わる", () => {
    const text = `${'"a\\"b", '.repeat(50_000)}"sk-live-1234\\u0035"`;
    const start = performance.now();
    const out = hide(text);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(out.endsWith(`"${REDACTED}"`)).toBe(true);
  });
});
