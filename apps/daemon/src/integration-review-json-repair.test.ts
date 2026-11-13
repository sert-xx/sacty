import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { extractIntegrationReview } from "./prompts.js";

/*
 * 統合レビューの出力の JSON が崩れていても、直して読む（PBI-298。もとは最終レビューの出力の崩れ（S5 r4）から入れた。
 * 最終レビューは PBI-331 でやめた）。
 */

describe("統合レビューの出力", () => {
  const ids = ["REQ"];

  it("文字列の中の二重引用符を直して読み、直したことを残す。本文からは判定の JSON を取り除く", () => {
    const output = `説明の文\n\`\`\`json\n{"sacty-integration-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"上限 "1,200" を満たす"}],"remarks":[],"findings":[],"summary":"ok"}}\n\`\`\``;
    const review = extractIntegrationReview(output, ids, []);
    expect(review.passed).toBe(true);
    expect(review.viewpoints[0]?.reason).toBe('上限 "1,200" を満たす');
    expect(review.output).toBe("説明の文");
    expect(review.outputRepaired).toMatchObject({
      code: "integrate.outputRepaired",
      params: { repairs: [{ kind: "quote", count: 2 }] },
    });
  });

  it("正しい出力は、今までどおり読め、注記は付かない", () => {
    const output = `\`\`\`json\n{"sacty-integration-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"}],"remarks":[],"findings":["足りない"],"summary":"ok"}}\n\`\`\``;
    const review = extractIntegrationReview(output, ids, []);
    expect(review.findings).toEqual(["足りない"]);
    expect(review.passed).toBe(false);
    expect(review).not.toHaveProperty("outputRepaired");
  });

  it("直しても読めなければ、不合格のまま、壊れた位置を所見に残す", () => {
    const output = `\`\`\`json\n{"sacty-integration-review":{"viewpoints":[{"id":"REQ","verified":true,"reason":"ok"},"remarks":[],"findings":[],"summary":"ok"}}\n\`\`\``;
    const review = extractIntegrationReview(output, ids, [], (t) => t);
    expect(review.passed).toBe(false);
    expect(review.summary).toMatchObject({ code: "integrate.unreadableAt" });
    expect(renderMessage(review.summary, "ja")).toContain("JSON の 1 行目");
    // 伏せる関数が無ければ、位置だけ
    const bare = extractIntegrationReview(output, ids, []);
    expect(renderMessage(bare.summary, "ja")).not.toContain("：");
    // JSON が無ければ、これまでの文言
    expect(extractIntegrationReview("判定なし", ids, []).summary).toMatchObject({
      code: "integrate.unreadable",
    });
  });
});

describe("直して読んだ文字列の、復号した秘密情報を保存しない（PBI-298 レビュー指摘）", () => {
  // 生の改行を含む文字列の中の `\u0073`（s）は、先に出力を伏せる処理が JSON の文字列として読まないので残り、
  // 直して読むときに元の値に戻る。復号したすべての文字列に hide をかけてから、判定として使う
  const secret = "sk-fiction-0123456789abcdef";
  const hide = (t: string) => t.split(secret).join("[伏せた値]");
  const leak = secret.replace("s", "\\u0073");

  it("統合レビュー：観点の理由・指摘・所見のどれにも残らない", () => {
    const output = `\`\`\`json\n{"sacty-integration-review":{"viewpoints":[{"id":"REQ","verified":false,"reason":"理由\n${leak}"}],"remarks":[],"findings":["足りない\n${leak}"],"summary":"所見\n${leak}"}}\n\`\`\``;
    const review = extractIntegrationReview(output, ["REQ"], [], hide);
    expect(review.outputRepaired).toBeDefined();
    expect(JSON.stringify(review)).not.toContain("fiction-0123");
    expect(review.findings).toEqual(["足りない\n[伏せた値]"]);
  });
});
