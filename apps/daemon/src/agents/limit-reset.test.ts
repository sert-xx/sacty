import { describe, expect, it } from "vitest";
import { LIMIT_RESET_MAX_AHEAD_MS, parseLimitReset } from "./limit-reset.js";
import { ClaudeOutcomeReader, parseClaudeResult } from "./parse.js";

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const read = (message: string, now: string) => iso(parseLimitReset(message, Date.parse(now)));

describe("利用上限の失敗の文から明ける時刻を読む", () => {
  it("Claude Code の時間帯の名前つきの形（セッション）を、その時間帯で読む", () => {
    // 2026-11-20 10:00 JST。3:45pm JST は 06:45Z
    const now = "2026-11-20T01:00:00Z";
    expect(read("You've hit your session limit · resets 3:45pm (Asia/Tokyo)", now)).toBe(
      "2026-11-20T06:45:00.000Z",
    );
    // classifyFailure が利用上限にしない Opus・Sonnet の文は、読む形に入れない
    expect(read("You've hit your Opus limit · resets 3:45pm (Asia/Tokyo)", now)).toBeUndefined();
  });

  it("週の上限は、曜日つきで読む（曜日が今日と同じで時刻が前なら翌週）", () => {
    // 2026-11-20 は金曜
    const now = "2026-11-20T01:00:00Z"; // JST 金 10:00
    expect(read("You've hit your weekly limit · resets Mon 12:00am (Asia/Tokyo)", now)).toBe(
      "2026-11-22T15:00:00.000Z",
    );
    expect(read("You've hit your weekly limit · resets Fri 11:00am (Asia/Tokyo)", now)).toBe(
      "2026-11-20T02:00:00.000Z",
    );
    expect(read("You've hit your weekly limit · resets Fri 9:00am (Asia/Tokyo)", now)).toBe(
      "2026-11-27T00:00:00.000Z",
    );
  });

  it("日付をまたぐ境界と年末を読む", () => {
    expect(read("session limit · resets 12:05am (Asia/Tokyo)", "2026-11-20T14:59:00Z")).toBe(
      "2026-11-20T15:05:00.000Z",
    );
    expect(read("session limit · resets 12:05am (UTC)", "2026-12-31T23:59:00Z")).toBe(
      "2027-01-01T00:05:00.000Z",
    );
    expect(read("session limit · resets 12:00pm (UTC)", "2026-12-31T23:59:00Z")).toBe(
      "2027-01-01T12:00:00.000Z",
    );
  });

  it("古い形のエポックの秒を読む", () => {
    expect(read("Claude AI usage limit reached|1760000000", "2025-10-09T00:00:00Z")).toBe(
      "2025-10-09T08:53:20.000Z",
    );
  });

  it("時間帯の無い形（Claude Code・Codex）は読まない", () => {
    const now = "2026-11-20T01:00:00Z";
    expect(read("You've hit your session limit · resets 3:45pm", now)).toBeUndefined();
    expect(read("You’ve hit your usage limit. Try again at 3:45 PM.", now)).toBeUndefined();
    expect(
      read("You’ve hit your usage limit. try again at Nov 21st, 2026 3:45 PM.", now),
    ).toBeUndefined();
    expect(read("You’ve hit your usage limit. Try again later.", now)).toBeUndefined();
    expect(read("You've hit your session limit", now)).toBeUndefined();
  });

  it("不正な時刻・知らない時間帯・一時的な混雑の文は読まない", () => {
    const now = "2026-11-20T01:00:00Z";
    expect(read("session limit · resets 13:00pm (Asia/Tokyo)", now)).toBeUndefined();
    expect(read("session limit · resets 0:30am (Asia/Tokyo)", now)).toBeUndefined();
    expect(read("session limit · resets 25:00pm (Asia/Tokyo)", now)).toBeUndefined();
    expect(read("session limit · resets 3:60pm (Asia/Tokyo)", now)).toBeUndefined();
    expect(read("session limit · resets 3:45pm (Mars/Olympus)", now)).toBeUndefined();
    expect(read("429 Too Many Requests, retry at 3:45pm (Asia/Tokyo)", now)).toBeUndefined();
    expect(read("rate limit · resets 3:45pm (Asia/Tokyo)", now)).toBeUndefined();
  });

  it("失敗の時刻のすぐ前の時刻は、翌日とは読まない", () => {
    // JST 10:00 に「9:50am」＝10 分前
    expect(
      read("session limit · resets 9:50am (Asia/Tokyo)", "2026-11-20T01:00:00Z"),
    ).toBeUndefined();
    // 0:03 に「11:59pm」（昨日）
    expect(
      read("session limit · resets 11:59pm (Asia/Tokyo)", "2026-11-19T15:03:00Z"),
    ).toBeUndefined();
    // すぐ前より前なら、翌日
    expect(read("session limit · resets 8:00am (Asia/Tokyo)", "2026-11-20T01:00:00Z")).toBe(
      "2026-11-20T23:00:00.000Z",
    );
  });

  it("過去・遠すぎるエポックは読まない", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    const epoch = (ms: number) => `Claude AI usage limit reached|${Math.floor(ms / 1000)}`;
    expect(parseLimitReset(epoch(now - 1000), now)).toBeUndefined();
    expect(parseLimitReset(epoch(now + LIMIT_RESET_MAX_AHEAD_MS + 60_000), now)).toBeUndefined();
    expect(parseLimitReset(epoch(now + 7 * 24 * 3600_000), now)).toBe(
      Math.floor((now + 7 * 24 * 3600_000) / 1000) * 1000,
    );
    expect(parseLimitReset("Claude AI usage limit reached|1760000000000", now)).toBeUndefined();
  });

  it("2000 字より後ろの時刻は読まず、2000 字以内の同じ文は読む", () => {
    const now = Date.parse("2026-11-20T01:00:00Z");
    const sentence = "session limit · resets 3:45pm (Asia/Tokyo)";
    expect(iso(parseLimitReset(`${sentence}${"x".repeat(5000)}`, now))).toBe(
      "2026-11-20T06:45:00.000Z",
    );
    expect(parseLimitReset(`${"x".repeat(2000)}${sentence}`, now)).toBeUndefined();
    expect(parseLimitReset(`${"x".repeat(1900)}${sentence}`, now)).toBeDefined();
  });

  it("すぐ前の幅（30 分）の境界と、読める先の上限（8 日）の境界", () => {
    const now = "2026-11-20T01:00:00Z"; // JST 10:00
    expect(read("session limit · resets 9:31am (Asia/Tokyo)", now)).toBeUndefined();
    expect(read("session limit · resets 9:30am (Asia/Tokyo)", now)).toBe(
      "2026-11-21T00:30:00.000Z",
    );
    expect(read("session limit · resets 10:00am (Asia/Tokyo)", now)).toBeUndefined();
    expect(read("session limit · resets 10:01am (Asia/Tokyo)", now)).toBe(
      "2026-11-20T01:01:00.000Z",
    );
    // 曜日つき：金曜 10:00 に「金曜 9:30am」は翌週、「金曜 9:45am」はすぐ前
    expect(read("weekly limit · resets Fri 9:30am (Asia/Tokyo)", now)).toBe(
      "2026-11-27T00:30:00.000Z",
    );
    expect(read("weekly limit · resets Fri 9:45am (Asia/Tokyo)", now)).toBeUndefined();
    // 8 日ちょうど以内は読み、超えたら読まない
    const base = Date.parse(now);
    const epoch = (ms: number) => `Claude AI usage limit reached|${ms / 1000}`;
    expect(parseLimitReset(epoch(base + LIMIT_RESET_MAX_AHEAD_MS), base)).toBe(
      base + LIMIT_RESET_MAX_AHEAD_MS,
    );
    expect(parseLimitReset(epoch(base + LIMIT_RESET_MAX_AHEAD_MS + 1000), base)).toBeUndefined();
  });

  it("夏時間の切り替え日（America/New_York 2026-11-01）を、その日のオフセットで読む", () => {
    // 2026-11-01 06:00Z = NY 01:00 EST（夏時間は 05:59Z まで）。1:30am は EST なら 06:30Z、EDT なら 05:30Z
    expect(read("session limit · resets 3:00am (America/New_York)", "2026-11-01T04:00:00Z")).toBe(
      "2026-11-01T08:00:00.000Z",
    );
    expect(read("session limit · resets 3:00am (America/New_York)", "2026-10-31T20:00:00Z")).toBe(
      "2026-11-01T08:00:00.000Z",
    );
    expect(read("session limit · resets 3:00pm (America/New_York)", "2026-11-01T04:00:00Z")).toBe(
      "2026-11-01T20:00:00.000Z",
    );
  });
});

describe("失敗の文の出どころ（cliText）", () => {
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      id: "m",
      content: [{ type: "text", text: "weekly limit · resets Mon 3:00pm (UTC)" }],
    },
  });
  const failedResult = (isError: boolean, text: string) =>
    JSON.stringify({
      type: "result",
      is_error: isError,
      result: text,
      usage: { output_tokens: 1 },
    });

  it("CLI 自身の出力（is_error の result・stderr）は cliText、エージェントの発言は持たない", () => {
    const text = "You've hit your weekly limit · resets Mon 3:00pm (UTC)";
    expect(parseClaudeResult(failedResult(true, text), 1)).toMatchObject({ cliText: true });
    expect(parseClaudeResult(failedResult(false, text), 1)).not.toHaveProperty("cliText");
    const reader = new ClaudeOutcomeReader();
    reader.push(assistant);
    expect(reader.finish(1)).not.toHaveProperty("cliText");
    const withStderr = new ClaudeOutcomeReader();
    withStderr.push(assistant);
    expect(withStderr.finish(1, text)).toMatchObject({ cliText: true });
  });
});
