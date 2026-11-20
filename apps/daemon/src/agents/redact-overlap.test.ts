import { describe, expect, it } from "vitest";
import { ByteRedactor } from "../agent-sessions.js";
import { StreamRedactor, secretForms } from "../session-logs.js";
import { REDACTED, redact } from "./redact.js";

/** 修正前の手順（長い値から順に、1つずつ置き換える）。重ならない入力で、結果が同じことを確かめるために写した。 */
const legacyRedact = (text: string, secrets: readonly string[]): string =>
  [...new Set(secrets)]
    .filter((v) => v)
    .sort((a, b) => b.length - a.length)
    .reduce((acc, v) => acc.split(v).join(REDACTED), text);

/** 素朴な方法：各値の各位置を総当たりして、含まれる文字に印を付け、重なる（文字を共有する）出現のかたまりを1つの目印にする。 */
function naiveRedact(text: string, secrets: readonly string[]): string {
  const mark = new Array<number>(text.length).fill(0); // 0=印なし。出現ごとに番号を振り、重なったら束ねる
  const parent: number[] = [0];
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  for (const secret of new Set(secrets)) {
    if (!secret) continue;
    for (let at = 0; at + secret.length <= text.length; at++) {
      if (text.slice(at, at + secret.length) !== secret) continue;
      const id = parent.length;
      parent.push(id);
      for (let i = at; i < at + secret.length; i++) {
        const prev = mark[i] as number;
        if (prev === 0) mark[i] = id;
        else parent[find(id)] = find(prev);
      }
    }
  }
  // 隣り合う出現は、別のかたまり（番号が違う）として2つの目印にする
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const m = mark[i] as number;
    if (m === 0) out += text[i];
    else if (i === 0 || mark[i - 1] === 0 || find(mark[i - 1] as number) !== find(m))
      out += REDACTED;
  }
  return out;
}

/** 種を固定した乱数（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 重なる値・自分自身と重なる値・接頭辞や接尾辞を共有する値・一方が他方を含む値・1文字の値を含む集合と、その値を重ねて・続けて・地の文に挟んだ入力。 */
function randomCase(rand: () => number): { secrets: string[]; text: string } {
  const pick = (n: number) => Math.floor(rand() * n);
  const alphabet = "ab-";
  const word = (min: number, max: number) =>
    Array.from({ length: min + pick(max - min + 1) }, () => alphabet[pick(alphabet.length)]).join(
      "",
    );
  const secrets: string[] = [];
  for (let n = 1 + pick(4); n > 0; n--) {
    const base =
      secrets.length > 0 && rand() < 0.5 ? (secrets[pick(secrets.length)] as string) : word(1, 5);
    const style = pick(5);
    if (style === 0)
      secrets.push(base.repeat(2)); // 自分自身と重なる
    else if (style === 1)
      secrets.push(base + word(1, 3)); // 接頭辞を共有する・含む
    else if (style === 2)
      secrets.push(word(1, 3) + base); // 接尾辞を共有する・含む
    else if (style === 3)
      secrets.push(base.slice(0, 1)); // 1文字
    else secrets.push(base);
  }
  let text = "";
  for (let n = 2 + pick(6); n > 0; n--) {
    const kind = pick(4);
    const s = secrets[pick(secrets.length)] as string;
    if (kind === 0)
      text += s; // 続けて
    else if (kind === 1)
      text += `${s.slice(0, 1 + pick(s.length))}${s}`.slice(0, s.length + pick(3)); // 重ねる
    else if (kind === 2)
      text += ` ${word(0, 4)} `; // 地の文
    else text += word(0, 6);
  }
  return { secrets, text };
}

function splitAt(text: string, cuts: number[]): string[] {
  const points = [0, ...[...cuts].sort((x, y) => x - y), text.length];
  return points.slice(0, -1).map((p, i) => text.slice(p, points[i + 1]));
}

describe("redact: 重なって現れる値（PBI-438）", () => {
  const cases: { name: string; secrets: string[]; text: string; expected: string }[] = [
    {
      name: "表2 同じ文字が続く値",
      secrets: ["00000000"],
      text: "id=000000000000",
      expected: "id=[REDACTED]",
    },
    {
      name: "表3 繰り返しのある値",
      secrets: ["abcabcabc"],
      text: "abcabcabcabc",
      expected: "[REDACTED]",
    },
    {
      name: "表4 一方の末尾が他方の先頭",
      secrets: ["sk-AAAA-BBBB", "BBBB-CCCC"],
      text: "key=sk-AAAA-BBBB-CCCC",
      expected: "key=[REDACTED]",
    },
    {
      name: "表5 一方が他方を含む値をまとめて",
      secrets: ["postgres://app:Pw0rd-fictional@db.example.test:5432/main", "Pw0rd-fictional"],
      text: "connect postgres://app:Pw0rd-fictional@db.example.test:5432/main failed",
      expected: "connect [REDACTED] failed",
    },
    {
      name: "表8 目印の中の文字に別の値が一致しない",
      secrets: ["sk-live-12345", "ACT"],
      text: "token sk-live-12345 ACT",
      expected: "token [REDACTED] [REDACTED]",
    },
    {
      name: "隣り合う出現は2つのまま",
      secrets: ["abc"],
      text: "x abcabc y",
      expected: "x [REDACTED][REDACTED] y",
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(redact(c.text, c.secrets)).toBe(c.expected);
    });
  }

  it("種を固定した乱数：素朴な総当たりと同じ結果になる。重ならない入力では修正前の手順とも同じ", () => {
    const rand = rng(438);
    let changed = 0;
    let same = 0;
    for (let i = 0; i < 4000; i++) {
      const { secrets, text } = randomCase(rand);
      const expected = naiveRedact(text, secrets);
      expect(redact(text, secrets), JSON.stringify({ secrets, text })).toBe(expected);
      // 修正前の手順と結果が変わる入力（今回の対象）と、変わらない入力（重ならない入力）の両方が含まれている
      if (expected === legacyRedact(text, secrets)) same++;
      else changed++;
    }
    expect(changed).toBeGreaterThan(100);
    expect(same).toBeGreaterThan(500);
  });

  it("出現がn個重なる入力でも、二乗の時間にならない（同じ文字だけの入力と、その文字だけの値）", () => {
    const text = "z".repeat(200_000);
    const secrets = Array.from({ length: 300 }, (_, i) => "z".repeat(i + 1));
    expect(redact(text, secrets)).toBe(REDACTED);
  });
});

describe("少しずつ届く出力の秘密情報（PBI-438）", () => {
  const stream = (secrets: string[], parts: string[]): string => {
    const r = new StreamRedactor(() => secrets);
    return parts.map((p) => r.push(p)).join("") + r.flush();
  };
  const bytes = (secrets: string[], parts: string[]): string => {
    const r = new ByteRedactor(secrets);
    return Buffer.concat([...parts.map((p) => r.push(Buffer.from(p, "utf8"))), r.flush()]).toString(
      "utf8",
    );
  };

  const conn = "postgres://app:Pw0rd-fictional@db.example.test:5432/main";
  it.each([
    [
      "表6 接続文字列とそのパスワード",
      [conn, "Pw0rd-fictional"],
      `connect ${conn} failed`,
      "connect [REDACTED] failed",
    ],
    ["表7 重なる値", ["ZQZ"], "x ZQZQZ y", "x [REDACTED] y"],
  ])("%s が、どこで2回に分かれても1つの目印になる", (_name, secrets, text, expected) => {
    for (let at = 0; at <= text.length; at++) {
      const parts = [text.slice(0, at), text.slice(at)];
      expect(stream(secrets, parts)).toBe(expected);
      expect(bytes(secrets, parts)).toBe(expected);
    }
  });

  it("同じ文字が長く続くかたまりは、持ち越しが値の長さのまま、1つの目印になる。peek は伏せたものを返す", () => {
    const p = new StreamRedactor(() => ["0000"]);
    expect(p.push("a000")).toBe("a");
    expect(p.peek()).toBe("000");
    expect(p.push("0")).toBe(REDACTED);
    expect(p.peek()).toBe(""); // 目印を出したかたまりの分は返さない
    expect(p.flush()).toBe("");
  });

  it("peek は、改行を含む値を伏せたまま返す（改行で前半を切られても後半が残らない）", () => {
    const secret = "LINE1-fictional\nSECRETLINE2";
    const r = new StreamRedactor(() => [secret]);
    r.push(`x ${secret}`);
    expect(r.peek()).not.toContain("SECRETLINE2");
    expect(r.peek()).not.toContain("LINE1-fictional");
  });

  it("途中で値が増えても、増えた後に届く分から伏せる", () => {
    const secrets = ["abc"];
    const r = new StreamRedactor(() => secrets);
    const out = [r.push("x abc y ")];
    secrets.push("zzzzzz");
    out.push(r.push("zzzzzz w"), r.flush());
    expect(out.join("")).toBe("x [REDACTED] y [REDACTED] w");
  });

  it("種を固定した乱数：乱数の位置で何回に分けても、まとめて伏せた結果と同じ（文字列・バイト列）", () => {
    const rand = rng(3);
    for (let i = 0; i < 3000; i++) {
      const { secrets, text } = randomCase(rand);
      const cuts = Array.from({ length: Math.floor(rand() * 6) }, () =>
        Math.floor(rand() * (text.length + 1)),
      );
      const parts = splitAt(text, cuts);
      const expected = redact(text, secretForms(secrets));
      const label = JSON.stringify({ secrets, text, cuts });
      expect(stream(secrets, parts), label).toBe(expected);
      expect(bytes(secrets, parts), label).toBe(expected);
    }
  });

  it("バイト列：多バイトの値と UTF-8 でないバイトを、どの位置で分けても壊さず、値だけを伏せる", () => {
    const secrets = ["鍵🔑秘密", "秘密ab"];
    const raw = Buffer.concat([
      Buffer.from("a "),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from(" 鍵🔑秘密ab "),
      Buffer.from([0xc3]),
    ]);
    const expected = Buffer.concat([
      Buffer.from("a "),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from(` ${REDACTED} `),
      Buffer.from([0xc3]),
    ]);
    for (let at = 0; at <= raw.length; at++) {
      const r = new ByteRedactor(secrets);
      const out = Buffer.concat([r.push(raw.subarray(0, at)), r.push(raw.subarray(at)), r.flush()]);
      expect(out.equals(expected), `at=${at}`).toBe(true);
    }
  });
});
