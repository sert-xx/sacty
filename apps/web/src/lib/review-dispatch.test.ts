import { message } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { pausedForUndispatchedReview } from "./review-dispatch";

describe("担当を起動しないレビューが続いて止まっているか（PBI-379）", () => {
  it("一時停止の説明が、その止まり方の文言のときだけ", () => {
    expect(
      pausedForUndispatchedReview({
        status: "paused",
        pausedMessage: message("review.notDispatchedPaused", { runs: 4 }),
      }),
    ).toBe(true);
  });

  it("やり直しの途中で人が一時停止した・別の理由で止まった・止まっていないときは、当たらない", () => {
    // 人の一時停止（説明なし）
    expect(pausedForUndispatchedReview({ status: "paused", pausedMessage: undefined })).toBe(false);
    // 別の理由の説明（文字列・別の文言）
    expect(pausedForUndispatchedReview({ status: "paused", pausedMessage: "429" })).toBe(false);
    expect(
      pausedForUndispatchedReview({
        status: "paused",
        pausedMessage: message("review.headUnknown"),
      }),
    ).toBe(false);
    // やり直しの途中（止まっていない）。前の一時停止の説明が残っていても、当たらない
    expect(
      pausedForUndispatchedReview({
        status: "queued",
        pausedMessage: message("review.notDispatchedPaused", { runs: 4 }),
      }),
    ).toBe(false);
  });
});
