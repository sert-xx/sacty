import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentOutcome } from "./agents/index.js";
import { type HeadTail, SessionLogStore } from "./session-logs.js";

/**
 * 伏せる時点（書くとき・閉じるとき・読むとき）で知っている秘密情報の集まりが違うときの、ログの範囲の読み取り（PBI-395）。
 * 書くとき：open で渡す集まり W。閉じるとき：W に、書き始めた後に足した A を加えた集まり。読むとき：閉じた実行は、
 * 読むときだけの集まり R（プロジェクトの設定など）。実行中は W・A・R。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-redaction-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const done: AgentOutcome = {
  kind: "completed",
  output: "",
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
};
const info = (taskId: string, runId: string) => ({
  taskId,
  runId,
  role: "design",
  agentId: "claude",
  runtime: "claude-code",
  authMode: "subscription",
});
const limits = (head: number, tail: number): Record<"events" | "stderr", HeadTail> => ({
  events: { head: 1000, tail: 1000 },
  stderr: { head, tail },
});

type Read = ReturnType<SessionLogStore["readRange"]>;
const textOf = (r: Read) => (r.kind === "ok" ? r.text : `<${r.kind}>`);

describe("伏せる時点ごとの秘密情報の集まりが違うときの、継ぎ目と前の回の印", () => {
  it("閉じるときに伏せた印の外側に、読むときだけの値の後半が残っても、返さない（末尾の始まり）", () => {
    const store = new SessionLogStore(join(dir, "runs"), limits(20, 28));
    const added = "sk-run-secret-0000g";
    const read = "ghp_NEWTOKEN1234567890abcdef";
    const h = store.open(info("t1", "r1"), () => []);
    h.stderr("start\n");
    h.addSecrets([added]);
    h.stderr(`${"d".repeat(60)}${read}`);
    h.close(done);
    // 末尾は値の先頭から始まる。閉じるときの伏せ直しは、先頭の g を実行の値の後ろの一部として伏せる
    expect(readFileSync(store.path("t1", "r1", "stderr") ?? "", "utf8")).toContain(
      "[REDACTED]hp_NEWTOKEN1234567890abcdef",
    );
    for (const request of [{ offset: 0 }, { fromEnd: true }, { offset: 40 }]) {
      const text = textOf(
        store.readRange("t1", "r1", { file: "stderr", max: 32_000, ...request }, [read]),
      );
      expect(text).not.toContain("hp_NEW");
      expect(text).not.toContain("0123");
      expect(text).not.toContain("abcdef");
    }
  });

  it("閉じるときに伏せた印の外側に、読むときだけの値の前半が残っても、返さない（先頭の終わり）", () => {
    const store = new SessionLogStore(join(dir, "runs"), limits(25, 20));
    const added = "sk-run-secret-0000g";
    const read = "NEWTOKEN1234567890abcdefs";
    const h = store.open(info("t2", "r2"), () => []);
    h.stderr(read);
    h.addSecrets([added]);
    h.stderr("d".repeat(80));
    h.close(done);
    expect(readFileSync(store.path("t2", "r2", "stderr") ?? "", "utf8")).toContain(
      "NEWTOKEN1234567890abcdef[REDACTED]",
    );
    for (const request of [{ offset: 0 }, { fromEnd: true }, { offset: 3, max: 10 }]) {
      const text = textOf(
        store.readRange("t2", "r2", { file: "stderr", max: 32_000, ...request }, [read]),
      );
      expect(text).not.toContain("NEWTOKEN");
      expect(text).not.toContain("0123");
      expect(text).not.toContain("abcdef");
    }
  });

  it("乱数の入力（書くとき・閉じるとき・読むときで秘密情報の集まりが違い、値が重なる）で、閉じた実行と実行中の読みの結果に、値のどの一部も出ない", () => {
    let seed = 20261120;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const pick = <T>(list: readonly T[]) => list[rand(list.length)] as T;
    const alphabet = ["Q", "Z", "秘", "密"];
    const filler = ["x", "-", " ", "\n", "y"];
    const word = (min: number, max: number, chars: readonly string[]) =>
      Array.from({ length: min + rand(max - min + 1) }, () => pick(chars)).join("");
    const strip = (text: string) => text.replaceAll("[REDACTED]", "");
    const leaks = (text: string) => alphabet.some((c) => strip(text).includes(c));
    let counter = 0;

    for (let round = 0; round < 1500; round++) {
      // 3つの集まり。値は同じ文字から作るので、先頭と末尾が重なり、1文字が一致する
      const values = [...new Set(Array.from({ length: 3 + rand(3) }, () => word(2, 7, alphabet)))];
      // 書くときの集まりは1つの値だけ（書くときの StreamRedactor は、重なる値を順に置き換えるので、この試験の対象にしない）
      const w = rand(2) === 0 ? [pick(values)] : [];
      const a = values.filter((v) => !w.includes(v) && rand(2) === 0);
      const r = values.filter((v) => !w.includes(v) && !a.includes(v));
      // 本文：値を、地の文の間に並べる（ときどき、続けて並べる）
      let text = "";
      for (let i = 0, n = 2 + rand(8); i < n; i++) {
        // 書くときに知っている値は、地の文で挟む（書くときの置き換えは、値が別の出現と重なる並びを正しく分けられない）
        const place = (value: string) => (w.includes(value) ? `x${value}x` : value);
        text += word(0, 5, filler) + place(pick(values));
        if (rand(3) === 0) text += place(pick(values));
      }
      text += word(0, 5, filler);
      const chars = [...text];
      const chunks: string[] = [];
      for (let i = 0; i < chars.length; ) {
        const n = 1 + rand(12);
        chunks.push(chars.slice(i, i + n).join(""));
        i += n;
      }
      // 先頭・末尾の上限も変える（継ぎ目の位置が変わる）
      const store = new SessionLogStore(join(dir, "runs"), limits(15 + rand(40), 15 + rand(40)));
      const addAt = rand(chunks.length + 1);
      const closed = rand(2) === 0;
      const taskId = `t${counter++}`;
      const h = store.open(info(taskId, "r"), () => w);
      let added = false;
      chunks.forEach((chunk, i) => {
        // 書き始めた後に足すので、最初の出力の後に足す
        if (i === Math.max(1, addAt)) {
          h.addSecrets(a);
          added = true;
        }
        h.stderr(chunk);
      });
      if (!added) h.addSecrets(a);
      if (closed) h.close(done);
      const extras = [...r, ...(closed ? [] : [])];
      for (let i = 0; i < 6; i++) {
        const request = rand(2)
          ? { fromEnd: true, max: 1 + rand(40) }
          : { offset: rand(120), max: 1 + rand(40) };
        const label = JSON.stringify({ w, a, r, text, closed, request, addAt });
        const got = store.readRange(taskId, "r", { file: "stderr", ...request }, extras);
        if (got.kind !== "ok") continue;
        expect(leaks(got.text), label).toBe(false);
        expect(got.text, label).not.toContain("�");
      }
      if (!closed) h.close(done);
    }
  });
});
