// 取り込みの docs の中身（PBI-100 のレビュー指摘）を確かめる。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DOCS = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "docs");
const read = (path: string) => readFileSync(join(DOCS, path), "utf8");

describe("取り込みの docs（PBI-100）", () => {
  it("トラブルシューティングは、チケットが取り込まれないときの確かめ方を GitHub と分けて書く", () => {
    const rows = read("user/troubleshooting.md")
      .split("\n")
      .filter((line) => line.startsWith("| "));
    const ticket = rows.find((row) => row.startsWith("| チケットが取り込まれない"));
    expect(ticket).toBeDefined();
    for (const word of [
      "チケットの取り込み",
      "チケットの取り込み先",
      "gateway.platforms",
      "platforms.yaml",
    ]) {
      expect(ticket).toContain(word);
    }
    // Issue の取り込むラベルと GitHub のアカウントは、チケットの取り込みに使わないと書く（PBI-99 の行と合わせる）
    expect(ticket).toContain("チケットの取り込みには使いません");
    expect(ticket).toContain("完了の状態でない");
    // Issue の行にチケットを混ぜない。取り込みに `github:` が要るとは書かない
    expect(rows.find((row) => row.startsWith("| Issue"))).not.toContain("チケット");
    expect(rows.join("\n")).not.toContain("`github:` があるか");
  });

  it("古い版への切り戻しは案内せず、対象外であることを ADR に書く", () => {
    expect(read("user/config.md")).not.toMatch(/切り戻|ロールバック|古い版に戻/);
    const adr = read("adr/20261015-0310-intake-intervals-per-kind.md");
    expect(adr).toContain("古い版への切り戻しは対象外");
    expect(adr).toContain("古い版は取り込みを動かさない");
  });
});
