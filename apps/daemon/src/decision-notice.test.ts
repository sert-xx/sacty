import { describe, expect, it } from "vitest";
import { buildDecisionNotice, decisionNoticeMarker } from "./decision-notice.js";
import { isDecisionNotice } from "./github.js";

describe("人の判断を待って止めたことの知らせ（PBI-452）", () => {
  const input = {
    taskId: "t-1",
    round: 2,
    findings: [{ finding: "上限を超える", reason: "方式を変えても解消しない" }],
    secrets: [] as string[],
  };

  it("目印は止めた回ごとで、本文の先頭にあり、取り込みから外す判定に当たる", () => {
    expect(decisionNoticeMarker("t-1", 2)).toBe("<!-- sacty-decision-notice:t-1:2 -->");
    const body = buildDecisionNotice(input);
    expect(body.startsWith(decisionNoticeMarker("t-1", 2))).toBe(true);
    expect(isDecisionNotice(body)).toBe(true);
  });

  it("指摘と根拠を引用し、秘密の値を伏せる", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const body = buildDecisionNotice({
      ...input,
      findings: [{ finding: "上限を超える", reason: `値は ${secret}` }],
      secrets: [secret],
    });
    expect(body).toContain("上限を超える");
    expect(body).toContain("根拠：");
    expect(body).not.toContain(secret);
  });
});
