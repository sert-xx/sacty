import { describe, expect, it } from "vitest";
import { isReworkNotice } from "./github.js";
import { buildReworkNotice, reworkNoticeMarker } from "./rework-notice.js";

const TASK = "52359c0c-6e66-4842-a4ae-65e73d30a117";
const URL = "http://127.0.0.1:4700/tasks/52359c0c-6e66-4842-a4ae-65e73d30a117";
const base = {
  taskId: TASK,
  round: 2,
  reason: "決定を変える（方針）：設計が決めた構成を別の方式に選び直す",
  stepName: "設計",
  taskUrl: URL,
  secrets: [] as string[],
};

describe("設計に戻したことの PR のコメント（PBI-446）", () => {
  it("目印・戻したこと・理由・次に人がすること・実装の工程で直させる伝え方・画面へのリンクを書く", () => {
    const body = buildReworkNotice(base);
    expect(body.startsWith(reworkNoticeMarker(TASK, 2))).toBe(true);
    expect(body).toContain("設計に戻しました");
    expect(body).toContain("> 決定を変える（方針）：設計が決めた構成を別の方式に選び直す");
    expect(body).toContain("設計の PR");
    expect(body).toContain("実装の工程で直す");
    expect(body).toContain(`](${URL})`);
    expect(isReworkNotice(body)).toBe(true);
  });

  it("理由の秘密情報の値・内部のパスを残さず、@ の通知を無効にし、600 文字で切る", () => {
    const body = buildReworkNotice({
      ...base,
      reason: `SECRET-VALUE-123 /sacty-input/task.md:77 @alice ${"あ".repeat(900)}`,
      secrets: ["SECRET-VALUE-123"],
    });
    expect(body).not.toContain("SECRET-VALUE-123");
    expect(body).not.toContain("/sacty-input");
    expect(body).not.toContain("@alice");
    expect(body).toContain("@​alice");
    expect(body).not.toContain("あ".repeat(700));
  });

  it("回が違えば目印も違う（1回の差し戻しに1通）", () => {
    expect(reworkNoticeMarker(TASK, 1)).not.toBe(reworkNoticeMarker(TASK, 2));
  });
});
