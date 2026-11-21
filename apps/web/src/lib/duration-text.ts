import type { DashboardMessages } from "@/i18n/messages/dashboard";

/**
 * 待っている時間・期間の文（分・時間・日のどれか1つ。PBI-118）。1分未満は「1分未満」。
 */
export function durationText(ms: number, d: DashboardMessages["duration"]): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return d.underMinute;
  if (minutes < 60) return d.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return d.hours(hours);
  return d.days(Math.floor(hours / 24));
}
