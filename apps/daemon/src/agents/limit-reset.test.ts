import { describe, expect, it } from "vitest";
import { LIMIT_RESET_MAX_AHEAD_MS, parseLimitReset } from "./limit-reset.js";

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const read = (message: string, now: string) => iso(parseLimitReset(message, Date.parse(now)));

describe("利用上限の失敗の文から明ける時刻を読む", () => {
  it("Claude Code の時間帯の名前つきの形（セッション・Opus・Sonnet）を、その時間帯で読む", () => {
    // 2026-11-20 10:00 JST。3:45pm JST は 06:45Z
    const now = "2026-11-20T01:00:00Z";
    expect(read("You've hit your session limit · resets 3:45pm (Asia/Tokyo)", now)).toBe(
      "2026-11-20T06:45:00.000Z",
    );
    expect(read("You've hit your Opus limit · resets 3:45pm (Asia/Tokyo)", now)).toBe(
      "2026-11-20T06:45:00.000Z",
    );
    expect(read("You've hit your Sonnet limit · resets 3:45pm (America/New_York)", now)).toBe(
      "2026-11-20T20:45:00.000Z",
    );
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

  it("長い文でも、短い時間で読み終える", () => {
    const long = `${"session limit · resets 1".repeat(200)}${"9".repeat(100000)}`;
    const t = Date.now();
    expect(parseLimitReset(long, Date.parse("2026-11-20T00:00:00Z"))).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(500);
  });
});
