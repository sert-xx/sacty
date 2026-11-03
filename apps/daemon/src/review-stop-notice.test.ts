import { message } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { isReviewStopNotice } from "./github.js";
import {
  buildResolvedNotice,
  buildStopNotice,
  isOpenStopNotice,
  notifiesReviewStop,
  SUMMARY_MAX,
  stopKey,
  stopMarker,
  stopMarkerOfTask,
  stopSummary,
} from "./review-stop-notice.js";

const TASK = "52359c0c-6e66-4842-a4ae-65e73d30a117";
const URL = "http://127.0.0.1:4700/tasks/52359c0c-6e66-4842-a4ae-65e73d30a117";

describe("レビューが止まったことの知らせ（PBI-292）", () => {
  it("F37 の止まり方（モデルの混雑）を、理由・再開のしかた（タスクの画面へのリンク）つきで書く", () => {
    const summary = stopSummary("Selected model is at capacity. Please try a different model.", []);
    const body = buildStopNotice({ taskId: TASK, reason: "error", summary, taskUrl: URL });
    expect(body.startsWith(stopMarker(TASK, stopKey("error", summary)))).toBe(true);
    expect(body).toContain("Sacty のレビューが止まりました");
    expect(body).toContain("エラー");
    expect(body).toContain("Selected model is at capacity");
    expect(body).toContain(`](${URL})`);
    expect(isReviewStopNotice(body)).toBe(true);
    expect(isOpenStopNotice(body)).toBe(true);
  });

  it("理由と要点が同じなら同じ止まり方、違えば別の止まり方", () => {
    expect(stopKey("error", "混雑")).toBe(stopKey("error", "混雑"));
    expect(stopKey("error", "混雑")).not.toBe(stopKey("auth", "混雑"));
    expect(stopKey("error", "混雑")).not.toBe(stopKey("error", "別の失敗"));
    // 止まるたびに変わる数・ID・時刻は、別の止まり方にしない
    expect(stopKey("error", "timed out after 30s (req 4f3a9c01b2d7)")).toBe(
      stopKey("error", "timed out after 31s (req 0a1b2c3d4e5f)"),
    );
    expect(stopKey("error", "timed out")).not.toBe(stopKey("error", "disk full"));
    // 別のタスクの目印は前方一致しない
    expect(stopMarker("task-1", "k")).not.toContain(stopMarkerOfTask("task-10"));
    expect(stopMarker("task-10", "k").startsWith(stopMarkerOfTask("task-1"))).toBe(false);
  });

  it("要点は1行にして、長ければ切り詰める。空の文でも書ける", () => {
    expect(stopSummary("一行目\n二行目\n\n  三行目", [])).toBe("一行目 二行目 三行目");
    const long = stopSummary("あ".repeat(SUMMARY_MAX + 50), []);
    expect(long).toBe(`${"あ".repeat(SUMMARY_MAX)}…`);
    expect(stopSummary(undefined, [])).toBe("");
    expect(stopSummary("", [])).toBe("");
    const body = buildStopNotice({
      taskId: TASK,
      reason: "usage_limit",
      summary: "",
      taskUrl: URL,
    });
    expect(body).toContain("AI の利用上限");
    expect(body).not.toContain("（`");
    // コードと引数の文言は、日本語の文にする
    expect(stopSummary(message("run.timeout", { minutes: 3 }), [])).toContain("3");
  });

  it("秘密情報を伏せてから切り詰める：切り口にかかる位置の秘密情報の前半も残さない", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123456789";
    // 切り詰めの上限の内側に、秘密情報の前半だけが入る位置に置く
    for (const lead of [SUMMARY_MAX - 5, SUMMARY_MAX - secret.length + 4, SUMMARY_MAX - 1]) {
      const text = `${"x".repeat(lead)}${secret}${"y".repeat(100)}`;
      const summary = stopSummary(text, [secret]);
      // 前半（4文字以上）が1つも残らない
      for (let n = 4; n <= secret.length; n++) {
        for (let at = 0; at + n <= secret.length; at++) {
          expect(summary).not.toContain(secret.slice(at, at + n));
        }
      }
      expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
      const body = buildStopNotice({ taskId: TASK, reason: "error", summary, taskUrl: URL });
      expect(body).not.toContain("ghp_");
    }
    // 引数に入った外から来た文の秘密情報も伏せる
    const params = stopSummary(
      message("github.failed", {
        action: "postReview",
        status: 403,
        detail: `${"x".repeat(SUMMARY_MAX - 3)}${secret}`,
        hint: "none",
      }),
      [secret],
    );
    expect(params).not.toContain("ghp_");
  });

  it("外から来た文は、コードにして載せる（@ メンションや目印のようなものを本文に出さない）", () => {
    const summary = stopSummary("denied for @alice `rm` <!-- sacty-review:x -->", []);
    const body = buildStopNotice({ taskId: TASK, reason: "error", summary, taskUrl: URL });
    expect(body).toContain("`denied for @alice 'rm' <!-- sacty-review:x -->`");
    // 目印は先頭の行だけ。外から来た文の中の目印では始まらない
    expect(body.split("\n")[0]).toBe(stopMarker(TASK, stopKey("error", summary)));
  });

  it("再開してレビューを投稿したら、解消済みの投稿に直す（理由は残し、再開の案内は外す）", () => {
    const open = buildStopNotice({
      taskId: TASK,
      reason: "error",
      summary: "混雑",
      taskUrl: URL,
    });
    const resolved = buildResolvedNotice(
      open,
      "https://github.com/acme/app/pull/12#pullrequestreview-9",
    );
    expect(isOpenStopNotice(resolved)).toBe(false);
    expect(isReviewStopNotice(resolved)).toBe(true);
    expect(resolved.split("\n")[0]).toBe(
      `${stopMarker(TASK, stopKey("error", "混雑")).replace(/ -->$/, "")}:resolved -->`,
    );
    expect(resolved).toContain("解消済み");
    expect(resolved).toContain("pullrequestreview-9");
    expect(resolved).toContain("混雑");
    expect(resolved).not.toContain("再開のしかた");
    // 解消済みの投稿は、同じ止まり方の「まだ解消していない投稿」の目印に当たらない
    expect(resolved.startsWith(stopMarker(TASK, stopKey("error", "混雑")))).toBe(false);
    expect(resolved.startsWith(stopMarkerOfTask(TASK))).toBe(true);
  });

  it("知らせるのは、人が止めたのではない止まり方だけ", () => {
    for (const reason of ["error", "usage_limit", "auth", "budget"] as const) {
      expect(notifiesReviewStop(reason)).toBe(true);
    }
    for (const reason of ["manual", "verification", "child_cancelled", undefined] as const) {
      expect(notifiesReviewStop(reason)).toBe(false);
    }
  });
});
